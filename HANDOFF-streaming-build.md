# Scope — streaming `build_to_disk` for on-device layer builds

**Goal:** make on-device layer builds memory-bounded (a working set, not the whole
corpus) so a phone can build/rebuild a large layer (tearma = 193k resources)
without OOM — the same wall that killed the *desktop* tearma build until it was
worked around with JS-side descriptor batching.

## Key finding: most of the machinery already exists
Two corrections to the initial framing:

1. **`build_to_memory` is NOT the v2 head format.** It returns a
   `HashMap<path, bytes>` of flat v1 artifacts (`summary.bin`, `dictionary.bin`,
   `pages/*.dat`, `tiles/*.dat`, `all.nt`) — `ros-madair-core/src/build.rs:283-289`.
   The **v2 head** (`head.sqlite` + content-hashed `chunks/` + `spine_*` /
   `reverse_links` / `vocab`) is produced by the **emit** crate, not core.
2. **The bundled tearma never builds on the phone** — `offline.rs` extracts a
   pre-built `heads/tearma-v2.zip`. On-device `build_to_memory` runs only for
   **user-imported / prebuild-compile** layers (`builder_plugin.rs:486,562`).

So "streaming build" matters for the *user-buildable large layer* case, not the
shipped corpora. Two ways to get there, and the cheaper one is already written:

## Path A (recommended): route on-device v2 builds through `emit`
`ros_madair_emit::emit` (`emit/src/lib.rs:121`) is **already corpus-independent**
and **already emits the v2 head format** the app reads:
- streams business-data **file-by-file**, dropping each after processing
  (`lib.rs:235-280`) — peak = one file, not the corpus;
- `head.sqlite` is a **file connection in one transaction** (`lib.rs:147,234,281`),
  rows inserted per-resource (`head.rs:367-505`) — not a RAM Vec;
- tiles flushed to disk as **content-hashed msgpack chunks** per 256-tile bucket
  (`chunks.rs:16,98,139`) — never all resident;
- two passes over files for stream-order ids (`lib.rs:211-225`).

This is exactly what the desktop `regen-layer-v2` uses. **The scope is to let the
on-device builder call the emit path** (behind the `v2-emit` feature, already a
dependency) instead of `build_to_memory`, feeding it a batched/file loader rather
than a `Vec<StaticResource>`. It also unifies desktop + device on ONE builder and
retires the v1 flat-artifact path for v2 layers. Residual O(corpus) state in emit
is small (interner/dict, closure); the one that still grows is `fragment_rows`
(O(resources×nodegroups), `chunks.rs:39-55`) — spill it if it ever bites.

## Path B: make `build_to_memory` stream (if the v1 format must stay)
`build.rs` **already has the streaming trio** — `prepare_routing` (pass 1, global
routing, `:984`), `BuildAccumulator` + `process_resource_batch` (pass 2, streams
N-Triples to a `BufWriter`, `:921-1121`), `finalize_build` (`:1128`) — and the
`ros-madair-build` bin already drives it (`:215-277`). The gap is only the
*caller*. Refactors, ranked by memory impact:

1. **Stop holding the whole corpus (biggest win).** The on-device caller
   (`builder_plugin.rs:203` builds `Vec<StaticResource>`; `:486,562` call
   `build_to_memory`) and the PyO3 `build` (`ros-madair-builder/src/lib.rs:146`)
   load everything at once. Change them to a **file-/batch-loader** feeding pass 1
   (`extract_resource_summary` `:41` + `collect_reference_ids` `:109`) then pass 2
   (`process_resource_batch`) → `finalize_build`. Mirrors emit's loop. Note
   `build_to_disk(out_dir, …)` (`:565`) exists but **still takes the whole
   `&[StaticResource]` slice** — it only removes the artifact-HashMap + `all_triples`
   hotspots, not the corpus. The real work is the streaming loader upstream.
2. **Bound `tile_content` (`build.rs:353`).** Forward-only (keyed by the resource's
   own page) → append each blob to a per-page file handle during pass 2 instead of
   holding a second full copy of all tiles. Self-contained.
3. **Bound `page_records` (`build.rs:352`) — hardest, defer.** `build_records_for_resource`
   writes a *reverse* record onto the **target's** page (`:232-244`), so a page
   accrues contributions from any resource and can't flush until the corpus is
   done. Needs temp-file spill + k-way merge at finalize. Do last, only if #1+#2
   aren't enough.
4. **Leave global (cheap):** `dict`, `summary_builder`, `resource_names`,
   `page_resource_meta` — inherently need all resources, small vs live resources.

## Recommendation
**Path A.** The streaming, v2-correct builder already exists (emit); the work is
wiring the on-device builder + a batched resource loader to it, not writing a new
builder. It converges desktop and device on one path and makes the JS-side
descriptor batching (this session's workaround) unnecessary. Path B is only worth
it if the v1 flat-artifact format must be produced on-device.

## Effort estimate
- Path A: a batched/file `StaticResource` loader (the parser currently returns a
  full `Vec` — `builder_plugin.rs:203`) + point the on-device build command at the
  emit entrypoint behind `v2-emit`. Medium; no new algorithms.
- Path B #1: similar loader + swap `build_to_memory` for the streaming trio.
  Medium. #2: small. #3: large (spill/merge) — defer.

Cross-refs: `HANDOFF-ondevice-tbx-v2.md` (the TBX on-device build path this feeds).
