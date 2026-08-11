// Slice 3 (read proof): open an emitted Parquet dataset with DuckReader and run a
// ros-madair-query IR through it, proving the DuckDB+Parquet read path works in the
// app's own build against a real layer's data. This is the "DuckDB goes live"
// step - it forces the linker to keep DuckDB (unlike the dormant-dep android build)
// and exercises DuckReader::resolve_ids end to end.
//
//   cargo run --release --example duck-probe --features v2-duck -- \
//       data/parquet-bunamo/tiles_lexical_entry.parquet \
//       data/prebuild-bunamo/graphs/resource_models/<graph_id>.json <graph_id>

use alizarin_core::graph::StaticGraph;
use ros_madair_duck::DuckReader;
use ros_madair_handlers::default_registry;
use ros_madair_query::{Measure, Query};

fn main() {
    let mut args = std::env::args().skip(1);
    let parquet = args.next().expect("usage: duck-probe <tiles.parquet> <graph.json> <graph_id>");
    let graph_json = args.next().expect("usage: duck-probe <tiles.parquet> <graph.json> <graph_id>");
    let graph_id = args.next().expect("usage: duck-probe <tiles.parquet> <graph.json> <graph_id>");

    // graph.json is `{ "graph": [ {...} ] }` (as regen writes it); tolerate a bare graph too.
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&graph_json).expect("read graph.json")).expect("parse graph.json");
    let graph_val = raw
        .get("graph")
        .and_then(|g| g.get(0))
        .cloned()
        .unwrap_or(raw);
    let graph: StaticGraph = serde_json::from_value(graph_val).expect("StaticGraph");

    let registry = default_registry();
    let duck = DuckReader::open(&parquet).expect("DuckReader::open (read_parquet offline)");

    // No WHERE: SelectIds over the whole model, capped - just proving the read path
    // returns real resource ids from the Parquet tiles.
    let query = Query {
        model: graph_id,
        r#where: None,
        measures: vec![Measure::SelectIds],
        limit: Some(10),
    };
    let ids = duck.resolve_ids(&query, &graph, &registry).expect("resolve_ids");

    eprintln!("[duck] resolve_ids -> {} id(s) (limit 10)", ids.len());
    for id in ids.iter().take(3) {
        eprintln!("[duck]   {id}");
    }
    assert!(!ids.is_empty(), "expected at least one resource id from the parquet");
    eprintln!("[duck] OK - DuckReader read the Parquet dataset in-app");
}
