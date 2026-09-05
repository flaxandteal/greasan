// SPDX-License-Identifier: AGPL-3.0-or-later
//! Emit any prebuild directory to a v2 head, generalising
//! `examples/regen-macbain-v2.rs`. Requires `--features v2-emit`.
//!
//!     cargo run --release --example regen-layer-v2 --features v2-emit -- \
//!         data/prebuild-wiktionary data/wiktionary-v2
//!
//! Optional third arg: the resource-model graphid to ship as `<out>/graph.json`
//! (the schema the head carries none of). Defaults to Lexical Entry
//! (`449c8695-…`) - the model shared across the wiktionary/macbain/core layers,
//! and the one the cross-layer merge composes on. A prebuild that carries more
//! than one model still emits ALL of them into one head; only the graph SHIPPED
//! beside the head is selected here, because the read path hydrates one model at
//! a time and needs that model's `StaticGraph`.
//!
//! Paths are resolved relative to the repo root (two levels above this crate),
//! so the same short `data/...` paths work as in `regen-macbain-v2`.

use std::path::Path;

const DEFAULT_GRAPH_ID: &str = "449c8695-253e-521b-8994-27701ce22305";

fn main() {
    let mut args = std::env::args().skip(1);
    let prebuild = args.next().expect("usage: regen-layer-v2 <prebuild_dir> <out_dir> [graph_id]");
    let out = args.next().expect("usage: regen-layer-v2 <prebuild_dir> <out_dir> [graph_id]");
    let graph_id = args.next().unwrap_or_else(|| DEFAULT_GRAPH_ID.to_string());

    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root");
    let data_dir = repo.join(&prebuild);
    let out_dir = repo.join(&out);
    let graph_src = data_dir
        .join("graphs/resource_models")
        .join(format!("{graph_id}.json"));

    if !graph_src.is_file() {
        panic!(
            "graph {} not found in {} - pass the right graph_id as arg 3",
            graph_src.display(),
            data_dir.join("graphs/resource_models").display(),
        );
    }

    // Content-addressed chunks survive a re-emit rather than being overwritten;
    // clear the dir so a stale chunk cannot linger.
    std::fs::remove_dir_all(&out_dir).ok();
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let cfg: std::collections::HashMap<String, ros_madair_emit::ClusterConfig> =
        std::collections::HashMap::new();
    let summary = ros_madair_emit::emit_parquet(
        data_dir.to_str().expect("utf-8 data dir"),
        out_dir.to_str().expect("utf-8 out dir"),
        // Same base_uri as regen-macbain-v2: the layers must agree on it to compose.
        "https://example.org/",
        &ros_madair_emit::default_registry(),
        &cfg,
    )
    .expect("emit");

    std::fs::copy(&graph_src, out_dir.join("graph.json")).expect("copy graph.json");

    let resources: usize = summary.iter().map(|m| m.resources).sum();
    let tiles: usize = summary.iter().map(|m| m.tiles).sum();
    let edges: usize = summary.iter().map(|m| m.edges).sum();
    println!(
        "v2 parquet head written to {} - {} models, {} resources, {} tiles, {} edges; graph.json = {}",
        out_dir.display(),
        summary.len(),
        resources,
        tiles,
        edges,
        graph_id,
    );
}
