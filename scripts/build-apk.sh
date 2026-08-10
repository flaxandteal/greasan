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
#
# It ALWAYS bakes in `--features v2` (forgetting it ships a v2-less APK where
# `v2_prepare_offline` is missing) and, unless --no-rezip, refreshes each bundled
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
HEADS=(wiktionary-v2-full macbain-v2 bunamo-v2 place-v2 concept-v2 example-tatoeba-v2 example-gaois-v2 example-udt-v2 person-v2 note-v2 layer-v2)

INSTALL=0; LAUNCH=0; DEBUG=0; REZIP=1; RELEASE=0; DEVICE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install)  INSTALL=1 ;;
    --launch)   LAUNCH=1 ;;
    --debug)    DEBUG=1 ;;
    --release)  RELEASE=1 ;;
    --no-rezip) REZIP=0 ;;
    --device)   DEVICE="${2:?--device needs a serial}"; shift ;;
    -h|--help)  sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
adbc() { adb ${DEVICE:+-s "$DEVICE"} "$@"; }

# --- 1. Refresh bundled head zips from head dirs (flat, deflate, NO pagefind) ---
if [ $REZIP -eq 1 ]; then
  mkdir -p "$ROOT/data/bundle/heads"
  for h in "${HEADS[@]}"; do
    src="$ROOT/data/$h"; zip="$ROOT/data/bundle/heads/$h.zip"
    [ -f "$src/head.sqlite" ] || { echo "!! missing $src/head.sqlite - build the layer first" >&2; exit 1; }
    if [ ! -f "$zip" ] || [ "$src/head.sqlite" -nt "$zip" ] || [ "$src/graph.json" -nt "$zip" ]; then
      echo "[bundle] re-zipping $h"
      ( cd "$src" && rm -f "$zip" && zip -q -r -X "$zip" head.sqlite manifest.json graph.json chunks )
    else
      echo "[bundle] $h up to date"
    fi
  done
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
FEATURES="v2-emit,nav-server"
[ $RELEASE -eq 1 ] && FEATURES="v2-emit"
BUILD_ARGS=(--apk --features "$FEATURES" --target aarch64)
[ $DEBUG -eq 1 ] && BUILD_ARGS+=(--debug)
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
