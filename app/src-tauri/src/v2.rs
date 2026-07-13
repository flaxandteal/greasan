// SPDX-License-Identifier: AGPL-3.0-or-later
//! v2 static-assets pilot (single layer: macbain) — feature `v2`.
//!
//! The native read path that replaces the v1 SPARQL/page-index stack for
//! one layer:
//!
//! * schema: the Arches resource-model export (`<head_dir>/graph.json`),
//!   loaded into `alizarin_core_v2::StaticGraph` (the *sandbox* core — see
//!   the type-isolation note below);
//! * head: `head.sqlite` emitted by `ros-madair-emit` (dict / spine /
//!   concept_tags / vocab / fragment_dir / chunks), opened read-only;
//! * body: content-addressed `chunks/<hash>.msgpack` tile chunks, hydrated
//!   to a schema-aware JSON tree by `resource_tiles_to_tree`;
//! * queries: the serde IR of `ros-madair-query`, compiled to parameterized
//!   SQL and executed with rusqlite.
//!
//! ## Type isolation (important)
//!
//! The plan was to link a *second* copy of `alizarin-core` (the sandbox one
//! the v2 stack tracks) alongside the v1 core used by `ros-madair-core`.
//! Cargo forbids it: both are `2.0.0-alpha.120`, and a lockfile cannot hold
//! two same-name/same-version packages from different paths ("package
//! collision in the lockfile"), nor the same package under two names. So the
//! whole app currently builds against the *sandbox* core (a superset; v1
//! compiles against it unchanged) — see the note in `Cargo.toml`.
//!
//! The isolation discipline is kept anyway, so the split can be restored the
//! moment the sandbox core's version is bumped: this module is JSON-in /
//! JSON-out (`serde_json::Value` at every public boundary) and refers to the
//! core through the `core_v2` alias below. No v2 type escapes into the app.
//!
//! Ported from `alizarin-sandbox`'s `alizarin-emit` example
//! `hydrate_entry.rs` (branch `macbain-pilot`, 04d1484).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

// The one line that changes when the two cores can coexist again:
// `use alizarin_core_v2 as core_v2;`
use alizarin_core as core_v2;
use core_v2::extension_type_registry::ExtensionTypeRegistry;
use core_v2::graph::{StaticGraph, StaticResourceMetadata};
use core_v2::json_conversion::resource_tiles_to_tree;
use core_v2::StaticTile;
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::Value;

/// Deserialization mirror of `ros_madair_emit::chunks::ChunkTile`, which is
/// serialize-only and crate-private upstream. The emit writes with
/// `rmp_serde::to_vec_named` (a msgpack *map* keyed by field name), so the
/// field names — not the order — are the contract.
///
/// UPSTREAM REQUEST R2: `pub fn hydrate_resource(head_dir, uuid, &graph)` in
/// `ros-madair-emit` would delete this struct, its `From` impl, and the whole
/// chunk-reading block below (i.e. everything between the SQLite open and the
/// `resource_tiles_to_tree` call).
#[derive(Deserialize)]
struct ChunkTile {
    #[serde(default)]
    data: BTreeMap<String, Value>,
    nodegroup_id: String,
    resourceinstance_id: String,
    #[serde(default)]
    tileid: Option<String>,
    #[serde(default)]
    parenttile_id: Option<String>,
    #[serde(default)]
    sortorder: Option<i32>,
}

impl From<ChunkTile> for StaticTile {
    fn from(c: ChunkTile) -> Self {
        StaticTile {
            data: c.data.into_iter().collect::<HashMap<_, _>>(),
            nodegroup_id: c.nodegroup_id,
            resourceinstance_id: c.resourceinstance_id,
            tileid: c.tileid,
            parenttile_id: c.parenttile_id,
            provisionaledits: None,
            sortorder: c.sortorder,
        }
    }
}

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

/// The datatype-capability registry the emitter used (`ros_madair_emit::
/// default_registry`): the CLM `reference` handler. Without it, `reference`
/// nodes are `DetailOnly` to the query compiler and every concept predicate
/// on them is rejected as `not_head_indexed` — even though the emitter
/// (which *did* register the handler) indexed them into `concept_tags`.
///
/// UPSTREAM REQUEST R3: `ros_madair_emit::default_registry()` (or a registry
/// reconstructed from `manifest.json`) exported from a crate we can depend on
/// without pulling the whole emitter would delete this function.
fn registry() -> ExtensionTypeRegistry {
    let mut registry = ExtensionTypeRegistry::new();
    registry.register(
        alizarin_clm_core_v2::DATATYPE_NAME,
        alizarin_clm_core_v2::create_reference_handler(),
    );
    registry
}

fn open_head(head_dir: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        head_dir.join("head.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open head.sqlite: {e}"))
}

