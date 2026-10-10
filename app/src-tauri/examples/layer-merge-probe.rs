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

    // CARRIER_UNION=1 replicates v2_hydrate_layers' composition: base = first
    // layer carrying the resource, overlays = the other carriers (model union) ++
    // fxg layers. Otherwise use the single graph_json as base (the old behaviour).
    let lg = if std::env::var("CARRIER_UNION").is_ok() {
        let want = [uuid.clone()];
        let mut carriers: Vec<Arc<StaticGraph>> = Vec::new();
        let mut fxg_only: Vec<Arc<StaticGraph>> = Vec::new();
        for d in &dirs {
            let g = Arc::new(load_graph(&format!("{d}/graph.json")));
            let carries = ros_madair_duck::descriptors(&[Path::new(d.as_str())], &want)
                .map(|m| m.contains_key(&uuid))
                .unwrap_or(false);
            if carries { carriers.push(g); }
            else if g.functions_x_graphs.as_ref().is_some_and(|v| !v.is_empty()) { fxg_only.push(g); }
        }
        let base = carriers.first().cloned().unwrap_or_else(|| Arc::new(load_graph(&graph_json)));
        let mut overlays: Vec<Arc<StaticGraph>> = carriers.into_iter().skip(1).collect();
        overlays.extend(fxg_only);
        eprintln!("[merge] CARRIER_UNION: {} carrier(s) + {} fxg", 1 + overlays.len(), 0);
        LayeredGraph::new(base, overlays)
    } else {
        LayeredGraph::new(Arc::new(load_graph(&graph_json)), vec![])
    };
    let reg = FunctionsRegistry::new();
    let dir_paths: Vec<&Path> = dirs.iter().map(|d| Path::new(d.as_str())).collect();

    let tree = ros_madair_duck::hydrate_layers(&dir_paths, &uuid, &lg, &["ga", "gd", "en"], None, &reg)
        .expect("hydrate_layers");
    let stats = tree.get("statistics");
    eprintln!("[merge] dirs: {dirs:?}");
    eprintln!("[merge] resourceinstanceid: {:?}", tree.get("resourceinstanceid"));
    eprintln!("[merge] name: {:?}", tree.get("name"));
    eprintln!("[merge] statistics.resource_count: {:?}", stats.and_then(|s| s.get("resource_count")));
    eprintln!("[merge] integration.config_block: {:?}", tree.get("integration").and_then(|i| i.get("config_block")));
    if std::env::var("DUMP_TREE").is_ok() {
        eprintln!("[merge] TREE keys: {:?}", tree.as_object().map(|o| o.keys().collect::<Vec<_>>()));
        eprintln!("[merge] FULL: {}", serde_json::to_string(&tree).unwrap());
    }
    println!("{}", serde_json::to_string(&stats).unwrap());
}
