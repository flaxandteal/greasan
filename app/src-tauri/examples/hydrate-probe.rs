// Slice 5 proof: hydrate a resource to a display tree with the Parquet `data`
// column as the tile source (DuckReader::resource_tiles + hydrate), replacing the
// msgpack chunk read. Reuses ros-madair-read's storage-agnostic tile→tree.
//
//   cargo run --release --example hydrate-probe --features v2-duck -- \
//       data/parquet-place/tiles_place.parquet <graph.json> <graph_id>

use alizarin_core::graph::StaticGraph;
use ros_madair_duck::DuckReader;
use ros_madair_handlers::default_registry;
use ros_madair_query::{Measure, Query};

fn main() {
    let mut args = std::env::args().skip(1);
    let parquet = args.next().expect("usage: hydrate-probe <tiles.parquet> <graph.json> <graph_id>");
    let graph_json = args.next().expect("usage: hydrate-probe <tiles.parquet> <graph.json> <graph_id>");
    let graph_id = args.next().expect("usage: hydrate-probe <tiles.parquet> <graph.json> <graph_id>");

    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&graph_json).expect("read graph")).expect("parse graph");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    let mut graph: StaticGraph = serde_json::from_value(gv).expect("StaticGraph");
    graph.build_indices();

    let catalog = std::path::Path::new(&parquet)
        .parent()
        .unwrap()
        .join("concept_catalog.parquet");
    let duck = DuckReader::open(&parquet)
        .expect("open")
        .with_catalog(catalog.to_str().unwrap())
        .expect("catalog");

    // Pick one resource.
    let registry = default_registry();
    let q = Query { model: graph_id, r#where: None, measures: vec![Measure::SelectIds], limit: Some(1) };
    let ids = duck.resolve_ids(&q, &graph, &registry).expect("resolve_ids");
    let uuid = ids.first().expect("at least one resource").clone();
    eprintln!("[hydrate] resource {uuid}");

    let tiles = duck.resource_tiles(&uuid).expect("resource_tiles");
    eprintln!("[hydrate] {} tile(s) read from the Parquet data column", tiles.len());
    assert!(!tiles.is_empty(), "expected tiles");

    let tree = duck.hydrate(&uuid, &graph, &["ga", "en"]).expect("hydrate");
    let pretty = serde_json::to_string_pretty(&tree).expect("json");
    for line in pretty.lines().take(45) {
        eprintln!("[hydrate] {line}");
    }
    eprintln!("[hydrate] OK - hydrated a resource from Parquet in-app");
}
