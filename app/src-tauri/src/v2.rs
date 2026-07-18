// SPDX-License-Identifier: AGPL-3.0-or-later
//! v2 static-assets pilot (single layer: macbain) — feature `v2`.
//!
//! The native read path that replaces the v1 SPARQL/page-index stack for
//! one layer:
//!
//! * schema: the Arches resource-model export (`<head_dir>/graph.json`),
//!   loaded into `alizarin_core_v2::StaticGraph` (the *sandbox* core — see
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
//! `Deserialize`) and `ros-madair-handlers` (the single registry definition —
//! plus a manifest that *declares* the handler set it was emitted with).
//!
//! The registry one mattered most. A hand-built query-side registry that
//! disagrees with the emitter's does not fail: it compiles valid SQL against an
//! index that was never written, and returns **zero rows**. Deriving it from the
//! manifest closes that — an artifact emitted with a handler this build cannot
//! provide now errors loudly instead of quietly answering nothing.
//!
//! ## Type isolation (still worth keeping)
//!
//! Two copies of `alizarin-core` are linked: the real one (2.0.0-alpha.120 —
//! v1, `ros-madair-core`, the rest of the app) and the sandbox one that the v2
//! stack tracks (2.0.0-alpha.121), aliased `alizarin-core-v2`. The version bump
//! is what makes that legal; see `Cargo.toml`. This module is JSON-in /
//! JSON-out (`serde_json::Value` at every public boundary), so no v2 type
//! escapes into the app and the two cores never meet.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use alizarin_core_v2::graph::StaticGraph;
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

/// The datatype-capability registry to plan queries with — rebuilt from the
/// handler set the artifact's manifest *declares* it was emitted with.
///
/// This is what the manifest's `handlers` block is for. `reference` (the
/// datatype of the `dialect` node) is head-indexed — present in `concept_tags`,
/// and therefore filterable at all — only because the emitter had the CLM
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
        // so a head dir must stay readable without one — and the only registry we
        // can offer then is the default, i.e. a guess, deliberately the same guess
        // the emitter's own default makes. Every artifact this app ships is
        // emitted with the default registry AND declares it, so this branch is for
        // hand-assembled heads only. If the guess is ever wrong the symptom is
        // zero rows — which is precisely why the declaration exists and why we
        // prefer it whenever it is present.
        _ => Ok(ros_madair_handlers::default_registry()),
    }
}

/// Hydrate one resource to a schema-aware JSON tree.
///
/// `ros-madair-read` owns the path now (UUID → dict → spine `rid` →
/// `fragment_dir` → chunks → `resource_tiles_to_tree`). Kept on top of it: the
/// cross-check `hydrate_resource` does not do by itself — the number of tiles
/// actually recovered from the chunks must equal what `fragment_dir` says this
/// resource has. A mismatch means a chunk went missing or a resource id is
/// duplicated across chunks, i.e. a corrupt artifact. Hard error, rather than a
/// quietly truncated entry.
pub fn hydrate_resource(
    head_dir: &Path,
    resource_uuid: &str,
    graph: &StaticGraph,
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
    ros_madair_read::hydrate_tiles(&tiles, resource_uuid, graph).map_err(|e| e.to_string())
}

