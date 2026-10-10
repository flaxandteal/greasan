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

This is exactly what the desktop `regen-layer-v2` uses — **and emit already runs
on-device.** `v2.rs:596` (`#[cfg(all(feature = "v2", feature = "v2-emit"))]`) is a
`v2_emit_overlay` command that calls `ros_madair_emit::emit` (`v2.rs:631`) to
re-emit the mutable note/flag overlay, with a not-enabled fallback at `:643`. So
this is not a new on-device integration: emit already compiles into and runs in
the app, and there is a working on-device emit command to model on or share.

**The scope is to let the on-device builder call the emit path** (behind the
`v2-emit` feature, already a dependency) instead of `build_to_memory`, feeding it
a batched/file loader rather than a `Vec<StaticResource>`. It also unifies desktop
+ device on ONE builder and retires the v1 flat-artifact path for v2 layers.

> **Note on the feature cost:** `v2-emit` is optional and opt-in (no `default`
> feature set), so enabling it for the shipped mobile build pulls `ros-madair-emit`
> + bundled `rusqlite` into the binary. `v2_emit_overlay` shows that cost is
> already accepted for the note path, so this is likely a non-issue — but confirm
> it's on for the *release* mobile build, not just examples.

### ⚠️ Measure the cumulative O(corpus) state before treating Path A as *the* fix

Emit's *streaming* is genuinely bounded (peak ≈ one file), but several structures
are **held whole for the entire corpus and only consumed at finalize** — and the
whole point is to not OOM at tearma's **193k resources**, so these must be sized,
not assumed small:

- **`fragment_rows`** (`chunks.rs:55`) — `Vec<(i64,i64,i64,i64)>`, appended
  per-resource (`chunks.rs:206`), consumed only at finalize (`head.rs:560`). At
  193k × nodegroups-each that is ~1–4M tuples × 32 B ≈ **30–130 MB**.
- **the interner/dict** (`head.rs:27`) — every unique UUID/URI/concept-id string
  + map, corpus-wide, never released. At 193k resources plus their
  concepts/refs/nodes this is **hundreds of thousands to millions of entries** —
  NOT "small."
- plus the SKOS closure.

If these sum to a couple hundred MB held simultaneously at finalize, **Path A does
not solve the OOM** — it moves the wall, and you are back in the temp-file spill
that Path B #3 defers as "hardest."

### Measured (2026-07-29): peak RSS = 2.7 GB — Path A as-wired does NOT fit

One clean run settles it. `regen-layer-v2` (which calls `ros_madair_emit::emit`)
over the real `data/prebuild-tearma` (193,393 resources → 1.29M tiles, 5,055
chunks, 137 MB head.sqlite), run as the **binary directly** under `/usr/bin/time -v`:

- **Maximum resident set size: 2,806,992 kB ≈ 2.7 GB** (elapsed 4:29).

That is **~5–14× over a safe phone build budget** (~200–500 MB before Android's
OOM killer). So **Path A, run over a single big prebuild file, does not solve the
on-device OOM — it *is* the OOM.**

And it is far past the `fragment_rows`/interner estimates above, which means the
dominant term is **NOT the internal finalize state — it's the input.** The desktop
prebuild is ONE `business_data/<graphid>.json` holding all 193k resources; emit's
"stream file-by-file / peak = one file" only bounds memory when the input is SPLIT
into many small files. One big file ⇒ the whole corpus (the parsed serde_json tree
+ its tiles) is resident. So the **batched/file loader is the load-bearing part of
Path A, not an optional nicety** — routing to emit *without* it buys nothing.

### Measured (2026-07-29): the internal floor is ~232 MB — input WAS ~92% of peak

Isolated the floor by stream-splitting the one 486 MB `business_data` file into 97
shards of 2,000 resources (~5 MB each on disk, ~28 MB parsed) so emit's file-level
streaming drops each between files, then re-ran the SAME `ros-madair-emit` release
binary under `/usr/bin/time -v`:

| input | peak RSS | elapsed |
|---|---|---|
| one 486 MB file (as shipped) | **2.7 GB** | 4:29 |
| 97 shards, same 193,393 resources | **232 MB** | 3:48 |

Same output (193,393 resources → 1.29M tiles, 5,055 chunks, 137 MB head — only the
snapshot id differs, from the re-sharded locality). Conclusions:

- **The input was ~92% of the peak.** Making it streamable cuts 2.7 GB → 232 MB
  (~12×). The internal O(corpus) state (`fragment_rows` + interner + closure +
  one open chunk + `insert_bulk`) is ~232 MB — and that is an UPPER bound, since
  each 28 MB shard-parse still sits on top; finer shards / true per-resource
  streaming trim it further.
