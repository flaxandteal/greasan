// Option A proof: (1) confirm the emitted `link_targets` is now the per-node
// object `{node_id: [targets]}`, (2) run DuckReader::geo_points (the reverse-link
// + geo lookup) against real place data - node-precise.
//
//   cargo run --release --example geo-probe --features v2-duck -- data/parquet-place/tiles_place.parquet

use duckdb::Connection;
use ros_madair_duck::DuckReader;

fn main() {
    let parquet = std::env::args().nth(1).expect("usage: geo-probe <tiles_place.parquet>");

    // Raw-sample a link_targets that is a JSON OBJECT (starts with '{'), proving
    // the per-node shape (the old format was a bare '[' array).
    let conn = Connection::open_in_memory().expect("duck");
    conn.execute_batch(&format!(
        "CREATE VIEW t AS SELECT * FROM read_parquet('{parquet}');"
    ))
    .expect("view");
    let sample: String = conn
        .query_row(
            "SELECT link_targets FROM t WHERE link_targets IS NOT NULL AND link_targets LIKE '{%' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .expect("a per-node link_targets object");
    eprintln!("[geo] sample link_targets = {sample}");
    let obj: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&sample).expect("link_targets must be a JSON object");
    assert!(!obj.is_empty(), "link_targets object should be non-empty");
    eprintln!("[geo] link_targets has {} node key(s)", obj.len());

    // Pick a real (node_id, target) from it.
    let (node_id, targets) = obj.iter().next().unwrap();
    let target = targets.as_array().unwrap()[0].as_str().unwrap().to_string();
    eprintln!("[geo] querying node={node_id} target={target}");

    // geo_points: places citing that target through that node, with coordinates.
    let duck = DuckReader::open(&parquet).expect("open");
    let pts = duck.geo_points(node_id, &target).expect("geo_points");
    eprintln!("[geo] geo_points -> {} place(s)", pts.len());
    for (id, name, lat, lng) in pts.iter().take(3) {
        eprintln!("[geo]   {name:?} [{id}] @ ({lat}, {lng})");
    }
    assert!(!pts.is_empty(), "expected >=1 citing place with geometry");
    eprintln!("[geo] OK - per-node link_targets + geo_points reverse-lookup work in-app");
}
