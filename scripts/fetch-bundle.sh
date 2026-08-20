#!/usr/bin/env bash
#
# Fetch a pinned data bundle from greasan-data and reconstruct the local data/
# layout a full APK build expects. The inverse of scripts/publish-bundle.sh.
#
# Reads the pin from bundle-pin.json ({ "repo": ..., "tag": ... }) unless
# overridden. Used by app-release CI before scripts/build-apk.sh --release --duck.
#
# Asset -> destination:
#   <head>.zip              -> data/bundle/parquet-heads/<head>.zip
#   pf__<index>__<file>     -> data/<index>/<file>
#   basemap.pmtiles         -> app/src-tauri/basemap/goidelic.pmtiles
#   heads-versions.json     -> data/bundle/heads-versions.json (informational)
#
# Usage:
#   scripts/fetch-bundle.sh                       # use bundle-pin.json
#   scripts/fetch-bundle.sh --tag bundle-2026-08-20 --repo flaxandteal/greasan-data
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN="$ROOT/bundle-pin.json"
REPO=""; TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)  TAG="${2:?}"; shift ;;
    --repo) REPO="${2:?}"; shift ;;
    --pin)  PIN="${2:?}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$TAG" ] || [ -z "$REPO" ]; then
  [ -f "$PIN" ] || { echo "!! no pin file at $PIN and no --tag/--repo given" >&2; exit 1; }
  REPO="${REPO:-$(python3 -c "import json,sys;print(json.load(open('$PIN'))['repo'])")}"
  TAG="${TAG:-$(python3 -c "import json,sys;print(json.load(open('$PIN'))['tag'])")}"
fi
echo "[fetch] bundle $TAG from $REPO"

DL="$(mktemp -d)"; trap 'rm -rf "$DL"' EXIT
gh release download "$TAG" --repo "$REPO" --dir "$DL"

mkdir -p "$ROOT/data/bundle/parquet-heads"
placed=0
for f in "$DL"/*; do
  name="$(basename "$f")"
  case "$name" in
    heads-versions.json)
      cp -f "$f" "$ROOT/data/bundle/heads-versions.json" ;;
    basemap.pmtiles)
      mkdir -p "$ROOT/app/src-tauri/basemap"
      cp -f "$f" "$ROOT/app/src-tauri/basemap/goidelic.pmtiles" ;;
    pf__*)
      # pf__<index>__<file>  ->  data/<index>/<file>
      rest="${name#pf__}"; index="${rest%%__*}"; file="${rest#*__}"
      mkdir -p "$ROOT/data/$index"
      cp -f "$f" "$ROOT/data/$index/$file"; placed=$((placed+1)) ;;
    *.zip)
      cp -f "$f" "$ROOT/data/bundle/parquet-heads/$name"; placed=$((placed+1)) ;;
    *)
      echo "[fetch] ignoring unrecognised asset: $name" ;;
  esac
done
echo "[fetch] reconstructed $placed data files under data/ (+ manifest/basemap)"
echo "[fetch] ready for: scripts/build-apk.sh --release --duck"
