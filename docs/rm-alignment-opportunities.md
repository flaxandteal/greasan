# Gréasán ↔ Rós Madair alignment: UX, code-quality, and reduce-custom-logic opportunities

_As of 2026-10-29. Grounded in three audits: the Svelte frontend (`app/src`), the Tauri Rust backend (`app/src-tauri/src`), and the Rós Madair public API surface (alpha.21→alpha.32, `FORMAT_VERSION 5`)._

The recurring theme: a lot of the app's custom logic predates RM features that now do the same job natively. Two of the newest features — `render_fields` (alpha.32) and the untyped `Backlink` query (alpha.23) — are already paid for (you absorbed the 4-tuple break; the reverse edge index co-emits) but unused, and both have direct user-visible payoff.

Each opportunity is tagged: **[value]** user-visible, **[reduce]** deletes custom logic, **[quality]** correctness/risk, **[upstream]** needs an RM change.

---

## Tier 1 — clear wins, low effort, high confidence

### 1.1 Emit POS/dialect as `render_fields` → delete the facet re-hydrate  **[reduce][value]** — 🟡 HALF-UNBLOCKED (alpha.33; needs a34)
> alpha.33 gave the non-geo render row — `render_summaries` now returns `5/5` for a dictionary head (was `0/5`), and `render_fields` populate. **But the values are concept value-IDs, not labels** (`{"dialect":"a0805fe2-…"}`): `build_render_fields` reads the raw tile value at emit without catalog resolution, unlike `descriptor` which is a real label. So reading `render_fields` for the facet would still need a UUID→label pass — no win over the existing `v2_concept_values` (which returns labels directly). Needs the a34 follow-up in `HANDOFF-rosmadair-nonspatial-render-row.md` (resolve `render_fields` to labels at emit); until then `v2_concept_values` stays and the frontend does **not** read `render_fields`.
`render_summaries` returns a 4-tuple `(descriptor, geo_descriptor, render_summary, render_fields)` since alpha.32 (`ros-madair-duck/src/lib.rs:589-623`). `render_fields` is a `{alias: display_value}` JSON of domain-declared promoted node values, emitted via `ClusterConfig.render_fields` / `ROS_MADAIR_RENDER_FIELDS` (`ros-madair-emit/src/parquet.rs:1436`).

Today the FTS sidecar carries no POS/dialect, so `dictionary.ts:507-537` fires a per-query `conceptValues(ftsDirs, uris, ['part_of_speech','dialect'])` to re-attach facets, backed by `v2_concept_values` (`v2.rs:867-942`) — a hand-built SQL string that globs `concepts_*.parquet` and interpolates URI/node-id IN-lists directly into SQL (injection-adjacent, `v2.rs:909-914`).

Promote `part_of_speech` + `dialect` as `render_fields` in every layer build (`scripts/build-*-layer.mjs` + the on-device TBX emit at `builder_plugin.rs:554`). Then `render_summaries` carries them for free off the cell-pruned scan, and:
- `v2_concept_values` (76 lines of hand-rolled SQL) can be deleted.
- The client facet re-hydrate (`dictionary.ts:507-537`) collapses to reading the tuple's 4th element.
- Search-result cards and map pins get POS/dialect chips **without hydrating tiles**.

You already took the 4-tuple break for this; you're just not emitting the field yet.

### 1.2 Set `ROS_MADAIR_EMIT_MEMORY_LIMIT` on-device → unblock Téarma  **[value]**
Confirmed: **nothing** in `app/src-tauri/src` sets the emit memory limit (grep for `set_var`/the env var is empty). The on-device Téarma emit (189k records) thrashes a DuckDB external merge-sort at the **default 512 MB** while ~15 GB of phone RAM sits idle — >55 min and counting.

The lever shipped in alpha.24: `ROS_MADAIR_EMIT_MEMORY_LIMIT` (any DuckDB size literal, e.g. `6GB`), consumed at `parquet.rs:1074-1090`; `ROS_MADAIR_EMIT_THREADS` caps sort threads. Set it (device-RAM-aware) before the `emit_parquet_with_progress` call. Also consider `--no-render-cache` / `ROS_MADAIR_EMIT_RENDER_CACHE=0` (tile `data` is ~49% larger with it on) and `partition_by_nodegroup` for the big model. This is the single blocker on Téarma being usable on-device, and it's a one-line env set.

