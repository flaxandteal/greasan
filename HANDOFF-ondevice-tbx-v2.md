# Hand-off — migrate the on-device TBX generator to v2

For a **separate session.** Goal: the "Build from TBX" on-device layer install
(`builder_plugin.rs`, `format == "tbx"`) should emit a **v2 head** the app can
actually read, instead of a v1 `build_to_memory` index the v2 read path ignores.

**Decision locked (do not relitigate):** use the **temp-prebuild** approach —
write a prebuild dir on device, then call the existing file-based
`ros_madair_emit::emit`. Do **not** add an in-memory emit API: `ros-madair-emit`
lives in the read-only `magic/RosMadair-sandbox` and must not be touched. The
~480 MB temp prebuild (full Téarma) before the ~126 MB head is **accepted**.

---

## 0. Why this exists / what's already true

- The app reads entries only via v2: `loadEntryFlagged → loadEntryV2 → currentV2HeadDirs` (`dictionary.ts:588`). `USE_V2` is gone; the v1 `SparqlStore` read path is dead.
- `builder_plugin.rs` `format=="tbx"` is the on-device generator. It fetches the TBX, `tbx_parser::parse_tbx → records_to_csv` (now emits `grammar_class` — this session's fix), `build_resources_from_business_csv` → in-memory `graph` + `resources` + `collections`, then `build_to_memory` (`:486`) → **v1 index**. That index is registered via the v1 `addDynamicLayer → SparqlStore`, which the v2 read path never consults. So today an on-device-installed layer is *searchable but won't open*.
- **On-device Pagefind is already solved** — `build_pagefind_indices_sync` (`:835`) uses the Rust `pagefind::api::PagefindIndex` crate (no Node). Keep it as-is.
- The shipped app bundles v2 heads (`offline.rs` + `tauri.conf.json`); on-device TBX install is the *additional* path this migration makes real.

---

## 1. Rust — emit a v2 head (`app/src-tauri/src/builder_plugin.rs`, `tbx` path ~411–545)

Keep steps 1–3 unchanged (fetch → `parse_tbx` → `records_to_csv` → `build_resources_from_business_csv`; keep `uuid_namespace: TEARMA_UUID_NS` (`:462`) so composed slugs match bundled entries — compose over, don't duplicate).

Replace **step 4** (`build_to_memory`, `:486`) with:

1. **Write a temp prebuild dir** (e.g. under the layer output dir, `_prebuild/`). Mirror `scripts/build-tearma-layer.mjs:147–182`:
   - `graphs/resource_models/{LEXICAL_ENTRY_GRAPH_ID}.json` ← serialize the `StaticGraph` (serde; it round-trips from this JSON already).
   - `business_data/{graphId}.json` ← `{ "business_data": { "resources": [ …StaticResource… ] } }`.
   - `reference_data/collections/{cid}.json` (+ `.xml` SKOS) ← the `collections`.
   - `manifest.json` — copy the shape of an existing `data/prebuild-tearma/manifest.json`.
   The format is exactly what `parse_prebuild_archive` (same file) consumes and what the `regen-*-v2` examples read.
2. **Emit**: `ros_madair_emit::emit(temp_prebuild_dir, layer_out_dir, base_uri)` → `head.sqlite` + `chunks/` + `manifest.json`. See `app/src-tauri/examples/regen-tearma-v2.rs` for the exact call + the `graph.json` copy afterwards.
3. **Copy `graph.json`** beside the head (the head carries no schema).
4. **Delete the temp prebuild** to reclaim the ~480 MB.
5. **Keep the Pagefind step** (`build_pagefind_indices_sync`) writing `pagefind-{ga,en,sampla}` into the layer dir.

Result layout (per installed layer, in `app_data/layers/{name}/`): `head.sqlite`, `chunks/`, `manifest.json`, `graph.json`, `pagefind-*` — same shape as a bundled v2 layer.

The `"prebuild"` and `"built"` formats still call `build_to_memory` (`:562`) — v1. Leave them until the read side is v2-only (§3), then drop.

---

## 2. Frontend — register an installed v2 head at runtime + persist

Today `activeV2Layers` (`dictionary.ts:554`) is module-private, set only by `initOfflineLayers` (bundle). Add a runtime-append path:

1. **`addV2Layer({name, headDir, pagefindBase})`** in `dictionary.ts` — push onto `activeV2Layers` **and** `dynamicLayers` (so `currentV2HeadDirs`, `search`/`allPagefindBasesForLang`, `layerCoverage`, and the layer sheet all include it). Invalidate `dialectCache`.
2. **Persist** installed on-device layers (localStorage: `name` + native head path + pagefind base). Bundle layers stay implicit; only user-installed ones need persisting.
3. **Restore on launch**: in `bootstrapLayers` (`store.ts:344`), after `initOfflineLayers` + `registerV2Layers`, re-resolve each persisted installed layer's `app_data/layers/{name}/` via the dev/`tauri.localhost` protocols (`store.ts` `layerBaseUrl`/`layerPfBase`) and `addV2Layer` it. Offline requirement: an installed layer must survive relaunch.
4. **Wire Settings "Build from TBX"** (`Settings.svelte` → `store.ts`): after the builder returns the head dir, `addV2Layer` + persist + refresh the `layers` store. Replace the v1 `importLayer`/`installPackage` → `addDynamicLayer` path for the tbx case.
5. **Stack position**: append installed layers after the bundle layers (overlays); ensure the layer-visibility sheet toggles them.

---

## 3. Then the v1 cleanup falls out (the original ask)

Once installed layers read via v2, remove the genuinely-dead v1 machinery:
- **Read path**: `SparqlStore` import + `sparqlStore`/`withStoreMut`/`ensureStore`/`loadEntry`/`addDynamicLayer`/`removeDynamicLayer`/`restoreLayers`. **Keep** `dynamicLayers`, `registerV2Layers`, `getDynamicLayers`, `search` (v2 uses them).
- **v1 install formats**: the `"prebuild"`/`"built"` `build_to_memory` branches in `builder_plugin.rs`; `tauri-builder.ts` bits that are v1-only; `store.ts` `importLayer`/`installPackage`/`addLayerDirect`/`buildProgress` if fully replaced.
- **Keep** `tbx_parser.rs` (now the v2 generator's front end) and the prebuild-writing half of `build-*-layer.mjs`.

Do §3 as a *follow-up* to §1–§2, not before — the read side must be v2 first.

---

## 4. Guardrails
- Temp-prebuild only; never modify `magic/RosMadair-sandbox` (`ros-madair-emit`).
- Delete the temp prebuild after emit.
- Keep on-device Pagefind (`build_pagefind_indices_sync`).
- Reuse `TEARMA_UUID_NS` so on-device Téarma composes over bundled entries.
- Persist + restore installed layers (offline).

## 5. Verify
- On-device build Téarma from the TBX → `app_data/layers/tearma/{head.sqlite, chunks/, graph.json, manifest.json, pagefind-*}`.
- Search a term → tapping it **opens** the entry (proves `loadEntryV2` sees the head), with the declension (`grammar_class`) shown.
- Relaunch → the installed layer is still present and queryable.

## 6. Key files / APIs
| Thing | Location |
|---|---|
| On-device generator (tbx path) | `app/src-tauri/src/builder_plugin.rs:411–545` (`build_to_memory` at `:486`) |
| v2 emit call pattern | `app/src-tauri/examples/regen-tearma-v2.rs`; `ros_madair_emit::emit(dir,out,uri)` |
| Prebuild writer reference (JS) | `scripts/build-tearma-layer.mjs:147–182` |
| Prebuild format consumer | `parse_prebuild_archive` in `builder_plugin.rs` |
| On-device Pagefind | `build_pagefind_indices_sync` (`builder_plugin.rs:835`) |
| v2 layer set / read | `dictionary.ts` `activeV2Layers:554`, `currentV2HeadDirs:588`, `registerV2Layers`, `initOfflineLayers` |
| Bootstrap / restore | `store.ts` `bootstrapLayers:344`, `layerBaseUrl`/`layerPfBase` |
| Install UI | `Settings.svelte` (`importLayer`/`installPackage`), `store.ts` |
