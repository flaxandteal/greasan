// SPDX-License-Identifier: AGPL-3.0-or-later
//! Diagnostic: hydrate a resource over the composed stack (the read API - NOT raw
//! tiles) and dump its `forms` nodegroup, showing for each form its written_rep
//! and how its `gram_features` (case/number/gender concepts) resolve. Tells us
//! whether BuNaMo's case/number tags come back as real labels (nominative/…) or
//! stay raw UUIDs (the closure gap that dumps forms into paradigm.ts's "Other").
//!
//!   cargo run --release --example verify-forms --features v2 -- \
//!       <resource_uuid> <head-dir> [head2 ...]
//! e.g. ... -- e2b4d2fe-5b66-5c4d-a62b-b7a0ae55ffc7 \
//!            data/wiktionary-v2-full data/bunamo-v2

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

/// Union each head's UUID -> label closure - identical query to `v2::v2_closure`,
/// but across ALL head dirs (the runtime merges every visible head).
fn closure(dirs: &[PathBuf]) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for dir in dirs {
        let conn = match ros_madair_read::open_head(dir) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let mut stmt = conn
            .prepare(
                "SELECT d.term, v.label FROM vocab v \
                 JOIN dict d ON d.term_id = v.concept WHERE v.label IS NOT NULL",
            )
            .expect("prepare vocab-label");
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .expect("query");
        for row in rows {
            let (u, l) = row.expect("row");
            if !l.is_empty() {
                m.entry(u).or_insert(l);
            }
        }
    }
    m
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.matches('-').count() == 4
}

fn main() {
    let mut args = std::env::args().skip(1);
    let uuid = args.next().expect("resource uuid");
    let dirs: Vec<String> = args.collect();
    assert!(!dirs.is_empty(), "need at least one head dir");

    let paths: Vec<PathBuf> = dirs.iter().map(|d| repo().join(d)).collect();
    let graph = load_graph(&paths[0].join("graph.json"));
    let refs: Vec<&Path> = paths.iter().map(|p| p.as_path()).collect();
    let layers = Layers::open(&refs).expect("Layers::open");
    let tree = layers.hydrate_resource(&uuid, &graph, &["en"]).expect("hydrate");

    let map = closure(&paths);
    println!("closure size={}", map.len());
    for probe in ["nominative", "genitive", "singular", "plural", "dative", "vocative"] {
        println!("  closure has '{probe}': {}", map.values().any(|v| v == probe));
    }

    let forms = match tree.get("forms") {
        Some(Value::Array(a)) => a.clone(),
        Some(v) => vec![v.clone()],
        None => vec![],
    };
    println!("\n{} form(s) on {}:", forms.len(), uuid);
    for (i, f) in forms.iter().enumerate() {
        let wr = f
            .get("written_rep")
            .and_then(|w| match w {
                Value::String(s) => Some(s.clone()),
                Value::Object(o) => o
                    .get("en")
                    .and_then(|e| e.get("value"))
                    .or_else(|| o.get("value"))
                    .and_then(|x| x.as_str())
                    .map(String::from),
                _ => None,
            })
            .unwrap_or_default();
        // gram_features is a concept-list: array of strings (labels or UUIDs).
        let gf_raw = f.get("gram_features").cloned().unwrap_or(Value::Null);
        let tags: Vec<String> = match &gf_raw {
            Value::Array(a) => a
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect(),
            Value::String(s) => vec![s.clone()],
            _ => vec![],
        };
        let resolved: Vec<String> = tags
            .iter()
            .map(|t| {
                if is_uuid(t) {
                    match map.get(t) {
                        Some(l) => format!("{t} => {l}"),
                        None => format!("{t} => <UNRESOLVED>"),
                    }
                } else {
                    format!("{t} (already a label)")
                }
            })
            .collect();
        println!("  [{i}] written_rep={wr:?}");
        println!("       gram_features: {resolved:?}");
    }
}
