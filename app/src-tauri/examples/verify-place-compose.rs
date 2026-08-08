// SPDX-License-Identifier: AGPL-3.0-or-later
//! Acceptance test for the PLACE layer:
//!  1. Composability: does the full goi stack + the place head open as one
//!     composed view, or must place be a separate head?
//!  2. Reverse lookup: cited_by(baile/cill goi UUID, "element_entry") on the
//!     place head returns the places whose name_elements cite that goi entry -
//!     a DIFFERENT node path from the old cognate_entry_id build.
//!  3. Hydrate a couple of citers and show name / feature_type / the
//!     name_elements.element_entry pointing back at the goi UUID.
//!
//!     cargo run --release --example verify-place-compose --features v2 -- \
//!         data/place-v2 <baile_uuid> <cill_uuid> \
//!         data/wiktionary-v2-full data/macbain-v2 data/tearma-v2 data/bunamo-v2 data/place-v2
//!
//! Args: <place_head> <baile_uuid> <cill_uuid> [stack dirs to compose-test...].

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

/// Decode a localized-string tile value: `{"en":{"value":"…"}}` -> the value, or
/// a bare string, or a stringified fallback.
fn lstr(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o
            .values()
            .next()
            .and_then(|inner| inner.get("value").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// A resource-instance value hydrates as `[{"resourceId":"…"}]`; pull the id(s).
fn ri_ids(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|o| o.get("resourceId").and_then(Value::as_str).map(str::to_string))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => vec![],
    }
}

fn show_place(tree: &Value, feature_labels: &serde_json::Map<String, Value>) {
    let name = lstr(tree.get("name"));
    let name_en = lstr(tree.get("name_en"));
    let ft_id = lstr(tree.get("feature_type"));
    let ft_label = feature_labels.get(&ft_id).and_then(Value::as_str).unwrap_or(ft_id.as_str());
    println!("  name={name:?}  name_en={name_en:?}  feature_type={ft_label:?}");
    if let Some(els) = tree.get("name_elements").and_then(Value::as_array) {
        for e in els {
            let surf = lstr(e.get("element_surface"));
            let ids = ri_ids(e.get("element_entry"));
            println!("    element_surface={surf:?}  element_entry -> {}", ids.join(", "));
        }
    }
}

/// Build concept-id -> English label from the prebuild-place collection JSON by
/// recursively collecting every object carrying both `id` and a prefLabel value.
fn load_feature_labels() -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let dir = repo().join("data/prebuild-place/reference_data/collections");
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };
    fn walk(v: &Value, out: &mut serde_json::Map<String, Value>) {
        match v {
            Value::Object(o) => {
                if let (Some(Value::String(id)), Some(pl)) = (o.get("id"), o.get("prefLabels")) {
                    if let Some(label) = pl.as_object()
                        .and_then(|m| m.values().next())
                        .and_then(|lv| lv.get("value").and_then(Value::as_str))
                    {
                        out.insert(id.clone(), Value::String(label.to_string()));
                    }
                }
                for val in o.values() { walk(val, out); }
            }
            Value::Array(a) => for val in a { walk(val, out); },
            _ => {}
        }
    }
    for e in entries.flatten() {
        if e.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        if let Ok(raw) = std::fs::read_to_string(e.path()) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) { walk(&v, &mut out); }
        }
    }
    out
}

fn main() {
    let mut args = std::env::args().skip(1);
    let place = args.next().expect("place head dir");
    let baile = args.next().expect("baile uuid");
    let cill = args.next().expect("cill uuid");
    let stack: Vec<String> = args.collect();

    let place_p = repo().join(&place);
    let graph = load_graph(&place_p.join("graph.json"));
    println!("place graph_id: {}", graph.graph_id());
    println!();

    // concept-id -> label, read from the prebuild collection JSON (the head ships
    // no RDM), so feature_type hydrates to a human label rather than a UUID.
    let feature_labels = load_feature_labels();

    // --- 1. Composability ---------------------------------------------------
    if !stack.is_empty() {
        let paths: Vec<PathBuf> = stack.iter().map(|s| repo().join(s)).collect();
        let refs: Vec<&Path> = paths.iter().map(|p| p.as_path()).collect();
        print!("[compose] Layers::open({:?}) -> ", stack);
        match Layers::open(&refs) {
            Ok(l) => println!("OK ({} layers compose in-stack)", l.len()),
            Err(e) => println!("REJECTED: {e}"),
        }
    }

    // --- 2. Reverse lookup on the place head alone --------------------------
    let place_only = Layers::open(&[place_p.as_path()]).expect("place head opens");
    for (label, target) in [("baile", &baile), ("cill", &cill)] {
        let citers = place_only
            .cited_by(target, "element_entry", &graph, None)
            .expect("cited_by element_entry");
        println!("\n[cited_by] {label} ({target}) via 'element_entry': {} places", citers.len());
        for uuid in citers.iter().take(2) {
            println!(" hydrate {uuid}:");
            match place_only.hydrate_resource(uuid, &graph) {
                Ok(tree) => show_place(&tree, &feature_labels),
                Err(e) => println!("  (hydrate error: {e})"),
            }
        }
    }
}
