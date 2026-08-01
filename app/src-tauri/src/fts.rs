//! SQLite FTS5 full-text sidecar for on-device-built layers.
//!
//! pagefind is the wrong tool for a corpus we build *on the device* (Téarma
//! can't ship, so it must be): its per-record fragment write is ~40 min and
//! ~750MB at Téarma scale. FTS5 — already compiled into the bundled SQLite we
//! link — builds the same headword+gloss search in seconds, a fraction of the
//! size, with bm25 ranking, prefix (as-you-type), and diacritic folding.
//!
//! The index lives in a `search.sqlite` sidecar beside `head.sqlite` — Rós
//! Madair stays ignorant of text (its emit output is untouched); this is a
//! downstream consumer of the same descriptor fields (headword = name, gloss =
//! description) the hydration path already exposes. A layer's text engine is a
//! property of how it was built; the search orchestrator dispatches per layer.

#![cfg(feature = "v2")]

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

/// Incremental FTS5 index writer — fed one resource at a time from the build
/// loop (where pagefind used to be), so the full resource set is never held.
#[cfg(feature = "v2-emit")]
pub struct FtsBuilder {
    conn: Connection,
    n: usize,
}

#[cfg(feature = "v2-emit")]
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

/// One search hit. `score` is bm25 (lower = better in SQLite; we negate so
/// higher = better, matching the rest of the search pipeline).
#[derive(Debug, Serialize)]
pub struct FtsHit {
    pub uri: String,
    pub headword: String,
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

        let sql = "SELECT uri, headword, snippet(fts, ?1, '[', ']', '…', 8), bm25(fts) \
                   FROM fts WHERE fts MATCH ?2 ORDER BY bm25(fts) LIMIT ?3";
        let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare fts search: {e}"))?;
        let rows = stmt
            .query_map(
                rusqlite::params![snip_col, match_expr, limit as i64],
                |r| {
                    Ok(FtsHit {
                        uri: r.get::<_, String>(0)?,
                        headword: r.get::<_, String>(1)?,
                        snippet: r.get::<_, String>(2)?,
                        // Negate bm25 so higher = better (SQLite bm25 is lower=better).
                        score: -r.get::<_, f64>(3)?,
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
    Ok(hits)
}

#[cfg(all(test, feature = "v2-emit"))]
mod tests {
    use super::*;
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
