// SPDX-License-Identifier: AGPL-3.0-or-later
//! Acceptance test for the BuNaMo layer: hydrate the COMPOSED stack
//! (wiktionary base + bunamo overlay) for `goi-fear-noun` and show that the
//! composed entry carries wiktionary's senses AND BuNaMo's full paradigm.
//!
//!     cargo run --release --example verify-bunamo-compose --features v2 -- \
//!         data/wiktionary-v2-full data/bunamo-v2 9f29742a-33e7-57d5-99ea-6febb7d8dffb
//!
//! Args: <base_head> <overlay_head> <resource_uuid> [more overlays...]. Prints,
//! per single layer and for the composed stack: the top-level nodegroup keys and
//! the `forms` / `senses` tile counts. That is the observable of per-nodegroup
//! precedence: whether composed forms == overlay forms (REPLACE) or base∪overlay
//! (UNION).

use std::path::{Path, PathBuf};

use alizarin_core::graph::StaticGraph;
use ros_madair_read::Layers;
use serde_json::Value;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

fn load_graph(path: &Path) -> StaticGraph {
    let raw = std::fs::read_to_string(path).expect("read graph.json");
    let json: Value = serde_json::from_str(&raw).expect("parse graph json");
    let gv = match json.get("graph").and_then(|g| g.get(0)) {
        Some(v) => v.clone(),
        None => json,
    };
    let mut g: StaticGraph = serde_json::from_value(gv).expect("graph schema");
    g.build_indices();
    g
}

fn ng_len(tree: &Value, key: &str) -> usize {
    tree.get(key).and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)
}

fn keys(tree: &Value) -> Vec<String> {
    tree.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default()
}

fn forms_summary(tree: &Value) -> Vec<String> {
    tree.get("forms")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|t| {
                    let wr = t.get("written_rep").and_then(Value::as_str).unwrap_or("");
                    let gf = t
                        .get("gram_features")
                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                        .unwrap_or_default();
                    format!("{wr}  [{gf}]")
                })
                .collect()
        })
        .unwrap_or_default()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let base = args.next().expect("base head dir");
    let overlay = args.next().expect("overlay head dir");
    let uuid = args.next().expect("resource uuid");
    let extra: Vec<String> = args.collect();

    let base_p = repo().join(&base);
    let overlay_p = repo().join(&overlay);
    let mut extra_p: Vec<PathBuf> = extra.iter().map(|e| repo().join(e)).collect();

    let graph = load_graph(&base_p.join("graph.json"));

    // Single layers alone.
    let base_only = Layers::open(&[base_p.as_path()]).expect("base opens");
    let overlay_only = Layers::open(&[overlay_p.as_path()]).expect("overlay opens");
    let base_tree = base_only.hydrate_resource(&uuid, &graph).ok();
    let overlay_tree = overlay_only.hydrate_resource(&uuid, &graph).ok();

    // Composed stack, base first (later overrides earlier).
    let mut stack: Vec<&Path> = vec![base_p.as_path(), overlay_p.as_path()];
    for p in &extra_p { stack.push(p.as_path()); }
    let composed = Layers::open(&stack).expect("composed stack opens (contract honoured)");
    let merged = composed.hydrate_resource(&uuid, &graph).expect("composed hydrate");

    println!("resource uuid: {uuid}");
    println!("layers in stack: {}", composed.len());
    println!();

    if let Some(t) = &base_tree {
        println!("[base only]    keys={:?}  forms={} senses={}",
            keys(t), ng_len(t, "forms"), ng_len(t, "senses"));
    } else {
        println!("[base only]    (resource absent)");
    }
    if let Some(t) = &overlay_tree {
        println!("[overlay only] keys={:?}  forms={} senses={}",
            keys(t), ng_len(t, "forms"), ng_len(t, "senses"));
    } else {
        println!("[overlay only] (resource absent)");
    }
    println!("[COMPOSED]     keys={:?}  forms={} senses={}",
        keys(&merged), ng_len(&merged, "forms"), ng_len(&merged, "senses"));

    let base_forms = base_tree.as_ref().map(ng_len_forms).unwrap_or(0);
    let overlay_forms = overlay_tree.as_ref().map(ng_len_forms).unwrap_or(0);
    let composed_forms = ng_len(&merged, "forms");
    println!();
    println!("PRECEDENCE: base_forms={base_forms} overlay_forms={overlay_forms} composed_forms={composed_forms}");
    if composed_forms == overlay_forms && base_forms > 0 && overlay_forms != base_forms + overlay_forms {
        println!("  -> composed forms == OVERLAY forms  => per-nodegroup REPLACE (overlay wins)");
    } else if composed_forms == base_forms + overlay_forms {
        println!("  -> composed forms == base+overlay   => per-tile UNION");
    } else {
        println!("  -> composed forms = {composed_forms} (inspect manually)");
    }

    println!();
    println!("composed `senses` (wiktionary contribution):");
    if let Some(senses) = merged.get("senses").and_then(Value::as_array) {
        for s in senses.iter().take(6) {
            let g = s.get("gloss").and_then(Value::as_str).unwrap_or("");
            let src = s.get("source_label").and_then(Value::as_str).unwrap_or("");
            println!("  - [{src}] {g}");
        }
    } else {
        println!("  (none)");
    }

    println!();
    println!("composed `forms` (BuNaMo paradigm):");
    for f in forms_summary(&merged) {
        println!("  - {f}");
    }

    println!();
    println!("RAW first 2 forms tiles (structure check):");
    if let Some(arr) = merged.get("forms").and_then(Value::as_array) {
        for t in arr.iter().take(2) {
            println!("{}", serde_json::to_string(t).unwrap());
        }
    }
    // Also dump the overlay-only forms raw, so BuNaMo's written_rep is visible.
    if let Some(t) = &overlay_tree {
        println!("RAW overlay-only forms tiles:");
        if let Some(arr) = t.get("forms").and_then(Value::as_array) {
            for tile in arr { println!("{}", serde_json::to_string(tile).unwrap()); }
        }
    }

    let _ = &mut extra_p;
}

fn ng_len_forms(t: &Value) -> usize {
    t.get("forms").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)
}
