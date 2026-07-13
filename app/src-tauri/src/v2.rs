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

use std::path::{Path, PathBuf};

use alizarin_core_v2::graph::StaticGraph;
use ros_madair_handlers::ExtensionTypeRegistry;
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
}
