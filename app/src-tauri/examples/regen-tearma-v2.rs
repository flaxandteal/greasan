// SPDX-License-Identifier: AGPL-3.0-or-later
//! Regenerate the v2 head at `data/tearma-v2/` from `data/prebuild-tearma/`
//! (which `scripts/build-tearma-layer.mjs` writes from the Téarma business CSV).
//! Requires `--features v2-emit`.
//!
//!     cargo run --release --example regen-tearma-v2 --features v2-emit
//!
//! Sibling of `regen-macbain-v2.rs` - see that file for why the emitter runs as
//! an example in this workspace rather than `cargo run -p ros-madair-emit`.

use std::path::Path;

fn main() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root");
    let data_dir = repo.join("data/prebuild-tearma");
    let out_dir = repo.join("data/tearma-v2");

    // The head carries no schema, so the Tauri command needs the graph beside it.
    let graph_src =
        data_dir.join("graphs/resource_models/449c8695-253e-521b-8994-27701ce22305.json");

    // Chunks are content-addressed; a stale one survives a re-emit. Clear first.
    std::fs::remove_dir_all(&out_dir).ok();
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let summary = ros_madair_emit::emit(
        data_dir.to_str().expect("utf-8 data dir"),
        out_dir.to_str().expect("utf-8 out dir"),
        "https://example.org/",
    )
    .expect("emit");

    std::fs::copy(&graph_src, out_dir.join("graph.json")).expect("copy graph.json");

    println!(
        "v2 head written to {} - snapshot {}, {} resources, {} tiles, {} chunks",
        out_dir.display(),
        summary.snapshot_id,
        summary.resources,
        summary.tiles,
        summary.chunks,
    );
}
