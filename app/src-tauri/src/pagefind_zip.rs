use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::{Manager, Runtime, UriSchemeContext};
use zip::ZipArchive;

/// Cached open zip archives keyed by file path.
pub type PfZipState = Mutex<HashMap<String, ZipArchive<File>>>;

fn content_type_for(path: &str) -> &'static str {
    if path.ends_with(".js") {
        "application/javascript"
    } else if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".css") {
        "text/css"
    } else {
        // .pf_meta, .pf_index, .pf_filter, .pf_fragment, .pagefind
        "application/octet-stream"
    }
}

/// Read an entry from the zip archive, trying both `name` and `./name`.
pub(crate) fn read_entry(archive: &mut ZipArchive<File>, name: &str) -> Option<Vec<u8>> {
    let alt = format!("./{name}");
    let names = [name, alt.as_str()];
    for candidate in &names {
        if let Ok(mut entry) = archive.by_name(candidate) {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            if entry.read_to_end(&mut buf).is_ok() {
                return Some(buf);
            }
        }
    }
    None
}

/// Build a response with CORS headers (required for cross-origin fetch from tauri.localhost).
fn response(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
        .header("Access-Control-Allow-Headers", "*")
        .header("Content-Type", content_type)
        .body(body)
        .unwrap()
}

/// URI scheme protocol handler for serving pagefind files from zip archives.
///
/// URL format: `http://pfzip.localhost/{index-name}/{lang-dir}/{file-path...}`
///
/// Resolves to `{app_data_dir}/files/{index-name}/{lang-dir}.zip` entry `{file-path}`.
pub fn handle_request<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    // Handle CORS preflight
    if request.method() == "OPTIONS" {
        return response(204, "text/plain", vec![]);
    }

    let app = ctx.app_handle();
    let raw_path = request.uri().path().trim_start_matches('/');
    // Percent-decode the path so layer names with spaces/special chars resolve correctly
    let decoded_path = percent_decode_str(raw_path).decode_utf8_lossy();
    let path = decoded_path.as_ref();

    // Parse: {index-name}/{lang-dir}/{file-path...}
    let mut parts = path.splitn(3, '/');
    let (index_name, lang_dir, file_path) =
        match (parts.next(), parts.next(), parts.next()) {
            (Some(a), Some(b), Some(c)) if !a.is_empty() && !b.is_empty() && !c.is_empty() => {
                (a, b, c)
            }
            _ => {
                return response(400, "text/plain", b"expected /{index}/{lang-dir}/{path}".to_vec());
            }
        };

    let app_data = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            return response(500, "text/plain", format!("app data dir: {e}").into_bytes());
        }
    };

    // Resolution order:
    // 1. {app_data}/files/{index-name}/{lang-dir}.zip (Android base index)
    // 2. {app_data}/layers/{index-name}/{lang-dir}.zip (layers)
    let candidates = [
        app_data.join("files").join(index_name).join(format!("{lang_dir}.zip")),
        app_data.join("layers").join(index_name).join(format!("{lang_dir}.zip")),
    ];

    let zip_path = match candidates.iter().find(|p| p.exists()) {
        Some(p) => p.clone(),
        None => {
            eprintln!("[pfzip] zip not found for {index_name}/{lang_dir}.zip - tried: {:?}", candidates);
            return response(404, "text/plain", format!("zip not found: {index_name}/{lang_dir}.zip").into_bytes());
        }
    };
    let zip_key = zip_path.to_string_lossy().to_string();

    let state = app.state::<PfZipState>();
    let mut cache = match state.lock() {
        Ok(c) => c,
        Err(_) => {
            return response(500, "text/plain", b"lock poisoned".to_vec());
        }
    };

    // Lazily open zip archive
    if !cache.contains_key(&zip_key) {
        let file = match File::open(&zip_path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[pfzip] zip open failed: {} ({e})", zip_path.display());
                return response(404, "text/plain", format!("zip not found: {}", zip_path.display()).into_bytes());
            }
        };
        match ZipArchive::new(file) {
            Ok(archive) => {
                cache.insert(zip_key.clone(), archive);
            }
            Err(e) => {
                return response(500, "text/plain", format!("zip open: {e}").into_bytes());
            }
        }
    }

    let archive = cache.get_mut(&zip_key).unwrap();

    match read_entry(archive, file_path) {
        Some(buf) => response(200, content_type_for(file_path), buf),
        None => response(404, "text/plain", format!("not in zip: {file_path}").into_bytes()),
    }
}