### 1.3 Populate FTS `gloss` on the catalogue-install path → English search actually works  **[value][quality]** — ✅ DONE (alpha.33, 2026-10-30)
> alpha.33 promotes `descriptors.description` to a `descriptor_description` column on the `resources` entry table (verified: returns gloss text "great-grandfather" etc.). `fts.rs build_for_head` now reads it into a rid→gloss map and feeds `fts.add`, so English/Gluais search works on installed layers once they're re-emitted at v6.
`fts.rs:22-27` declares `fts5(uri UNINDEXED, headword, gloss, …)`, but `build_for_head:153` calls `fts.add(&rid, &name, "")` — **empty gloss** — because the install path promotes `descriptor_name` but not `description` (`fts.rs:124-125`). Net effect: **English/Gluais search silently returns nothing for catalogue-installed (non-TBX) layers.** That's a user-visible bug hiding as a "half-built facet." Promote `description` onto the install head (or feed gloss from `render_fields` per 1.1) so the second search index isn't dead.

### 1.4 Group homographs with one `Backlink` query → no content-shift, faster open  **[reduce][value]**
`enrichEntryV2` (`dictionary-v2.ts:334-374`) builds homograph groups by reverse-`citedBy` on the concept, hydrating the concept, then firing `Promise.all(loadEntryV2(sibId))` — **N extra full hydrates per entry open**, resolved late so the card first renders single-POS then **re-lays-out** into the grouped card (visible shift, `dictionary.ts:1015-1019`).

alpha.23 gives `Expr::Backlink { target }` (`ros-madair-query/src/lib.rs:148-156`; JSON `{"backlink":{"target":"<concept-uuid>"}}`) — "every resource linking to T through any predicate," EXACT, lowered to a `edges_rev` semijoin (`ros-madair-compile/src/lib.rs:422-435`). The reverse index `redges_` co-emits with `edges_` and is auto-registered — no opt-in. So "all LexicalEntries under this LexicalConcept" is one `resolve_ids`, then one batched hydrate, instead of citedBy + N hydrates. Group on first paint; delete the deferred sibling-load path.

---

## Tier 2 — strong, more work or needs a verification step

### 2.1 Unify on the hydrate-renders-labels path → delete the closure machinery  **[reduce][quality]**
The codebase holds **two contradictory strategies**. `layers-catalogue.ts:55-70` already asserts the end-state ("ros-madair now renders references to labels during hydrate … no frontend closure needed"; `refLabel` is just `str(v)`). But the entry and map paths still run the old one:
- `dictionary-v2.ts:30-113` — module-level `closureCache`, `v2_closure` round-trip, `makeLabel(map)` resolving `part_of_speech`/`dialect`/`gram_features`/`gender`/`sense_dialect` by hand.
- `MapView.svelte:606-644` — a **third** independent copy of the same closure + `localStr`/`refId` helpers, for `feature_type` alone.
- `store.ts:516-521` — a dedicated `warmClosure` in the startup path.

RM alpha.29 (`FORMAT_VERSION 5`) resolves reference/concept UUIDs → labels **inside** `hydrate` via the `value_ids` bridge (`concept_labels()` keys the map by both concept-id and every value-id; `ros-madair-duck/src/lib.rs:668-687`, `hydrate.rs:42-74`). **Verify first** that `v2_hydrate_layers`/`_batch` opens with a catalog (`has_catalog`) so this path is live — the Rust `v2_closure` is already a thin wrapper over `concept_labels()` (`v2.rs:406-434`), which suggests the plumbing is there. If confirmed, hydrate returns plain label strings and you delete: both JS closure copies, `makeLabel`, `warmClosure`, and the app-side `ClosureCache` disk cache (`v2.rs:356-398`). Removes a startup warm and the post-paint content shift.

