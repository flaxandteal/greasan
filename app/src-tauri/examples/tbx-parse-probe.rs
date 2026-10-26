// Memory/correctness probe for the on-device TBX parse (the Téarma OOM path).
// Includes tbx_parser.rs directly (it's self-contained) and runs the SAME
// parse_tbx + enrich_records the on-device build calls, reporting peak RSS so a
// before/after of the merge-during-parse change is measurable on the host.
//
//   cargo run --release --example tbx-parse-probe -- <decompressed .tbx>

#[path = "../src/tbx_parser.rs"]
mod tbx_parser;

/// Peak resident set size (VmHWM) in MB - the high-water mark, what the phone's
/// low-memory killer watches.
fn peak_rss_mb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|n| n.parse::<u64>().ok())
        })
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: tbx-parse-probe <tbx file>");
    let bytes = std::fs::read(&path).expect("read tbx");
    eprintln!("[probe] input {} MB", bytes.len() / 1_000_000);

    let t = std::time::Instant::now();
    let mut records = tbx_parser::parse_tbx(&bytes).expect("parse_tbx");
    eprintln!(
        "[probe] parse: {} ms, {} merged records, peak RSS {} MB",
        t.elapsed().as_millis(),
        records.len(),
        peak_rss_mb()
    );
    drop(bytes);

    let t = std::time::Instant::now();
    tbx_parser::enrich_records(&mut records);
    eprintln!(
        "[probe] enrich: {} ms, peak RSS {} MB",
        t.elapsed().as_millis(),
        peak_rss_mb()
    );
    eprintln!("[probe] OK ({} records)", records.len());
}
