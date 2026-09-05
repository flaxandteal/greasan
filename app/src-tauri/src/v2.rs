// SPDX-License-Identifier: AGPL-3.0-or-later
//! v2 static-assets pilot (single layer: macbain) - feature `v2`.
//!
//! The native read path that replaces the v1 SPARQL/page-index stack for
//! one layer:
//!
//! * schema: the Arches resource-model export (`<head_dir>/graph.json`),
//!   loaded into `alizarin_core_v2::StaticGraph` (the *sandbox* core - see
//!   the type-isolation note below);
//! * head + body: `ros-madair-read` resolves a UUID through `head.sqlite`,
//!   recovers its tiles from the content-addressed `chunks/<hash>.msgpack`
//!   files and hydrates them to a schema-aware JSON tree;
//! * queries: the serde IR of `ros-madair-query`, compiled to parameterized
//!   SQL against a registry rebuilt from the *manifest's declared handlers*,
//!   and executed with rusqlite.
//!
//! ## What this module used to be
//!
//! It hand-rolled all three of those: a private `Deserialize` mirror of the
//! emitter's crate-private chunk wire struct, its own dict→spine→fragment_dir
//! →chunks SQL join, its own msgpack read loop, and a hand-built extension-type
//! registry. All four are gone. Upstream shipped `ros-madair-read` (the native
//! read path), `ros-madair-format` (the wire/manifest types, now public and
//! `Deserialize`) and `ros-madair-handlers` (the single registry definition -
//! plus a manifest that *declares* the handler set it was emitted with).
//!
//! The registry one mattered most. A hand-built query-side registry that
//! disagrees with the emitter's does not fail: it compiles valid SQL against an
//! index that was never written, and returns **zero rows**. Deriving it from the
//! manifest closes that - an artifact emitted with a handler this build cannot
//! provide now errors loudly instead of quietly answering nothing.
//!
//! ## Type isolation (still worth keeping)
//!
//! Two copies of `alizarin-core` are linked: the real one (2.0.0-alpha.120 -
//! v1, `ros-madair-core`, the rest of the app) and the sandbox one that the v2
//! stack tracks (2.0.0-alpha.121), aliased `alizarin-core-v2`. The version bump
//! is what makes that legal; see `Cargo.toml`. This module is JSON-in /
//! JSON-out (`serde_json::Value` at every public boundary), so no v2 type
//! escapes into the app and the two cores never meet.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use alizarin_core::graph::StaticGraph;
use ros_madair_handlers::ExtensionTypeRegistry;
use serde_json::Value;

/// Load + index the Arches resource-model export shipped alongside the head.
/// Accepts a bare graph object or a `{"graph":[...]}` export.
pub fn load_graph(path: &Path) -> Result<StaticGraph, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let json: Value = serde_json::from_str(&raw).map_err(|e| format!("parse graph json: {e}"))?;
    let graph_value = match json.get("graph").and_then(|g| g.get(0)) {
        Some(v) => v.clone(),
        None => json,
    };
    let mut graph: StaticGraph =
        serde_json::from_value(graph_value).map_err(|e| format!("graph schema: {e}"))?;
    graph.build_indices();
    Ok(graph)
}

/// `load_graph`, cached by path (invalidated on mtime+len change). A resource
/// open hydrates against the same layer graphs every time; parsing them once and
/// handing back an `Arc` avoids re-reading graph.json per call. The one owner of
/// layer-graph loading for the duck hydrate path - base graph and fxg-bearing
/// overlays both come through here, so there is a single mechanism and cache.
fn load_graph_cached(path: &Path) -> Result<std::sync::Arc<StaticGraph>, String> {
    use std::sync::{Mutex, OnceLock};
    use std::time::SystemTime;
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (SystemTime, u64, std::sync::Arc<StaticGraph>)>>> =
        OnceLock::new();
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let mtime = meta.modified().map_err(|e| e.to_string())?;
    let len = meta.len();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some((t, l, g)) = cache.get(path) {
        if *t == mtime && *l == len {
            return Ok(g.clone());
        }
    }
    let g = std::sync::Arc::new(load_graph(path)?);
    cache.insert(path.to_path_buf(), (mtime, len, g.clone()));
    Ok(g)
}

/// The composed `LayeredGraph` for a base + zero-or-more fxg-bearing overlays,
/// retained across hydrates so its lazily-built merged lookup index survives too
/// (not just the member parses). Always a `LayeredGraph` - even a single layer -
/// so hydrate takes one concrete graph and the layer count is internal to it.
/// Keyed by member `Arc` identity: `load_graph_cached` hands back the same `Arc`
/// while a graph.json is unchanged, so a reinstall mints a new `Arc` -> new key
/// -> rebuilt composition; identical inputs reuse the cached one.
fn cached_layered_graph(
    base: &std::sync::Arc<StaticGraph>,
    overlays: &[std::sync::Arc<StaticGraph>],
) -> std::sync::Arc<alizarin_core::LayeredGraph> {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<Vec<usize>, std::sync::Arc<alizarin_core::LayeredGraph>>>> =
        OnceLock::new();
    let key: Vec<usize> = std::iter::once(std::sync::Arc::as_ptr(base) as usize)
        .chain(overlays.iter().map(|o| std::sync::Arc::as_ptr(o) as usize))
        .collect();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("layered-graph cache poisoned");
    if let Some(lg) = cache.get(&key) {
        return lg.clone();
    }
    let lg = std::sync::Arc::new(alizarin_core::LayeredGraph::new(
        base.clone(),
        overlays.to_vec(),
    ));
    cache.insert(key, lg.clone());
    lg
}

