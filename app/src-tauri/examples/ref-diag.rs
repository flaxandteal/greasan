// Diagnostic for the reference label-keying mismatch: dump (a) a resource's raw
// reference tiles (the stored value id) and (b) the matching catalog rows
// (which column/id holds the label), so upstream can repro the exact shape.
//
//   cargo run --release --example ref-diag -- <head_dir> <resource_uuid> <label_substr>

use ros_madair_duck::DuckReader;

fn main() {
    let mut a = std::env::args().skip(1);
    let dir = a.next().expect("usage: ref-diag <dir> <uuid> <label_substr>");
    let uuid = a.next().expect("uuid");
    let needle = a.next().unwrap_or_else(|| "Public Domain".into());

    let glob = format!("{dir}/tiles_*.parquet");
    let cat = format!("{dir}/concept_catalog.parquet");
    let duck = DuckReader::open_with_catalog(&glob, &cat).expect("open");

    eprintln!("=== (a) raw tiles for {uuid} ===");
    let tiles = duck.resource_tiles(&uuid).expect("resource_tiles");
    for t in &tiles {
        eprintln!("[tile] {}", serde_json::to_string(&t).unwrap_or_default());
    }

    eprintln!("=== (b) catalog: concept_labels() rows matching '{needle}' ===");
    let labels = duck.concept_labels().expect("concept_labels");
    eprintln!("[catalog] concept_labels() total rows: {}", labels.len());
    let nl = needle.to_lowercase();
    for (id, lab) in &labels {
        if lab.to_lowercase().contains(&nl) {
            eprintln!("[catalog] concept_id={id}  label={lab}");
        }
    }

    // Direct catalog lookup (the resolver's keying): does the stored reference id
    // resolve via concept_label()? If Some -> the catalog IS keyed on this id
    // (RM resolution bug for our shape); if None -> our tile's id is NOT the
    // catalog's concept_id (our emit/keying bug).
    if let Some(stored_id) = a.next() {
        match duck.concept_label(&stored_id).expect("concept_label") {
            Some(lab) => eprintln!("[lookup] concept_label({stored_id}) = Some({lab})  <- catalog IS keyed on the stored id"),
            None => eprintln!("[lookup] concept_label({stored_id}) = None  <- stored id is NOT the catalog concept_id (keying miss)"),
        }
    }
}
