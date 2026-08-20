#!/usr/bin/env bash
#
# Publish the pre-built data bundle as a versioned release on the greasan-data
# repo, so app builds can fetch a pinned corpus instead of regenerating ~1 GB of
# data on every build.
#
# The heads/pagefind/basemap are built separately (build-parquet-layers.mjs,
# build-*-layer.mjs, build-basemap.sh); this script only packages + uploads what
# already exists on disk. A bundle carries everything a FULL APK needs:
#
#   <head>.zip                       11 parquet heads  -> data/bundle/parquet-heads/<head>.zip
#   pf__<index>__<file>.zip          10 pagefind zips  -> data/<index>/<file>
#   basemap.pmtiles                  map tiles         -> app/src-tauri/basemap/goidelic.pmtiles
#   heads-versions.json              manifest { head: snapshot_id }
#
# The pagefind + basemap set is derived from tauri.full.conf.json, so this stays
# in sync with what the full build actually bundles. Each item is its own asset,
# so a corpus refresh re-uploads only what changed. scripts/fetch-bundle.sh is
# the inverse (used by app-release CI).
#
# Usage:
#   scripts/publish-bundle.sh                     # tag bundle-<YYYY-MM-DD>, publish
#   scripts/publish-bundle.sh --tag bundle-v3     # explicit tag
#   scripts/publish-bundle.sh --dry-run           # show what would happen, upload nothing
#   scripts/publish-bundle.sh --repo owner/name   # override target repo
#
# Requires: gh authenticated with contents:write on the target repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="flaxandteal/greasan-data"
# Heads that make up a bundle. Tearma is deliberately excluded (local-only,
# licensing) and never enters a published bundle. Keep in sync with build-apk.sh.
HEADS=(wiktionary-v2-full macbain-v2 gramadan-forms-v2 place-v2 concept-v2 example-tatoeba-v2 example-gaois-v2 example-udt-v2 person-v2 note-v2 layer-v2)

TAG=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)     TAG="${2:?--tag needs a value}"; shift ;;
    --repo)    REPO="${2:?--repo needs a value}"; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
# date is fine in a shell script (unlike a workflow JS runtime).
[ -n "$TAG" ] || TAG="bundle-$(date -u +%Y-%m-%d)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- Stage every asset + build the manifest from each head's snapshot_id ---
echo "[bundle] staging $TAG"
python3 - "$ROOT" "$STAGE" "${HEADS[@]}" <<'PY'
import json, pathlib, sys, shutil, subprocess
root = pathlib.Path(sys.argv[1]); stage = pathlib.Path(sys.argv[2]); heads = sys.argv[3:]
missing = []

# 1. Heads (parquet) + manifest, from data/bundle/parquet-heads/.
src = root / "data" / "bundle" / "parquet-heads"
vers = {}
for h in heads:
    zp = src / f"{h}.zip"
    if not zp.exists():
        missing.append(str(zp)); continue
    shutil.copy2(zp, stage / f"{h}.zip")
    raw = subprocess.run(["unzip", "-p", str(zp), "manifest.json"],
                         capture_output=True, text=True).stdout
    if raw.strip():
        vers[h] = json.loads(raw).get("snapshot_id", "")

# 2. Pagefind + basemap, derived from tauri.full.conf.json so we stage exactly
#    what a full build bundles. pagefind -> pf__<index>__<file>; basemap flat.
cfg = json.loads((root / "app" / "src-tauri" / "tauri.full.conf.json").read_text())
for rel, dest in cfg["bundle"]["resources"].items():
    p = (root / "app" / "src-tauri" / rel).resolve()
    if dest.startswith("pagefind/"):
        # dest = pagefind/<index>/<file>; source path mirrors data/<index>/<file>
        parts = dest.split("/", 1)[1]                 # <index>/<file>
        asset = "pf__" + parts.replace("/", "__")
        (stage / asset).write_bytes(p.read_bytes()) if p.exists() else missing.append(str(p))
    elif dest.startswith("basemap/"):
        if p.exists() and p.stat().st_size > 0:
            shutil.copy2(p, stage / "basemap.pmtiles")
        else:
            print(f"[bundle] basemap absent/placeholder at {p} - NOT bundling", file=sys.stderr)

if missing:
    print("!! missing bundle inputs (build the layers first):", file=sys.stderr)
    for m in missing: print("   " + m, file=sys.stderr)
    sys.exit(1)

(stage / "heads-versions.json").write_text(json.dumps(vers, indent=2))
print(f"[bundle] staged {len(heads)} heads + pagefind + basemap; manifest written")
PY

echo "[bundle] assets:"
( cd "$STAGE" && ls -la )

# --- Publish ---
NOTES="Pre-built open-data bundle for Gréasán (CC BY-SA 4.0).

Everything a full APK needs: 11 parquet heads, pagefind indices (pf__*), basemap
tiles, and heads-versions.json (head -> snapshot_id). Consumed by app-release CI
via a pinned tag (see bundle-pin.json). Tearma is not included (local-only)."

if [ $DRY -eq 1 ]; then
  echo "[dry-run] would: gh release create $TAG --repo $REPO --prerelease"
  echo "[dry-run] assets: $(cd "$STAGE" && ls | tr '\n' ' ')"
  exit 0
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "[bundle] $TAG exists; uploading assets (clobber)"
  gh release upload "$TAG" --repo "$REPO" --clobber "$STAGE"/*
else
  gh release create "$TAG" --repo "$REPO" --prerelease \
    --title "Gréasán data bundle $TAG" --notes "$NOTES" "$STAGE"/*
fi
echo "[bundle] published: https://github.com/$REPO/releases/tag/$TAG"
echo "[bundle] pin it for app releases by setting this tag in bundle-pin.json"
