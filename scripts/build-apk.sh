#!/usr/bin/env bash
#
# Build - and optionally sign + install - the Gréasán Android APK in ONE command,
# so the multi-step v2 flow needs a single approval instead of a dozen prompts.
#
# Usage:
#   scripts/build-apk.sh                    # refresh bundle + build + sign
#   scripts/build-apk.sh --install          # ... + uninstall-first install on device
#   scripts/build-apk.sh --install --launch # ... + launch the app
#   scripts/build-apk.sh --device SERIAL    # target a specific adb device
#   scripts/build-apk.sh --debug            # debug APK (auto-signed, all ABIs)
#   scripts/build-apk.sh --release          # PUBLIC release: no nav-server, alpha-signed
#   scripts/build-apk.sh --no-rezip         # skip the bundle-head refresh
#   scripts/build-apk.sh                    # DuckDB+Parquet substrate (parquet
#                                           #   heads) - the only read path now
#   scripts/build-apk.sh --base             # BASE-ONLY: core metadata + basemap, NO
#                                           #   heads. Boots to empty state; layers
#                                           #   install at runtime. The CI smoke build.
#
# The DuckDB+Parquet read stack is baked in unconditionally (no read-path feature
# flag). Unless --no-rezip, it refreshes each bundled
# head zip (data/bundle/heads/<head>.zip) from its emitted head dir (data/<head>/)
# whenever the head is newer - the guard against shipping a stale head (which bit
# us with the patched wiktionary graph and the geo place head). Head/layer CONTENT
# is built separately by scripts/build-*-layer.mjs; this script only packages,
# signs and ships.
#
# Uninstall-first on install is deliberate: it clears app-data so the new bundle
# fully re-extracts (rather than the READY_MARKER skipping extraction).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="org.flaxandteal.greasan"
# NOTE: tearma-v2 is deliberately NOT bundled - Téarma cannot be shipped
# (licensing), so it is built on-device (tbx-v2 → FTS5 sidecar) instead.
HEADS=(wiktionary-v2-full macbain-v2 gramadan-forms-v2 place-v2 concept-v2 example-tatoeba-v2 example-gaois-v2 example-udt-v2 person-v2 note-v2 layer-v2)

INSTALL=0; LAUNCH=0; DEBUG=0; REZIP=1; RELEASE=0; BASE_ONLY=0; DEVICE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install)  INSTALL=1 ;;
    --launch)   LAUNCH=1 ;;
    --debug)    DEBUG=1 ;;
    --release)  RELEASE=1 ;;
    --duck)     ;;          # accepted for back-compat; duck is the only path now
    --base)     BASE_ONLY=1 ;;
    --no-rezip) REZIP=0 ;;
    --device)   DEVICE="${2:?--device needs a serial}"; shift ;;
    -h|--help)  sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
# Base-only ships no head zips, so there is nothing to rezip.
[ $BASE_ONLY -eq 1 ] && REZIP=0
adbc() { adb ${DEVICE:+-s "$DEVICE"} "$@"; }

# --- 1. Refresh bundled head zips from head dirs (flat, deflate, NO pagefind) ---
# Ships the Parquet substrate heads (built by scripts/build-parquet-layers.mjs into
# data/bundle/parquet-heads/<h>.zip); offline.rs reads them via DuckReader.
if [ $REZIP -eq 1 ]; then
  mkdir -p "$ROOT/data/bundle/heads"
  for h in "${HEADS[@]}"; do
    pq="$ROOT/data/bundle/parquet-heads/$h.zip"; zip="$ROOT/data/bundle/heads/$h.zip"
    [ -f "$pq" ] || { echo "!! missing $pq - run scripts/build-parquet-layers.mjs $h first" >&2; exit 1; }
    if [ ! -f "$zip" ] || [ "$pq" -nt "$zip" ]; then
      echo "[bundle] copying parquet head $h"
      cp -f "$pq" "$zip"
    else
      echo "[bundle] $h up to date"
    fi
  done
fi

# --- 1a. Per-layer versions index: {head -> snapshot_id} from each head's
# manifest, so the app (offline.rs) re-extracts only the layers whose data changed
# on an update, not all ~400MB. Regenerated every build (also under --no-rezip).
# Reads snapshot_id from inside each parquet-head zip (unzip -p manifest.json). ---
if [ $BASE_ONLY -eq 1 ]; then
  mkdir -p "$ROOT/data/bundle"; printf '{}' > "$ROOT/data/bundle/heads-versions.json"
  echo "[bundle] base-only: empty heads-versions.json (no bundled heads)"
else
python3 - "$ROOT" "${HEADS[@]}" <<'PY'
import json, pathlib, sys, subprocess
root = pathlib.Path(sys.argv[1]); heads = sys.argv[2:]
vers = {}
for h in heads:
    zp = root / "data" / "bundle" / "parquet-heads" / f"{h}.zip"
    if zp.exists():
        raw = subprocess.run(["unzip", "-p", str(zp), "manifest.json"],
                             capture_output=True, text=True).stdout
        if raw.strip():
            vers[h] = json.loads(raw).get("snapshot_id", "")
(root / "data" / "bundle" / "heads-versions.json").write_text(json.dumps(vers))
print(f"[bundle] heads-versions.json: {len(vers)} layers")
PY
fi

# --- 1b. Basemap: guarantee the bundled file exists so tauri resource bundling
# succeeds. Real tiles come from scripts/build-basemap.sh; without them a 0-byte
# placeholder keeps the build green - basemap_available() reports false and the
# map falls back to the hand-drawn outline. ---
BASEMAP="$ROOT/app/src-tauri/basemap/goidelic.pmtiles"
if [ ! -s "$BASEMAP" ]; then
  echo "[bundle] basemap tiles absent - using placeholder (run scripts/build-basemap.sh for real tiles)"
  mkdir -p "$(dirname "$BASEMAP")"; : > "$BASEMAP"
