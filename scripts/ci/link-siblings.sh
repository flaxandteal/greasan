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
#
# Only alizarin is vendored as a submodule now: it is needed by BOTH the Rust side
# (alizarin-core path dep) AND the frontend (npm `alizarin` file: dep + the vite
# alias to magic/alizarin/js/main.ts), so a checkout is unavoidable. The other
# siblings no longer need a symlinked checkout:
#   - ros-madair-* and gramadan are Cargo `git` deps (resolved from GitHub by rev)
#   - pagefind + @alizarin/clm are hosted GitHub-release tarballs in package.json
#   - the combined ros-madair-alizarin wasm binary was retired (v2-duck read path)
declare -A LINKS=(
  [alizarin]="magic/alizarin"   # alizarin-core (Rust path dep) + alizarin npm/vite (frontend)
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
