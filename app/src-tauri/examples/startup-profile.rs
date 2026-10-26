// Startup-cost profile for the DuckDB read stack: measures the two dominant
// warm-up costs the app pays in bootstrapLayers() - per-head reader open (what
// `prewarm` does) and `concept_labels` (what `warmClosure` does) - against the
// local parquet dev heads, so the mitigation costing rests on real numbers.
//
//   cargo run --release --example startup-profile -- [data_dir]
//
// NOTE: local wiktionary-v2/logainm-v2 are still old head.sqlite (no tiles_*.parquet)
// so they're skipped; production has them as parquet. Treat the per-head cost as
// the scaling unit and multiply by the real stack size.

use std::path::{Path, PathBuf};
use std::time::Instant;

fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| "../../data".to_string());
    let mut dirs_p: Vec<PathBuf> = std::fs::read_dir(&root)
        .expect("read data dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.file_name().unwrap().to_string_lossy().ends_with("-v2"))
        .filter(|p| {
            // Only parquet heads (have tiles_*.parquet); skip meta + old-format heads.
            std::fs::read_dir(p)
                .map(|rd| rd.filter_map(|e| e.ok()).any(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    n.starts_with("tiles_") && n.ends_with(".parquet")
                }))
                .unwrap_or(false)
        })
        .collect();
    dirs_p.sort();
    let dirs: Vec<&Path> = dirs_p.iter().map(|p| p.as_path()).collect();
    eprintln!("[profile] {} parquet head dirs in stack:", dirs.len());

    // --- 1. Per-head COLD reader open (the prewarm granularity; what lazy-open defers) ---
    let mut total_open = 0u128;
    for d in &dirs {
        let glob = format!("{}/tiles_*.parquet", d.to_string_lossy());
        let cat = d.join("concept_catalog.parquet");
        let t = Instant::now();
        let r = if cat.is_file() {
            ros_madair_duck::DuckReader::open_with_catalog(&glob, &cat.to_string_lossy()).map(|_| ())
        } else {
            ros_madair_duck::DuckReader::open_with(&glob, ros_madair_duck::SpatialSource::None).map(|_| ())
        };
        let ms = t.elapsed().as_millis();
        total_open += ms;
        eprintln!(
            "  open {:<24} {:>5} ms {}",
            d.file_name().unwrap().to_string_lossy(),
            ms,
            if r.is_ok() { "" } else { "(ERR)" }
        );
    }
    eprintln!("[profile] SUM per-head cold open = {} ms  (~= prewarm total, serial)", total_open);

    // --- 2. concept_labels / closure (what warmClosure pays; fresh readers) ---
    let t = Instant::now();
    let labels = ros_madair_duck::concept_labels(&dirs);
    eprintln!(
        "[profile] concept_labels(stack) = {} ms  ({} labels)",
        t.elapsed().as_millis(),
        labels.map(|m| m.len()).unwrap_or(0)
    );

    // --- 3. concept_labels again (warm pool?) to see if a disk cache would save it ---
    let t = Instant::now();
    let _ = ros_madair_duck::concept_labels(&dirs);
    eprintln!("[profile] concept_labels AGAIN = {} ms  (shows pool/OS-cache benefit)", t.elapsed().as_millis());
}