/// The datatype-capability registry to plan queries with - rebuilt from the
/// handler set the artifact's manifest *declares* it was emitted with.
///
/// This is what the manifest's `handlers` block is for. `reference` (the
/// datatype of the `dialect` node) is head-indexed - present in `concept_tags`,
/// and therefore filterable at all - only because the emitter had the CLM
/// handler registered. A query side that *guesses* its registry can guess wrong
/// in the dangerous direction: plan against an index that was never written and
/// return zero rows, silently, forever. So ask the artifact instead of guessing.
///
/// `registry_from_declarations` errors loudly if the artifact declares a handler
/// this build cannot provide. That failure is the feature.
fn registry(head_dir: &Path) -> Result<ExtensionTypeRegistry, String> {
    // Load `<head_dir>/manifest.json` (the format crate's layout/compatibility
    // contract). Absent is legal - see the fallback arm below. (This inlines what
    // the retired ros-madair-read::load_manifest did; the read crate folded into
    // ros-madair-duck and the app reads the manifest directly now.)
    let manifest_path = head_dir.join("manifest.json");
    let manifest: Option<ros_madair_format::Manifest> = match std::fs::read(&manifest_path) {
        Ok(bytes) => {
            Some(serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read manifest {}: {e}", manifest_path.display())),
    };
    match manifest {
        Some(m) if !m.handlers.is_empty() => {
            ros_madair_handlers::registry_from_declarations(&m.handlers)
        }
        // No manifest, or one declaring no handlers. The format treats an absent
        // manifest as legal (spine tables are discoverable from sqlite_master),
        // so a head dir must stay readable without one - and the only registry we
        // can offer then is the default, i.e. a guess, deliberately the same guess
        // the emitter's own default makes. Every artifact this app ships is
        // emitted with the default registry AND declares it, so this branch is for
        // hand-assembled heads only. If the guess is ever wrong the symptom is
        // zero rows - which is precisely why the declaration exists and why we
        // prefer it whenever it is present.
        _ => Ok(ros_madair_handlers::default_registry()),
    }
}

/// Parquet path (v2-duck): compile the IR to DuckDB SQL over the dir's
/// `tiles_*.parquet` via DuckReader, per measure. Same `{results: [{measure,
/// coarse, columns, rows}]}` shape; `coarse` is always false (DuckDB's HasLink is
/// exact per-tile, unlike the sqlite head's chunk-granularity summary). No spatial
/// (SpatialSource::None) - run_query's callers are lexical/catalogue, not geo.
pub fn run_query(head_dir: &Path, ir: &Value, graph: &StaticGraph) -> Result<Value, String> {
    use ros_madair_duck::{DuckReader, SpatialSource};
    let query: ros_madair_query::Query =
        serde_json::from_value(ir.clone()).map_err(|e| format!("bad query IR: {e}"))?;
    let registry = registry(head_dir)?;
    let glob = format!("{}/tiles_*.parquet", head_dir.display());
    let mut duck = DuckReader::open_with(&glob, SpatialSource::None).map_err(|e| e.to_string())?;
    // Attach the concept catalog when present - enables DescendantOrSelfOf facets.
    let catalog = head_dir.join("concept_catalog.parquet");
    if catalog.is_file() {
        duck = duck
            .with_catalog(&catalog.to_string_lossy())
            .map_err(|e| e.to_string())?;
    }
    let limit = query.limit.map(|l| l as usize);
    let mut results = Vec::new();
    for measure in &query.measures {
        match measure {
            ros_madair_query::Measure::SelectIds => {
                let mut ids = duck.resolve_ids(&query, graph, &registry).map_err(|e| e.to_string())?;
                // resolve_ids does not apply query.limit; match the sqlite path.
                if let Some(l) = limit {
                    ids.truncate(l);
                }
                let rows: Vec<Value> = ids
                    .into_iter()
                    .map(|id| Value::Array(vec![Value::from(id)]))
                    .collect();
                results.push(serde_json::json!({
                    "measure": "select_ids", "coarse": false,
                    "columns": ["resource_id"], "rows": rows,
                }));
            }
            ros_madair_query::Measure::CountRecords => {
                let n = duck.count_records(&query, graph, &registry).map_err(|e| e.to_string())?;
                results.push(serde_json::json!({
                    "measure": "count_records", "coarse": false,
                    "columns": ["count"], "rows": [[n]],
                }));
            }
        }
    }
    Ok(serde_json::json!({ "results": results }))
}

fn graph_path(head_dir: &str) -> PathBuf {
    Path::new(head_dir).join("graph.json")
}

/// Keep only head dirs that actually carry parquet tiles. A layer can be
/// registered (offline.rs lists every corpus unconditionally) yet have no data
/// on disk - mid-install, or an on-device-only layer like Téarma that was never
/// built in this checkout. The duck reader errors hard on a `tiles_*.parquet`
/// glob that matches nothing, which would fail EVERY composed read; skip such a
/// layer (with a log) so the rest of the stack still resolves and hydrates.
fn present_layer_dirs(head_dirs: Vec<String>) -> Vec<String> {
    head_dirs
        .into_iter()
        .filter(|d| {
            let has_tiles = std::fs::read_dir(d).ok().is_some_and(|rd| {
                rd.flatten().any(|e| {
                    let n = e.file_name();
                    let n = n.to_string_lossy();
                    n.starts_with("tiles_") && n.ends_with(".parquet")
                })
            });
            if !has_tiles {
                logcat_error(&format!("[v2] skipping layer with no parquet tiles: {d}"));
            }
            has_tiles
        })
        .collect()
}

/// Parquet path (v2-duck): tiles from the `data` column via DuckReader::hydrate,
/// reusing the storage-agnostic tile→tree half. No spatial needed.
#[tauri::command]
pub fn v2_hydrate(head_dir: String, resource_id: String, language: Option<String>) -> Result<Value, String> {
    use ros_madair_duck::{DuckReader, SpatialSource};
    let graph = load_graph(&graph_path(&head_dir))?;
    let langs: Vec<&str> = match language.as_deref() {
        Some(l) => vec![l, "ga", "gd", "en"],
        None => vec!["ga", "gd", "en"],
    };
    let glob = format!("{head_dir}/tiles_*.parquet");
    let mut duck = DuckReader::open_with(&glob, SpatialSource::None).map_err(|e| e.to_string())?;
    let catalog = Path::new(&head_dir).join("concept_catalog.parquet");
    if catalog.is_file() {
        duck = duck
            .with_catalog(&catalog.to_string_lossy())
            .map_err(|e| e.to_string())?;
    }
    duck.hydrate(&resource_id, &graph, &langs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn v2_query(head_dir: String, ir: Value) -> Result<Value, String> {
    let graph = load_graph(&graph_path(&head_dir))?;
    run_query(Path::new(&head_dir), &ir, &graph)
}

// ---------------------------------------------------------------------------
// Multi-layer composition (R1) - `ros-madair-read`'s `Layers`.
//
// The single-head commands above read ONE snapshot. `Layers` reads N ordered
// snapshots (base first, later overrides earlier) as one composed view - a
// shipped BASE plus overlays Gréasán emits on-device as the user edits. This is
// the path the eventual `SparqlStore` replacement takes; the commands here prove
// the R1 API compiles and runs through the dual-core seam. Precedence is
// per-nodegroup and lives entirely inside `ros-madair-read`; this module stays a
// JSON-in / JSON-out boundary, so no v2 type escapes into the app.
//
// The registry, graph and composability contract all come from the FIRST layer:
// `Layers::open` refuses layers that disagree on base_uri / handler set / spine
// tables / field class, so the base's registry and graph are authoritative for
// the stack. Layers may carry different *model sets* (an overlay carries only
// what was edited), but the shared model must be described identically.
// ---------------------------------------------------------------------------

/// Open an ordered layer stack, base first. Precedence = order.
/// Emit an ERROR-priority line to Android logcat (tag `greasan`), so composition
/// failures are grep-able with `adb logcat greasan:E` / `adb logcat | grep greasan`.
/// Tauri does not route Rust `eprintln!` to logcat on Android, so a straight
/// stderr print is invisible on-device; this uses liblog directly. Off Android it
/// falls back to stderr.
pub fn logcat_error(msg: &str) {
    #[cfg(target_os = "android")]
    {
        use std::os::raw::c_char;
        #[link(name = "log")]
        extern "C" {
            fn __android_log_write(prio: i32, tag: *const c_char, text: *const c_char) -> i32;
        }
        if let Ok(m) = std::ffi::CString::new(msg) {
            // 6 = ANDROID_LOG_ERROR
            unsafe { __android_log_write(6, c"greasan".as_ptr(), m.as_ptr()) };
        }
    }
    #[cfg(not(target_os = "android"))]
    eprintln!("[greasan] {msg}");
}

/// Duck-substrate stub for `v2_query_layers`. The sqlite composed-query path
/// cannot read parquet heads and has no callers, so this errors loudly rather
/// than silently returning nothing. If a composed multi-layer query is ever
/// needed on duck, port it via `ros_madair_duck` (per-layer resolve + merge),
/// mirroring the `cited_by` reverse-lookup.
#[tauri::command]
pub fn v2_query_layers(_head_dirs: Vec<String>, _ir: Value) -> Result<Value, String> {
    Err("v2_query_layers: not implemented on the duck substrate (no callers)".to_string())
}

// ---------------------------------------------------------------------------
// Concept label resolution.
//
// Hydrated trees leave REFERENCE/concept fields (part_of_speech, dialect,
// gram_features, …) as RAW concept UUIDs - the head indexes concept ids, not
// their human labels. Upstream (A2) retired the sidecar `closure.json` and
// moved the labels INTO the head: the `vocab` table now carries a `label`
// column keyed by the concept's dict `term_id`, so display resolves as a
// self-contained SQL join
//
//   SELECT d.term, v.label FROM vocab v JOIN dict d ON d.term_id = v.concept
//
// where `d.term` is the concept UUID string and `v.label` its display label.
// The old `value_map` (value-id -> concept-id) was only ever an emit-time
// intermediate and is NOT carried in the head; macbain's reference values are
// bare concept UUIDs, so they key straight into this map with no indirection.
// Later layers override earlier, matching the base-first precedence of `Layers`.
// ---------------------------------------------------------------------------

/// Fold each head's (base first) `vocab.label` into one `uuid -> label` map by
/// joining `vocab` to `dict` on the concept term_id. Concept UUIDs resolve
/// directly; later layers override earlier. A head whose `vocab` is empty (an
/// overlay that carries no concepts) simply contributes nothing rather than
/// failing the stack. The command name and signature are unchanged from the
/// `closure.json` era so the TS wrapper and `loadEntryV2` need no edits.
#[tauri::command]
pub fn v2_closure(head_dirs: Vec<String>) -> Result<HashMap<String, String>, String> {
    let head_dirs = present_layer_dirs(head_dirs);
    use ros_madair_duck::{DuckReader, SpatialSource};
    let mut map: HashMap<String, String> = HashMap::new();
    for dir in &head_dirs {
        let catalog = Path::new(dir).join("concept_catalog.parquet");
        if !catalog.is_file() {
            continue;
        }
        let glob = format!("{dir}/tiles_*.parquet");
        let duck = DuckReader::open_with(&glob, SpatialSource::None)
            .map_err(|e| e.to_string())?
            .with_catalog(&catalog.to_string_lossy())
            .map_err(|e| e.to_string())?;
        // Later dirs override earlier, matching the sqlite insert.
        map.extend(duck.concept_labels().map_err(|e| e.to_string())?);
    }
    Ok(map)
}

/// Resolve resource UUIDs to their `display_name` (descriptor) via the head's spine
/// tables - a cheap indexed lookup (`dict` → `spine_*`), NO hydration. This is how a
/// consumer shows a related resource whose descriptor IS the content - e.g. an
/// external example, whose `display_name` is the sentence - without a per-resource
/// hydrate, and crucially without needing that resource's MODEL graph (the head ships
/// only the base graph.json). Every `spine_*` table (one per model) is searched across
/// the layer stack; first hit wins. Batch: one call resolves many uris.
/// Parquet path (v2-duck): read the promoted `descriptor_name` tile column per
/// resource via DuckReader over each dir's `tiles_*.parquet`. No spatial needed for
/// descriptors, so open with `SpatialSource::None` (no extension, no network).
#[tauri::command]
pub fn v2_descriptors(
    head_dirs: Vec<String>,
    uris: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let head_dirs = present_layer_dirs(head_dirs);
    use ros_madair_duck::{DuckReader, SpatialSource};
    let mut out: HashMap<String, String> = HashMap::new();
    for dir in &head_dirs {
        let glob = format!("{dir}/tiles_*.parquet");
        let duck = DuckReader::open_with(&glob, SpatialSource::None).map_err(|e| e.to_string())?;
        for (uri, name) in duck.descriptors(&uris).map_err(|e| e.to_string())? {
            out.entry(uri).or_insert(name);
        }
    }
    Ok(out)
}

/// Canonical search-result display for a set of URIs, resolved from the COMPOSED
/// head stack instead of trusting whichever layer's Pagefind meta happened to win
/// the merge. headword = spine.display_name; part_of_speech + the entry-level
/// dialect come from concept_tags -> vocab (both are references). Fixes bare /
/// duplicate rows that leak from a forms-only layer (BuNaMo) when the rich layer's
/// exact match is crowded past the per-layer result cap. Gloss is a tile, so it
/// stays from Pagefind. First head (composition order) that has the resource wins,
/// so the richest layer (wiktionary first) provides the display for shared slugs.
#[derive(serde::Serialize, Default)]
pub struct SearchDisplay {
    pub headword: String,
    pub pos: String,
    pub dialects: Vec<String>,
}

/// Parquet path (v2-duck): headword from `descriptor_name`, POS + dialect labels
/// from the per-nodegroup `concept_id` ⨝ concept catalog (DuckReader::search_display).
/// First head (composition order) with a headword for a uri wins, as in sqlite.
#[tauri::command]
pub fn v2_search_display(
    head_dirs: Vec<String>,
    uris: Vec<String>,
    pos_node: String,
    dialect_node: String,
) -> Result<HashMap<String, SearchDisplay>, String> {
    let head_dirs = present_layer_dirs(head_dirs);
    use ros_madair_duck::{DuckReader, SpatialSource};
    let mut out: HashMap<String, SearchDisplay> = HashMap::new();
    for dir in &head_dirs {
        if uris.iter().all(|u| out.contains_key(u)) {
            break;
        }
        let glob = format!("{dir}/tiles_*.parquet");
        let mut duck = DuckReader::open_with(&glob, SpatialSource::None).map_err(|e| e.to_string())?;
        let catalog = Path::new(dir).join("concept_catalog.parquet");
        if catalog.is_file() {
            duck = duck
                .with_catalog(&catalog.to_string_lossy())
                .map_err(|e| e.to_string())?;
        }
        let rows = duck
            .search_display(&uris, &pos_node, &dialect_node)
            .map_err(|e| e.to_string())?;
        for (uri, row) in rows {
            // Require a headword (matches the sqlite spine-hit contract); first
            // head with the resource wins.
            let Some(headword) = row.headword else { continue };
            out.entry(uri).or_insert(SearchDisplay {
                headword,
                pos: row.pos.unwrap_or_default(),
                dialects: row.dialects,
            });
        }
    }
    Ok(out)
}

/// Hydrate one resource from the composed view of a layer stack: gather its tiles
/// from every layer that has it, merge with per-nodegroup precedence (topmost
/// wins), then hydrate to a schema-aware JSON tree. The graph is the base's.
/// Parquet path (v2-duck): composed hydration over a stack of Parquet layer dirs
/// via ros_madair_duck::hydrate_layers - same per-nodegroup precedence, tiles from
/// the `data` column. (Needs each dataset dir to carry graph.json; slice 6.)
#[tauri::command]
pub fn v2_hydrate_layers(head_dirs: Vec<String>, resource_id: String, language: Option<String>) -> Result<Value, String> {
    // Drop registered-but-dataless layers (e.g. an on-device-only Téarma not
    // built here) before composing - hydrate_layers opens every dir's parquet
    // and errors hard on one with no tiles, which would fail the whole entry.
    let head_dirs = present_layer_dirs(head_dirs);
    let Some(base) = head_dirs.first() else {
        return Err("v2_hydrate_layers: no layers given".to_string());
    };
    // The app owns layer-graph loading (one cached `load_graph`): the base model,
    // plus the fxg-bearing overlays a computed layer contributes. When any
    // overlay declares functions we retain a composed LayeredGraph (dirs[0] is
    // the base; overlays are the rest that declare fxgs) and pass it as the
    // derive-pass view; otherwise the base graph is its own view.
    let base_graph = load_graph_cached(&graph_path(base))?;
    let overlays: Vec<std::sync::Arc<StaticGraph>> = head_dirs
        .iter()
        .skip(1)
        .filter_map(|d| load_graph_cached(&graph_path(d)).ok())
        .filter(|g| {
            g.functions_x_graphs
                .as_ref()
                .is_some_and(|v| !v.is_empty())
        })
        .collect();
    // One graph for hydrate: always a LayeredGraph (a single-layer one when no
    // computed layer is installed). Whether it wraps one layer or many is
    // internal to it - hydrate never sees the multiplicity.
    let composed = cached_layered_graph(&base_graph, &overlays);
    let langs: Vec<&str> = match language.as_deref() {
        Some(l) => vec![l, "ga", "gd", "en"],
        None => vec!["ga", "gd", "en"],
    };
    let dirs: Vec<&Path> = head_dirs.iter().map(|d| Path::new(d.as_str())).collect();
    // Register the graph-attached Derive providers (greasan-gramadan) and pass
    // each dir's layer id, so a computed layer's presence spine materialises its
    // forms JIT. `member_of` in the layer's functions_x_graphs config matches a
    // layer id below; with no computed layer installed this is a no-op (nothing
    // declares a compute-tiles function, so nothing fires).
    let functions = gramadan_registry(&dirs);
    let layer_ids: Vec<String> = head_dirs.iter().map(|d| layer_id_of(d)).collect();
    ros_madair_duck::hydrate_layers(
        &dirs,
        &resource_id,
        &composed,
        &langs,
        Some(&layer_ids),
        &functions,
    )
    .map_err(|e| e.to_string())
}

/// Pre-warm every per-hydrate cache for a layer set so the FIRST entry open is as
/// fast as the rest: the app-side graph / LayeredGraph / functions-registry caches,
/// and the duck-side reader pool + concept-label cache. Fire-and-forget from the
/// frontend after the layer set is known; safe to run off the UI thread and
/// idempotent (each cache no-ops once warm).
#[tauri::command]
pub fn v2_prewarm(head_dirs: Vec<String>) -> Result<(), String> {
    let head_dirs = present_layer_dirs(head_dirs);
    let dirs: Vec<&Path> = head_dirs.iter().map(|d| Path::new(d.as_str())).collect();
    if let Some(base) = head_dirs.first() {
        let base_graph = load_graph_cached(&graph_path(base))?;
        let overlays: Vec<std::sync::Arc<StaticGraph>> = head_dirs
            .iter()
            .skip(1)
            .filter_map(|d| load_graph_cached(&graph_path(d)).ok())
            .filter(|g| g.functions_x_graphs.as_ref().is_some_and(|v| !v.is_empty()))
            .collect();
        let _ = cached_layered_graph(&base_graph, &overlays);
        let _ = gramadan_registry(&dirs);
    }
    ros_madair_duck::prewarm(&dirs);
    Ok(())
}

/// A layer's id is its directory basename (the layer name) - the same value a
/// computed layer's `functions_x_graphs` config carries in `member_of`.
fn layer_id_of(dir: &str) -> String {
    Path::new(dir)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.to_string())
}

/// Build the FunctionsRegistry for a hydrate pass: the gramadan Derive provider,
/// with a [`GramadanVocab`] resolved from the loaded concept catalogs so its
/// generated `gram_features` reference the SAME concepts as attested BuNaMo forms
/// (and therefore merge cleanly rather than duplicating).
fn gramadan_registry(dirs: &[&Path]) -> std::sync::Arc<alizarin_core::FunctionsRegistry> {
    use std::sync::{Mutex, OnceLock};
    // The vocab is resolved by reading every layer's concept_catalog.parquet - too
    // heavy to redo per entry open, and stable for a given layer set (concept ids
    // don't change per entry). Cache the built registry, keyed by the dir set, so
    // it is built ONCE per installed-layer set and reused across hydrates.
    static CACHE: OnceLock<Mutex<HashMap<String, std::sync::Arc<alizarin_core::FunctionsRegistry>>>> =
        OnceLock::new();
    let key = dirs
        .iter()
        .map(|d| d.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("gramadan-registry cache poisoned");
    if let Some(r) = cache.get(&key) {
        return r.clone();
    }
    let mut registry = alizarin_core::default_functions_registry();
    greasan_gramadan::register(&mut registry, gramadan_vocab(dirs));
    let arc = std::sync::Arc::new(registry);
    cache.insert(key, arc.clone());
    arc
}

/// Invert the concept catalog (id -> label) for the labels the gramadan provider
/// stamps: the axis tags (number/case), gender, and the form dialect. Labels come
/// straight from `build-bunamo-data.py`'s vocabulary, so the two paths agree.
fn gramadan_vocab(dirs: &[&Path]) -> greasan_gramadan::GramadanVocab {
    use ros_madair_duck::{DuckReader, SpatialSource};
    // label -> concept id, folded across every loaded catalog (first wins).
    let mut by_label: HashMap<String, String> = HashMap::new();
    for dir in dirs {
        let catalog = dir.join("concept_catalog.parquet");
        if !catalog.is_file() {
            continue;
        }
        let glob = format!("{}/tiles_*.parquet", dir.display());
        let Ok(duck) = DuckReader::open_with(&glob, SpatialSource::None)
            .and_then(|d| d.with_catalog(&catalog.to_string_lossy()))
        else {
            continue;
        };
        if let Ok(labels) = duck.concept_labels() {
            for (id, label) in labels {
                by_label.entry(label).or_insert(id);
            }
        }
    }

    let mut tag_concepts = HashMap::new();
    for tag in [
        "singular",
        "plural",
        "nominative",
        "genitive",
        "vocative",
        "dative",
        "masculine",
        "feminine",
    ] {
        if let Some(id) = by_label.get(tag) {
            tag_concepts.insert(tag.to_string(), id.clone());
        }
    }
    // gender node concept id -> is-feminine. Match on the label prefix so both a
    // dedicated Gender collection ("Masculine"/"Feminine") and the feature tags
    // ("masculine"/"feminine") resolve.
    let mut gender_is_fem = HashMap::new();
    for (label, id) in &by_label {
        let l = label.to_lowercase();
        if l.starts_with("fem") {
            gender_is_fem.insert(id.clone(), true);
        } else if l.starts_with("masc") {
            gender_is_fem.insert(id.clone(), false);
        }
    }
    // form_dialect = "Irish" (build-bunamo stamps this on every form).
    let dialect_concept = by_label
        .get("Irish")
        .or_else(|| by_label.get("Irish (General)"))
        .cloned()
        .unwrap_or_default();

    greasan_gramadan::GramadanVocab {
        tag_concepts,
        gender_is_fem,
        dialect_concept,
        // Source code stamped on every generated form: the gramadan-forms layer's
        // tag, so the UI attributes computed forms to it (a tab per source,
        // distinct from an attested BuNaMo layer). Matches family.ts sourceLabels.
        source_label: "gf".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Reverse-cognate lookup (P12) - `ros-madair-read`'s `Layers::cited_by`.
//
// The inverse of a forward `HasLink` predicate: opening entry X, find every
// entry that LINKS TO X through `node_path` in the composed view. This restores
// v1's continuum behaviour - the Irish "fear" (5b663193…) surfaces the MacBain
// "fear" (e98ed0c3…) which lists it as a cognate via `cognate_entry_id`, so the
// loader can fold MacBain's etymology into the Irish entry. Registry + graph are
// the base layer's, exactly as `v2_query_layers`.
// ---------------------------------------------------------------------------

/// Parquet counterpart of `v2_cited_by`: reverse-link over the Parquet
/// `link_targets`. The sqlite `open_layers`/`Layers::cited_by` path above cannot
/// read a v2-duck head (there is no `head.sqlite`), so it returned nothing here -
/// which left the Logainm placenames section (a `cited_by` over the place graph's
/// `element_entry` node) empty on duck builds. Resolve the node alias against the
/// base graph (the place head for placenames), then union the reverse-lookup
/// across the layer set (pooled readers).
#[tauri::command]
pub fn v2_cited_by(
    head_dirs: Vec<String>,
    uri: String,
    node_path: String,
) -> Result<Vec<String>, String> {
    let Some(base) = head_dirs.first() else {
        return Err("v2_cited_by: no layers given".to_string());
    };
    let graph = load_graph_cached(&graph_path(base))?;
    let node_id = graph
        .get_node_by_alias(&node_path)
        .map(|n| n.nodeid.clone())
        .ok_or_else(|| format!("v2_cited_by: unknown alias '{node_path}'"))?;
    let dirs: Vec<&Path> = head_dirs.iter().map(|d| Path::new(d.as_str())).collect();
    // `cited_by` is now a DuckReader method (the free fn was retired when
    // ros-madair-read folded into ros-madair-duck). Open the layer set and query.
    let duck = ros_madair_duck::DuckReader::open_layers(&dirs).map_err(|e| e.to_string())?;
    duck.cited_by(&node_id, &uri).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Geo-point lookup (map(layer, filter) primitive) - a single indexed SQL join
// on a head that carries the spine/geo tables, no hydration.
//
// For a reverse-link `node` (e.g. the place graph's `name_elements.element_entry`
// node) and a `target` resource (the headword the user opened), return every
// resource that cites the target through that node, each with its spine
// `display_name` and its point geometry from `geo_bbox` (min == max for points).
// This is the generic backing query for `MapView`: the only place-specific
// assumption is the `spine_place`/`geo_bbox` table names of the place head - the
// node and target are opaque UUIDs the caller has already resolved.
// ---------------------------------------------------------------------------

/// Resolve the geo-points for a `(node_uri, target_uri)` filter against a single
/// head. `node_path` and `target_uri` are `dict.term` UUIDs already (the caller
/// passes the `element_entry` node uuid and the headword resource uuid - no alias
/// resolution against the graph, so this works even though the node lives in the
/// place graph rather than the composed stack's base graph). Returns
/// `[{id, name, lat, lng}]`, one row per citing place with geometry.
///
/// Parquet path (v2-duck): DuckReader::geo_points over `tiles_*.parquet` - the
/// node-precise per-node `link_targets` reverse-lookup + geo point, no spatial
/// extension needed (point columns, not a spatial predicate).
#[tauri::command]
pub fn v2_geo_points(
    head_dir: String,
    node_path: String,
    target_uri: String,
) -> Result<Vec<Value>, String> {
    use ros_madair_duck::{DuckReader, SpatialSource};
    let glob = format!("{head_dir}/tiles_*.parquet");
    let duck = DuckReader::open_with(&glob, SpatialSource::None).map_err(|e| e.to_string())?;
    let points = duck
        .geo_points(&node_path, &target_uri)
        .map_err(|e| e.to_string())?;
    Ok(points
        .into_iter()
        .map(|(id, name, lat, lng)| {
            serde_json::json!({ "id": id, "name": name, "lat": lat, "lng": lng })
        })
        .collect())
}

/// Re-emit a v2 head in place from an in-memory business-data JSON - the app's
/// write path (the first one). `head_dir` is the head to (re)generate (e.g. the
/// note/flag overlay), `graph_id` its resource model, `business_data_json` the
/// `{"business_data":{"resources":[…]}}` string alizarin builds on the JS side.
///
/// The head's own `graph.json` doubles as the prebuild resource model, so we only
/// need the resources. Emit uses the same `https://example.org/` base_uri every
/// `regen-layer-v2` head carries, so `Layers::open` still composes the stack.
#[tauri::command]
pub fn v2_emit_overlay(
    app: tauri::AppHandle,
    head_dir: String,
    graph_id: String,
    business_data_json: String,
) -> Result<(), String> {
    use std::fs;
    let head = Path::new(&head_dir);
    let graph_json = head.join("graph.json");
    if !graph_json.is_file() {
        return Err(format!("v2_emit_overlay: no graph.json at {head_dir}"));
    }
    // Temp prebuild dir beside the head.
    let prebuild = head.with_file_name(format!(".prebuild-{graph_id}"));
    let _ = fs::remove_dir_all(&prebuild);
    let models = prebuild.join("graphs/resource_models");
    fs::create_dir_all(&models).map_err(|e| e.to_string())?;
    fs::create_dir_all(prebuild.join("business_data")).map_err(|e| e.to_string())?;
    let model_dst = models.join(format!("{graph_id}.json"));
    fs::copy(&graph_json, &model_dst).map_err(|e| e.to_string())?;
    fs::write(
        prebuild.join(format!("business_data/{graph_id}.json")),
        &business_data_json,
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        prebuild.join("manifest.json"),
        r#"{"base_uri":"https://flaxandteal.org/ontology/goidelic#","source":"note","source_tag":"NO","built":"1970-01-01T00:00:00Z","license":"CC0 (app-generated)"}"#,
    )
    .map_err(|e| e.to_string())?;

    // Emit clears head_dir, so re-emit in place then restore graph.json.
    let _ = fs::remove_dir_all(head);
    fs::create_dir_all(head).map_err(|e| e.to_string())?;
    // Progress → the frontend as `emit-progress` events; a progress bar does
    // `listen("emit-progress", e => …)` with `{ phase | done, total }`.
    //
    // For the small note/flag overlay this synchronous call is fine. A LARGE
    // layer build (Path A, HANDOFF-streaming-build.md) should run this on a
    // blocking thread (`tauri::async_runtime::spawn_blocking`) so it does not tie
    // up a command worker for minutes, and should thread a cancel signal (an
    // `AtomicBool` set by a sibling command) into the `ControlFlow` below.
    // Slice 7: editable overlays (notes/flags) are Parquet layers on the duck
    // substrate, so the write path re-emits a Parquet dataset the DuckReader can
    // compose - not a sqlite head. head_dir was cleared above, so there is no FTS
    // sidecar to preserve here (overlays are not full-text searched).
    {
        use tauri::Manager;
        let cfg_by_graph: std::collections::HashMap<String, ros_madair_emit::ClusterConfig> =
            std::collections::HashMap::new();
        ros_madair_emit::emit_parquet(
            prebuild.to_str().ok_or("non-utf8 prebuild path")?,
            head.to_str().ok_or("non-utf8 head path")?,
            "https://example.org/",
            &ros_madair_emit::default_registry(),
            &cfg_by_graph,
        )
        .map_err(|e| format!("emit_parquet: {e}"))?;
        // emit_parquet writes a real self-describing manifest.json now (real
        // snapshot_id + handlers + models) - no stub. Sign the overlay in place so
        // an edited/frozen overlay carries the same attestations.json as any other
        // head; the read side verifies it uniformly.
        let key = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("signing")
            .join("ed25519.key");
        ros_madair_emit::sign_head(head, &key).map_err(|e| format!("sign_head: {e}"))?;
    }
    fs::copy(&model_dst, head.join("graph.json")).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&prebuild);
    Ok(())
}

/// The result of verifying a layer head against its own attestations. `status`
/// is one of `"verified"` (green shield), `"unverified"` (yellow — unsigned), or
/// `"tampered"` (red — altered/invalid). `reason` is human-facing copy for the
/// enable-time warning; empty for verified.
/// PINNED ROOT — Flax & Teal's platform attestation key. Trusted because it
/// ships INSIDE the signed APK; this is the anchor the whole confirmation chain
/// hangs off. An attestation whose actor is F&T AND whose signing key is this key
/// is CONFIRMED, not merely self-asserted.
///
/// NOTE: this is the current dev/publisher key. For a real release, replace it
/// with F&T's canonical key (`ros-madair-emit pubkey <key>`). Stage 2 extends the
/// trusted set to recognised UPSTREAM publishers via an F&T-attested actor→key
/// registry (the catalogue layer), so `endorsed`-by-upstream can confirm too.
const FT_ROOT_ACTOR: &str = "https://flaxandteal.co.uk/#organization";
const FT_ROOT_KEY: &str = "z6Mko9zKqAQFkifiqRe6t2Cntw7NHs7SiFboTWZednS6wJsf";

#[derive(serde::Serialize)]
pub struct LayerVerification {
    pub status: String,
    pub reason: String,
    /// Named attribution when the (verified) layer carries one: the actor's name
    /// and role ("derived" = produced from public records by them; "endorsed" =
    /// the authoritative upstream publisher vouches). Empty when anonymous.
    pub author: String,
    pub role: String,
    /// True when the attribution's signer is a PINNED/registered key (currently
    /// F&T's root) — "confirmed" rather than merely self-asserted.
    pub confirmed: bool,
}

/// Verify an installed layer by name: resolve its head at `{app_data}/layers/
/// {name}`, recompute the snapshot_id from the artifacts on disk, and check the
/// signature over it (see `ros_madair_emit::verify_head`). Taking a name (not a
/// path) lets the UI verify any layer - visible or hidden - without knowing the
/// native head location. Drives the three-shield badge + the enable-time gate:
/// verified enables silently; unverified/tampered raise a warn popup
/// (Accept/Reject) rather than hard-refusing.
#[tauri::command]
pub fn v2_verify_layer(
    app: tauri::AppHandle,
    name: String,
) -> Result<LayerVerification, String> {
    use tauri::Manager;
    let head = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("layers")
        .join(&name);
    let (status, reason, author, role, confirmed) = match ros_madair_emit::verify_head(&head) {
        Ok(ros_madair_emit::HeadTrust::Verified { attributions, .. }) => {
            // Surface the first named attribution, if any (endorsed outranks
            // derived — an upstream endorsement is the stronger claim to show).
            let pick = attributions
                .iter()
                .find(|a| a.role == ros_madair_emit::Role::Endorsed)
                .or_else(|| attributions.first());
            match pick {
                Some(a) => {
                    let role = match a.role {
                        ros_madair_emit::Role::Endorsed => "endorsed",
                        ros_madair_emit::Role::Derived => "derived",
                        ros_madair_emit::Role::Authored => "authored",
                    };
                    // CONFIRM against the pinned root: the actor is F&T and the
                    // signer is the pinned key. (Stage 2 widens this to a registry.)
                    let confirmed =
                        a.actor_id == FT_ROOT_ACTOR && a.public_key_multibase == FT_ROOT_KEY;
                    (
                        "verified",
                        String::new(),
                        a.actor_name.clone(),
                        role.to_string(),
                        confirmed,
                    )
                }
                None => ("verified", String::new(), String::new(), String::new(), false),
            }
        }
        Ok(ros_madair_emit::HeadTrust::Unsigned) => {
            ("unverified", String::new(), String::new(), String::new(), false)
        }
        Ok(ros_madair_emit::HeadTrust::Failed { reason }) => {
            ("tampered", reason, String::new(), String::new(), false)
        }
        // No manifest at that path (never built here, or a differently-located
        // head): report unverified rather than error out the whole list.
        Err(_) => ("unverified", String::new(), String::new(), String::new(), false),
    };
    Ok(LayerVerification {
        status: status.to_string(),
        reason,
        author,
        role,
        confirmed,
    })
}

/// DEBUG on-device emit memory measurement (HANDOFF-streaming-build.md). If the
/// marker file `{app_data}/files/emit-measure/RUN` exists - pushed via adb for a
/// measurement run - stream-emit the prebuild directory at `emit-measure/prebuild/`
/// into `emit-measure/out/` on a background thread IN THIS PROCESS, so an external
/// `dumpsys meminfo` poll captures the real peak RSS of the memory-bounded emit
/// over a large corpus. Writes `summary.json` (the emit summary, incl. snapshot_id
/// - cross-check against the desktop build) and a `DONE` marker on completion. The
/// marker is one-shot (removed on start). Inert in production: the marker never
/// exists. No-op in a `v2` build without `v2-emit`.
pub fn maybe_run_emit_measurement(app: tauri::AppHandle) {
    use tauri::Manager;
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let base = app_data.join("files/emit-measure");
    if !base.join("RUN").is_file() {
        return;
    }
    std::thread::spawn(move || {
        let prebuild = base.join("prebuild");
        let out = base.join("out");
        let _ = std::fs::remove_dir_all(&out);
        let _ = std::fs::remove_file(base.join("DONE"));
        let _ = std::fs::remove_file(base.join("RUN")); // one-shot
        let prebuild_s = prebuild.to_string_lossy();
        let out_s = out.to_string_lossy();
        let cfg_by_graph: std::collections::HashMap<String, ros_madair_emit::ClusterConfig> =
            std::collections::HashMap::new();
        let mut on_progress =
            |_p: ros_madair_emit::EmitProgress| std::ops::ControlFlow::Continue(());
        // Parquet emit (duck read path); the sqlite emit_with_progress/EmitOptions
        // were retired with the head engine.
        let summary = match ros_madair_emit::emit_parquet_with_progress(
            &prebuild_s,
            &out_s,
            "https://example.org/",
            &ros_madair_emit::default_registry(),
            &cfg_by_graph,
            &mut on_progress,
        ) {
            Ok(s) => serde_json::to_string(&s)
                .unwrap_or_else(|e| format!("{{\"ser_err\":\"{e}\"}}")),
            Err(e) => format!("{{\"error\":\"{}\"}}", e.to_string().replace('"', "'")),
        };
        let _ = std::fs::write(base.join("summary.json"), summary);
        let _ = std::fs::write(base.join("DONE"), "1");
    });
}
