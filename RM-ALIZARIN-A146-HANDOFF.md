# Handoff: alizarin a146 + Rós Madair alpha.34, for Gréasán

alizarin `2.0.0-alpha.146` and RM `0.1.0-alpha.34` are published/aligned (both from
crates.io, no patches). Gréasán is a **consumer** of both **and owns the Layer catalogue model**
(`models/layer/*` + `scripts/build-layer-catalogue.mjs`). This covers what to bump, what to
accommodate, and a fold opportunity that is specifically Gréasán's to take.

Current Gréasán pins: `alizarin-core = "2.0.0-alpha.140"` (well behind) and `ros-madair-* =
"=0.1.0-alpha.33"` (published, no patch).

## 1. Upgrade alizarin a140 → a146 (registry; no patch)

Move `alizarin-core` (and `alizarin-clm-core`/`alizarin-geo-core` if pinned) to `=2.0.0-alpha.146`.
Keep the EXACT `=` — a caret resolves to the semver-higher `2.0.0-beta.9`. All four crates are on
crates.io; the `@alizarin/*` packages are on npm. Crossing 140→146, accommodate:

- **REQUIRED — `greasan-gramadan` tile data `HashMap` → `BTreeMap`.** a143 made `StaticTile.data`
  a `BTreeMap` (deterministic key order). `crates/greasan-gramadan/src/lib.rs:233` still builds
  `data` as a `HashMap`, so it won't compile against a143+. Fix: `use std::collections::{BTreeMap,
  HashMap};` and change line 233 to `BTreeMap`. (This is the exact fix already applied in
  AonachResponder's copy of the crate.)
- **Derive functions (a144).** `ComputeTilesConfig`→`DeriveConfig`, `compute_tiles_functions`→
  `derive_functions` (old names remain as `#[deprecated]` aliases — warnings if used).
  `ComputeTilesProvider`/`apply_compute_tiles` were removed. The Gramadán derive provider is
  unchanged as code, but **its declarations should gain a `nodes` map** (role → alias|id) to use
  the new role lookup (follows arches-her's `GeoJSONToBNGPoint`). It still runs without one
  (`on_load` default), so this is a forward-path TODO, not a blocker.
- **Reference node config moved core → clm (a144).** `NodeConfigReference`/`as_reference`/
  `get_reference` are gone; a reference node's collection comes from the registered clm handler
  (`collection_id`). Gréasán is reference-heavy (controlled lists), so this is your largest surface:
  verify label resolution still passes a registry (`default_registry()` / the clm registry) into
  `build_alias_to_collection_map` / `resolve_labels_full`, or references lose their collection.
- **Behaviour you may notice:** permissions parsed strictly (loaded tiles filtered by the model's
  permissions); display reads use the current language with default fallback; cyclic-JSON arguments
  now raise an ordinary error on every binding (previously crashed NAPI/Python, corrupted WASM).
  Extension C ABI is v5 — matters only to **prebuilt extension `.so` addons**; Rust-crate linking is
  unaffected.

RM made this same bump with **only** the BTreeMap fix needed. Gréasán's extra work is the
reference-heavy label paths and the Gramadán `nodes` map. Build + test after bumping.

## 2. Upgrade RM =alpha.33 → =alpha.34 (registry; no patch)

Gréasán already uses PUBLISHED RM, so this is a plain version bump of the six `ros-madair-*` pins
to `=0.1.0-alpha.34` once it lands on crates.io (imminent). alpha.34 is a146-aligned and carries the
split-layers `LayerPairing` / layer-manifest metadata. No consumer-facing API change is expected.

## 3. The fold opportunity — spans on the Layer catalogue (Gréasán's to take)

alizarin a146 ships a new **Aggregate function kind** + a built-in **fold provider** (`FoldAggregate`,
already in `default_functions_registry`; wasm/napi/python bindings done). It reduces a **slice of
member resources** into **node values on a calling resource**, purely and deterministically, at an
explicit build-time call — never on load. **Nothing in alizarin knows what a "span" is; the Layer's
owner decides.** Since Gréasán owns `models/layer` + `build-layer-catalogue.mjs`, it is the natural
(and only) place to give the dictionary's layers summaries over their members.

Concrete uses for Gréasán:

- **Faceting via `group_by`** — the standout for a dictionary. One summary per fixed-vocabulary
  value (part-of-speech, dialect, source, register) in a **single node value**, computed once at
  build: e.g. "senses per POS" per layer. Browse/filter UI counts with **zero query-time
  aggregation**, and the owner needn't know the categories in advance.
- **Counts** (`resources` / `values` outputs) — "N headwords / N senses in this layer" baked onto
  the catalogue card.
- **Spatial extent** for the **Logainm placenames** layer — a geometry fold → `{bbox,
  geometry_types, count}` for map zoom-to-fit and spatial pruning (needs `alizarin-geo` registered).
- **Temporal** — if entries carry dates (attestation/etymology), a `date`/`edtf` fold →
  `{min, max, count}` per layer.

**Mechanics.** Add a spans nodegroup to `models/layer`; add a `functions_x_graphs` Aggregate entry
(`AGGREGATE_FUNCTION_ID`, provider `FOLD_AGGREGATE_PROVIDER_ID`) on the Layer graph with the fold
config — per item: target `tileid` (you supply it, so ids are stable), member `graph`, dot `path`,
its `datatype`, optional `where` (set membership) and `group_by`, and `into` mapping outputs
(`summary`/`summary_text`/`values`/`resources`/`skipped`) to node aliases on the Layer graph. Run
`applyAggregateFunctions` (the binding) at catalogue build in `build-layer-catalogue.mjs` over a
streamed slice of each layer's members. The provider fills the span node values; **Gréasán writes the
span tile itself** (its role concept + labels — the role taxonomy is entirely Gréasán's choice;
alizarin never reads it). One caveat: a summary node must **not** be a geometry datatype, so RM's
spatial index doesn't mistake an extent for content.

**Why this is Gréasán's and not RM's:** RM deliberately does NOT compute spans — it's a consumer that
can *prune* on them (drop a layer whose spans can't match a query, via `datatype_fold::fold_may_match`,
conservative/superset-safe). The span-writing is consumer-owned, i.e. the catalogue builder's — yours.

Full design: alizarin `notes/spans-scope.md` (Aggregate + spans) and `notes/fold-scope.md` (the fold
primitive); the alizarin→RM handoff at `RosMadair-sandbox-parquet/docs/alizarin-a144-handoff.md`;
worked fixtures at `alizarin/tests/data/aggregate/` with `tests/dual-backend/aggregate.test.ts`.
Rollups across layers (a catalogue resource summarising its member Layers) are a coming alizarin
provider, not yet shipped.

---

## Gréasán-side status + verified pre-audit (2026-11-16)

- **Reference-config risk CLEARED (no migration change).** a146 `alizarin-clm-core`
  `get_collection_id()` = `controlled_list.or(rdm_collection)` — `controlledList` is the
  PRIMARY key, which is exactly what our concept→reference migration already writes
  (`build-core.mjs:118/122`, `layer-emit.mjs:71/72`). References resolve unchanged.
- **greasan-gramadan: one hard change only.** `src/lib.rs:233` builds tile `data` as
  `HashMap` → must be `BTreeMap` for a143+ (`use std::collections::{BTreeMap, HashMap};`).
  It already impls the new `DeriveProvider`; `ComputeTilesConfig` stays via a
  `#[deprecated]` alias (warning, not a break); the `nodes` role-map is a forward TODO.
- **Publication gate:** a146 is on crates.io + npm. RM alpha.34 is NOT yet on crates.io
  (index tops at alpha.33); its Release-Package run is in progress as of 2026-11-16.

### Bump checklist (execute when ros-madair alpha.34 lands on crates.io)
1. `greasan-gramadan/src/lib.rs`: tile `data` `HashMap` → `BTreeMap`.
2. `app/src-tauri/Cargo.toml`: 6 `ros-madair-*` pins `=0.1.0-alpha.33` → `=0.1.0-alpha.34`;
   `alizarin-core` `=2.0.0-alpha.140` → `=2.0.0-alpha.146` (keep exact `=`). `cargo update`.
3. npm: `@alizarin/*` → a146 (frontend + the combined wasm).
4. `cargo check --lib --examples`, `npm run check`, Rust + vitest suites.
5. Verify labels: `hydrate-probe` on a re-emitted head (dialect/part_of_speech resolve).
6. Re-emit all heads → new bundle → publish → re-pin `bundle-pin.json` (tile ids shift,
   so snapshot_ids churn — a v6-style re-emit migration).