### 2.2 One identity oracle for the `goi-` slug → stop silent cross-layer merge failures  **[quality][reduce]**
The `normalize_head` / macron-fold / `goi-<head>-<pos>` scheme is implemented **at least six times across three languages**:
- Rust ×2: `tbx_parser.rs:585-611` (full slug) and `builder_plugin.rs:1203-1221` (deliberately-lighter concept-id).
- Python ×1: `src/goidelic/slug_identity.py:36-58` — the declared source of truth.
- JS ×4: `scripts/lib/concept-emit.mjs:42-49` plus re-copies in `build-macbain-layer.mjs:82`, `build-logainm-layer.mjs:77`, `build-core.mjs`.

Because `resourceinstanceid = uuid5(("resource", graphid), slug)`, a one-glyph divergence silently breaks cross-layer compose with no error — **this is exactly the bug that just bit Téarma POS**. The only current guard is hardcoded-value unit tests "verified against node by a comment." Minimum viable fix: a checked-in golden-vectors file (headword → slug) that the Rust tests, Python tests, and a JS test all assert against, so divergence fails CI instead of a user. Better: push the canonical normaliser into a shared crate with a wasm binding (it's resource-identity logic; arguably RM's to own). **[upstream, optional]**

### 2.3 Replace path-regex layer identification with a per-model base query  **[reduce][quality]**
`dictionary.ts:867-928` recovers which layer carries a model by **regex-matching head directory path spelling** (`/\/place(-v2)?(\/|$)/`, `d.includes('/example-')`), and `layerCoverage` fans out one `descriptors([headDir],[uri])` probe **per layer**. The store comment at `842-847` says `Layers` already resolves a per-model base — use it. Layer carrier-detection is also hand-rolled and **duplicated** on the Rust side between `v2_hydrate_layers` (`v2.rs:490-528`) and `v2_hydrate_layers_batch` (`616-648`), both probing `descriptors(...).contains_key(rid)`. This is graph-composition policy that belongs inside `hydrate_layers` as "auto-select carrying layers." **[upstream for the clean version]**

### 2.4 De-duplicate the localized-string + linguistic helpers  **[reduce]**
Four near-identical localized-string unwrappers: `dictionary-v2.ts:67-81`, `dictionary.ts:1025-1036`, `layers-catalogue.ts:41-53`, `MapView.svelte:615-626`. Plus two pipeline-mirrored linguistic rules living in the client: `stripInitialMutation` (`dictionary.ts:397-409`, "mirrors the logainm builder's stripMutation") and `dialectsToCode` (`dictionary.ts:380-388`, "mirrors DIALECT_LABEL_TO_CODE"). One shared helper for the unwrappers; the linguistic ones are candidates to push down so there's a single copy (same divergence risk as 2.2).

---

## Tier 3 — new demonstrable user value from recent RM features

### 3.1 Reverse-etymology browse via `Backlink` over the ety edges — no Oxigraph  **[value]**
Etymology is currently deferred to an Oxigraph-WASM SPARQL subset. But `Backlink` (3.1 above) over the `ety:EtyLink` edges answers the canonical etymology query shape **natively on the duck substrate**: "what words derive from / are cognate with / were borrowed from this etymon." `{"backlink":{"target":"<etymon-uuid>"}}` → `resolve_ids`. That's a genuinely new dictionary feature ("words descended from Old Irish X", "Norse loans") without shipping or querying a second engine. The typed `OnBacklink { path, model, where }` (`ros-madair-query/src/lib.rs:166-171`) lets you filter by link type (derivation vs cognate vs borrowing). Worth a spike now that the corpus and the primitive both exist.

### 3.2 Spatial dialect-geography browse  **[value]**
The spatial substrate (GridBox cell semijoin, `geo_descriptor` on `render_summaries`) needs **no** spatial extension on-device (`SpatialSource::None`; GridBox is a pure cell semijoin) and is already proven by `responder_buffer`. Beyond the responder use-case, this enables a dictionary-native feature: "words attested in this region" / dialect geography — surface where dialect-tagged lemmas cluster, tie Logainm places to dialect zones. The plumbing is there; it's a product decision to expose it.

### 3.3 Richer, hydrate-free result cards and map pins  **[value]**
Once 1.1 lands, `render_summaries` carries descriptor + geo point + related-title blob + POS/dialect in one cell-pruned scan. Search results and the map bottom-sheet can show full chips (POS, dialect, a sense snippet) **without** the per-result tile hydrate they implicitly depend on now — faster, and visually richer.

---

