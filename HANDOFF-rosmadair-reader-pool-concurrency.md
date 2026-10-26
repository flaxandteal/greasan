# Handoff → ros-madair-duck: make the reader pool concurrent (per-dir locks)

> **STATUS: RESOLVED in `ros-madair-duck` 0.1.0-alpha.31** ("reader-pool concurrency
> fix") — `with_layer` now uses exactly the per-dir `Arc<Mutex<Option<DuckReader>>>`
> pattern proposed below. Gréasán bumped alpha.29 → alpha.31.
>
> **Caveat found on verification:** this fixed the pooled *hydrate* path and read
> concurrency generally, but did **not** speed the catalogue's `queryV2` — because
> Gréasán's `run_query` (v2.rs) opens a **fresh** `DuckReader` via `open_with`,
> bypassing the `with_layer` pool entirely. Its ~950 ms contention was actually
> prewarm's concurrent IO/CPU burst, not this lock (loadCatalogue stayed ~2.7 s with
> mass-prewarm on alpha.31; ~1.6 s without). Downstream fix: don't mass-prewarm
> (lazy-open + single-head warm-up). **Possible upstream follow-up:** route
> `run_query` through the pool too, or expose a pooled query entry point, so repeated
> queries reuse a warm reader instead of creating a fresh connection each call.

**Crate:** `ros-madair-duck` (observed on `0.1.0-alpha.29`)
**Function:** `with_layer` — the process-global `DuckReader` pool.
**Severity:** startup/UX — serializes *all* DuckDB work process-wide; measured ~950 ms
of pure lock-wait on a cold start (see Evidence).

## Problem

`with_layer` holds a single global `Mutex` for the **entire duration** of both the
cold reader open **and** the caller's closure `f()` (the actual query):

```rust
fn with_layer<T>(dir: &Path, f: impl FnOnce(&DuckReader) -> Result<T, DuckError>)
    -> Result<T, DuckError>
{
    static POOL: OnceLock<Mutex<HashMap<PathBuf, DuckReader>>> = OnceLock::new();
    let mut pool = POOL.get_or_init(|| Mutex::new(HashMap::new()))
        .lock().expect("layer reader pool poisoned");
    if !pool.contains_key(dir) {
        let reader = open_layer(dir)?;          // (1) slow parquet open, under the GLOBAL lock
        pool.insert(dir.to_path_buf(), reader);
    }
    f(pool.get(dir).expect("just inserted"))     // (2) the query runs under the GLOBAL lock too
}
```

Two consequences:

1. **No two DuckDB ops overlap, ever.** Because `f()` runs under the global lock,
   every `resource_tiles` / `descriptors` / `run_query` across *every* dir is
   serialized on this one mutex. Concurrent commands can't use DuckDB in parallel,
   and a single multi-dir hydrate (which calls `with_layer` per dir in a loop) can
   never pipeline.
2. **A mass warm-up stalls everything.** `prewarm` opens N readers by calling
   `with_layer` N times; each cold `open_layer` (1) holds the global lock. Any other
   thread that wants *any* dir blocks for the whole open-all-readers span.

## Evidence (downstream: Gréasán, desktop, dev stack ~9 parquet heads)

A background `prewarm` runs concurrently with the layer-catalogue load on startup.
The catalogue's first query is `v2_query` → `run_query` → `with_layer`.

| Scenario | `queryV2` (select 13 ids) |
|---|---|
| prewarm enabled (races the query) | **2075 ms** |
| prewarm disabled | **1128 ms** |

The ~950 ms delta is pure lock-wait — the query blocked on the pool mutex while
prewarm held it opening readers. (The residual ~1.1 s is a *separate* DuckDB
first-query cold-init, which we handle downstream with a background warm-up; not
this bug.) The select-13-ids query's own work is ~100 ms.

## Requested fix: per-dir reader locks

Hold the global lock only to get-or-insert a **per-dir** reader slot; do the open and
the query under that per-dir lock. Different dirs then run fully concurrently; a cold
open blocks only its own dir; same-dir calls serialize (correct — a `DuckReader`
wraps a `duckdb::Connection`, which is `Send` but `!Sync`, so it can't be used
concurrently anyway).

```rust
fn with_layer<T>(dir: &Path, f: impl FnOnce(&DuckReader) -> Result<T, DuckError>)
    -> Result<T, DuckError>
{
    use std::sync::{Arc, Mutex, OnceLock};
    // Outer lock guards only the MAP (get-or-insert the slot); inner per-dir lock
    // guards the reader's open + use. `None` until first opened.
    static POOL: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Option<DuckReader>>>>>> =
        OnceLock::new();

    let slot = {
        let mut pool = POOL.get_or_init(|| Mutex::new(HashMap::new()))
            .lock().expect("layer reader pool poisoned");
        pool.entry(dir.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }; // <-- global lock released here

    let mut guard = slot.lock().expect("layer reader slot poisoned");
    if guard.is_none() {
        *guard = Some(open_layer(dir)?);   // cold open holds only THIS dir's lock
    }
    f(guard.as_ref().expect("just opened"))
}
```

Properties:
- **Signature unchanged** — every call site is unaffected.
- **Global lock is now O(1)** (map entry only), never held across an open or a query.
- **Cross-dir concurrency**: a hydrate over a stack, or two concurrent commands, now
  overlap their per-dir queries instead of serializing.
- **Open isolation**: `prewarm` opening dir X no longer blocks a query on dir Y.
- **Failure behaviour**: an `open_layer` error leaves the slot `None` (empty), so the
  next call retries — same as today (today it errored before inserting).

## Validation to add

- **Concurrency test**: two threads calling `with_layer` on *different* dirs with a
  closure that sleeps briefly should finish in ~max(one), not ~sum. Same dir → serial.
- **No-regression**: existing hydrate/descriptor/query results unchanged.
- **Bench** (optional): the downstream repro — a `prewarm(all)` on one thread plus a
  `run_query(select_ids)` on another should no longer show the query inheriting
  prewarm's wall-time.

## Also worth an audit (same pattern, not yet measured)

`cached_concept_labels` and the other `OnceLock<Mutex<…>>` caches nearby (around the
same region of `lib.rs`) — confirm none of them hold their lock across the heavy
work (a catalog read) rather than just the map get/insert. Same class of bug if so.

## Downstream status (Gréasán, for context)

While this lands upstream, Gréasán mitigates app-side: un-await the catalogue load,
restrict the catalogue hydrate to carrier dirs, skip the (unneeded) gramadan registry
for Layer resources, and a background DuckDB warm-up for the one-time cold-init. The
per-dir-lock fix is the part only `ros-madair-duck` can do cleanly, and it's the one
that removes the ~950 ms (and unlocks real read concurrency everywhere else).
