# HANDOFF — Layer-skeleton catalogue

Status: **DONE + verified end-to-end on a core-only `.deb` (branch `layer-skeleton-catalogue`). Only Phase-2 (per-package Layer resource + layered catalogue read) remains — a refinement, not a blocker.**
Round-trip proven: a core-only build ships the 24 KB skeleton `layer-v2`; the Layer Manager shows "YOUR LAYERS · 0" + the 6 installable layers from the catalogue; installing MacBain downloads its greasan-data `<head>.zip`, extracts, validates, registers as v2, and moves into "YOUR LAYERS". Four install bugs were fixed to get there (all on the `built` path, each hidden behind the previous):
1. `extract_built_archive_sync` only did tar.gz → sniff `PK`, extract zip (greasan-data heads are zip).
2. `DOWNLOADABLE_SLUGS` offered wiktionary/bunamo/place (not assets on the pinned bundle → 404) → restricted to the 6 present: macbain, gramadan-forms, concept, example-{tatoeba,gaois,udt}.
3. post-extract check required v1 `summary.bin` → validate `has_parquet_tiles` (v2).
4. `installPackage` finalized via v1 `addDynamicLayer` (hangs on a v2 head) → `addV2Layer`.

PREVIOUS status:
The `offline.rs` presence gate (`resolved_layers` → `head_has_tiles`, + `v2_prepare_offline` reorder so un-bundled heads leave no empty dir) was the linchpin: `layerStack` now reflects only truly-installed layers, so the frontend's EXISTING "Add a layer · From catalogue" suggestions (catalogue entries with an `install` block, minus installed) + empty-state render the known/available layers with Install buttons — **no frontend change needed**. offline.rs compiles clean. NOT yet run on a base APK/desktop build + device (the only verification left for this slice).

ORIGINAL (pre-§3) status: The §4 fork is RESOLVED — (a) vendored: `app/src-tauri/skeleton/layer-v2.zip` is committed (24 KB, built from `--skeleton`), base `tauri.conf.json` lists `heads/layer-v2.zip`, and `build-apk.sh --base` / `build-desktop.sh` stage the skeleton there. The emit fix (`regen-parquet-v2`) is now runtime-verified (skeleton head built OK). So a core-only build now SHIPS the skeleton `layer-v2` head; what's left is the app reading it as "known/available" rather than "installed-but-empty" (§3), none of which is bundle-verified yet (needs a base APK/desktop build + on-device run).

## Goal (user's framing)
Each **Layer resource instance** (in the `layer-v2` catalogue graph) is prepopulated
with a **skeleton set of tiles** shipped in the core/base build — metadata only
(name, swatch, licensing, links=UPSTREAM source, integration/download=DOWNSTREAM
greasan-data URL), NOT the corpus it points at. When a known layer is installed,
its package brings its **own fuller Layer-definition resource** (same `layer-<slug>`
ResourceID); the store's cross-layer tile merge (`hydrate_layers`, topmost-wins per
nodegroup) **overrides+supplements** the baked-in skeleton automatically.

Fixes the symptom: a core-only build (desktop `.deb` / `--base` APK) currently shows
every CORPORA head as "installed-but-empty" with amber "unverified" shields, and
offers no way to install them (wiktionary/macbain were marked "bundled, no install"
— only true in the full APK).

## 1. DONE — build side (committed on `layer-skeleton-catalogue`)
- `7436d53` refactor: `scripts/lib/layers-data.mjs` is the single source of truth
  (`LAYERS`, `CSV_COLUMNS`, `buildBusinessCsv`, `uuidv5`, `csvEscape`). Behaviour-preserving.
- `90baafc` fix: `build-layer-catalogue.mjs` emits via `regen-parquet-v2` (the
  `regen-layer-v2 --features v2-emit` it used was removed in the DuckDB cutover —
  it was broken). **NOT runtime-verified** (needs NAPI + cargo emit).
- `6aa1217` feat: greasan-data download URLs baked into the Layer resources.
  `greasanDataAssetUrl(head,tag)` → `…/flaxandteal/greasan-data/releases/download/<tag>/<head>.zip`,
  tag from `bundle-pin.json` (`bundle-2026-08-20`). `install:{name,url,format:'built'}`
  + a download row. `DOWNLOADABLE_SLUGS` = wiktionary, macbain, bunamo, gramadan-forms,
  place, example-{tatoeba,gaois,udt}, concept. Excludes tearma (file-picker), person/note
  (internal), basemap (own PMTiles). Verified: URLs present iff downloadable.
