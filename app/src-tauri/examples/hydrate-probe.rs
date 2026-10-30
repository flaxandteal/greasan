// Verification probe for the 2.1 refactor: does `hydrate_layers` return
// part_of_speech / dialect / forms[].gram_features as RESOLVED LABELS, or as raw
// concept UUIDs still needing the frontend `makeLabel`/`v2_closure` pass?
//
//   cargo run --release --example hydrate-probe -- data/macbain-v2
//
// Prints the first few lexical_entry resources' part_of_speech + dialect values
// off the real hydrate path (same call v2_hydrate_layers makes). A UUID-looking
// value means closure is still load-bearing; a human label means it is dead code.

use alizarin_core::graph::StaticGraph;
use alizarin_core::{FunctionsRegistry, LayeredGraph};
use ros_madair_duck::{DuckReader, SpatialSource};
use ros_madair_handlers::default_registry;
use ros_madair_query::Query;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;

const LEXICAL_ENTRY_GID: &str = "449c8695-253e-521b-8994-27701ce22305";

fn load_graph(p: &str) -> StaticGraph {
    let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(p).expect("read")).expect("parse");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    let mut g: StaticGraph = serde_json::from_value(gv).expect("graph");
    g.build_indices();
    g
}

fn looks_uuid(s: &str) -> bool {
    s.len() == 36 && s.as_bytes().iter().filter(|&&b| b == b'-').count() == 4
}

fn show(label: &str, v: &serde_json::Value) {
    let s = serde_json::to_string(v).unwrap_or_default();
    let verdict = if s.contains('-') && s.matches('-').count() >= 4 && looks_uuid(v.as_str().unwrap_or("")) {
        "  <-- RAW UUID (closure still needed)"
    } else {
        ""
    };
    println!("    {label}: {s}{verdict}");
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| "data/macbain-v2".into());

    let graph = load_graph(&format!("{dir}/graph.json"));
    let layered = LayeredGraph::new(Arc::new(graph.clone()), vec![]);
    let registry = FunctionsRegistry::new();

    // Grab a handful of lexical_entry ids from the head.
    let duck = DuckReader::open_with(&format!("{dir}/tiles_*.parquet"), SpatialSource::None).expect("open");
    let hreg = default_registry();
    let q: Query = serde_json::from_value(json!({"model": LEXICAL_ENTRY_GID, "measures": ["select_ids"], "limit": 8})).unwrap();
    let ids = duck.resolve_ids(&q, &graph, &hreg).expect("ids");
    println!("[probe] {} ids from {dir}", ids.len());

    // alpha.33: render_summaries reads the entry table (ungated by geo), so a
    // non-spatial dictionary resource carries render_fields too. 4th tuple element.
    let probe_ids: Vec<String> = ids.iter().take(5).cloned().collect();
    match duck.render_summaries(&probe_ids) {
        Ok(sm) => {
            println!("[render_summaries] map has {} / {} ids", sm.len(), probe_ids.len());
            for id in &probe_ids {
                match sm.get(id) {
                    Some(t) => println!(
                        "    {id}: descriptor={:?} geo={:?} render_fields={:?}",
                        t.0.as_deref(), t.1.as_deref(), t.3.as_deref()
                    ),
                    None => println!("    {id}: <no entry row>"),
                }
            }
        }
        Err(e) => println!("[render_summaries] err: {e}"),
    }
    // alpha.33 resource_entries 4-tuple: (graph_id, legacyid, descriptor, descriptor_description).
    // descriptor_description is the gloss (<Gloss> template) - the 1.3 FTS source.
    match duck.resource_entries(&probe_ids) {
        Ok(re) => {
            println!("[resource_entries] descriptor_description (gloss):");
            for id in &probe_ids {
                let gloss = re.get(id).and_then(|t| t.3.as_deref()).unwrap_or("<none>");
                println!("    {id}: {gloss:?}");
            }
        }
        Err(e) => println!("[resource_entries] err: {e}"),
    }

    let langs = ["ga", "gd", "en"];
    for id in ids.iter().take(8) {
        let tree = match ros_madair_duck::hydrate_layers(&[Path::new(&dir)], id, &layered, &langs, None, &registry) {
            Ok(t) => t,
            Err(e) => { println!("  {id}: hydrate err {e}"); continue; }
        };
        println!("  {id}");
        if let Some(obj) = tree.as_object() {
            let keys: Vec<&String> = obj.keys().collect();
            println!("    [keys] {keys:?}");
        }
        if let Some(v) = tree.get("part_of_speech") { show("part_of_speech", v); }
        if let Some(v) = tree.get("dialect") { show("dialect", v); }
        // forms[].gram_features
        if let Some(forms) = tree.get("forms").and_then(|f| f.as_array()) {
            if let Some(f0) = forms.first() {
                if let Some(v) = f0.get("gram_features") { show("forms[0].gram_features", v); }
            }
        }
    }
}
