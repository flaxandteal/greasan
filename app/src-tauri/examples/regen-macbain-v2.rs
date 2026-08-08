// SPDX-License-Identifier: AGPL-3.0-or-later
//! Regenerate the v2 pilot artifact at `data/macbain-v2/` from
//! `data/prebuild-macbain/`. Requires `--features v2-emit`.
//!
//!     cargo run --release --example regen-macbain-v2 --features v2-emit
//!
//! (`scripts/build-macbain-v2.mjs` wraps this and is the provenance record.)
//!
//! # Why an example here, rather than `cargo run -p ros-madair-emit`
//!
//! The emitter is a path dependency, so building it from *this* workspace puts
//! its artifacts in *this* `target/` and leaves the RosMadair sandbox's `target/`
//! lock and `Cargo.lock` alone - which matters, because that tree is worked on
//! independently and `--manifest-path <sandbox>` would take both.
//!
//! # Why the artifact had to be re-emitted at all
//!
//! The committed head was emitted at `manifest_version` 3, which predates the
//! manifest's `handlers` block - the declaration `src/v2.rs` now rebuilds its
//! query registry from. `handlers` is a required field of the current
//! `ros_madair_format::Manifest`, so a v3 manifest does not merely lack the
//! declaration: it does not parse, and `ros-madair-read` refuses the snapshot
//! outright (loudly, which is the intended behaviour - see that crate's P17
//! note). Re-emitting is the only move; there is deliberately no compat path.

use std::path::Path;

fn main() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root");
    let data_dir = repo.join("data/prebuild-macbain");
    let out_dir = repo.join("data/macbain-v2");

    // The Arches resource-model export for Lexical Entry. The head carries no
    // schema, so the Tauri command needs the graph shipped beside it.
    let graph_src =
        data_dir.join("graphs/resource_models/449c8695-253e-521b-8994-27701ce22305.json");

    // Chunks are content-addressed, so a stale one would simply survive a
    // re-emit rather than be overwritten. Clear the directory.
    std::fs::remove_dir_all(&out_dir).ok();
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let summary = ros_madair_emit::emit(
        data_dir.to_str().expect("utf-8 data dir"),
        out_dir.to_str().expect("utf-8 out dir"),
        // Unchanged from the previous emit; it feeds the snapshot id.
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
