//! SQLite FTS5 full-text sidecar for on-device-built layers.
//!
//! pagefind is the wrong tool for a corpus we build *on the device* (Téarma
//! can't ship, so it must be): its per-record fragment write is ~40 min and
//! ~750MB at Téarma scale. FTS5 - already compiled into the bundled SQLite we
//! link - builds the same headword+gloss search in seconds, a fraction of the
//! size, with bm25 ranking, prefix (as-you-type), and diacritic folding.
//!
//! The index lives in a `search.sqlite` sidecar beside `head.sqlite` - Rós
//! Madair stays ignorant of text (its emit output is untouched); this is a
//! downstream consumer of the same descriptor fields (headword = name, gloss =
//! description) the hydration path already exposes. A layer's text engine is a
//! property of how it was built; the search orchestrator dispatches per layer.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

/// The FTS5 columns. `uri` is stored but not indexed (retrieval key); headword
/// and gloss are the two searchable fields (Ceannfhocail / Gluais tabs).
const FTS_SCHEMA: &str = "\
    PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;\n\
    CREATE VIRTUAL TABLE fts USING fts5(\n\
        uri UNINDEXED, headword, gloss,\n\
        tokenize='unicode61 remove_diacritics 2'\n\
    );";

/// Incremental FTS5 index writer - fed one resource at a time from the build
/// loop (where pagefind used to be), so the full resource set is never held.
pub struct FtsBuilder {
    conn: Connection,
    n: usize,
}

impl FtsBuilder {
    /// Create a fresh `search.sqlite` in `dir` with the FTS5 table + an open txn.
    pub fn create(dir: &Path) -> Result<Self, String> {
        let path = dir.join("search.sqlite");
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).map_err(|e| format!("open search.sqlite: {e}"))?;
        conn.execute_batch(FTS_SCHEMA)
            .map_err(|e| format!("create fts: {e}"))?;
        conn.execute_batch("BEGIN;")
            .map_err(|e| format!("begin fts txn: {e}"))?;
        Ok(Self { conn, n: 0 })
    }

    /// Index one entry. Empty headword is skipped (nothing to match on).
    pub fn add(&mut self, uri: &str, headword: &str, gloss: &str) -> Result<(), String> {
        if headword.trim().is_empty() {
            return Ok(());
        }
        let mut stmt = self
            .conn
            .prepare_cached("INSERT INTO fts(uri, headword, gloss) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("prepare fts insert: {e}"))?;
        stmt.execute(rusqlite::params![uri, headword, gloss])
            .map_err(|e| format!("fts insert: {e}"))?;
        self.n += 1;
        Ok(())
    }

    /// Commit + optimize (merges the b-tree segments for smaller/faster reads).
    pub fn finish(self) -> Result<usize, String> {
        self.conn
            .execute_batch("COMMIT;")
            .map_err(|e| format!("commit fts: {e}"))?;
        // Best-effort: 'optimize' compacts the index; not fatal if it fails.
        let _ = self
            .conn
            .execute("INSERT INTO fts(fts) VALUES('optimize')", []);
        Ok(self.n)
    }
}

