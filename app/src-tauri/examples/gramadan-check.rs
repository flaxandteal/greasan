//! Reproduce the native gramadan-forms derive for one resource and print the
//! generated forms (written_rep + gram_features + source), so we can see whether
//! the paradigm pivots (tags resolve to axis labels) - the "4-way cells" issue.
//!
//!   cargo run --release --example gramadan-check --features v2-duck -- \
//!     <uuid> <base-dir> <overlay-dir>...
//! e.g. (from app/src-tauri):
//!   ... -- 9f29742a-33e7-57d5-99ea-6febb7d8dffb \
//!        ../../data/parquet-wiktionary ../../data/parquet-gramadan-forms

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use alizarin_core::graph::StaticGraph;
use alizarin_core::LayeredGraph;
use ros_madair_duck::{DuckReader, SpatialSource};

fn load_graph(dir: &Path) -> StaticGraph {
    let raw = std::fs::read_to_string(dir.join("graph.json")).expect("graph.json");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let v = json.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(json);
    let mut g: StaticGraph = serde_json::from_value(v).unwrap();
    g.build_indices();
    g
}

// Replica of the app's gramadan_vocab (invert concept catalogs for the tag /
// gender / dialect labels).
fn build_vocab(dirs: &[&Path]) -> greasan_gramadan::GramadanVocab {
    let mut by_label: HashMap<String, String> = HashMap::new();
    for dir in dirs {
        let catalog = dir.join("concept_catalog.parquet");
        if !catalog.is_file() {
            continue;
        }
        let glob = format!("{}/tiles_*.parquet", dir.display());
        if let Ok(duck) = DuckReader::open_with(&glob, SpatialSource::None)
            .and_then(|d| d.with_catalog(&catalog.to_string_lossy()))
        {
            if let Ok(labels) = duck.concept_labels() {
                for (id, label) in labels {
                    by_label.entry(label).or_insert(id);
                }
            }
        }
    }
    let mut tag_concepts = HashMap::new();
    for tag in ["singular", "plural", "nominative", "genitive", "vocative", "dative", "masculine", "feminine"] {
        if let Some(id) = by_label.get(tag) {
            tag_concepts.insert(tag.to_string(), id.clone());
        } else {
            eprintln!("[check] vocab MISS: no catalog concept for tag '{tag}'");
        }
    }
    let mut gender_is_fem = HashMap::new();
    for (label, id) in &by_label {
        let l = label.to_lowercase();
        if l.starts_with("fem") { gender_is_fem.insert(id.clone(), true); }
        else if l.starts_with("masc") { gender_is_fem.insert(id.clone(), false); }
    }
    let dialect_concept = by_label.get("Irish").or_else(|| by_label.get("Irish (General)")).cloned().unwrap_or_default();
    eprintln!("[check] vocab: {} tag concepts, {} gender concepts, dialect={:?}",
        tag_concepts.len(), gender_is_fem.len(), if dialect_concept.is_empty() {"MISSING"} else {"ok"});
    greasan_gramadan::GramadanVocab { tag_concepts, gender_is_fem, dialect_concept, source_label: "gf".into() }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let uuid = args[0].clone();
    let dirs: Vec<&Path> = args[1..].iter().map(|s| Path::new(s.as_str())).collect();
    let langs = ["ga", "gd", "en"];
    // On device the head dir basename is the HEAD name (e.g. gramadan-forms-v2),
    // which is what the fxg member_of matches. Our local dirs are parquet-<x>, so
    // map them to the head name so is_member behaves as on device.
    let layer_ids: Vec<String> = dirs.iter().map(|d| {
        let base = d.file_name().unwrap().to_string_lossy();
        format!("{}-v2", base.strip_prefix("parquet-").unwrap_or(&base))
    }).collect();
    eprintln!("[check] layer_ids: {layer_ids:?}");

    let base = Arc::new(load_graph(dirs[0]));
    let overlays: Vec<Arc<StaticGraph>> = dirs[1..].iter().filter_map(|d| {
        let g = load_graph(d);
        if g.functions_x_graphs.as_ref().is_some_and(|v| !v.is_empty()) { Some(Arc::new(g)) } else { None }
    }).collect();
    let composed = LayeredGraph::new(base, overlays);

    let mut registry = alizarin_core::default_functions_registry();
    greasan_gramadan::register(&mut registry, build_vocab(&dirs));

    // Pure paradigm (bypasses hydration/merge) - what the derive SHOULD emit.
    eprintln!("[check] pure noun_forms(fear, Masc, 1):");
    for f in greasan_gramadan::noun_forms("fear", gramadan::features::Gender::Masc, 1) {
        eprintln!("   {} {:?}", f.written_rep, f.tags);
    }

    let tree = ros_madair_duck::hydrate_layers(&dirs, &uuid, &composed, &langs, Some(&layer_ids), &registry)
        .expect("hydrate");

    // Print the forms as hydrated (labels resolved).
    let forms = tree.get("forms").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    eprintln!("[check] {} forms in hydrated tree:", forms.len());
    for f in forms.iter().take(12) {
        let wr = f.get("written_rep").map(|v| v.to_string()).unwrap_or_default();
        let gf = f.get("gram_features").map(|v| v.to_string()).unwrap_or_default();
        let src = f.get("form_source_label").map(|v| v.to_string()).unwrap_or_default();
        eprintln!("  wr={wr}  gram_features={gf}  source={src}");
    }
}
