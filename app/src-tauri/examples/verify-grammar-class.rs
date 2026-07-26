// SPDX-License-Identifier: AGPL-3.0-or-later
//! Acceptance test for the entry-level `grammar_class` field on the BuNaMo layer.
//!
//! Answers, empirically:
//!   (A) Does `Layers::open` accept the full stack once bunamo's graph gains the
//!       `grammar_class` node while the other heads' graphs still lack it?
//!   (B) Does the BUNAMO-ONLY hydrate surface `grammar_class` (test 2b)?
//!   (C) Does the COMPOSED hydrate surface `grammar_class` + senses + forms,
//!       given the authoritative graph is headDirs[0]?
//!
//!   cargo run --release --example verify-grammar-class --features v2 -- \
//!       <resource_uuid> <graph-head> <head1> [head2 ...]
//!
//! e.g. ... -- 9f29742a-33e7-57d5-99ea-6febb7d8dffb data/wiktionary-v2-full \
//!            data/wiktionary-v2-full data/macbain-v2 data/tearma-v2 data/bunamo-v2
//! The FIRST head after the uuid is the graph source (authoritative). The rest
//! are the Layers stack, in order.

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
    let gv = match json.get("graph").and_then(|g| g.get(0)) {
        Some(v) => v.clone(),
        None => json,
    };
    let mut g: StaticGraph = serde_json::from_value(gv).expect("graph schema");
    g.build_indices();
    g
}

fn ng_len(tree: &Value, key: &str) -> usize {
    tree.get(key).and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)
}

fn keys(tree: &Value) -> Vec<String> {
    tree.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default()
}

/// grammar_class may render as a bare string, or as a single-tile array/object
/// depending on how a top-level cardinality-1 string node hydrates. Probe all.
fn grammar_class(tree: &Value) -> String {
    match tree.get("grammar_class") {
        None => "<ABSENT>".to_string(),
        Some(Value::String(s)) => format!("\"{s}\""),
        Some(v) => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let uuid = args.next().expect("resource uuid");
    let graph_head = args.next().expect("graph-head dir");
    let stack_dirs: Vec<String> = args.collect();
    assert!(!stack_dirs.is_empty(), "need at least one stack head");

    let graph = load_graph(&repo().join(&graph_head).join("graph.json"));
    println!("graph source: {graph_head}");
    println!(
        "  graph defines `grammar_class` node: {}",
        graph.get_node_by_alias("grammar_class").is_some()
    );
    println!("resource uuid: {uuid}\n");

    // --- (A) composability of the full stack ---
    let stack_paths: Vec<PathBuf> = stack_dirs.iter().map(|d| repo().join(d)).collect();
    let refs: Vec<&Path> = stack_paths.iter().map(|p| p.as_path()).collect();
    println!("=== (A) Layers::open on the full stack ===");
    println!("stack order: {:?}", stack_dirs);
    let composed = match Layers::open(&refs) {
        Ok(l) => {
            println!("  RESULT: OPEN SUCCEEDED ({} layers)\n", l.len());
            l
        }
        Err(e) => {
            println!("  RESULT: OPEN REFUSED -> {e:?}\n");
            return;
        }
    };

    // --- per-single-layer hydrate (2b lives here: the bunamo-only head) ---
    println!("=== (B) per-single-layer hydrate of {uuid} ===");
    for d in &stack_dirs {
        let p = repo().join(d);
        let only = Layers::open(&[p.as_path()]).expect("single head opens");
        match only.hydrate_resource(&uuid, &graph) {
            Ok(t) => println!(
                "  [{d}] keys={:?} forms={} senses={} grammar_class={}",
                keys(&t), ng_len(&t, "forms"), ng_len(&t, "senses"), grammar_class(&t)
            ),
            Err(_) => println!("  [{d}] (resource absent)"),
        }
    }
    println!();

    // --- (C) composed hydrate ---
    println!("=== (C) COMPOSED hydrate of {uuid} ===");
    let merged = composed.hydrate_resource(&uuid, &graph).expect("composed hydrate");
    println!(
        "  keys={:?}\n  forms={} senses={} grammar_class={}",
        keys(&merged), ng_len(&merged, "forms"), ng_len(&merged, "senses"),
        grammar_class(&merged)
    );
    println!("\n  composed senses (source_label):");
    if let Some(s) = merged.get("senses").and_then(Value::as_array) {
        for x in s.iter().take(8) {
            let g = x.get("gloss").and_then(Value::as_str).unwrap_or("");
            let src = x.get("source_label").and_then(Value::as_str).unwrap_or("");
            println!("    - [{src}] {g}");
        }
    }
    println!("\n  FULL composed tree (pretty):");
    println!("{}", serde_json::to_string_pretty(&merged).unwrap());
}
