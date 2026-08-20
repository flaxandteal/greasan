#!/usr/bin/env bash
#
# Publish the pre-built parquet head bundles as a versioned release on the
# greasan-data repo, so app builds can fetch a pinned corpus instead of
# regenerating ~1 GB of data on every build.
#
# The heads themselves are built separately (scripts/build-parquet-layers.mjs);
# this script only packages + uploads what already exists in
# data/bundle/parquet-heads/. Each head is its own release asset, plus a
# heads-versions.json manifest ({ head: snapshot_id }) so a later refresh can
# re-upload only the heads that changed.
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
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
# date is fine in a shell script (unlike a workflow JS runtime).
[ -n "$TAG" ] || TAG="bundle-$(date -u +%Y-%m-%d)"

SRC="$ROOT/data/bundle/parquet-heads"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- 1. Collect the heads + build the manifest from each head's snapshot_id ---
echo "[bundle] staging heads for $TAG"
python3 - "$SRC" "$STAGE" "${HEADS[@]}" <<'PY'
import json, pathlib, sys, shutil, subprocess
src = pathlib.Path(sys.argv[1]); stage = pathlib.Path(sys.argv[2]); heads = sys.argv[3:]
vers = {}
missing = []
for h in heads:
    zp = src / f"{h}.zip"
    if not zp.exists():
        missing.append(h); continue
    shutil.copy2(zp, stage / f"{h}.zip")
    raw = subprocess.run(["unzip", "-p", str(zp), "manifest.json"],
                         capture_output=True, text=True).stdout
    if raw.strip():
        vers[h] = json.loads(raw).get("snapshot_id", "")
if missing:
    print("!! missing heads (run build-parquet-layers.mjs first): " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
(stage / "heads-versions.json").write_text(json.dumps(vers, indent=2))
print(f"[bundle] {len(vers)} heads staged; manifest written")
PY

echo "[bundle] assets:"
ls -la "$STAGE"

# --- 2. Publish ---
NOTES="Pre-built open-data layer bundle for Gréasán (CC BY-SA 4.0).

Per-head parquet zips + heads-versions.json (head -> snapshot_id). Consumed by
the app-release CI via a pinned tag. Tearma is not included (local-only)."

if [ $DRY -eq 1 ]; then
  echo "[dry-run] would: gh release create $TAG --repo $REPO --prerelease --title 'Gréasán data bundle $TAG'"
  echo "[dry-run] would upload: $(ls "$STAGE" | tr '\n' ' ')"
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
echo "[bundle] pin it for app releases by setting this tag in data/bundle-pin.json"
