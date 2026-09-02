#!/usr/bin/env bash
# Reconstruct the sibling-repo directory layout that Cargo/npm path deps expect.
#
# Locally the app references sibling repos by relative path that climb ABOVE the
# repo root (e.g. `../../../magic/RosMadair` from app/src-tauri). In CI those
# siblings are vendored as git submodules under `.deps/` INSIDE the checkout, so
# we symlink each submodule to the out-of-tree path the manifests demand.
#
# All targets resolve to $(dirname "$GITHUB_WORKSPACE")/<...>:
#   Cargo (from app/src-tauri):  ../../../X  -> $WS/../X
#   npm   (from app):            ../../X     -> $WS/../X
#
# Idempotent. Run after `git submodule update --init --recursive`.
set -euo pipefail

WS="${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}"
PARENT="$(dirname "$WS")"

# submodule-under-.deps  ->  path relative to $PARENT.
# These MUST match the out-of-tree path deps in app/src-tauri/Cargo.toml and
# app/package.json (verify with: grep -E 'path *= *"\.\.' app/src-tauri/Cargo.toml).
declare -A LINKS=(
  [RosMadair-sandbox-parquet]="magic/RosMadair-sandbox-parquet"  # ros-madair-{read,format,handlers,query,emit,duck}
  [alizarin-sandbox]="magic/alizarin-sandbox"               # alizarin-core + alizarin npm pkg
  [malazan-experiment]="svg/malazan-experiment"             # patched pagefind fork
  [Gramadan]="Gramadan"                                     # philtweir/Gramadan (gramadan-rs)
)

for sub in "${!LINKS[@]}"; do
  src="$WS/.deps/$sub"
  dst="$PARENT/${LINKS[$sub]}"
  if [[ ! -d "$src" ]]; then
    echo "ERROR: submodule missing: $src (did submodule init run?)" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  # Replace any stale link/dir, then point it at the submodule.
  rm -rf "$dst"
  ln -s "$src" "$dst"
  echo "linked $dst -> $src"
done

echo "Sibling layout reconstructed under $PARENT"
