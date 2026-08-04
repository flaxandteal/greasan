// SPDX-License-Identifier: AGPL-3.0-or-later
//! Acceptance test for the entry-level `gender` (lexinfo:gender) concept node.
//! Hydrates a resource over the composed stack (the read API — NOT raw tiles) and
//! resolves its gender value through the head's closure (the same vocab->label
//! join `v2_closure` uses). PASS iff the stored value resolves to a real label.
//!
//!   cargo run --release --example verify-gender --features v2 -- \
//!       <resource_uuid> <head-dir> [head2 ...]
//! e.g. ... -- 9f29742a-33e7-57d5-99ea-6febb7d8dffb data/wiktionary-v2-full

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use alizarin_core::graph::StaticGraph;
use ros_madair_read::Layers;
use serde_json::Value;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

fn load_graph(path: &Path) -> StaticGraph {
    let raw = std::fs::read_to_string(path).expect("read graph.json");
    let json: Value = serde_json::from_str(&raw).expect("parse graph json");
    let gv = json.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(json);
    let mut g: StaticGraph = serde_json::from_value(gv).expect("graph schema");
    g.build_indices();
    g
}

/// The head's UUID -> label closure — identical query to `v2::v2_closure`.
fn closure(dir: &Path) -> HashMap<String, String> {
    let conn = ros_madair_read::open_head(dir).expect("open head");
    let mut stmt = conn
        .prepare(
            "SELECT d.term, v.label FROM vocab v \
             JOIN dict d ON d.term_id = v.concept WHERE v.label IS NOT NULL",
        )
        .expect("prepare vocab-label");
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .expect("query");
    let mut m = HashMap::new();
    for row in rows {
        let (u, l) = row.expect("row");
        if !l.is_empty() {
            m.insert(u, l);
        }
    }
    m
}

/// Extract the concept UUID a reference field hydrated to (string, or an object
/// wrapping the id) — mirrors the frontend `makeLabel`.
fn ref_id(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Object(o) => o
            .get("id")
            .or_else(|| o.get("resourceId"))
            .or_else(|| o.get("value"))
            .and_then(|x| x.as_str())
            .map(String::from),
        _ => None,
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let uuid = args.next().expect("resource uuid");
    let dirs: Vec<String> = args.collect();
    assert!(!dirs.is_empty(), "need at least one head dir");

    let head0 = repo().join(&dirs[0]);
    let graph = load_graph(&head0.join("graph.json"));
    println!("gender node in graph: {}", graph.get_node_by_alias("gender").is_some());

    let paths: Vec<PathBuf> = dirs.iter().map(|d| repo().join(d)).collect();
    let refs: Vec<&Path> = paths.iter().map(|p| p.as_path()).collect();
    let layers = Layers::open(&refs).expect("Layers::open");
    // hydrate folds each layer's vocab (id -> label) internally, so a reference
    // field comes back already resolved to its label — or a raw UUID if the tile
    // value has no vocab entry (the old mismatch bug).
    let tree = layers.hydrate_resource(&uuid, &graph, &["en"]).expect("hydrate");

    println!("tree keys: {:?}", tree.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()));
    // Declension lives nested under the grammar_class_group nodegroup.
    let gcg = tree.get("grammar_class_group");
    let gc = gcg
        .and_then(|g| if let Value::Array(a) = g { a.first() } else { Some(g) })
        .and_then(|g| g.get("grammar_class"));
    println!("grammar_class_group: {}", serde_json::to_string(&gcg).unwrap_or_default());
    println!("grammar_class (declension): {}", serde_json::to_string(&gc).unwrap_or_default());

    let gender_raw = tree.get("gender").cloned().unwrap_or(Value::Null);
    println!("tree.gender (raw): {}", serde_json::to_string(&gender_raw).unwrap());

    let map = closure(&head0);
    println!(
        "closure size={}  masculine present={} feminine present={}",
        map.len(),
        map.values().any(|v| v == "masculine"),
        map.values().any(|v| v == "feminine"),
    );

    // The resolved label (string, or a localized wrapper).
    let s = match &gender_raw {
        Value::String(s) => s.clone(),
        Value::Object(o) => o
            .get("en")
            .and_then(|e| e.get("value"))
            .or_else(|| o.get("value"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| ref_id(&gender_raw))
            .unwrap_or_default(),
        _ => String::new(),
    };
    let is_uuid = s.len() == 36 && s.matches('-').count() == 4;
    if s == "masculine" || s == "feminine" {
        println!("PASS: gender hydrates to the label '{s}'");
    } else if is_uuid {
        // Unresolved UUID — try the closure to show what it *should* map to.
        println!("FAIL: gender is an unresolved UUID '{s}' (closure -> {:?})", map.get(&s));
    } else if s.is_empty() {
        println!("FAIL: gender absent/empty on tree");
    } else {
        println!("UNEXPECTED gender value: '{s}'");
    }
}
