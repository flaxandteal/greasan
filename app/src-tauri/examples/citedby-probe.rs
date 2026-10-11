// Throwaway: exercise v2_cited_by's native core (ros_madair_duck::cited_by) over
// an installed layer stack, to see whether the concept fold resolves a homograph
// entry -> its grouping LexicalConcept.
//
//   cargo run --release --example citedby-probe -- \
//       <concept-graph.json> <node_alias> <entry-uuid> <dir0> [dir1 ...]

use std::path::Path;
use alizarin_core::graph::StaticGraph;

fn load_graph(p: &str) -> StaticGraph {
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(p).expect("read graph")).expect("parse graph");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    let mut g: StaticGraph = serde_json::from_value(gv).expect("StaticGraph");
    g.build_indices();
    g
}

fn main() {
    let mut args = std::env::args().skip(1);
    let graph_json = args.next().expect("usage: <graph.json> <alias> <uuid> <dir>...");
    let alias = args.next().expect("alias");
    let uuid = args.next().expect("uuid");
    let dirs: Vec<String> = args.collect();
    assert!(!dirs.is_empty(), "at least one dir");

    let graph = load_graph(&graph_json);
    let node_id = graph
        .get_node_by_alias(&alias)
        .map(|n| n.nodeid.clone())
        .unwrap_or_else(|| panic!("unknown alias '{alias}'"));
    eprintln!("[citedby] alias '{alias}' -> node {node_id}");

    let dir_paths: Vec<&Path> = dirs.iter().map(|d| Path::new(d.as_str())).collect();
    let hits = ros_madair_duck::cited_by(&dir_paths, &node_id, &uuid).expect("cited_by");
    eprintln!("[citedby] {} hit(s): {:?}", hits.len(), hits);
}
