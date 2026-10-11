// Replicate v2_hydrate_layers' graph_id path EXACTLY (graph_path_for +
// carrier-union + hydrate_layers) over a real multi-dir stack, to see whether a
// secondary-model resource (a LexicalConcept carried by MacBain) hydrates with
// its concept_headword + etymology when the stack is led by a lexical head.
//
//   cargo run --release --example hydrate-gid-probe -- <gid> <uuid> <dir0> [dir1 ...]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use alizarin_core::graph::StaticGraph;
use alizarin_core::{FunctionsRegistry, LayeredGraph};

fn graph_path_for(dir: &str, gid: &str) -> PathBuf {
    let p = Path::new(dir).join(format!("graph_{gid}.json"));
    if p.is_file() { p } else { Path::new(dir).join("graph.json") }
}
fn load_graph(p: &Path) -> StaticGraph {
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(p).expect("read graph")).expect("parse");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    let mut g: StaticGraph = serde_json::from_value(gv).expect("StaticGraph");
    g.build_indices();
    g
}

fn main() {
    let mut args = std::env::args().skip(1);
    let gid = args.next().expect("gid");
    let uuid = args.next().expect("uuid");
    let dirs: Vec<String> = args.collect();
    assert!(!dirs.is_empty());

    let want = [uuid.clone()];
    let mut carriers: Vec<Arc<StaticGraph>> = Vec::new();
    let mut fxg_only: Vec<Arc<StaticGraph>> = Vec::new();
    for d in &dirs {
        let g = Arc::new(load_graph(&graph_path_for(d, &gid)));
        let carries = ros_madair_duck::descriptors(&[Path::new(d.as_str())], &want)
            .map(|m| m.contains_key(&uuid)).unwrap_or(false);
        eprintln!("[probe] dir {d}: graph {} carries={}", g.graphid, carries);
        if carries { carriers.push(g); }
        else if g.functions_x_graphs.as_ref().is_some_and(|v| !v.is_empty()) { fxg_only.push(g); }
    }
    let base = carriers.first().cloned().unwrap_or_else(|| Arc::new(load_graph(&graph_path_for(&dirs[0], &gid))));
    let base_gid = base.graphid.clone();
    let mut overlays: Vec<Arc<StaticGraph>> =
        carriers.into_iter().skip(1).filter(|g| g.graphid == base_gid).collect();
    overlays.extend(fxg_only);
    eprintln!("[probe] base graph = {base_gid}, {} overlay(s)", overlays.len());
    let lg = LayeredGraph::new(base, overlays);
    let reg = FunctionsRegistry::new();
    let dir_paths: Vec<&Path> = dirs.iter().map(|d| Path::new(d.as_str())).collect();
    let tree = ros_madair_duck::hydrate_layers(&dir_paths, &uuid, &lg, &["ga","gd","en"], None, &reg)
        .expect("hydrate_layers");
    let keys: Vec<&String> = tree.as_object().map(|o| o.keys().collect()).unwrap_or_default();
    eprintln!("[probe] tree keys: {keys:?}");
    eprintln!("[probe] concept_headword: {}", tree.get("concept_headword").map(|v| v.to_string()).unwrap_or("<absent>".into()));
    eprintln!("[probe] etymology: {}", tree.get("etymology").map(|v| v.to_string()).unwrap_or("<absent>".into()));
}
