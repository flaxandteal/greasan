// Phase-0 proof for responder_buffer: mirror the command's engine path against a
// v4 head — seed a point from a resource's geo_descriptor, buffer a bbox around it,
// GridBox-prune to ids + count, then read the grid edge's render summary (descriptor
// + geo_descriptor point) for those ids. No app/webview needed.
//
//   cargo run --release --example buffer-probe -- data/place-v2 Place [radius_m]

use alizarin_core::graph::StaticGraph;
use ros_madair_duck::{DuckReader, SpatialSource};
use ros_madair_handlers::default_registry;
use ros_madair_query::Query;
use serde_json::json;

fn load_graph(p: &str) -> StaticGraph {
    let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(p).expect("read")).expect("parse");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    let mut g: StaticGraph = serde_json::from_value(gv).expect("graph");
    g.build_indices();
    g
}

fn point_of(s: &str) -> Option<(f64, f64)> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let c = v.get("coordinates")?.as_array()?;
    Some((c.first()?.as_f64()?, c.get(1)?.as_f64()?))
}

fn main() {
    let mut a = std::env::args().skip(1);
    let dir = a.next().expect("usage: buffer-probe <head_dir> <model> [radius_m]");
    let model = a.next().unwrap_or_else(|| "Place".into());
    let radius: f64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(2000.0);

    let graph = load_graph(&format!("{dir}/graph.json"));
    let duck = DuckReader::open_with(&format!("{dir}/tiles_*.parquet"), SpatialSource::None).expect("open");
    let registry = default_registry();

    // Seed a point from one resource's geo_descriptor (guaranteed in-dataset).
    let seedq: Query = serde_json::from_value(json!({"model": model, "measures": ["select_ids"], "limit": 50})).unwrap();
    let seed_ids = duck.resolve_ids(&seedq, &graph, &registry).expect("seed ids");
    let seeds = duck.render_summaries(&seed_ids).expect("seed summaries");
    let (seed, (lng, lat)) = seed_ids
        .iter()
        .find_map(|id| seeds.get(id).and_then(|(_, g, _)| g.as_deref()).and_then(point_of).map(|p| (id.clone(), p)))
        .expect("a seed resource with a geo_descriptor point");
    eprintln!("[buffer] seed {seed} @ ({lng:.5},{lat:.5}), radius {radius} m");

    // bbox around the seed (lat-corrected), guard the area.
    let dlat = radius / 111_320.0;
    let dlng = radius / (111_320.0 * lat.to_radians().cos().abs().max(1e-9));
    let (mnx, mny, mxx, mxy) = (lng - dlng, lat - dlat, lng + dlng, lat + dlat);
    eprintln!("[buffer] cells_in_box ok = {}", ros_madair_handlers::cells_in_box(mnx, mny, mxx, mxy).is_ok());

    // GridBox prune.
    let geo_path = if model.eq_ignore_ascii_case("Place") { "location" } else { "footprint" };
    let ir = json!({
        "model": model,
        "where": { "all": [ { "grid_box": { "path": geo_path, "min_lng": mnx, "min_lat": mny, "max_lng": mxx, "max_lat": mxy } } ] },
        "measures": ["count_records", "select_ids"], "limit": 500
    });
    let q: Query = serde_json::from_value(ir).unwrap();
    let count = duck.count_records(&q, &graph, &registry).expect("count");
    let mut ids = duck.resolve_ids(&q, &graph, &registry).expect("ids");
    ids.truncate(500);
    eprintln!("[buffer] count={count} returned={}", ids.len());

    // Render columns off the grid edge for those ids.
    let sm = duck.render_summaries(&ids).expect("render_summaries");
    let with_pt = ids.iter().filter(|id| sm.get(*id).and_then(|(_, g, _)| g.as_deref()).and_then(point_of).is_some()).count();
    let named = ids.iter().filter(|id| sm.get(*id).and_then(|(d, _, _)| d.as_deref()).is_some()).count();
    eprintln!("[buffer] with point {with_pt}/{}, with name {named}/{}", ids.len(), ids.len());

    assert!(count > 0, "expected places in the buffer");
    assert!(ids.contains(&seed), "the seed must fall in its own buffer");
    assert!(with_pt > 0, "expected at least one geo_descriptor point");
    eprintln!("[buffer] OK");
}
