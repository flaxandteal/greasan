# Rebuilding the corpus from scratch

_How to rebuild every bundled head from source on a clean machine, using the
published deps (alizarin a146 / ros-madair alpha.34). Written 2026-11-16 after
de-rotting the layer build scripts._

## Prerequisites

- **Sibling checkout**: `../Gramadan` (the morphology engine; `gramadan-py` /
  `gramadan-rs` are `path` deps in `pyproject.toml`). No other siblings — the Rust
  (`alizarin-core` a146, `ros-madair-*` alpha.34) and npm (`@alizarin/*` a146)
  deps resolve from crates.io / GitHub-release tarballs.
- **Raw source data** (gitignored, fetched separately): `data/raw/` (kaikki
  Wiktionary dumps, `logainm-{names,places,parents}.jsonl`), `data/bunamo-src/`
  (BuNaMo XML DB), the Téarma TBX.
- **Toolchains**: `uv` (Python), Node, Rust/cargo, Android SDK+NDK (for the APK).

## Install deps

```bash
uv sync                      # Python + gramadan-py (../Gramadan)
cd app && npm install        # fetches the a146 alizarin tarballs + the pagefind fork
cargo fetch --manifest-path app/src-tauri/Cargo.toml   # a146 / alpha.34 from crates.io
```

## 1. Pipeline — raw source → processed CSVs (`data/processed/`)

```bash
uv run python -m goidelic.run --config config.toml   # wiktionary + tearma CSVs
uv run python scripts/build-bunamo-data.py           # bunamo_lexical_entry_data.csv
```

(The processed CSVs are gitignored, so a true from-scratch run regenerates them
here. `build-bunamo-data.py` is deterministic — a re-run reproduces the same CSV.)

## 2. Layer builds — CSVs → prebuilds (+ pagefind)

Each writes `data/prebuild-<layer>/` and its pagefind indices. They read the
processed CSVs / raw data; order is independent except `build-layer-catalogue`
(last, reads the emitted heads).

```bash
node scripts/build-wiktionary-layer.mjs
node scripts/build-macbain-layer.mjs            # also mints the headword concepts
node scripts/build-bunamo-layer.mjs             # add --skip-data to reuse the CSV
node scripts/build-gramadan-forms-layer.mjs     # add --skip-data to reuse the CSV
node scripts/build-place-layer.mjs              # place + concept-v2 (reads data/raw logainm)
node scripts/build-external-example-layer.mjs tatoeba
node scripts/build-external-example-layer.mjs gaois
node scripts/build-external-example-layer.mjs udt
node scripts/build-flag-layers.mjs              # person + note
```

## 3. Emit heads → `data/bundle/parquet-heads/`

```bash
node scripts/build-parquet-layers.mjs \
  wiktionary-v2-full macbain-v2 bunamo-v2 gramadan-forms-v2 place-v2 concept-v2 \
  example-tatoeba-v2 example-gaois-v2 example-udt-v2 person-v2 note-v2
node scripts/build-layer-catalogue.mjs          # reads the heads -> prebuild-layer
node scripts/build-parquet-layers.mjs layer-v2  # emit the catalogue head
```

## 4. APK + publish

```bash
export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/<ver>
scripts/build-apk.sh --release                  # embeds the local parquet-heads
scripts/publish-bundle.sh --tag bundle-<YYYY-MM-DD>   # -> greasan-data; then re-pin bundle-pin.json
```

## What was de-rotted to make this work (2026-11-16)

These scripts hadn't been run end-to-end since the sqlite-engine / v2-emit removal:

- **`regen-layer-v2 --features v2-emit` → `regen-parquet-v2`** in
  `build-{external-example,gramadan-forms,logainm,place}-layer.mjs`. `v2-emit` is a
  removed cargo feature; `regen-parquet-v2` is the emitter the bundle actually uses.
- **`scripts/lib/pagefind-fork.mjs`**: tolerate an empty index (write an empty
  `catalogue.json` instead of throwing). Some scripts create a per-language index
  and add records to only one of them.
- **Gramadan sibling** (committed in `../Gramadan`): removed a stale circular
  symlink `Python/gramadan/gramadan` that broke `uv sync`; fixed
  `Verb.create_from_xml` to accept/forward `keep_doc` (the v2 DB loader passes it).

## Known rough edges (not blockers)

- `build-logainm` / `build-place` are slow (minutes — logainm matching + pagefind).
- There is no single all-layers orchestrator; `rebuild-chain.sh` only refreshes
  wiktionary. The steps above are the full chain.
- `bunamo-v2` and `logainm-v2` are build inputs, not shipped heads (absent from
  `tauri.full.conf.json` / the publish set).
