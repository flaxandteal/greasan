// Test-bed spike (Greasan-Testbed-Handoff.md): prove Expr::Bbox round-trips through
// the DuckDB engine - a hardcoded bounding box -> place resource IDs. This de-risks
// the "load-bearing unknown": the spatial predicate exists in ros-madair-query and
// the duck compiler already handles it (coarse geo_min/max overlap + an exact
// ST_Intersects fine step). Runs with SpatialSource::Auto, so it INSTALL/LOADs the
// spatial extension over the network (desktop/dev). The on-device path (no android
// spatial binary) is a separate coarse-only decision - see the handoff.
//
//   cargo run --release --example bbox-probe --features v2-duck -- data/parquet-place

use std::path::Path;

use alizarin_core::graph::StaticGraph;
use ros_madair_duck::{DuckReader, SpatialSource};
use ros_madair_emit::default_registry;
use ros_madair_query::{Expr, Measure, Query};

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| "data/parquet-place".to_string());
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root");
    let head = repo.join(&dir);

    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(head.join("graph.json")).expect("read graph"))
            .expect("parse graph");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    let mut graph: StaticGraph = serde_json::from_value(gv).expect("StaticGraph");
    graph.build_indices();
    let model = graph.graphid.clone();

    let glob = format!("{}/tiles_*.parquet", head.display());
    let reg = default_registry();
    // County Kerry, Ireland - a generous lng/lat box.
    let q = Query {
        model,
        r#where: Some(Expr::Bbox {
            path: "location".to_string(),
            min_lng: -10.5,
            min_lat: 51.7,
            max_lng: -9.2,
            max_lat: 52.5,
        }),
        measures: vec![Measure::SelectIds],
        limit: None,
    };

    // EXACT (Auto): INSTALL/LOAD spatial over the network, run the ST_Intersects
    // fine step. Desktop/dev only.
    let exact = DuckReader::open(&glob)
        .expect("open Auto")
        .resolve_ids(&q, &graph, &reg)
        .expect("resolve_ids(Bbox, exact)");

    // COARSE-ONLY (None): no spatial extension - the mobile path. Skips the fine
    // step, returns the bbox-overlap superset.
    let coarse = DuckReader::open_with(&glob, SpatialSource::None)
        .expect("open None")
        .resolve_ids(&q, &graph, &reg)
        .expect("resolve_ids(Bbox, coarse)");

    eprintln!("[bbox] Kerry box:  exact(ST_Intersects) = {}  coarse-only = {}", exact.len(), coarse.len());
    assert!(
        coarse.len() >= exact.len(),
        "coarse must be a SUPERSET of exact (no false negatives)"
    );
    eprintln!(
        "[bbox] OK - coarse-only is a superset of exact (+{} false positives kept), \
         both round-trip; mobile uses coarse-only",
        coarse.len() - exact.len()
    );
}
