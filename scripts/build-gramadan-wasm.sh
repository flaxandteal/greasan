#!/usr/bin/env bash
#
# Build the gramadan-wasm binding into app/src/lib/gramadan-pkg/ (gitignored, like
# RosMadair's pkg-alizarin). Run once on a fresh checkout before `npm run build` -
# the entry view imports the generated `gramadan.js` to produce noun paradigms.
#
# Crate: ../Gramadan/gramadan-wasm  (see gramadan-rs/HANDOFF-verb-adjective-paradigms.md
# for the verb/adjective work that lights up the stubbed branches).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Gramadan sits beside Gréasán inside Oscailte (Cód/Oscailte/Gramadan).
CRATE="$ROOT/../Gramadan/gramadan-wasm"
OUT="$ROOT/app/src/lib/gramadan-pkg"

wasm-pack build "$CRATE" --target web --out-dir "$OUT" --out-name gramadan --release
echo "[gramadan] built → $OUT"
