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
    // Attach the sibling concept_catalog.parquet so search_display's POS/dialect
    // concept-label joins have a catalog to hit.
    let catalog = std::path::Path::new(&parquet)
        .parent()
        .unwrap()
        .join("concept_catalog.parquet");
    let duck = DuckReader::open(&parquet)
        .expect("DuckReader::open (read_parquet offline)")
        .with_catalog(catalog.to_str().unwrap())
        .expect("with_catalog");

    // No WHERE: SelectIds over the whole model, capped - just proving the read path
    // returns real resource ids from the Parquet tiles.
    let query = Query {
        model: graph_id,
        r#where: None,
        measures: vec![Measure::SelectIds],
        limit: Some(10),
    };
    let ids = duck.resolve_ids(&query, &graph, &registry).expect("resolve_ids");

    eprintln!("[duck] resolve_ids -> {} id(s)", ids.len());
    assert!(!ids.is_empty(), "expected at least one resource id from the parquet");

    // Descriptor read (the v2_descriptors port): resolve display names for a sample.
    let sample: Vec<String> = ids.iter().take(5).cloned().collect();
    let descs = duck.descriptors(&sample).expect("descriptors");
    eprintln!("[duck] descriptors -> {}/{} resolved", descs.len(), sample.len());
    for id in &sample {
        eprintln!("[duck]   {id} => {:?}", descs.get(id));
    }
    // count_records (the CountRecords measure port): same compile path, COUNT(*).
    let n = duck.count_records(&query, &graph, &registry).expect("count_records");
    eprintln!("[duck] count_records -> {n}");
    assert_eq!(n, ids.len(), "count_records must match resolve_ids count");

    // search_display (v2_search_display port): headword + POS + dialect labels.
    // Bunamo is forms-only so POS/dialects are empty here, but this exercises the
    // full method incl. the concept-catalog joins (they run, just match nothing).
    const POS_NODE: &str = "a956278b-6815-5cc5-b674-e933e9c84aad";
    const DIALECT_NODE: &str = "69fb02e1-6d10-5a11-9bc2-4a02ad7fb8b0";
    let disp = duck.search_display(&sample, POS_NODE, DIALECT_NODE).expect("search_display");
    eprintln!("[duck] search_display -> {} row(s)", disp.len());
    for id in &sample {
        if let Some(r) = disp.get(id) {
            eprintln!("[duck]   {id} hw={:?} pos={:?} dial={:?}", r.headword, r.pos, r.dialects);
        }
    }

    // concept_labels (v2_closure port): bulk concept -> label from the catalog.
    let labels = duck.concept_labels().expect("concept_labels");
    eprintln!("[duck] concept_labels -> {} concept(s)", labels.len());
    for (id, label) in labels.iter().take(3) {
        eprintln!("[duck]   {id} => {label}");
    }

    eprintln!("[duck] OK - DuckReader: tiles + descriptors + count + display + labels from Parquet");
}
