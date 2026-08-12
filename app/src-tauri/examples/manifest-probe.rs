// Validate that a packaged Parquet head's manifest.json parses through
// ros-madair-read's load_manifest (the exact call the duck run_query registry()
// makes). Prints Ok/Err so we can confirm the hand-crafted complete manifest is
// accepted BEFORE paying for a full APK rebuild.
//
//   cargo run --example manifest-probe --features v2-duck -- data/parquet-layer

use std::path::Path;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: manifest-probe <head_dir>");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root");
    let head = repo.join(&dir);
    match ros_madair_read::load_manifest(&head) {
        Ok(Some(m)) => eprintln!(
            "[manifest] OK - parsed. format_version={}, base_uri={:?}, handlers={}, models={}, artifacts={}",
            m.format_version, m.base_uri, m.handlers.len(), m.models.len(), m.artifacts.len()
        ),
        Ok(None) => eprintln!("[manifest] no manifest.json at {}", head.display()),
        Err(e) => eprintln!("[manifest] ERR {e}"),
    }
}