/// Build a `search.sqlite` FTS5 sidecar for an already-materialised head dir
/// (its `graph.json` + `tiles_*.parquet`) - the catalogue "built"-install
/// counterpart of the index the tbx-v2 build loop produces inline. A downloaded
/// pre-built head carries tiles but no text index; this makes it searchable
/// (headword = name, gloss = description) with the SAME engine, schema, and
/// descriptor fields as the on-device path, so the existing FTS search
/// orchestrator (`v2_search_fts` over the active head dirs) picks it up with no
/// other change.
///
/// Only the head's PRIMARY model (the one in `graph.json`) is indexed: a second
/// baked model in the same dir (e.g. the `layer-<slug>` catalogue tiles) is
/// skipped, because `resolve_ids` is scoped to that graph id. Returns the
/// indexed row count.
pub fn build_for_head(head_dir: &Path) -> Result<usize, String> {
    use alizarin_core::graph::StaticGraph;
    use std::collections::HashSet;

    // The PRIMARY (graph.json) model's nodegroups. A head may carry a second
    // model's tiles in the same dir - notably the baked `layer-<slug>` catalogue
    // resource, whose `descriptor_name` is the layer display name, NOT a headword
    // - so we index only resources whose tiles sit in a primary nodegroup.
    let graph_json = head_dir.join("graph.json");
    let raw: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&graph_json).map_err(|e| format!("read graph.json: {e}"))?,
    )
    .map_err(|e| format!("parse graph.json: {e}"))?;
    let gv = raw
        .get("graph")
        .and_then(|g| g.get(0))
        .cloned()
        .unwrap_or(raw);
    let graph: StaticGraph =
        serde_json::from_value(gv).map_err(|e| format!("StaticGraph: {e}"))?;
    let primary_ngs: HashSet<String> =
        graph.nodegroups.iter().map(|ng| ng.nodegroupid.clone()).collect();

    // Headword = the emit-promoted `descriptor_name` column: the display name
    // alizarin computed at BUILD time (with full enrichment + the model's
    // descriptor template) and baked onto the tile rows. We read THAT rather than
    // re-deriving via `build_descriptors` over raw tiles - the runtime
    // re-derivation misses ~40% of entries here (and returns the literal
    // "<Headword>" template for them), whereas `descriptor_name` is authoritative
    // and complete. One scan over the app's own duckdb dep; first non-empty value
    // per resource wins.
    //
    // Gloss is NOT promoted to a column, so the Gluais/English search over an
    // installed layer awaits a follow-up (an emit-side `description` descriptor,
    // which would also benefit bundled heads). The Ceannfhocail/headword path -
    // the primary search, and the one a catalogue install needs most - works fully.
    let glob = head_dir.join("tiles_*.parquet");
    let conn = duckdb::Connection::open_in_memory().map_err(|e| format!("duckdb open: {e}"))?;
    // Elide unresolved descriptor templates: a build whose descriptor couldn't
    // resolve bakes the literal "<...>" placeholder (e.g. macbain entries with no
    // structured headword tile carry descriptor_name = "<Headword>"). Those are
    // not real headwords - indexing them would pollute search - so skip any value
    // that is a bare "<...>" placeholder.
    let sql = format!(
        "SELECT DISTINCT resource_id, descriptor_name, nodegroup_id \
         FROM read_parquet('{}') \
         WHERE descriptor_name IS NOT NULL AND descriptor_name <> '' \
           AND NOT (descriptor_name LIKE '<%>' AND descriptor_name NOT LIKE '% %')",
        glob.to_string_lossy().replace('\'', "''"),
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("duckdb prepare: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("duckdb query: {e}"))?;

    let mut fts = FtsBuilder::create(head_dir)?;
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(row) = rows.next().map_err(|e| format!("duckdb row: {e}"))? {
        let rid: String = row.get(0).map_err(|e| format!("col resource_id: {e}"))?;
        let name: String = row.get(1).map_err(|e| format!("col descriptor_name: {e}"))?;
        let ng: String = row.get(2).map_err(|e| format!("col nodegroup_id: {e}"))?;
        if !primary_ngs.contains(&ng) {
            continue;
        }
        if seen.insert(rid.clone()) {
            fts.add(&rid, &name, "")?;
        }
    }
    fts.finish()
}

/// One search hit. `score` is bm25 (lower = better in SQLite; we negate so
/// higher = better, matching the rest of the search pipeline).
#[derive(Debug, Serialize)]
pub struct FtsHit {
    pub uri: String,
    pub headword: String,
    /// The full gloss (subtitle for a headword-tab result).
    pub gloss: String,
    /// Highlighted snippet of the matched column (subtitle for a gloss-tab result).
    pub snippet: String,
    pub score: f64,
}

/// Turn raw user input into a safe FTS5 MATCH expression, scoped to a column.
///
/// User text can contain FTS5 operators (`"`, `*`, `:`, `(`, `NEAR`…), so we
/// tokenise, quote each token as a literal phrase, and append `*` to the last
/// token for as-you-type prefix matching. `field` restricts the match to a
/// column (`headword`/`gloss`); anything else searches both.
fn build_fts_match(query: &str, field: &str) -> Option<String> {
    let tokens: Vec<String> = query
        .split_whitespace()
        .map(|t| t.replace('"', "")) // strip quote chars; unicode61 handles the rest
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let last = tokens.len() - 1;
    let phrases: Vec<String> = tokens
        .iter()
        .enumerate()
        .map(|(i, t)| {
            // Quoted phrase; last token gets a prefix star for search-as-you-type.
            if i == last {
                format!("\"{t}\" *")
            } else {
                format!("\"{t}\"")
            }
        })
        .collect();
    let body = phrases.join(" ");
    let expr = match field {
        "headword" | "gloss" => format!("{field} : ({body})"),
        _ => format!("({body})"),
    };
    Some(expr)
}

/// Full-text search across the `search.sqlite` sidecars of the given layer
/// dirs. Results from all FTS layers are bm25-comparable, so we sort by score,
/// dedup by URI (first/best wins), and truncate to `limit`.
#[tauri::command]
pub fn v2_search_fts(
    fts_dirs: Vec<String>,
    query: String,
    field: String,
    limit: usize,
) -> Result<Vec<FtsHit>, String> {
    #[cfg(feature = "cmdperf")]
    let __t = std::time::Instant::now();
    let Some(match_expr) = build_fts_match(&query, &field) else {
        return Ok(Vec::new());
    };
    // snippet() needs the column index: 0=uri, 1=headword, 2=gloss.
    let snip_col = if field == "gloss" { 2 } else { 1 };

    let mut hits: Vec<FtsHit> = Vec::new();
    for dir in &fts_dirs {
        let path = Path::new(dir).join("search.sqlite");
        if !path.exists() {
            continue;
        }
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("open {}: {e}", path.display()))?;

        let sql = "SELECT uri, headword, gloss, snippet(fts, ?1, '[', ']', '…', 8), bm25(fts) \
                   FROM fts WHERE fts MATCH ?2 ORDER BY bm25(fts) LIMIT ?3";
        let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare fts search: {e}"))?;
        let rows = stmt
            .query_map(
                rusqlite::params![snip_col, match_expr, limit as i64],
                |r| {
                    Ok(FtsHit {
                        uri: r.get::<_, String>(0)?,
                        headword: r.get::<_, String>(1)?,
                        gloss: r.get::<_, String>(2)?,
                        snippet: r.get::<_, String>(3)?,
                        // Negate bm25 so higher = better (SQLite bm25 is lower=better).
                        score: -r.get::<_, f64>(4)?,
                    })
                },
            )
            .map_err(|e| format!("fts query for {dir}: {e}"))?;
        for hit in rows.flatten() {
            hits.push(hit);
        }
    }

    // Best score first, dedup by URI (a URI can appear in multiple layers).
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut seen = std::collections::HashSet::new();
    hits.retain(|h| seen.insert(h.uri.clone()));
    hits.truncate(limit);
    crate::cmdperf!("[cmdperf] v2_search_fts dirs={} field={field} q={:?} hits={} {}ms",
        fts_dirs.len(), query, hits.len(), __t.elapsed().as_millis());
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Timing probe for `build_for_head` on a real head dir (default
    /// ../../data/macbain-v2; override with FTS_HEAD_DIR). Ignored by default:
    ///   cargo test --release -p greasan fts_build_for_head_bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn fts_build_for_head_bench() {
        let dir = std::env::var("FTS_HEAD_DIR").unwrap_or_else(|_| {
            format!("{}/../../data/macbain-v2", env!("CARGO_MANIFEST_DIR"))
        });
        let dir = std::path::PathBuf::from(dir);
        let _ = std::fs::remove_file(dir.join("search.sqlite"));
        let t = std::time::Instant::now();
        let n = super::build_for_head(&dir).expect("build_for_head");
        let ms = t.elapsed().as_millis();
        eprintln!("[fts-bench] {} entries in {ms} ms ({:.1}/s)", n, n as f64 / (ms as f64 / 1000.0));
        // Confirm the index is usable.
        let hits = v2_search_fts(vec![dir.to_string_lossy().to_string()], "fear".into(), "headword".into(), 5).unwrap();
        eprintln!("[fts-bench] 'fear' headword hits: {}", hits.len());
        assert!(n > 0, "indexed nothing");
    }

    #[test]
    fn fts_build_and_search() {
        let dir = std::env::temp_dir().join(format!("fts-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let mut b = FtsBuilder::create(&dir).unwrap();
        b.add("goi-ga/admhail-duga", "admháil duga", "dock receipt").unwrap();
        b.add("goi-ga/aeraid", "aeráid", "climate").unwrap();
        b.add("goi-ga/fear", "fear", "man").unwrap();
        let n = b.finish().unwrap();
        assert_eq!(n, 3);
        let d = vec![dir.to_string_lossy().to_string()];
        // EN gloss search: "receipt" -> admháil duga
        let hits = v2_search_fts(d.clone(), "receipt".into(), "gloss".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "gloss search hits: {hits:?}");
        assert_eq!(hits[0].headword, "admháil duga");
        // Diacritic-folded prefix headword search: "aerai" -> aeráid
        let hits = v2_search_fts(d.clone(), "aerai".into(), "headword".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "prefix search hits: {hits:?}");
        assert_eq!(hits[0].headword, "aeráid");
        // Multi-word gloss prefix ("dock rec" as-you-type)
        let hits = v2_search_fts(d.clone(), "dock rec".into(), "gloss".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "as-you-type hits: {hits:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
