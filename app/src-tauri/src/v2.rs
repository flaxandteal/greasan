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
use ros_madair_read::Layers;
use rusqlite::types::ValueRef;
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
#[cfg(feature = "v2-duck")]
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
#[cfg(feature = "v2-duck")]
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
    let lg = std::sync::Arc::new(alizarin_core::LayeredGraph::over(
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
    let manifest = ros_madair_read::load_manifest(head_dir).map_err(|e| e.to_string())?;
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

/// Hydrate one resource to a schema-aware JSON tree.
///
/// `ros-madair-read` owns the path now (UUID → dict → spine `rid` →
/// `fragment_dir` → chunks → `resource_tiles_to_tree`). Kept on top of it: the
/// cross-check `hydrate_resource` does not do by itself - the number of tiles
/// actually recovered from the chunks must equal what `fragment_dir` says this
/// resource has. A mismatch means a chunk went missing or a resource id is
/// duplicated across chunks, i.e. a corrupt artifact. Hard error, rather than a
/// quietly truncated entry.
pub fn hydrate_resource(
    head_dir: &Path,
    resource_uuid: &str,
    graph: &StaticGraph,
    languages: &[&str],
) -> Result<Value, String> {
    let tiles = ros_madair_read::resource_tiles_with_graph(head_dir, resource_uuid, Some(graph))
        .map_err(|e| e.to_string())?;
    let expected =
        ros_madair_read::expected_tile_count(head_dir, resource_uuid).map_err(|e| e.to_string())?;
    if tiles.len() as i64 != expected {
        return Err(format!(
            "chunk/fragment_dir mismatch for {resource_uuid}: recovered {} tiles, \
             fragment_dir expects {expected}",
            tiles.len()
        ));
    }
    // Display tree: fold this head's vocab labels so `reference` fields render as
    // labels (not raw UUIDs) - the alizarin-managed rendering. The tile-count
    // cross-check above still runs.
    let conn = ros_madair_read::open_head(head_dir).map_err(|e| e.to_string())?;
    let mut labels = HashMap::new();
    ros_madair_read::read_vocab_labels(&conn, &mut labels).map_err(|e| e.to_string())?;
    ros_madair_read::hydrate_tiles_with_labels(&tiles, resource_uuid, graph, &labels, languages)
        .map_err(|e| e.to_string())
}

/// Parquet path (v2-duck): compile the IR to DuckDB SQL over the dir's
/// `tiles_*.parquet` via DuckReader, per measure. Same `{results: [{measure,
/// coarse, columns, rows}]}` shape; `coarse` is always false (DuckDB's HasLink is
/// exact per-tile, unlike the sqlite head's chunk-granularity summary). No spatial
/// (SpatialSource::None) - run_query's callers are lexical/catalogue, not geo.
#[cfg(feature = "v2-duck")]
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

/// Compile a `ros-madair-query` IR against the graph and execute each
/// compiled statement against the head.
///
/// Returns `{"results": [{"measure", "coarse", "columns", "rows"}, ...]}`.
/// `coarse: true` marks a chunk-granularity (link) over-approximation whose
/// rows must be re-verified against hydrated tiles.
#[cfg(not(feature = "v2-duck"))]
pub fn run_query(head_dir: &Path, ir: &Value, graph: &StaticGraph) -> Result<Value, String> {
    let query: ros_madair_query::Query =
        serde_json::from_value(ir.clone()).map_err(|e| format!("bad query IR: {e}"))?;
    let registry = registry(head_dir)?;
    let statements = ros_madair_query::compile_with_registry(&query, graph, Some(&registry))
        // The typed error is the repair contract - hand it to the caller as
        // structured JSON, not a flattened string, where we can.
        .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?;

    let conn = ros_madair_read::open_head(head_dir).map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for stmt in &statements {
        let mut prepared = conn
            .prepare(&stmt.sql)
            .map_err(|e| format!("prepare `{}`: {e}", stmt.sql))?;
        let params: Vec<Box<dyn rusqlite::ToSql>> = stmt
            .params
            .iter()
            .map(|p| match p {
                ros_madair_query::Param::Text(s) => Box::new(s.clone()) as Box<dyn rusqlite::ToSql>,
                ros_madair_query::Param::Int(i) => Box::new(*i) as Box<dyn rusqlite::ToSql>,
                ros_madair_query::Param::Real(r) => Box::new(*r) as Box<dyn rusqlite::ToSql>,
            })
            .collect();
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

        let columns: Vec<String> = prepared
            .column_names()
            .into_iter()
            .map(str::to_string)
            .collect();
        let mut rows = Vec::new();
        let mut cursor = prepared
            .query(rusqlite::params_from_iter(param_refs))
            .map_err(|e| format!("execute: {e}"))?;
        while let Some(row) = cursor.next().map_err(|e| format!("row: {e}"))? {
            let mut out = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                out.push(sql_value_to_json(
                    row.get_ref(i).map_err(|e| format!("column {i}: {e}"))?,
                ));
            }
            rows.push(Value::Array(out));
        }
        results.push(serde_json::json!({
            "measure": stmt.measure,
            "coarse": stmt.coarse,
            "columns": columns,
            "rows": rows,
        }));
    }
    Ok(serde_json::json!({ "results": results }))
}

fn sql_value_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn graph_path(head_dir: &str) -> PathBuf {
    Path::new(head_dir).join("graph.json")
}

/// Parquet path (v2-duck): tiles from the `data` column via DuckReader::hydrate,
/// reusing the storage-agnostic tile→tree half. No spatial needed.
#[cfg(feature = "v2-duck")]
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

#[cfg(not(feature = "v2-duck"))]
#[tauri::command]
pub fn v2_hydrate(head_dir: String, resource_id: String, language: Option<String>) -> Result<Value, String> {
    let graph = load_graph(&graph_path(&head_dir))?;
    // Goidelic display preference chain; requested language first if given.
    // serialize_string still falls back to first-available, so absent languages
    // are skipped rather than blanking the field.
    let langs: Vec<&str> = match language.as_deref() {
        Some(l) => vec![l, "ga", "gd", "en"],
        None => vec!["ga", "gd", "en"],
    };
    hydrate_resource(Path::new(&head_dir), &resource_id, &graph, &langs)
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

fn open_layers(head_dirs: &[String]) -> Result<Layers, String> {
    let paths: Vec<PathBuf> = head_dirs.iter().map(PathBuf::from).collect();
    let refs: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
    Layers::open(&refs).map_err(|e| {
        // Surface composition failures - most notably a layer whose base_uri
        // disagrees with the stack, which otherwise breaks hydrate SILENTLY (the
        // typed error only reaches the JS caller, never logcat). Now grep-able.
        let msg = format!(
            "Layers::open FAILED over {} head(s): {e} - dirs: {head_dirs:?}",
            refs.len()
        );
        logcat_error(&msg);
        msg
    })
}

/// Compile a `ros-madair-query` IR against the composed view of a layer stack.
///
/// The registry and graph are taken from the first (base) layer - the
/// composability check in `Layers::open` guarantees the rest agree. A
/// `CountRecords` measure returns a composed count (`Layers::count`); anything
/// else resolves the matching UUIDs (`Layers::resolve`), since a number cannot be
/// precedence-filtered.
#[tauri::command]
pub fn v2_query_layers(head_dirs: Vec<String>, ir: Value) -> Result<Value, String> {
    let Some(base) = head_dirs.first() else {
        return Err("v2_query_layers: no layers given".to_string());
    };
    let graph = load_graph(&graph_path(base))?;
    let registry = registry(Path::new(base))?;
    let query: ros_madair_query::Query =
        serde_json::from_value(ir).map_err(|e| format!("bad query IR: {e}"))?;
    let layers = open_layers(&head_dirs)?;

    let wants_count = query
        .measures
        .iter()
        .any(|m| *m == ros_madair_query::Measure::CountRecords);
    if wants_count {
        let count = layers
            .count(&query, &graph, Some(&registry))
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "measure": "count_records", "count": count }))
    } else {
        let ids = layers
            .resolve(&query, &graph, Some(&registry))
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "measure": "select_ids", "ids": ids }))
    }
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
#[cfg(feature = "v2-duck")]
#[tauri::command]
pub fn v2_closure(head_dirs: Vec<String>) -> Result<HashMap<String, String>, String> {
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

#[cfg(not(feature = "v2-duck"))]
#[tauri::command]
pub fn v2_closure(head_dirs: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    for dir in &head_dirs {
        let conn = ros_madair_read::open_head(Path::new(dir)).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT d.term, v.label FROM vocab v \
                 JOIN dict d ON d.term_id = v.concept \
                 WHERE v.label IS NOT NULL",
            )
            .map_err(|e| format!("prepare vocab-label query for {dir}: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("query vocab.label for {dir}: {e}"))?;
        for row in rows {
            let (uuid, label) = row.map_err(|e| format!("row from {dir}: {e}"))?;
            if !label.is_empty() {
                map.insert(uuid, label);
            }
        }
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
#[cfg(feature = "v2-duck")]
#[tauri::command]
pub fn v2_descriptors(
    head_dirs: Vec<String>,
    uris: Vec<String>,
) -> Result<HashMap<String, String>, String> {
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

/// sqlite-head path (default / shipping): `spine.display_name` ⨝ `dict`.
#[cfg(not(feature = "v2-duck"))]
#[tauri::command]
pub fn v2_descriptors(
    head_dirs: Vec<String>,
    uris: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for dir in &head_dirs {
        let conn = ros_madair_read::open_head(Path::new(dir)).map_err(|e| e.to_string())?;
        // Spine tables (one per model) are named in sqlite_master, not user input.
        let spines: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'spine_%'")
                .map_err(|e| format!("list spines for {dir}: {e}"))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| format!("query spines for {dir}: {e}"))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for uri in &uris {
            if out.contains_key(uri) {
                continue;
            }
            for spine in &spines {
                let sql = format!(
                    "SELECT s.display_name FROM {spine} s \
                     JOIN dict d ON d.term_id = s.term_id \
                     WHERE d.term = ?1 LIMIT 1"
                );
                if let Ok(name) = conn.query_row(&sql, [uri], |r| r.get::<_, String>(0)) {
                    if !name.is_empty() {
                        out.insert(uri.clone(), name);
                        break;
                    }
                }
            }
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
#[cfg(feature = "v2-duck")]
#[tauri::command]
pub fn v2_search_display(
    head_dirs: Vec<String>,
    uris: Vec<String>,
    pos_node: String,
    dialect_node: String,
) -> Result<HashMap<String, SearchDisplay>, String> {
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

#[cfg(not(feature = "v2-duck"))]
#[tauri::command]
pub fn v2_search_display(
    head_dirs: Vec<String>,
    uris: Vec<String>,
    pos_node: String,
    dialect_node: String,
) -> Result<HashMap<String, SearchDisplay>, String> {
    let mut out: HashMap<String, SearchDisplay> = HashMap::new();
    for dir in &head_dirs {
        if uris.iter().all(|u| out.contains_key(u)) {
            break;
        }
        let conn = ros_madair_read::open_head(Path::new(dir)).map_err(|e| e.to_string())?;
        let spines: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'spine_%'")
                .map_err(|e| format!("list spines for {dir}: {e}"))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| format!("query spines for {dir}: {e}"))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        // Intern the POS + dialect node UUIDs against THIS head's dict.
        let node_id = |u: &str| -> Option<i64> {
            conn.query_row("SELECT term_id FROM dict WHERE term=?1", [u], |r| r.get::<_, i64>(0))
                .ok()
        };
        let pos_nid = node_id(&pos_node);
        let dial_nid = node_id(&dialect_node);
        for uri in &uris {
            if out.contains_key(uri) {
                continue;
            }
            // rid + headword from the first spine that has this uri.
            let mut found: Option<(i64, String)> = None;
            for spine in &spines {
                let sql = format!(
                    "SELECT s.rid, s.display_name FROM {spine} s \
                     JOIN dict d ON d.term_id = s.term_id WHERE d.term = ?1 LIMIT 1"
                );
                if let Ok(row) = conn.query_row(&sql, [uri], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                }) {
                    found = Some(row);
                    break;
                }
            }
            let Some((rid, headword)) = found else {
                continue;
            };
            let mut disp = SearchDisplay {
                headword,
                pos: String::new(),
                dialects: Vec::new(),
            };
            // rid + node are i64 from the head's own dict - safe to inline (no
            // user text), avoiding a params dependency.
            if let Some(pn) = pos_nid {
                let sql = format!(
                    "SELECT v.label FROM concept_tags ct JOIN vocab v ON v.concept = ct.concept \
                     WHERE ct.rid = {rid} AND ct.node = {pn} LIMIT 1"
                );
                if let Ok(p) = conn.query_row(&sql, [], |r| r.get::<_, String>(0)) {
                    disp.pos = p;
                }
            }
            if let Some(dn) = dial_nid {
                let sql = format!(
                    "SELECT DISTINCT v.label FROM concept_tags ct JOIN vocab v \
                     ON v.concept = ct.concept WHERE ct.rid = {rid} AND ct.node = {dn}"
                );
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                        disp.dialects = rows.filter_map(|r| r.ok()).collect();
                    }
                }
            }
            out.insert(uri.clone(), disp);
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
#[cfg(feature = "v2-duck")]
#[tauri::command]
pub fn v2_hydrate_layers(head_dirs: Vec<String>, resource_id: String, language: Option<String>) -> Result<Value, String> {
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

/// A layer's id is its directory basename (the layer name) - the same value a
/// computed layer's `functions_x_graphs` config carries in `member_of`.
#[cfg(feature = "v2-duck")]
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
#[cfg(feature = "v2-duck")]
fn gramadan_registry(dirs: &[&Path]) -> alizarin_core::FunctionsRegistry {
    let mut registry = alizarin_core::default_functions_registry();
    greasan_gramadan::register(&mut registry, gramadan_vocab(dirs));
    registry
}

/// Invert the concept catalog (id -> label) for the labels the gramadan provider
/// stamps: the axis tags (number/case), gender, and the form dialect. Labels come
/// straight from `build-bunamo-data.py`'s vocabulary, so the two paths agree.
#[cfg(feature = "v2-duck")]
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

#[cfg(not(feature = "v2-duck"))]
#[tauri::command]
pub fn v2_hydrate_layers(head_dirs: Vec<String>, resource_id: String, language: Option<String>) -> Result<Value, String> {
    let Some(base) = head_dirs.first() else {
        return Err("v2_hydrate_layers: no layers given".to_string());
    };
    let graph = load_graph(&graph_path(base))?;
    let layers = open_layers(&head_dirs)?;
    let langs: Vec<&str> = match language.as_deref() {
        Some(l) => vec![l, "ga", "gd", "en"],
        None => vec!["ga", "gd", "en"],
    };
    layers
        .hydrate_resource(&resource_id, &graph, &langs)
        .map_err(|e| e.to_string())
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

/// Resolve the composed set of resources that CITE `uri` through `node_path`
/// (a link-datatype node alias, e.g. `cognate_entry_id`). Base layer is
/// authoritative for graph + registry; `Layers::cited_by` owns the
/// coarse-then-verify scan and per-nodegroup composition.
#[tauri::command]
pub fn v2_cited_by(
    head_dirs: Vec<String>,
    uri: String,
    node_path: String,
) -> Result<Vec<String>, String> {
    let Some(base) = head_dirs.first() else {
        return Err("v2_cited_by: no layers given".to_string());
    };
    let graph = load_graph(&graph_path(base))?;
    let registry = registry(Path::new(base))?;
    let layers = open_layers(&head_dirs)?;
    layers
        .cited_by(&uri, &node_path, &graph, Some(&registry))
        .map_err(|e| e.to_string())
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
#[cfg(feature = "v2-duck")]
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

#[cfg(not(feature = "v2-duck"))]
#[tauri::command]
pub fn v2_geo_points(
    head_dir: String,
    node_path: String,
    target_uri: String,
) -> Result<Vec<Value>, String> {
    let conn = ros_madair_read::open_head(Path::new(&head_dir)).map_err(|e| e.to_string())?;
    // Table names are the place head's fixed spine/geo tables, not user input;
    // the two UUIDs are bound parameters.
    let sql = "SELECT dt2.term AS id, sp.display_name AS name, \
                      gb.min_lat AS lat, gb.min_lng AS lng \
               FROM reverse_links rl \
               JOIN dict nd  ON nd.term = ?1 \
               JOIN dict td  ON td.term = ?2 \
               JOIN spine_place sp ON sp.term_id = rl.source \
               JOIN dict dt2 ON dt2.term_id = rl.source \
               JOIN geo_bbox gb ON gb.rid = sp.rid \
               WHERE rl.node = nd.term_id AND rl.target = td.term_id";
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("prepare geo query: {e}"))?;
    let rows = stmt
        .query_map([&node_path, &target_uri], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "lat": r.get::<_, f64>(2)?,
                "lng": r.get::<_, f64>(3)?,
            }))
        })
        .map_err(|e| format!("geo query for {head_dir}: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("geo rows: {e}"))
}

/// Re-emit a v2 head in place from an in-memory business-data JSON - the app's
/// write path (the first one). `head_dir` is the head to (re)generate (e.g. the
/// note/flag overlay), `graph_id` its resource model, `business_data_json` the
/// `{"business_data":{"resources":[…]}}` string alizarin builds on the JS side.
///
/// The head's own `graph.json` doubles as the prebuild resource model, so we only
/// need the resources. Emit uses the same `https://example.org/` base_uri every
/// `regen-layer-v2` head carries, so `Layers::open` still composes the stack.
#[cfg(all(feature = "v2", feature = "v2-emit"))]
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
    #[cfg(feature = "v2-duck")]
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
    #[cfg(not(feature = "v2-duck"))]
    {
        use tauri::Emitter;
        let mut on_progress = |p: ros_madair_emit::EmitProgress| {
            let payload = match p {
                ros_madair_emit::EmitProgress::Phase(name) => {
                    serde_json::json!({ "phase": name })
                }
                ros_madair_emit::EmitProgress::Streaming { done, total } => {
                    serde_json::json!({ "done": done, "total": total })
                }
            };
            let _ = app.emit("emit-progress", payload);
            std::ops::ControlFlow::Continue(())
        };
        ros_madair_emit::emit_with_progress(
            prebuild.to_str().ok_or("non-utf8 prebuild path")?,
            head.to_str().ok_or("non-utf8 head path")?,
            "https://example.org/",
            &ros_madair_emit::EmitOptions::default(),
            &ros_madair_emit::default_registry(),
            &mut on_progress,
        )
        .map_err(|e| format!("emit: {e}"))?;
    }
    fs::copy(&model_dst, head.join("graph.json")).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&prebuild);
    Ok(())
}

/// Stub when built without the emit crate (`v2` but not `v2-emit`).
#[cfg(all(feature = "v2", not(feature = "v2-emit")))]
#[tauri::command]
pub fn v2_emit_overlay(
    _head_dir: String,
    _graph_id: String,
    _business_data_json: String,
) -> Result<(), String> {
    Err("v2_emit_overlay: this build lacks the v2-emit feature".to_string())
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
#[cfg(feature = "v2")]
const FT_ROOT_ACTOR: &str = "https://flaxandteal.co.uk/#organization";
#[cfg(feature = "v2")]
const FT_ROOT_KEY: &str = "z6Mko9zKqAQFkifiqRe6t2Cntw7NHs7SiFboTWZednS6wJsf";

#[cfg(feature = "v2")]
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
#[cfg(all(feature = "v2", feature = "v2-emit"))]
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

/// Stub without the emit crate: cannot recompute/verify, so report unverified
/// rather than fabricate a pass.
#[cfg(all(feature = "v2", not(feature = "v2-emit")))]
#[tauri::command]
pub fn v2_verify_layer(_name: String) -> Result<LayerVerification, String> {
    Ok(LayerVerification {
        status: "unverified".to_string(),
        reason: "verification unavailable in this build".to_string(),
        author: String::new(),
        role: String::new(),
        confirmed: false,
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
#[cfg(all(feature = "v2", feature = "v2-emit"))]
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
        let mut on_progress =
            |_p: ros_madair_emit::EmitProgress| std::ops::ControlFlow::Continue(());
        let summary = match ros_madair_emit::emit_with_progress(
            &prebuild_s,
            &out_s,
            "https://example.org/",
            &ros_madair_emit::EmitOptions::default(),
            &ros_madair_emit::default_registry(),
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

/// No-op when built without the emit crate.
#[cfg(all(feature = "v2", not(feature = "v2-emit")))]
pub fn maybe_run_emit_measurement(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = "95470278-4a48-56b6-b818-c39a2840036e";

    fn head_dir() -> PathBuf {
        // app/src-tauri/ -> repo root -> data/macbain-v2
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../data/macbain-v2")
            .canonicalize()
            .expect("data/macbain-v2 present (see scripts/build-macbain-v2.mjs)")
    }

    fn graph() -> StaticGraph {
        load_graph(&head_dir().join("graph.json")).expect("graph loads")
    }

    #[test]
    fn hydrates_sample_entry() {
        let tree = hydrate_resource(&head_dir(), SAMPLE, &graph(), &["en"]).expect("hydrates");
        let text = serde_json::to_string(&tree).unwrap();
        assert!(
            text.contains("vocative particle"),
            "etymology_text not hydrated: {}",
            &text[..text.len().min(400)]
        );

        // 26 tiles: 19 cognates + 7 etymology.
        let cognates = tree
            .get("cognates")
            .and_then(Value::as_array)
            .expect("cognates array present");
        let etymology = tree
            .get("etymology")
            .and_then(Value::as_array)
            .expect("etymology array present");
        assert_eq!(cognates.len(), 19, "cognate tiles");
        assert_eq!(etymology.len(), 7, "etymology tiles");
    }

    /// Ground truth for the query tests, straight from SQL.
    fn sql_count(sql: &str) -> i64 {
        let conn = ros_madair_read::open_head(&head_dir()).unwrap();
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn counts_all_records() {
        let ir = json!({ "model": "lexical-entry", "measures": ["count_records"] });
        let out = run_query(&head_dir(), &ir, &graph()).expect("compiles + executes");
        let rows = out["results"][0]["rows"].as_array().unwrap();
        let count = rows[0][0].as_i64().unwrap();
        assert_eq!(count, 7860, "spine count");
        assert_eq!(
            count,
            sql_count("SELECT COUNT(*) FROM spine_lexical_entry"),
            "IR count disagrees with direct SQL"
        );
    }

    /// The `dialect` node is datatype `reference` - head-indexed only because
    /// the emitter registered the CLM handler. This asserts the query side
    /// agrees, via the manifest-derived registry.
    #[test]
    fn concept_query_on_reference_field() {
        let concept = "1052ed22-def2-5e6b-a5a2-ddff79e08e70";
        let ir = json!({
            "model": "lexical-entry",
            "where": { "concept": { "path": "dialect", "op": "is", "value": concept } },
            "measures": ["count_records"],
        });
        let out = run_query(&head_dir(), &ir, &graph()).expect("reference field is queryable");
        let count = out["results"][0]["rows"][0][0].as_i64().unwrap();
        assert_eq!(count, 4980, "concept query on reference field");
        assert_eq!(
            count,
            sql_count(
                "SELECT COUNT(DISTINCT ct.rid) FROM concept_tags ct \
                 JOIN dict n ON n.term_id = ct.node \
                 JOIN dict c ON c.term_id = ct.concept \
                 WHERE n.term = '69fb02e1-6d10-5a11-9bc2-4a02ad7fb8b0' \
                 AND c.term = '1052ed22-def2-5e6b-a5a2-ddff79e08e70'"
            ),
            "IR concept count disagrees with direct SQL"
        );
    }

    /// The foot-gun, closed.
    ///
    /// `ros_madair_query::compile()` - no registry - still rejects a concept
    /// predicate on a `reference` field as `not_head_indexed`, BY DESIGN: to a
    /// registry-less compiler an extension datatype is `DetailOnly`, and
    /// pretending otherwise is how you get silent zero-row answers. The previous
    /// version of this test pinned exactly that rejection, and left the caller to
    /// *remember* to pass a registry - a hand-built one, which could disagree
    /// with the emitter's and fail silently.
    ///
    /// What is pinned now is that the caller cannot forget and cannot disagree:
    /// the registry is derived from the artifact's own `manifest.handlers`, so the
    /// artifact that WAS indexed with the CLM handler is queryable, by
    /// construction, with no registry hand-assembled anywhere in this repo.
    #[test]
    fn manifest_declared_registry_makes_reference_queryable() {
        let manifest = ros_madair_read::load_manifest(&head_dir())
            .expect("manifest readable")
            .expect("this artifact ships a manifest");
        assert!(
            manifest.handlers.iter().any(|h| h.datatype == "reference"),
            "artifact must declare the handler that produced its concept_tags: {:?}",
            manifest.handlers
        );

        // The registry we plan with comes from that declaration and nothing else.
        let registry = registry(&head_dir()).expect("registry rebuilds from the declaration");
        let query: ros_madair_query::Query = serde_json::from_value(json!({
            "model": "lexical-entry",
            "where": { "concept": { "path": "dialect", "op": "is", "value": "x" } },
            "measures": ["count_records"],
        }))
        .unwrap();
        ros_madair_query::compile_with_registry(&query, &graph(), Some(&registry))
            .expect("manifest-derived registry makes the reference field head-indexed");
    }

    // -----------------------------------------------------------------------
    // Multi-layer composition (R1) - single-element layer set as the baseline
    // that proves the `Layers` API links + runs through the dual-core seam.
    // A one-layer stack must compose to exactly the single-head answers.
    // -----------------------------------------------------------------------

    fn single_layer() -> Layers {
        Layers::open(&[head_dir().as_path()]).expect("single-layer stack opens")
    }

    /// The seam itself: `Layers::open` links through `alizarin-core-v2` and a
    /// one-element stack is well-formed.
    #[test]
    fn layers_open_single() {
        let layers = single_layer();
        assert_eq!(layers.len(), 1, "one head, one layer");
        assert!(!layers.is_empty());
    }

    /// `count_records` through `Layers::count` must equal the single-head spine
    /// count - a one-layer stack has nothing to override.
    #[test]
    fn layers_count_all_records() {
        let ir = json!({ "model": "lexical-entry", "measures": ["count_records"] });
        let query: ros_madair_query::Query = serde_json::from_value(ir).unwrap();
        let registry = registry(&head_dir()).unwrap();
        let count = single_layer()
            .count(&query, &graph(), Some(&registry))
            .expect("composed count");
        assert_eq!(count, 7860, "composed count == single-head spine count");
        assert_eq!(
            count as i64,
            sql_count("SELECT COUNT(*) FROM spine_lexical_entry"),
            "Layers::count disagrees with direct SQL"
        );
    }

    /// The manifest-derived registry works THROUGH `Layers`: a concept `is`
    /// filter on the `reference`-datatype `dialect` node resolves to the same
    /// 4980 resources the single-head path counts. `resolve` is capped by
    /// `limit`, so it is lifted above the result size here.
    #[test]
    fn layers_resolve_reference() {
        let concept = "1052ed22-def2-5e6b-a5a2-ddff79e08e70";
        let ir = json!({
            "model": "lexical-entry",
            "where": { "concept": { "path": "dialect", "op": "is", "value": concept } },
            "measures": ["select_ids"],
            "limit": 10000,
        });
        let query: ros_madair_query::Query = serde_json::from_value(ir).unwrap();
        let registry = registry(&head_dir()).unwrap();
        let ids = single_layer()
            .resolve(&query, &graph(), Some(&registry))
            .expect("composed resolve on a reference field");
        assert_eq!(ids.len(), 4980, "composed resolve on reference field");
        assert_eq!(
            ids.len() as i64,
            sql_count(
                "SELECT COUNT(DISTINCT ct.rid) FROM concept_tags ct \
                 JOIN dict n ON n.term_id = ct.node \
                 JOIN dict c ON c.term_id = ct.concept \
                 WHERE n.term = '69fb02e1-6d10-5a11-9bc2-4a02ad7fb8b0' \
                 AND c.term = '1052ed22-def2-5e6b-a5a2-ddff79e08e70'"
            ),
            "Layers::resolve count disagrees with direct SQL"
        );
        // The composed count agrees with the composed resolve - the fast path
        // and the reference path on one query.
        let count_ir = json!({
            "model": "lexical-entry",
            "where": { "concept": { "path": "dialect", "op": "is", "value": concept } },
            "measures": ["count_records"],
        });
        let count_query: ros_madair_query::Query = serde_json::from_value(count_ir).unwrap();
        assert_eq!(
            single_layer()
                .count(&count_query, &graph(), Some(&registry))
                .unwrap(),
            4980,
            "Layers::count and Layers::resolve disagree"
        );
    }

    // -----------------------------------------------------------------------
    // Multi-layer composition (R1) - the real thing: TWO layers, wiktionary
    // (base, 185 resources across 2 models) + macbain (overlay, 7860 lexical
    // entries), composed on the 7 UUIDs they share. macbain enriches a
    // wiktionary headword with etymology + cognates under the SAME resource
    // UUID and the SAME lexical-entry graph; the cross-layer tile merge is the
    // union of their nodegroups. Heads are produced by
    // `examples/regen-layer-v2.rs` (see that file / this report's provenance).
    // -----------------------------------------------------------------------

    /// A UUID present in BOTH prebuild-wiktionary (lexical-entry) and
    /// prebuild-macbain. Its wiktionary tiles are the headword-side nodegroups;
    /// its macbain tiles are etymology + cognates. Disjoint nodegroup sets, so
    /// the composed hydrate is a clean union.
    const SHARED: &str = "e98ed0c3-34e5-5f5f-8151-fe77547d56d7";
    /// Fallback shared UUID, same shape.
    const SHARED_ALT: &str = "512ab3f3-e9e8-5f9d-8297-c2ac397d7d4a";

    fn wiktionary_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../data/wiktionary-v2")
            .canonicalize()
            .expect("data/wiktionary-v2 present (see examples/regen-layer-v2.rs)")
    }

    /// Top-level tree keys = the aliases of the root nodegroups the composed
    /// resource carries. This is the observable of the merge.
    fn tree_keys(tree: &Value) -> std::collections::BTreeSet<String> {
        tree.as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// The point of the whole swap: a resource shared across two real layers
    /// hydrates to the UNION of both layers' nodegroups, base + overlay.
    #[test]
    fn cross_layer_merge_shared_uuid() {
        let wikt = wiktionary_dir();
        let mac = head_dir();

        // The graph is the base's (both layers describe lexical-entry
        // identically - that is what `Layers::open` checks).
        let graph = load_graph(&wikt.join("graph.json")).expect("base graph loads");

        // base = wiktionary, overlay = macbain. If this refuses, the real layer
        // data does not honour the composition contract - a key finding, not a
        // thing to hack around.
        let composed = Layers::open(&[wikt.as_path(), mac.as_path()])
            .expect("wiktionary+macbain compose (base_uri/handlers/spine/field-class agree)");
        assert_eq!(composed.len(), 2, "two layers");

        // Pick a shared UUID that hydrates from the composed stack.
        let uuid = if composed.hydrate_resource(SHARED, &graph, &["en"]).is_ok() {
            SHARED
        } else {
            SHARED_ALT
        };

        let merged = composed
            .hydrate_resource(uuid, &graph, &["en"])
            .expect("composed hydrate of shared uuid");

        // Same UUID through each single layer alone.
        let wikt_only = Layers::open(&[wikt.as_path()]).expect("wiktionary single layer");
        let mac_only = Layers::open(&[mac.as_path()]).expect("macbain single layer");
        let wikt_tree = wikt_only
            .hydrate_resource(uuid, &graph, &["en"])
            .expect("wiktionary-alone hydrate");
        let mac_tree = mac_only
            .hydrate_resource(uuid, &graph, &["en"])
            .expect("macbain-alone hydrate");

        let merged_keys = tree_keys(&merged);
        let wikt_keys = tree_keys(&wikt_tree);
        let mac_keys = tree_keys(&mac_tree);

        // Make the merge visible in the test log (`cargo test -- --nocapture`).
        eprintln!("shared uuid           : {uuid}");
        eprintln!("wiktionary-only keys  : {wikt_keys:?}");
        eprintln!("macbain-only keys     : {mac_keys:?}");
        eprintln!("composed (merged) keys: {merged_keys:?}");

        // macbain's enrichment nodegroups are macbain-only...
        assert!(
            mac_keys.contains("etymology") && mac_keys.contains("cognates"),
            "macbain layer must carry etymology + cognates: {mac_keys:?}"
        );
        assert!(
            !wikt_keys.contains("etymology") && !wikt_keys.contains("cognates"),
            "etymology/cognates must NOT be in the wiktionary layer: {wikt_keys:?}"
        );
        // ...and wiktionary carries at least one nodegroup macbain does not.
        let wikt_exclusive: Vec<_> = wikt_keys.difference(&mac_keys).collect();
        assert!(
            !wikt_exclusive.is_empty(),
            "wiktionary must contribute a nodegroup macbain lacks: {wikt_keys:?} vs {mac_keys:?}"
        );

        // The composed tree contains BOTH a wiktionary-only nodegroup AND
        // macbain's etymology + cognates: the union, not either layer alone.
        assert!(
            merged_keys.contains("etymology") && merged_keys.contains("cognates"),
            "composed tree missing macbain enrichment: {merged_keys:?}"
        );
        for k in &wikt_exclusive {
            assert!(
                merged_keys.contains(k.as_str()),
                "composed tree dropped wiktionary-only nodegroup {k}: {merged_keys:?}"
            );
        }
        // Genuine union: composed keys == wiktionary keys ∪ macbain keys.
        let union: std::collections::BTreeSet<String> =
            wikt_keys.union(&mac_keys).cloned().collect();
        assert_eq!(
            merged_keys, union,
            "composed nodegroup set is not the union of the two layers"
        );
        // And the union is strictly bigger than either layer - enrichment
        // actually happened, this is not one layer masking the other.
        assert!(
            merged_keys.len() > wikt_keys.len() && merged_keys.len() > mac_keys.len(),
            "merge did not enlarge the nodegroup set: merged {} wikt {} mac {}",
            merged_keys.len(),
            wikt_keys.len(),
            mac_keys.len()
        );
    }

    /// FULL-HEAD proof: exactly the head dirs the running app is wired to
    /// (`V2_HEAD_DIRS` = wiktionary-v2-full + macbain-v2), hydrating the shared
    /// `fear` UUID through the SAME code path the `v2_hydrate_layers` Tauri
    /// command runs (`open_layers` → `Layers::hydrate_resource`). Prints the
    /// merged tree so a human can see wiktionary's headword/senses AND macbain's
    /// etymology/cognates in one resource. Run with `-- --nocapture`.
    fn wiktionary_full_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../data/wiktionary-v2-full")
            .canonicalize()
            .expect("data/wiktionary-v2-full present (the app's V2_HEAD_DIRS base)")
    }

    #[test]
    #[ignore = "requires data/wiktionary-v2-full/ incl. chunks on disk (not committed - 74MB binary); full-head proof, run explicitly"]
    fn fear_merge_full_head_app_path() {
        // The app passes String paths to v2_hydrate_layers; mirror that exactly.
        let head_dirs: Vec<String> = vec![
            wiktionary_full_dir().to_string_lossy().into_owned(),
            head_dir().to_string_lossy().into_owned(),
        ];
        let graph = load_graph(&graph_path(&head_dirs[0])).expect("full-head base graph loads");
        let layers = open_layers(&head_dirs).expect("wiktionary-full + macbain compose");
        assert_eq!(layers.len(), 2, "two layers");

        // fear - has wiktionary headword+senses AND macbain etymology+cognates.
        const FEAR: &str = "e98ed0c3-34e5-5f5f-8151-fe77547d56d7";
        let merged = layers
            .hydrate_resource(FEAR, &graph, &["en"])
            .expect("fear hydrates through the FULL-head 2-layer stack");

        let merged_keys = tree_keys(&merged);
        let pretty = serde_json::to_string_pretty(&merged).unwrap();
        eprintln!("=== fear ({FEAR}) merged via FULL head + macbain ===");
        eprintln!("merged nodegroup keys: {merged_keys:?}");
        eprintln!("headword field       : {:?}", merged.get("headword"));
        eprintln!(
            "merged tree (first 1600 chars):\n{}",
            &pretty[..pretty.len().min(1600)]
        );

        // macbain enrichment present in the merge...
        assert!(
            merged_keys.contains("etymology") && merged_keys.contains("cognates"),
            "FULL-head merge missing macbain etymology/cognates: {merged_keys:?}"
        );
        // ...alongside wiktionary-side content (more than just the two macbain
        // nodegroups), i.e. the union is genuinely enriched.
        assert!(
            merged_keys.len() > 2,
            "FULL-head merge did not carry wiktionary nodegroups too: {merged_keys:?}"
        );
        // The wiktionary headword text survives into the merged tree.
        assert!(
            pretty.contains("fear"),
            "merged tree does not contain the headword text 'fear'"
        );
    }


    /// REVERSE-COGNATE (P12): `Layers::cited_by` over the app's real head stack
    /// (wiktionary-v2-full + macbain-v2). The Irish "fear"
    /// (5b663193-5d21-5b88-8c1b-1c0aae030e84) is CITED by the MacBain "fear"
    /// (e98ed0c3-34e5-5f5f-8151-fe77547d56d7) via `cognate_entry_id`
    /// (resource-instance). Opening the Irish entry must therefore surface the
    /// MacBain entry so the loader can fold MacBain's etymology/cognates in. This
    /// is exactly the `v2_cited_by` Tauri command's code path (String paths →
    /// `open_layers` → `Layers::cited_by`, base layer's graph + registry).
    ///
    /// `#[ignore]` because it needs `data/wiktionary-v2-full/` + `data/macbain-v2/`
    /// chunks on disk (regenerated by `examples/regen-layer-v2.rs`; head-only in
    /// git). Run explicitly: `cargo test --features v2 -- --ignored cited_by`.
    #[test]
    #[ignore = "needs full heads (wiktionary-v2-full + macbain-v2) on disk; run with --ignored"]
    fn cited_by_reverse_cognate_full_head() {
        const IRISH_FEAR: &str = "5b663193-5d21-5b88-8c1b-1c0aae030e84";
        const MACBAIN_FEAR: &str = "e98ed0c3-34e5-5f5f-8151-fe77547d56d7";

        // Mirror the Tauri command exactly: String paths, base first.
        let head_dirs: Vec<String> = vec![
            wiktionary_full_dir().to_string_lossy().into_owned(),
            head_dir().to_string_lossy().into_owned(),
        ];
        let graph = load_graph(&graph_path(&head_dirs[0])).expect("full-head base graph loads");
        let registry = registry(Path::new(&head_dirs[0])).expect("base registry");
        let layers = open_layers(&head_dirs).expect("wiktionary-full + macbain compose");

        let citers = layers
            .cited_by(IRISH_FEAR, "cognate_entry_id", &graph, Some(&registry))
            .expect("cited_by resolves on the cognate_entry_id link node");

        eprintln!("=== cited_by({IRISH_FEAR}, cognate_entry_id) ===");
        eprintln!("returned {} citer(s): {citers:?}", citers.len());

        assert!(
            citers.iter().any(|c| c == MACBAIN_FEAR),
            "cited_by must include the MacBain 'fear' {MACBAIN_FEAR}; got {citers:?}"
        );
    }

    /// The overlay's non-shared resources still hydrate through the 2-layer
    /// stack: `SAMPLE` exists only in macbain, and composing wiktionary under it
    /// must not hide it.
    #[test]
    fn cross_layer_overlay_only_uuid() {
        let wikt = wiktionary_dir();
        let mac = head_dir();
        let graph = load_graph(&wikt.join("graph.json")).expect("base graph loads");
        let composed =
            Layers::open(&[wikt.as_path(), mac.as_path()]).expect("wiktionary+macbain compose");

        let tree = composed
            .hydrate_resource(SAMPLE, &graph, &["en"])
            .expect("overlay-only uuid hydrates through the 2-layer set");
        let cognates = tree
            .get("cognates")
            .and_then(Value::as_array)
            .expect("cognates present from overlay");
        let etymology = tree
            .get("etymology")
            .and_then(Value::as_array)
            .expect("etymology present from overlay");
        assert_eq!(cognates.len(), 19, "overlay-only cognate tiles preserved");
        assert_eq!(etymology.len(), 7, "overlay-only etymology tiles preserved");
    }

    /// `Layers::hydrate_resource` composes (trivially, one layer) and hydrates to
    /// the same tree the single-head path produces: 19 cognates + 7 etymology,
    /// text "vocative particle".
    #[test]
    fn layers_hydrate_sample() {
        let tree = single_layer()
            .hydrate_resource(SAMPLE, &graph(), &["en"])
            .expect("composed hydrate");
        let text = serde_json::to_string(&tree).unwrap();
        assert!(
            text.contains("vocative particle"),
            "etymology_text not hydrated: {}",
            &text[..text.len().min(400)]
        );
        let cognates = tree
            .get("cognates")
            .and_then(Value::as_array)
            .expect("cognates array present");
        let etymology = tree
            .get("etymology")
            .and_then(Value::as_array)
            .expect("etymology array present");
        assert_eq!(cognates.len(), 19, "cognate tiles");
        assert_eq!(etymology.len(), 7, "etymology tiles");
    }

    // -----------------------------------------------------------------------
    // Concept label resolution (A2: head's `vocab.label`, not `closure.json`).
    // -----------------------------------------------------------------------

    /// `v2_closure` folds the head's `vocab.label` (via the `dict`/`vocab` join)
    /// into a `uuid -> label` map. Concept UUIDs resolve DIRECTLY now - the old
    /// value-id indirection is gone with `closure.json`.
    #[test]
    fn closure_resolves_known_uuids() {
        let map = v2_closure(vec![head_dir().to_string_lossy().into_owned()])
            .expect("label map builds from data/macbain-v2/head.sqlite vocab.label");
        assert!(!map.is_empty(), "label map is non-empty");

        // A concept UUID resolves to its label via `vocab.label`.
        assert_eq!(
            map.get("0caceaea-9c8d-5df1-8fd2-4d015708fe3f").map(String::as_str),
            Some("noun"),
            "concept id resolves to its label",
        );
        // A second concept UUID - pronoun's value-id indirection is retired, so
        // the concept id itself is what a tile now carries and what resolves.
        assert_eq!(
            map.get("80fe1942-8911-5e10-8f7b-8dc6c78b223d").map(String::as_str),
            Some("pronoun"),
            "pronoun concept id resolves directly (no value_map)",
        );
        // The reference-datatype dialect concept resolves to its display label.
        assert_eq!(
            map.get("1052ed22-def2-5e6b-a5a2-ddff79e08e70").map(String::as_str),
            Some("Scottish Gaelic (General)"),
            "dialect reference concept resolves to its label",
        );
        // Every mapped label is non-empty.
        assert!(
            map.values().all(|l| !l.is_empty()),
            "no empty labels in the label map",
        );
    }

    /// Two-layer label map is the merge of both heads' `vocab.label` (later wins).
    #[test]
    fn closure_merges_layers() {
        let dirs = vec![
            wiktionary_dir().to_string_lossy().into_owned(),
            head_dir().to_string_lossy().into_owned(),
        ];
        let map = v2_closure(dirs).expect("merged label map builds");
        assert!(
            map.get("0caceaea-9c8d-5df1-8fd2-4d015708fe3f").map(String::as_str) == Some("noun"),
            "macbain concept still resolves in the merged map",
        );
        // The dialect concept - carried by both layers - resolves in the merge.
        assert_eq!(
            map.get("1052ed22-def2-5e6b-a5a2-ddff79e08e70").map(String::as_str),
            Some("Scottish Gaelic (General)"),
            "reference concept resolves through the merged map",
        );
    }

    /// SCRATCH (kept): dumps the composed wiktionary+macbain hydrate of the
    /// shared UUID so the TS flattener can be written against real key/value
    /// shapes - especially how part_of_speech / dialect / senses / source_label
    /// appear (raw uuids vs objects, card-1 vs card-n). Run with:
    ///   cargo test --features v2-emit --lib -- dump_shared_tree --nocapture
    #[test]
    fn dump_shared_tree() {
        let wikt = wiktionary_dir();
        let mac = head_dir();
        let graph = load_graph(&wikt.join("graph.json")).expect("base graph loads");
        let composed = Layers::open(&[wikt.as_path(), mac.as_path()]).expect("compose");
        let uuid = if composed.hydrate_resource(SHARED, &graph, &["en"]).is_ok() {
            SHARED
        } else {
            SHARED_ALT
        };
        let tree = composed.hydrate_resource(uuid, &graph, &["en"]).expect("hydrate");
        eprintln!("=== shared uuid: {uuid} ===");
        eprintln!("{}", serde_json::to_string_pretty(&tree).unwrap());

        // Also show what the vocab-backed label map resolves the raw reference
        // uuids to.
        let map = v2_closure(vec![
            wikt.to_string_lossy().into_owned(),
            mac.to_string_lossy().into_owned(),
        ])
        .expect("closure");
        for key in ["part_of_speech", "dialect"] {
            if let Some(v) = tree.get(key) {
                eprintln!(
                    "{key} = {v:?}  -> label {:?}",
                    v.as_str().and_then(|s| map.get(s))
                );
            }
        }
    }
}
