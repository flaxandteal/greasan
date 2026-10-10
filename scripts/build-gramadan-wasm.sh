#!/usr/bin/env bash
#
# Build the gramadan-wasm binding into app/src/lib/gramadan-pkg/. The generated
# binding is now VENDORED (committed) so CI + a fresh checkout need neither the
# Gramadan repo nor wasm-pack; this script only regenerates it when gramadan-wasm
# changes. The entry view imports the generated `gramadan.js` for noun paradigms.
#
# Crate: ../Gramadan/gramadan-wasm  (see gramadan-rs/HANDOFF-verb-adjective-paradigms.md
# for the verb/adjective work that lights up the stubbed branches).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Gramadan sits beside Gréasán inside Oscailte (Cód/Oscailte/Gramadan).
CRATE="$ROOT/../Gramadan/gramadan-wasm"
OUT="$ROOT/app/src/lib/gramadan-pkg"

wasm-pack build "$CRATE" --target web --out-dir "$OUT" --out-name gramadan --release
# wasm-pack drops a `.gitignore` (`*`) in the out-dir; remove it so the vendored
# binding stays trackable (CI builds from the committed pkg, not from Gramadan).
rm -f "$OUT/.gitignore"
echo "[gramadan] built → $OUT"
