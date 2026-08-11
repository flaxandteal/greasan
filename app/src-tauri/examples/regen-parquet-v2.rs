// Slice 2 of the DuckDB+Parquet migration: emit a prebuild dir to a Parquet
// dataset (tiles_<slug>.parquet + concept_catalog.parquet) via the parquet
// substrate's `emit_parquet`, the DuckDB-readable counterpart of the sqlite
// `emit` used by regen-layer-v2. Standalone so we can produce + inspect a real
// layer's Parquet before wiring DuckReader into v2.rs.
//
//   cargo run --example regen-parquet-v2 --features v2-emit -- <prebuild_dir> <out_dir>

use std::collections::HashMap;
use std::path::Path;

use ros_madair_emit::{default_registry, emit_parquet, ClusterConfig};

fn main() {
    let mut args = std::env::args().skip(1);
    let prebuild = args
        .next()
        .expect("usage: regen-parquet-v2 <prebuild_dir> <out_dir>");
    let out = args
        .next()
        .expect("usage: regen-parquet-v2 <prebuild_dir> <out_dir>");

    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root");
    let data_dir = repo.join(&prebuild);
    let out_dir = repo.join(&out);
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let registry = default_registry();
    // Empty map: every graph gets ClusterConfig::default() (see emit_parquet).
    let cfg_by_graph: HashMap<String, ClusterConfig> = HashMap::new();

    let summaries = emit_parquet(
        data_dir.to_str().expect("utf-8 data dir"),
        out_dir.to_str().expect("utf-8 out dir"),
        "https://example.org/",
        &registry,
        &cfg_by_graph,
    )
    .expect("emit_parquet");

    for s in &summaries {
        eprintln!("[parquet] model {}", s.graph_id);
    }

    // Carry the primary model's graph.json into the dataset dir so it is
    // self-contained (the app's v2_hydrate loads `<dir>/graph.json`, as the sqlite
    // heads do). Optional 3rd arg overrides which model is primary; default = the
    // first emitted.
    // Default primary = the model with the MOST tiles (e.g. lexical_entry over the
    // external_example sidecar in a multi-graph dataset); an explicit 3rd arg wins.
    let primary = args
        .next()
        .or_else(|| {
            summaries
                .iter()
                .max_by_key(|s| s.tiles)
                .map(|s| s.graph_id.clone())
        })
        .expect("no model emitted");
    let graph_src = data_dir
        .join("graphs/resource_models")
        .join(format!("{primary}.json"));
    std::fs::copy(&graph_src, out_dir.join("graph.json"))
        .unwrap_or_else(|e| panic!("copy graph.json ({}): {e}", graph_src.display()));

    eprintln!(
        "[parquet] {} model(s) + graph.json ({primary}) -> {}",
        summaries.len(),
        out_dir.display()
    );
}