else
  echo "[bundle] basemap: $(du -h "$BASEMAP" | cut -f1)"
fi

# --- 2. Build the APK (beforeBuildCommand runs the vite frontend build) ---
# nav-server is a debug-only unauthenticated localhost control port (127.0.0.1:8787)
# - NEVER ship it in a public release. --release omits it; local/dev builds keep it
# for the tour probe. See Cargo.toml.
# The DuckDB+Parquet read stack is a non-optional dependency now, so there are no
# read-path features to pass. Only nav-server remains (debug-only; omitted for a
# public --release build).
BUILD_ARGS=(--apk --target aarch64)
[ $RELEASE -eq 0 ] && BUILD_ARGS+=(--features nav-server)
[ $DEBUG -eq 1 ] && BUILD_ARGS+=(--debug)
# Base config (tauri.conf.json) ships only core metadata + basemap. The full data
# set (11 heads + pagefind) lives in tauri.full.conf.json and is overlaid in for
# any non-base build. tauri deep-merges the resources map, so the overlay adds the
# heads on top of the base entries. --config path is relative to the app/ cwd.
[ $BASE_ONLY -eq 0 ] && BUILD_ARGS+=(--config src-tauri/tauri.full.conf.json)
# Tauri copies bundle.resources into the android asset dir but NEVER removes
# files that dropped out of the config, so a swapped-out head (bunamo -> gramadan
# -forms) or a base build over a prior full build would otherwise ship stale
# heads. Clear every staged heads/ + pagefind/ asset dir so only the currently
# configured resources are packaged. Harmless when gen/android does not exist yet.
GEN="$ROOT/app/src-tauri/gen/android"
if [ -d "$GEN" ]; then
  find "$GEN" -type d -path '*assets*' \( -name heads -o -name pagefind \) -prune -exec rm -rf {} + 2>/dev/null || true
  echo "[apk] cleared stale staged head/pagefind assets"
fi
echo "[apk] tauri android build ${BUILD_ARGS[*]}"
( cd "$ROOT/app" && npx tauri android build "${BUILD_ARGS[@]}" )

# --- 3. Locate + sign ---
OUT="$ROOT/app/src-tauri/gen/android/app/build/outputs/apk"
if [ $DEBUG -eq 1 ]; then
  SIGNED="$(ls -t "$OUT"/*/debug/*.apk | head -1)"   # debug is auto-signed
else
  UNSIGNED="$(ls -t "$OUT"/*/release/*release-unsigned.apk | head -1)"
  BT="$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/ | sort -V | tail -1)"
  SIGNED="$ROOT/data/bundle/greasan-signed.apk"
  ALIGNED="$(mktemp -u).apk"
  "${BT}zipalign" -f -p 4 "$UNSIGNED" "$ALIGNED"
  if [ $RELEASE -eq 1 ]; then
    # Alpha signing identity - MUST stay stable across updates (else testers must
    # uninstall). Self-signed ALPHA key only; regenerate before any Play upload.
    # Keystore is PKCS12 (JDK 9+ default store type), so no --ks-type needed.
    "${BT}apksigner" sign --ks "$HOME/.android/greasan-alpha.jks" \
      --ks-pass pass:greasan-alpha-2026 --ks-key-alias greasan --key-pass pass:greasan-alpha-2026 \
      --out "$SIGNED" "$ALIGNED"
  else
    "${BT}apksigner" sign --ks "$HOME/.android/debug.keystore" \
      --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android \
      --out "$SIGNED" "$ALIGNED"
  fi
  rm -f "$ALIGNED"
  "${BT}apksigner" verify "$SIGNED" >/dev/null && echo "[sign] verified"
fi
echo "[apk] $SIGNED ($(du -h "$SIGNED" | cut -f1))"

# --- 3a. Head-set assertion (full builds only) ---
# offline.rs tolerates a missing head at runtime (so base-only boots clean), which
# means a full build that silently dropped OR carried a stale head would not fail
# on device. Assert the exact set here: the APK's heads must equal HEADS - no
# missing (forgotten head) and no extra (stale head left in the asset dir, e.g. a
# bunamo-v2 lingering after the gramadan-forms swap).
if [ $BASE_ONLY -eq 0 ] && [ $DEBUG -eq 0 ]; then
  expected="$(printf '%s\n' "${HEADS[@]}" | sort -u)"
  # grep reads the full stream (no early exit), so no SIGPIPE under pipefail.
  actual="$(unzip -Z1 "$SIGNED" 2>/dev/null | grep -oE 'assets/heads/[^/]+\.zip' | sed 's#assets/heads/##; s#\.zip$##' | sort -u)"
  if ! diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >/dev/null; then
    echo "[assert] FAILED: APK head set != expected (< expected, > actual):"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | sed 's/^/    /'
    exit 1
  fi
  echo "[assert] exactly ${#HEADS[@]} heads present, none stale"
else
  echo "[assert] base-only build: no heads expected"
fi

# --- 4. Install / launch ---
if [ $INSTALL -eq 1 ]; then
  echo "[install] uninstall-first (clean re-extract) then install"
  adbc uninstall "$PKG" || true
  adbc install "$SIGNED"
  if [ $LAUNCH -eq 1 ]; then
    adbc shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    echo "[launch] started"
  fi
fi
echo "[done]"