/// Compile a `ros-madair-query` IR against the graph and execute each
/// compiled statement against the head.
///
/// Returns `{"results": [{"measure", "coarse", "columns", "rows"}, ...]}`.
/// `coarse: true` marks a chunk-granularity (link) over-approximation whose
/// rows must be re-verified against hydrated tiles.
pub fn run_query(head_dir: &Path, ir: &Value, graph: &StaticGraph) -> Result<Value, String> {
    let query: ros_madair_query::Query =
        serde_json::from_value(ir.clone()).map_err(|e| format!("bad query IR: {e}"))?;
    let registry = registry(head_dir)?;
    let statements = ros_madair_query::compile_with_registry(&query, graph, Some(&registry))
        // The typed error is the repair contract — hand it to the caller as
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

#[tauri::command]
pub fn v2_hydrate(head_dir: String, resource_id: String) -> Result<Value, String> {
    let graph = load_graph(&graph_path(&head_dir))?;
    hydrate_resource(Path::new(&head_dir), &resource_id, &graph)
}

#[tauri::command]
pub fn v2_query(head_dir: String, ir: Value) -> Result<Value, String> {
    let graph = load_graph(&graph_path(&head_dir))?;
    run_query(Path::new(&head_dir), &ir, &graph)
}

// ---------------------------------------------------------------------------
// Multi-layer composition (R1) — `ros-madair-read`'s `Layers`.
//
// The single-head commands above read ONE snapshot. `Layers` reads N ordered
// snapshots (base first, later overrides earlier) as one composed view — a
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
fn open_layers(head_dirs: &[String]) -> Result<Layers, String> {
    let paths: Vec<PathBuf> = head_dirs.iter().map(PathBuf::from).collect();
    let refs: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
    Layers::open(&refs).map_err(|e| e.to_string())
}

/// Compile a `ros-madair-query` IR against the composed view of a layer stack.
///
/// The registry and graph are taken from the first (base) layer — the
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
// gram_features, …) as RAW concept UUIDs — the head indexes concept ids, not
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

/// Hydrate one resource from the composed view of a layer stack: gather its tiles
/// from every layer that has it, merge with per-nodegroup precedence (topmost
/// wins), then hydrate to a schema-aware JSON tree. The graph is the base's.
#[tauri::command]
pub fn v2_hydrate_layers(head_dirs: Vec<String>, resource_id: String) -> Result<Value, String> {
    let Some(base) = head_dirs.first() else {
        return Err("v2_hydrate_layers: no layers given".to_string());
    };
    let graph = load_graph(&graph_path(base))?;
    let layers = open_layers(&head_dirs)?;
    layers
        .hydrate_resource(&resource_id, &graph)
        .map_err(|e| e.to_string())
}

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
        let tree = hydrate_resource(&head_dir(), SAMPLE, &graph()).expect("hydrates");
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

    /// The `dialect` node is datatype `reference` — head-indexed only because
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
    /// `ros_madair_query::compile()` — no registry — still rejects a concept
    /// predicate on a `reference` field as `not_head_indexed`, BY DESIGN: to a
    /// registry-less compiler an extension datatype is `DetailOnly`, and
    /// pretending otherwise is how you get silent zero-row answers. The previous
    /// version of this test pinned exactly that rejection, and left the caller to
    /// *remember* to pass a registry — a hand-built one, which could disagree
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
    // Multi-layer composition (R1) — single-element layer set as the baseline
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
    /// count — a one-layer stack has nothing to override.
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
        // The composed count agrees with the composed resolve — the fast path
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
    // Multi-layer composition (R1) — the real thing: TWO layers, wiktionary
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
        // identically — that is what `Layers::open` checks).
        let graph = load_graph(&wikt.join("graph.json")).expect("base graph loads");

        // base = wiktionary, overlay = macbain. If this refuses, the real layer
        // data does not honour the composition contract — a key finding, not a
        // thing to hack around.
        let composed = Layers::open(&[wikt.as_path(), mac.as_path()])
            .expect("wiktionary+macbain compose (base_uri/handlers/spine/field-class agree)");
        assert_eq!(composed.len(), 2, "two layers");

        // Pick a shared UUID that hydrates from the composed stack.
        let uuid = if composed.hydrate_resource(SHARED, &graph).is_ok() {
            SHARED
        } else {
            SHARED_ALT
        };

        let merged = composed
            .hydrate_resource(uuid, &graph)
            .expect("composed hydrate of shared uuid");

        // Same UUID through each single layer alone.
        let wikt_only = Layers::open(&[wikt.as_path()]).expect("wiktionary single layer");
        let mac_only = Layers::open(&[mac.as_path()]).expect("macbain single layer");
        let wikt_tree = wikt_only
            .hydrate_resource(uuid, &graph)
            .expect("wiktionary-alone hydrate");
        let mac_tree = mac_only
            .hydrate_resource(uuid, &graph)
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
        // And the union is strictly bigger than either layer — enrichment
        // actually happened, this is not one layer masking the other.
        assert!(
            merged_keys.len() > wikt_keys.len() && merged_keys.len() > mac_keys.len(),
            "merge did not enlarge the nodegroup set: merged {} wikt {} mac {}",
            merged_keys.len(),
            wikt_keys.len(),
            mac_keys.len()
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
            .hydrate_resource(SAMPLE, &graph)
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
            .hydrate_resource(SAMPLE, &graph())
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
    /// into a `uuid -> label` map. Concept UUIDs resolve DIRECTLY now — the old
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
        // A second concept UUID — pronoun's value-id indirection is retired, so
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
        // The dialect concept — carried by both layers — resolves in the merge.
        assert_eq!(
            map.get("1052ed22-def2-5e6b-a5a2-ddff79e08e70").map(String::as_str),
            Some("Scottish Gaelic (General)"),
            "reference concept resolves through the merged map",
        );
    }

    /// SCRATCH (kept): dumps the composed wiktionary+macbain hydrate of the
    /// shared UUID so the TS flattener can be written against real key/value
    /// shapes — especially how part_of_speech / dialect / senses / source_label
    /// appear (raw uuids vs objects, card-1 vs card-n). Run with:
    ///   cargo test --features v2-emit --lib -- dump_shared_tree --nocapture
    #[test]
    fn dump_shared_tree() {
        let wikt = wiktionary_dir();
        let mac = head_dir();
        let graph = load_graph(&wikt.join("graph.json")).expect("base graph loads");
        let composed = Layers::open(&[wikt.as_path(), mac.as_path()]).expect("compose");
        let uuid = if composed.hydrate_resource(SHARED, &graph).is_ok() {
            SHARED
        } else {
            SHARED_ALT
        };
        let tree = composed.hydrate_resource(uuid, &graph).expect("hydrate");
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