- `bae70ac` feat: `build-layer-catalogue.mjs --skeleton` → empty resource_count (no
  built heads), everything else identical. This is the core/base skeleton build.

## 2. Bundling mechanism (mapped)
- Base `app/src-tauri/tauri.conf.json` resources = `heads-versions.json` + `basemap` ONLY.
- Full build overlays `app/src-tauri/tauri.full.conf.json` (deep-merged) → adds the 11
  `heads/<head>.zip` + pagefind. Selected by `build-apk.sh:125` (`--config` iff not `--base`).
- Heads staged at `data/bundle/heads/<head>.zip` (copied from `data/bundle/parquet-heads/<head>.zip`).
  `HEADS` in build-apk.sh **includes `layer-v2`** → the FULL build already bundles the full catalogue.
- `offline.rs` reads `heads/<head>.zip` from `resource_dir()`, unpacks to `<app_data>/heads/<head>/`.
- Base build (`--base`): empty heads-versions.json, **no heads staged** → `loadLayerCatalogue`
  returns `[]` (catalogue head absent). That's the gap.

## 3. REMAINING — integration (NOT started; none script-verifiable, needs full build)
- **(2c) Bundle the skeleton always.** Base `tauri.conf.json` must list `heads/layer-v2.zip`,
  and the base pipeline must stage a skeleton `data/bundle/heads/layer-v2.zip`
  (from `build-layer-catalogue.mjs --skeleton` → `data/layer-v2` → zip). See §4 fork.
- **(Step 3) Classify.** `offline.rs:resolved_layers` (maps every CORPORA entry to an
  active layer presence-blind, `:259-272`) must gate on real head presence. Frontend
  `registerV2Layers`/`getDynamicLayers`/`layerStack` (dictionary.ts ~934-943 / store.ts
  ~250-275): known-skeleton (from the catalogue, "available to install", uses the download
  URL) vs installed-with-tiles; "N ON" counts installed only.
- **Shields.** The amber shield is `v2_verify_layer` probing `layers/<name>/` while bundled
  heads live at `heads/<head>/` → `unverified` (v2.rs:793-844). Known/skeleton-only rows
  shouldn't carry it.
- **(Phase 2) Layered catalogue read.** `loadLayerCatalogue` (app/src/lib/layers-catalogue.ts
  :121-135) uses single-head `queryV2`/`hydrateV2`. Make it union Layer ids across all
  catalogue-carrying heads + hydrate via `hydrateLayers` (installed topmost) so an installed
  layer's own Layer resource overrides+supplements the skeleton. Resource-URI identity:
  the package's Layer resource MUST mint the same `layer-<slug>` ResourceID (default alizarin
  namespace) — only tile ids use the per-layer namespace.
- **(Phase 2) Packages carry their own Layer resource.** `build-*-layer.mjs` emit a
  `layer-<slug>` Layer resource; `builder_plugin.rs` registers those tiles on install.

## 4. THE FORK (blocks 2c) — how to produce the skeleton `layer-v2.zip` for base builds
- **(a) Vendor it (recommended).** Build the skeleton zip once, commit
  `data/bundle/heads/layer-v2.zip` (like the vendored `gramadan-pkg`). Base CI bundles the
  committed file — no NAPI/cargo added to the base pipeline (which deliberately avoids heavy
  steps). Goes stale when `LAYERS` changes → a `rebuild-skeleton` note + the `--skeleton`
  flag handle regen.
- **(b) Build it in base CI.** Base pipeline runs `build-layer-catalogue.mjs --skeleton`
  (+ zip). Always fresh, but adds NAPI + `cargo run regen-parquet-v2` to `app-smoke`/
  `app-desktop` — heavier base CI.

## Resume checklist
1. `git -C ~/Cód/Oscailte/Gréasán log --oneline v2-duckdb-substrate..layer-skeleton-catalogue` (the 4 commits).
2. Pick §4 fork. If (a): run `node scripts/build-layer-catalogue.mjs --skeleton` (needs NAPI
   + the app built once), zip `data/layer-v2` → `data/bundle/heads/layer-v2.zip`, commit it.
3. Add `"../../data/bundle/heads/layer-v2.zip": "heads/layer-v2.zip"` to base `tauri.conf.json`
   resources. Ensure `tauri.full.conf.json` still bundles the FULL layer-v2 (same path, staged file differs).
4. §3 classify + layered read + shields. Verify on a `--base` APK / desktop `.deb` + on-device:
   core-only shows layers as "available to install" (with sources + a working download), not
   "installed-but-empty + amber".
