// Slice 5 multi-layer proof: hydrate a resource that exists in MULTIPLE Parquet
// layers via ros_madair_duck::hydrate_layers - the composed view (per-nodegroup
// precedence), tiles from the Parquet `data` column. e.g. macbain (etymology) +
// bunamo (forms) folded into one lexical entry.
//
//   cargo run --release --example compose-probe --features v2-duck -- \
//       <graph.json> data/parquet-macbain data/parquet-bunamo

use std::path::Path;

use alizarin_core::graph::StaticGraph;
use duckdb::Connection;
use ros_madair_duck::hydrate_layers;

fn main() {
    let mut args = std::env::args().skip(1);
    let graph_json = args.next().expect("usage: compose-probe <graph.json> <dir>...");
    let dirs: Vec<String> = args.collect();
    assert!(dirs.len() >= 2, "give >=2 layer dirs to compose");

    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&graph_json).expect("read graph")).expect("parse");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    let mut graph: StaticGraph = serde_json::from_value(gv).expect("StaticGraph");
    graph.build_indices();

    // A resource id present in EVERY layer (INTERSECT).
    let conn = Connection::open_in_memory().unwrap();
    let intersect = dirs
        .iter()
        .map(|d| format!("SELECT resource_id FROM read_parquet('{d}/tiles_*.parquet')"))
        .collect::<Vec<_>>()
        .join("\nINTERSECT\n");
    let uuid: String = conn
        .query_row(&format!("{intersect} LIMIT 1"), [], |r| r.get(0))
        .expect("a resource shared by all layers");
    eprintln!("[compose] shared resource {uuid} across {} layers", dirs.len());

    let dir_paths: Vec<&Path> = dirs.iter().map(|d| Path::new(d.as_str())).collect();
    let tree = hydrate_layers(&dir_paths, &uuid, &graph, &["ga", "en"]).expect("hydrate_layers");
    let pretty = serde_json::to_string_pretty(&tree).expect("json");
    for line in pretty.lines().take(60) {
        eprintln!("[compose] {line}");
    }
    eprintln!("[compose] OK - composed hydration across {} Parquet layers", dirs.len());
}
