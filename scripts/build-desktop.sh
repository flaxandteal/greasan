#!/usr/bin/env bash
#
# Build the Gréasán Linux DESKTOP app (core-only: graph/collection schema is
# embedded in the binary, NO bundled corpus). The user installs it and loads
# their OWN Téarma TBX, which builds on-device (tbx-v2 -> FTS5 + Parquet) -
# nothing leaves the machine. This is the desktop analogue of `build-apk.sh --base`.
#
# Usage:
#   scripts/build-desktop.sh                 # .deb + .AppImage, no nav-server
#   scripts/build-desktop.sh --bundles deb   # just the .deb (skip AppImage tooling)
#   scripts/build-desktop.sh --debug         # unoptimised debug build
#   scripts/build-desktop.sh --nav-server    # LOCAL DEBUG ONLY: include nav-server
#                                            #   (unauthenticated localhost port -
#                                            #   NEVER distribute such a build)
#
# Reuses the exact native src-tauri backend the APK runs. The DuckDB+Parquet read
# stack + tbx-v2 on-device build are compiled natively for the host; there are no
# read-path features to pass. Artifacts are copied to data/bundle/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BUNDLES="deb,appimage"; NAVSERVER=0; DEBUG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bundles)    BUNDLES="${2:?--bundles needs a list}"; shift ;;
    --nav-server) NAVSERVER=1 ;;
    --debug)      DEBUG=1 ;;
    -h|--help)    sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# --- 1. Core-only bundle inputs (no heads) ---
# offline.rs re-extracts any bundled heads into app_data on first run; core-only
# ships none, so the app boots to empty state and the user installs Téarma from
# their own TBX. heads-versions.json is a bundled resource, so it must exist.
mkdir -p "$ROOT/data/bundle"
printf '{}' > "$ROOT/data/bundle/heads-versions.json"
echo "[bundle] core-only: empty heads-versions.json (no bundled corpus)"

# Basemap is a bundled resource; guarantee the file exists so resource bundling
# succeeds. Real tiles come from scripts/build-basemap.sh; a 0-byte placeholder
# keeps the build green (basemap_available() reports false, map falls back).
BASEMAP="$ROOT/app/src-tauri/basemap/goidelic.pmtiles"
if [ ! -s "$BASEMAP" ]; then
  echo "[bundle] basemap absent - placeholder (run scripts/build-basemap.sh for real tiles)"
  mkdir -p "$(dirname "$BASEMAP")"; : > "$BASEMAP"
else
  echo "[bundle] basemap: $(du -h "$BASEMAP" | cut -f1)"
fi

# Tauri stages bundle.resources into target/<profile>/ but never removes files
# that dropped out of the config, so heads/ + pagefind/ left by a prior FULL build
# would be picked up and extracted by a bare-binary run (misleading a core-only
# test; the .deb itself only bundles what the config lists). Clear them so
# core-only really is core-only.
for p in release debug; do
  rm -rf "$ROOT/app/src-tauri/target/$p/heads" "$ROOT/app/src-tauri/target/$p/pagefind" 2>/dev/null || true
done

# --- 2. Build (beforeBuildCommand runs the vite frontend build) ---
# nav-server is a debug-only unauthenticated localhost control port - NEVER
# distribute a build that includes it. Default cargo features omit it.
BUILD_ARGS=(--bundles "$BUNDLES")
[ $DEBUG -eq 1 ] && BUILD_ARGS+=(--debug)
if [ $NAVSERVER -eq 1 ]; then
  echo "[desktop] !! nav-server INCLUDED - local debug only, DO NOT distribute"
  BUILD_ARGS+=(--features nav-server)
fi
echo "[desktop] tauri build ${BUILD_ARGS[*]}"
( cd "$ROOT/app" && npx tauri build "${BUILD_ARGS[@]}" )

# --- 3. Locate + collect artifacts ---
PROFILE=release; [ $DEBUG -eq 1 ] && PROFILE=debug
BUNDLE_DIR="$ROOT/app/src-tauri/target/$PROFILE/bundle"
OUT="$ROOT/data/bundle"
shopt -s nullglob
copied=0
for f in "$BUNDLE_DIR"/deb/*.deb "$BUNDLE_DIR"/appimage/*.AppImage; do
  cp -f "$f" "$OUT/"
  echo "[desktop] $(basename "$f") ($(du -h "$f" | cut -f1)) -> data/bundle/"
  copied=$((copied+1))
done
[ $copied -gt 0 ] || { echo "!! no desktop artifacts under $BUNDLE_DIR - check the tauri build output" >&2; exit 1; }

# Tauri derives the .deb `Package:` field from productName ("Gréasán"), lowercased
# but NOT transliterated -> "gréasán", which dpkg rejects (package names must be
# ASCII: a-z0-9-+._). The display name stays "Gréasán"; only the control Package
# field + filename need sanitising. Repack each .deb with Package: greasan.
for deb in "$OUT"/*.deb; do
  [ -e "$deb" ] || continue
  [ "$(dpkg-deb -f "$deb" Package)" = "greasan" ] && continue
  tmp="$(mktemp -d)"
  dpkg-deb -R "$deb" "$tmp"
  sed -i 's/^Package: .*/Package: greasan/' "$tmp/DEBIAN/control"
  ver="$(dpkg-deb -f "$deb" Version)"; arch="$(dpkg-deb -f "$deb" Architecture)"
  ascii="$OUT/greasan_${ver}_${arch}.deb"
  dpkg-deb --root-owner-group --build "$tmp" "$ascii" >/dev/null
  rm -rf "$tmp"
  [ "$ascii" != "$deb" ] && rm -f "$deb"
  echo "[desktop] sanitised deb Package -> greasan ($(basename "$ascii"))"
done
echo "[done]"
