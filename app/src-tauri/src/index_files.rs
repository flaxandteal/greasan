use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::{Manager, Runtime, UriSchemeContext};
use zip::ZipArchive;

use crate::pagefind_zip::read_entry;

/// Cached open zip archives (tiles.zip, pages.zip) keyed by file path.
/// Newtype wrapper so Tauri's state doesn't collide with PfZipState (same inner type).
pub struct LayerZipState(Mutex<HashMap<String, ZipArchive<File>>>);

impl Default for LayerZipState {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

fn content_type_for(path: &str) -> &'static str {
    if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".xml") {
        "application/xml"
    } else {
        "application/octet-stream"
    }
}

/// Build a response with CORS headers including Range support.
fn response(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        .header("Accept-Ranges", "bytes")
        .header("Content-Type", content_type)
        .body(body)
        .unwrap()
}

/// Parse `bytes=start-end` range header. Returns inclusive (start, end).
fn parse_range(header: &str, file_len: u64) -> Option<(u64, u64)> {
    let range = header.strip_prefix("bytes=")?;
    let mut parts = range.split('-');
    let start_str = parts.next()?.trim();
    let end_str = parts.next()?.trim();

    if start_str.is_empty() {
        // bytes=-N (last N bytes)
        let n: u64 = end_str.parse().ok()?;
        Some((file_len.saturating_sub(n), file_len - 1))
    } else {
        let start: u64 = start_str.parse().ok()?;
        let end = if end_str.is_empty() {
            file_len - 1
        } else {
            end_str.parse::<u64>().ok()?
        };
        if start <= end && start < file_len {
            Some((start, end.min(file_len - 1)))
        } else {
            None
        }
    }
}

/// Try to serve a file from tiles.zip or pages.zip within a layer directory.
/// Returns Some(response) if the file was found in a zip, None to fall through to disk.
fn try_serve_from_zip<R: Runtime>(
    app: &tauri::AppHandle<R>,
    index_name: &str,
    file_path: &str,
) -> Option<tauri::http::Response<Vec<u8>>> {
    let (zip_name, entry_name) = if let Some(rest) = file_path.strip_prefix("tiles/") {
        ("tiles.zip", rest)
    } else if let Some(rest) = file_path.strip_prefix("pages/") {
        ("pages.zip", rest)
    } else {
        return None;
    };

    let app_data = app.path().app_data_dir().ok()?;
    let zip_candidates = [
        app_data.join("files").join(index_name).join(zip_name),
        app_data.join("layers").join(index_name).join(zip_name),
        app_data.join(index_name).join(zip_name),
    ];
    let zip_path = zip_candidates.iter().find(|p| p.exists())?;
    let zip_key = zip_path.to_string_lossy().to_string();

    let state = app.state::<LayerZipState>();
    let mut cache = state.0.lock().ok()?;

    if !cache.contains_key(&zip_key) {
        let file = File::open(zip_path).ok()?;
        cache.insert(zip_key.clone(), ZipArchive::new(file).ok()?);
    }

    let archive = cache.get_mut(&zip_key)?;
    let buf = read_entry(archive, entry_name)?;
    Some(response(200, content_type_for(file_path), buf))
}

/// URI scheme protocol handler for serving ros-madair index files with Range support.
///
/// URL format: `http://rmindex.localhost/{index-name}/{file-path...}`
///
/// Resolves to `{app_data_dir}/files/{index-name}/{file-path}`.
/// For paths under `tiles/` or `pages/`, tries the corresponding .zip first.
pub fn handle_request<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    // Handle CORS preflight (triggered by Range header)
    if request.method() == "OPTIONS" {
        return response(204, "text/plain", vec![]);
    }

    let app = ctx.app_handle();
    let raw_path = request.uri().path().trim_start_matches('/');
    let decoded_path = percent_decode_str(raw_path).decode_utf8_lossy();
    let path = decoded_path.as_ref();

    // Parse: {index-name}/{file-path...}
    let mut parts = path.splitn(2, '/');
    let (index_name, file_path) = match (parts.next(), parts.next()) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => (a, b),
        _ => return response(400, "text/plain", b"expected /{index}/{path}".to_vec()),
    };

    // Try serving from zip (tiles.zip, pages.zip) first
    if let Some(zip_response) = try_serve_from_zip(app, index_name, file_path) {
        return zip_response;
    }

    let app_data = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => return response(500, "text/plain", format!("app data dir: {e}").into_bytes()),
    };

    // Resolution order:
    // 1. {app_data}/files/{index-name}/{file-path} (Android base index)
    // 2. {app_data}/layers/{index-name}/{file-path} (layers)
    // 3. {app_data}/{index-name}/{file-path} (desktop base index)
    let candidates = [
        app_data.join("files").join(index_name).join(file_path),
        app_data.join("layers").join(index_name).join(file_path),
        app_data.join(index_name).join(file_path),
    ];

    let mut file = match candidates.iter().find_map(|p| File::open(p).ok()) {
        Some(f) => f,
        None => {
            eprintln!("[rmindex] not found in any path: {index_name}/{file_path}");
            return response(404, "text/plain", format!("not found: {file_path}").into_bytes());
        }
    };

    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let ct = content_type_for(file_path);

    // Check for Range: first from `_range` query param (avoids CORS preflight on
    // Android WebView), then from the standard Range header.
    let range_from_query = request.uri().query().and_then(|q| {
        q.split('&').find_map(|param| {
            let raw = param.strip_prefix("_range=")?;
            // Minimal percent-decode: '=' is encoded as %3D by URLSearchParams
            Some(raw.replace("%3D", "=").replace("%3d", "="))
        })
    });
    let range_header = range_from_query
        .as_deref()
        .or_else(|| request.headers().get("range").and_then(|v| v.to_str().ok()));

    if let Some(range_str) = range_header {
        if let Some((start, end)) = parse_range(range_str, file_len) {
            let len = end - start + 1;

            if let Err(e) = file.seek(SeekFrom::Start(start)) {
                return response(500, "text/plain", format!("seek: {e}").into_bytes());
            }

            let mut buf = vec![0u8; len as usize];
            if let Err(e) = file.read_exact(&mut buf) {
                return response(500, "text/plain", format!("read: {e}").into_bytes());
            }

            return tauri::http::Response::builder()
                .status(206)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                .header("Access-Control-Allow-Headers", "Range")
                .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
                .header("Accept-Ranges", "bytes")
                .header("Content-Type", ct)
                .header("Content-Range", format!("bytes {start}-{end}/{file_len}"))
                .header("Content-Length", len.to_string())
                .body(buf)
                .unwrap();
        }
    }

    // Full file read (no Range header or unparseable range)
    let mut buf = Vec::with_capacity(file_len as usize);
    if let Err(e) = file.read_to_end(&mut buf) {
        return response(500, "text/plain", format!("read: {e}").into_bytes());
    }

    response(200, ct, buf)
}
