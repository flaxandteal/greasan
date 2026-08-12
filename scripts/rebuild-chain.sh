#!/usr/bin/env bash
# One-shot rebuild chain: pipeline (no Wiktionary forms) → wiktionary package →
# bundled wiktionary head → catalogue → APK → install. Kicked off after the
# noun-grid + forms-drop + layer-consolidation + licence changes this session.
# NOT --no-rezip: wiktionary-v2-full + layer-v2 heads change and must re-zip.
set -euo pipefail
cd /home/philtweir/Cód/Oscailte/Gréasán
export ANDROID_NDK_HOME="$HOME/Android/Sdk/ndk/27.0.12077973"

step() { echo; echo "========== $* =========="; date '+%H:%M:%S'; }

step "STEP 1/6: pipeline (skip examples stage; drops Wiktionary forms)"
# Temp config in the repo root so relative paths (base = config dir) still resolve.
TMP="config.chain-tmp.toml"
cp -f config.toml "$TMP"
sed -i 's/^stages = .*/stages = ["filter", "normalise", "ontolex", "arches"]/' "$TMP"
uv run python -m goidelic.run --config "$TMP"
rm -f "$TMP"

step "STEP 2/6: build wiktionary package (writes data/prebuild-wiktionary, no forms)"
node scripts/build-wiktionary-layer.mjs

step "STEP 3/6: regen bundled wiktionary-v2-full head from the prebuild"
cargo run --release --example regen-layer-v2 --features v2-emit \
  --manifest-path app/src-tauri/Cargo.toml -- \
  data/prebuild-wiktionary data/wiktionary-v2-full

step "STEP 4/6: build layer catalogue head (Téarma licence + install config)"
node scripts/build-layer-catalogue.mjs

step "STEP 5/6: build + sign APK (re-zip changed heads; bundle gramadan wasm)"
scripts/build-apk.sh

step "STEP 6/6: install (adb install -r preserves app data / on-device Téarma)"
adb install -r data/bundle/greasan-signed.apk

step "CHAIN DONE"
