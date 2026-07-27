#!/usr/bin/env bash
# Build a self-rendered, monochrome-ready vector basemap (PMTiles) for the map view.
#
# License: tiles are rendered from OpenStreetMap data — ODbL 1.0. The app MUST
# show "© OpenStreetMap contributors". Planetiler also pulls Natural Earth (public
# domain) and OSM water polygons (ODbL) for coastline/ocean.
#
# Output is a single .pmtiles file (OpenMapTiles schema) — bundled in the APK and
# read via a byte-range Tauri command (no tile server, stays offline).
#
# Region is staged: prove the pipeline on Ireland (small, low disk), then widen
# AREA to cover Scotland + Isle of Man (british-isles) once the integration works.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$REPO/.basemap-tools"          # gitignored: planetiler.jar + geofabrik cache
OUT_DIR="$REPO/app/src-tauri/basemap" # staged for APK bundling
OUT="$OUT_DIR/goidelic.pmtiles"

# Geofabrik area. Stage 1: ireland-and-northern-ireland. Stage 2: british-isles.
# maxzoom 13 — z12 was too sparse to name residential streets (OSM tags many
# only at z13-14). Measured footprint (Ireland): z12 ~38 MB, z13 ~114 MB. Costs
# more bundle but that is where street-level naming lives; revisit when AREA
# widens to british-isles (~2-3x → keep an eye on APK size).
AREA="${BASEMAP_AREA:-ireland-and-northern-ireland}"
MAXZOOM="${BASEMAP_MAXZOOM:-13}"
JAR="$TOOLS/planetiler.jar"
JAR_URL="https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar"

mkdir -p "$TOOLS" "$OUT_DIR"

if [ ! -f "$JAR" ]; then
  echo "[basemap] downloading planetiler.jar…"
  curl -fL --retry 3 -o "$JAR" "$JAR_URL"
fi

echo "[basemap] area=$AREA maxzoom=$MAXZOOM → $OUT"
echo "[basemap] free disk before: $(df -h "$REPO" | awk 'NR==2{print $4}')"

# --download fetches the geofabrik extract (cached under $TOOLS/data). Bounded RAM
# so it behaves on a modest machine. Output is PMTiles (inferred from extension).
java -Xmx3g -jar "$JAR" \
  --area="$AREA" \
  --maxzoom="$MAXZOOM" \
  --languages=en,ga,gd \
  --download \
  --download-dir="$TOOLS/data" \
  --tmpdir="$TOOLS/tmp" \
  --nodemap-type=sparsearray \
  --output="$OUT" \
  --force

echo "[basemap] done: $(du -h "$OUT" | cut -f1)  ($OUT)"
echo "[basemap] free disk after:  $(df -h "$REPO" | awk 'NR==2{print $4}')"
