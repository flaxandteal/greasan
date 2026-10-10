// Phase-2 proof: hydrate ONE resource over an ordered stack of head dirs via
// ros_madair_duck::hydrate_layers (the native side of v2_hydrate_layers), so we
// can show a baked layer-<slug> resource in an installed corpus head overriding
// the skeleton catalogue's placeholder. Base graph = dirs[0] (the skeleton layer
// head); later dirs override earlier per nodegroup (topmost wins).
//
//   cargo run --release --example layer-merge-probe -- \
//       <graph.json> <uuid> <dir0> [dir1 ...]

use std::path::Path;
use std::sync::Arc;

use alizarin_core::graph::StaticGraph;
use alizarin_core::{FunctionsRegistry, LayeredGraph};

fn load_graph(p: &str) -> StaticGraph {
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(p).expect("read graph")).expect("parse graph");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    let mut g: StaticGraph = serde_json::from_value(gv).expect("StaticGraph");
    g.build_indices();
    g
}

fn main() {
    let mut args = std::env::args().skip(1);
    let graph_json = args.next().expect("usage: layer-merge-probe <graph.json> <uuid> <dir>...");
    let uuid = args.next().expect("usage: layer-merge-probe <graph.json> <uuid> <dir>...");
    let dirs: Vec<String> = args.collect();
    assert!(!dirs.is_empty(), "at least one head dir");

    let lg = LayeredGraph::new(Arc::new(load_graph(&graph_json)), vec![]);
    let reg = FunctionsRegistry::new();
    let dir_paths: Vec<&Path> = dirs.iter().map(|d| Path::new(d.as_str())).collect();

    let tree = ros_madair_duck::hydrate_layers(&dir_paths, &uuid, &lg, &["ga", "gd", "en"], None, &reg)
        .expect("hydrate_layers");
    let stats = tree.get("statistics");
    eprintln!("[merge] dirs: {dirs:?}");
    eprintln!("[merge] resourceinstanceid: {:?}", tree.get("resourceinstanceid"));
    eprintln!("[merge] name: {:?}", tree.get("name"));
    eprintln!("[merge] statistics.resource_count: {:?}", stats.and_then(|s| s.get("resource_count")));
    println!("{}", serde_json::to_string(&stats).unwrap());
}
