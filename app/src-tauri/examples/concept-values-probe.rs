// Validate the v2_concept_values read: resolve part_of_speech + dialect concept
// labels for a set of resource URIs from a head's concepts_*.parquet + catalog.
//
//   cargo run --release --example concept-values-probe -- <head_dir> <uuid>...

use std::path::Path;
use alizarin_core::graph::StaticGraph;

fn load_graph(p: &Path) -> StaticGraph {
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(p).expect("read graph")).expect("parse");
    let gv = raw.get("graph").and_then(|g| g.get(0)).cloned().unwrap_or(raw);
    serde_json::from_value(gv).expect("StaticGraph")
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("usage: <head_dir> <uuid>...");
    let uris: Vec<String> = args.collect();
    assert!(!uris.is_empty());

    let graph = load_graph(&Path::new(&dir).join("graph.json"));
    let aliases = ["part_of_speech", "dialect"];
    let mut node_to_alias = std::collections::HashMap::new();
    for a in &aliases {
        if let Some(n) = graph.get_node_by_alias(a) {
            eprintln!("[probe] alias {a} -> node {}", n.nodeid);
            node_to_alias.insert(n.nodeid.clone(), a.to_string());
        }
    }

    let mut concept_files = Vec::new();
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with("concepts_") && n.ends_with(".parquet") {
            concept_files.push(e.path().to_string_lossy().into_owned());
        }
    }
    let cat = Path::new(&dir).join("concept_catalog.parquet");
    let lit = |v: &[String]| v.iter().map(|s| format!("'{}'", s.replace('\'', "''"))).collect::<Vec<_>>().join(",");
    let node_ids: Vec<String> = node_to_alias.keys().cloned().collect();
    let sql = format!(
        "SELECT c.resource_id, c.node_id, cat.label FROM read_parquet([{}]) c \
         JOIN read_parquet(['{}']) cat ON c.concept_id = cat.concept_id \
         WHERE c.resource_id IN ({}) AND c.node_id IN ({}) AND cat.label IS NOT NULL",
        lit(&concept_files), cat.to_string_lossy().replace('\'', "''"), lit(&uris), lit(&node_ids),
    );
    let conn = duckdb::Connection::open_in_memory().unwrap();
    let mut stmt = conn.prepare(&sql).unwrap();
    let mut rows = stmt.query([]).unwrap();
    while let Some(row) = rows.next().unwrap() {
        let rid: String = row.get(0).unwrap();
        let nid: String = row.get(1).unwrap();
        let label: String = row.get(2).unwrap();
        eprintln!("[probe] {rid}  {} = {label:?}", node_to_alias.get(&nid).map(|s| s.as_str()).unwrap_or("?"));
    }
    eprintln!("[probe] done");
}