/// Hydrate one resource to a schema-aware JSON tree.
///
/// 1. UUID -> `dict.term_id` -> `spine_<slug>.rid` (the spine `rid` is a
///    sequential resource counter, *not* the dict id);
/// 2. `fragment_dir JOIN chunks` -> chunk hashes for that rid;
/// 3. read `chunks/<hash>.msgpack`, keeping only the tiles whose
///    `resourceinstance_id` is the target (chunks pack many resources);
/// 4. `resource_tiles_to_tree` (partial-safe) against the graph.
pub fn hydrate_resource(
    head_dir: &Path,
    resource_uuid: &str,
    graph: &StaticGraph,
) -> Result<Value, String> {
    let conn = open_head(head_dir)?;

    let spine_table: String = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'spine_%' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("no spine table in head: {e}"))?;

    let rid: i64 = conn
        .query_row(
            &format!(
                "SELECT s.rid FROM {spine_table} s \
                 JOIN dict d ON d.term_id = s.term_id WHERE d.term = ?1"
            ),
            [resource_uuid],
            |r| r.get(0),
        )
        .map_err(|e| format!("resource {resource_uuid} not in head: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT c.hash, f.tile_count FROM fragment_dir f \
             JOIN chunks c ON c.chunk = f.chunk WHERE f.rid = ?1",
        )
        .map_err(|e| format!("fragment_dir: {e}"))?;
    let rows: Vec<(String, i64)> = stmt
        .query_map([rid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .and_then(|it| it.collect::<Result<_, _>>())
        .map_err(|e| format!("fragment_dir rows: {e}"))?;
    let expected: i64 = rows.iter().map(|(_, n)| n).sum();
    let hashes: BTreeSet<String> = rows.into_iter().map(|(h, _)| h).collect();

    let mut tiles: Vec<StaticTile> = Vec::new();
    for hash in &hashes {
        let path = head_dir.join("chunks").join(format!("{hash}.msgpack"));
        let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let chunk: Vec<ChunkTile> =
            rmp_serde::from_slice(&bytes).map_err(|e| format!("decode {hash}: {e}"))?;
        for ct in chunk {
            if ct.resourceinstance_id == resource_uuid {
                tiles.push(ct.into());
            }
        }
    }
    if tiles.len() as i64 != expected {
        return Err(format!(
            "chunk/fragment_dir mismatch for {resource_uuid}: recovered {} tiles, fragment_dir expects {expected}",
            tiles.len()
        ));
    }
    // Stable order, so hydration output is reproducible.
    tiles.sort_by(|a, b| {
        (a.nodegroup_id.as_str(), a.tileid.as_deref())
            .cmp(&(b.nodegroup_id.as_str(), b.tileid.as_deref()))
    });

    let metadata = StaticResourceMetadata {
        descriptors: Default::default(),
        graph_id: graph.graph_id().to_string(),
        name: String::new(),
        resourceinstanceid: resource_uuid.to_string(),
        publication_id: None,
        principaluser_id: None,
        legacyid: None,
        graph_publication_id: None,
        createdtime: None,
        lastmodified: None,
    };
    resource_tiles_to_tree(&tiles, &metadata, graph).map_err(|e| format!("hydration failed: {e}"))
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
    let registry = registry();
    let statements = ros_madair_query::compile_with_registry(&query, graph, Some(&registry))
        // The typed error is the repair contract — hand it to the caller as
        // structured JSON, not a flattened string, where we can.
        .map_err(|e| {
            serde_json::to_string(&e).unwrap_or_else(|_| e.to_string())
        })?;

    let conn = open_head(head_dir)?;
    let mut results = Vec::new();
    for stmt in &statements {
        let mut prepared = conn
            .prepare(&stmt.sql)
            .map_err(|e| format!("prepare `{}`: {e}", stmt.sql))?;
        let params: Vec<Box<dyn rusqlite::ToSql>> = stmt
            .params
            .iter()
            .map(|p| match p {
                ros_madair_query::Param::Text(s) => {
                    Box::new(s.clone()) as Box<dyn rusqlite::ToSql>
                }
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
        let conn = open_head(&head_dir()).unwrap();
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
    /// agrees, via `compile_with_registry` (upstream Task B).
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
        assert!(count > 0, "concept query on reference field returned 0");
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

    /// Without the registry, `reference` is DetailOnly to the compiler: the
    /// same predicate must fail with the typed, repairable error. This pins
    /// *why* `run_query` passes a registry.
    #[test]
    fn concept_query_without_registry_is_rejected() {
        let query: ros_madair_query::Query = serde_json::from_value(json!({
            "model": "lexical-entry",
            "where": { "concept": { "path": "dialect", "op": "is", "value": "x" } },
            "measures": ["count_records"],
        }))
        .unwrap();
        let err = ros_madair_query::compile(&query, &graph()).unwrap_err();
        assert!(
            matches!(
                err,
                ros_madair_query::QueryError::NotHeadIndexed { ref datatype, .. }
                    if datatype == "reference"
            ),
            "expected not_head_indexed(reference), got {err:?}"
        );
    }
}