- **The `fragment_rows`/interner spill (Path B #3, "hard, defer") is very likely
  NOT needed.** The floor fits a phone regime; 2.7 GB never could.
- **Time improved** (3:48 vs 4:29) — no giant alloc/drop pressure. Streaming the
  input is a time win, not a cost.

Caveat: 232 MB is desktop process RSS for the emit work; on-device it sits on top
of the app's own resident set, so confirm against the target device's budget. And
the 2.7 GB control is `regen-layer-v2`; the 232 MB is the CLI binary — same emit
path, and the 12× gap dwarfs any harness delta.

Bottom line: the internal O(corpus) floor is **no longer the blocker** — 2.7 GB →
232 MB by making the input streamable, and the `fragment_rows`/interner spill is
retired. But "wins on memory" is not yet "fits the device": 232 MB is desktop
emit-process RSS *in isolation*, and on-device it stacks on the app's own resident
set. That app baseline is **now measured** (device `48181FDAS001HT`, release build,
tearma layer installed, idle post-launch):

| metric | value | note |
|---|---|---|
| TOTAL PSS | **179 MB** | fair-share cost lmkd scores on |
| RssAnon | **89 MB** | private anonymous — the hard unevictable floor |
| RssFile | 183 MB | code/mmap, reclaimable under pressure |
| TOTAL RSS | 340 MB | |

`head.sqlite` (136 MB) is **not** resident in the process — sqlite's `pread` path
keeps it in the kernel page cache (reclaimable), so it does not count against the
app's anon floor. So the earlier "~150–300 MB" guess was right: settled PSS is
179 MB, dead centre.

## IMPLEMENTED & MEASURED (2026-07-29) — the fix is built and works, on desktop AND on device

The streaming emit is implemented and verified end-to-end. This section supersedes
the "projected ~410 MB" estimate above: the real on-device peak is now measured.

### What was built
- **alizarin-core** (`loader.rs`): `stream_business_data_resources(reader, on_elem)`
  — a byte-level structural scanner over the `{business_data:{resources:[…]}}`
  wrapper that yields each resource element's `(byte_offset, bytes)` WITHOUT holding
  the file (respects JSON string escapes; UTF-8-safe). Plus
  `parse_business_data_resource_bytes` for the per-element seek-back parse. Unit-
  tested (escapes, nesting, unicode, offset round-trip, empty/missing array).
- **ros-madair-emit** (`lib.rs` + `locality.rs`): both passes rewritten to stream.
  Pass 1 scans each file for a tiny `Probe` (id + locality field) + byte offset,
  `sort_probes` orders each file's probes exactly as the old per-file
  `sort_by_locality` did, ids interned in that order. Pass 2 SEEKS to each offset
  and processes one resource at a time. Files ≤ 8 MiB take the whole-file parse
  (kept for the tiny note-overlay + bare format) — a memory strategy only, snapshot-
  independent. Uses `pread`/seek, NOT mmap, so file bytes stay in the (reclaimable,
  kernel-side) page cache and out of process RSS.

### Why the snapshot is preserved (the key correctness argument)
The order is kept **per-file** (files in path order, resources locality-sorted
within each file) — byte-identical to the old order, NOT a global re-sort. Since
every real prebuild is one `business_data/<graphid>.json` per graph, this preserves
the snapshot for single- AND multi-graph layouts. Verified by matching canonical
snapshots on all three comparator paths:

| layer | path exercised | snapshot | desktop peak RSS |
|---|---|---|---|
| tearma (193k, 1 file) | id-order (`None`) | `38a61b7a…` ✓ = shipped | **226 MB** (was **2.7 GB**) |
| place (354 MB) | geo/Hilbert | `3319c943…` ✓ = shipped | 119 MB |
| wiktionary (2 files, 48.8k) | multi-graph cross-file | `ef2c7064…` ✓ = old-emit | 62 MB |

### On-device measurement (device `48181FDAS001HT`, debug build, in-process)
Harness: `v2::maybe_run_emit_measurement` (setup hook, marker-gated, inert in prod)
streams the real 509 MB / 193k tearma prebuild through `emit_with_progress` in the
app process; `dumpsys`/`/proc` polled for peak RSS. Result:

- **Output identical to desktop:** snapshot `38a61b7a50b1f332`, 193,393 resources,
  1,293,051 tiles, 5,055 chunks, 137 MB head. The phone builds byte-for-byte what
  the desktop does.
- **Peak VmHWM = 449 MB**, and it is at **finalize, not streaming**: the process
  held ~300 MB across the entire streaming pass (chunks 1→5055) then spiked to
  449 MB at `insert_bulk` (interner + `fragment_rows` + vocab materialised to bulk-
  write `head.sqlite`). So the on-device ceiling is the finalize O(corpus) state —
  and it **fits**: 449 MB total RSS, 4 GB device, foreground, completed cleanly. The
  old whole-parse would have hit 2.7 GB and been OOM-killed. **Path B #3
  (`fragment_rows`/interner temp-file spill) is confirmed NOT needed.**

### Two findings that must shape the production wiring
1. **Bounded ≠ fast.** The phone ran the 193k build ~20× slower than desktop
   (~25 min vs 3:51) — sustained-load thermal/CPU throttling. "Build on a phone" is
   memory-viable but a real UX cost at this corpus size: needs visible progress
   (the `EmitProgress` plumbing already exists) and realistically a background
   long-running build, not a modal wait. Small layers are fine; 193k is a slog.
2. **Production needs a foreground service + wakelock.** The measurement ran on a
   bare `std::thread` at setup. A real on-device build must run under an Android
   foreground service (and hold a wakelock) to survive backgrounding and the
   low-memory killer through a ~25 min run. The existing `spawn_blocking` note on
   `v2_emit_overlay` (v2.rs) points the same way.

### Still to do for the real Path A (production, not the harness)
Route the on-device `build_layer` v2 path through `emit` (behind `v2-emit`) instead
of `build_to_memory`, driven from Settings, under a foreground service — replacing
the v1 flat-artifact build for v2 layers. The memory-bounded emitter it depends on
now exists and is proven; this is the remaining wiring + the service.

> **Sharding is NOT the fix — it was the measurement method, and on the LANDED
> emit it is now actively HARMFUL.** The 232 MB probe split the input into 97 files
> so the *old* per-file-streaming emit dropped each file in turn. Two independent
> reasons never to ship it:
> 1. **Snapshot id.** Shard boundaries become chunk boundaries → different content
>    hashes → a different snapshot id, breaking the manifest incremental-update /
>    integrity path.
> 2. **Memory — it re-materialises the corpus on the emit that actually shipped.**
>    Files ≤ 8 MiB (`SMALL_LIMIT`) take the whole-file parse and are held as
>    `Src::Mem(Box<StaticResource>)` in the `order` vec. So many small shards = the
>    whole corpus resident on the heap = back to ~2.7 GB. ONLY the seek path (files
>    > 8 MiB → `Src::Disk` offset) is bounded. The 232 MB sharding number came from
>    the *pre-seek* emit; it would not reproduce today.
>
> **Design rule for ANY streaming producer feeding emit** (including a future
> `tree_to_tiles`-based loader that skips the CSV/JSON intermediate): keep the input
> ONE large file (> 8 MiB) and let pass 2 seek + re-parse per resource. Never shard,
> and never hand emit a `Vec<StaticResource>` — that is `Src::Mem` for every
> resource, i.e. the whole-corpus peak by another name.

The JS-side descriptor batching can retire once the streaming loader lands. The
internal spill does not appear to be on the critical path.

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
**Path A** — and note emit already runs on-device (`v2_emit_overlay`), so this is
wiring, not a new integration. The streaming, v2-correct builder already exists
(emit); the work is pointing the on-device builder + a batched resource loader at
it, not writing a new builder. It converges desktop and device on one path.

**The streaming emitter is now BUILT and MEASURED** (see "IMPLEMENTED & MEASURED"
above): the seek-based scanner + streaming emit is done, snapshot-identical on all
three paths, and the real in-app peak is measured at **449 MB VmHWM on-device**
(finalize spike; ~300 MB streaming) — it fits, and the `fragment_rows`/interner
spill (Path B #3) is confirmed unneeded. The descriptor-batching workaround can
retire on desktop now. What remains is NOT the emitter but the **production
wiring**: route `build_layer`'s v2 path through `emit` instead of `build_to_memory`,
from Settings, under an Android foreground service + wakelock (the ~25 min build
must survive backgrounding). Path B is only worth it if the v1 flat-artifact format
must be produced on-device.

## Effort estimate
- **Emitter memory fix: DONE.** Scanner in `alizarin-core/loader.rs` + streaming
  passes in `ros-madair-emit`. Desktop + on-device verified.
- **Remaining Path A wiring:** point `build_layer` (v2 branch) at `emit` behind
  `v2-emit`, add the Android foreground service + wakelock + progress UI (the
  `EmitProgress` events already exist). Medium — integration + service, no new
  algorithms.
- Path B #1: similar loader + swap `build_to_memory` for the streaming trio.
  Medium. #2: small. #3: NOT needed (measurement retired it).

Cross-refs: `HANDOFF-ondevice-tbx-v2.md` (the TBX on-device build path this feeds).