## Tier 4 — code-quality hygiene (no RM dependency)

- **`.expect()` on poisoned mutexes in hot paths** (`v2.rs:111`, `v2.rs:710`) panics the command worker if a prior hydrate panicked; the adjacent `load_graph_cached:80` uses `.map_err(…)?`. Make lock-poison handling consistent. **[quality]**
- **464 MB JSON round-trip in the TBX build** (`builder_plugin.rs:373-453`→`554`): resources are built → serialised to `business_data/<gid>.json` → re-parsed by `emit_parquet`. Pure overhead; exists only because `emit_parquet` takes a prebuild **directory**, not an in-memory resource iterator. Can't be removed app-side — flag as an upstream ask for a streaming resource-sink emit. **[upstream]**
- **`stream_tbx_v2_build` is a 278-line function** (`builder_plugin.rs:302-580`) mixing scaffold/build/concept/FTS/emit; each phase is a natural extraction. **[quality]**
- **Sample flag on `baile` ships as real user data** (`flags-write.ts:82-93`) seeded on first run; localStorage is the source of truth while the head stores irreversible UUIDs — they can desync. Remove the demo seed. **[quality][value]**
- **Destructive "Recent history" slider** (`Settings.svelte:174-186`) truncates `recentEntries` on input — dragging to 0 wipes history with no undo. **[value]**
- **6,103 un-virtualised DOM buttons** in the MapView bottom sheet (`MapView.svelte:827-837`) for the `baile` case — virtualise the list. **[value]**
- **Buffer UI is English-only** with a code comment flagging it pre-ship (`MapView.svelte:744-762`). i18n before shipping. **[value]**
- **Dead/debug surface in prod**: `v2_query_layers` always returns `Err("not implemented")` (`v2.rs:333-335`, registered in `lib.rs:89`); `maybe_run_emit_measurement` (`v2.rs:1338-1377`) ships an adb-marker-triggered thread. Remove or feature-gate. **[quality]**
- **Hardcoded fallbacks that rot silently**: the 5-UUID `load_core_collections` fallback array (`builder_plugin.rs:1300-1319`); scattered `base_uri` string literals (`v2.rs:843,1209,1364`, `builder_plugin.rs:351,560`); duplicated graph-UUID constants. Centralise. **[quality]**
- **Positional CSV construction** (`tbx_parser.rs:729-762`) writes columns by hand index (`row[0]`, `row[n-1]`) relying on an "appended last" comment — a column reorder corrupts output silently. **[quality]**
- **Silent error-swallowing** (`catch { console.warn }` almost everywhere in `dictionary.ts`/`store.ts`): a hydrate failure shows an empty entry with no surfaced error. Add a minimal error surface for the data paths. **[value][quality]**
- **4× `read_dir` prefix/suffix scans** and **2× tar-extraction** implementations — one helper each. **[quality]**

---

## What is NOT reducible (be honest)

- **The dual Pagefind + FTS5 merge/re-rank** (`dictionary.ts:421-668`) can't collapse to an RM primitive — **RM has no unified text-search engine.** The bespoke tiering (`textTier`/`branchPenalty`/`rank`) exists because the two engines' scores are incompatible. This is a real architectural gap, not app cruft. The *facet re-hydrate* half (1.1) and the *dead-slug dedup* half (the `(headword,pos)` collapse at `dictionary.ts:618-638` compensating for un-unified slugs — fixed by 2.2) can go; the merge itself stays until there's one index behind one API. **[upstream, large]**
- **The responder_buffer consumption** (`MapView.svelte:560-579`) is already the right pattern — honest over-inclusive bbox drawn as-is, no client-side geo math. Leave it.

---

## Suggested sequence

1. **1.2** (env var, minutes) — unblocks the Téarma layer you can't currently install.
2. **1.1 + 1.3** together — emit `render_fields`, which both fixes facets and feeds the empty FTS gloss; delete `v2_concept_values`.
3. **1.4** — Backlink homograph grouping (removes the content-shift).
4. **2.1** — verify the catalog-hydrate path, then delete the closure machinery (biggest single LOC reduction).
5. **2.2** — identity golden-vectors (cheap insurance against the next silent merge break).
6. **3.1** — reverse-etymology spike (the headline new feature).
