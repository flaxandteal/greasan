use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use ros_madair_core::{build_to_memory, SkosCollection, StaticGraph};
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager, Runtime};

use crate::BuilderState;

// Re-export the alizarin StaticResource via ros-madair-core
use ros_madair_core::StaticResource;

#[derive(Debug, Serialize, Deserialize)]
pub struct BuildLayerResult {
    pub layer_id: String,
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildLayerStatus {
    pub state: String,
    pub progress: f64,
    pub error: Option<String>,
    pub output_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LayerInfo {
    pub layer_id: String,
    pub output_path: String,
    pub has_pagefind: bool,
}

/// Manifest optionally included in prebuild archives.
#[derive(Debug, Deserialize)]
struct PrebuildManifest {
    #[serde(default = "default_base_uri")]
    base_uri: String,
}

fn default_base_uri() -> String {
    "https://flaxandteal.org/ontology/goidelic#".to_string()
}

fn update_status<R: Runtime>(app: &AppHandle<R>, layer_id: &str, state: &str, progress: f64) {
    if let Some(st) = app.try_state::<BuilderState>() {
        if let Ok(mut map) = st.lock() {
            map.insert(
                layer_id.to_string(),
                BuildLayerStatus {
                    state: state.to_string(),
                    progress,
                    error: None,
                    output_path: None,
                },
            );
        }
    }
}

fn update_status_complete<R: Runtime>(app: &AppHandle<R>, layer_id: &str, output_path: String) {
    if let Some(st) = app.try_state::<BuilderState>() {
        if let Ok(mut map) = st.lock() {
            map.insert(
                layer_id.to_string(),
                BuildLayerStatus {
                    state: "complete".to_string(),
                    progress: 1.0,
                    error: None,
                    output_path: Some(output_path),
                },
            );
        }
    }
}

fn update_status_failed<R: Runtime>(app: &AppHandle<R>, layer_id: &str, error: String) {
    if let Some(st) = app.try_state::<BuilderState>() {
        if let Ok(mut map) = st.lock() {
            map.insert(
                layer_id.to_string(),
                BuildLayerStatus {
                    state: "failed".to_string(),
                    progress: 0.0,
                    error: Some(error),
                    output_path: None,
                },
            );
        }
    }
}

fn layers_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    Ok(app_data.join("layers"))
}

/// Parse a prebuild tar.gz archive into graphs, resources, and collections.
///
/// Expected archive structure:
/// - `graphs/{id}.json` — StaticGraph JSON
/// - `business_data/{id}.json` — StaticResource JSON (single or array)
/// - `collections/{id}.json` — SkosCollection JSON
/// - `manifest.json` (optional) — { base_uri: "..." }
fn parse_prebuild_archive(
    bytes: &[u8],
) -> Result<
    (
        String,
        HashMap<String, StaticGraph>,
        Vec<StaticResource>,
        Vec<SkosCollection>,
        HashMap<String, Vec<u8>>,
    ),
    String,
> {
    let decoder = GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);

    let mut graphs: HashMap<String, StaticGraph> = HashMap::new();
    let mut resources: Vec<StaticResource> = Vec::new();
    let mut collections: Vec<SkosCollection> = Vec::new();
    let mut passthrough_files: HashMap<String, Vec<u8>> = HashMap::new();
    let mut base_uri = default_base_uri();

    for entry_result in archive.entries().map_err(|e| format!("tar read error: {e}"))? {
        let mut entry = entry_result.map_err(|e| format!("tar entry error: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar path error: {e}"))?
            .to_path_buf();

        let path_str = path.to_string_lossy();

        // Strip leading ./ or top-level directory prefix
        let normalised = path_str
            .trim_start_matches("./")
            .trim_start_matches(|c: char| c != '/' && c != '.')
            .trim_start_matches('/');
        // Also try the raw path for flat archives
        let candidates = [normalised, path_str.as_ref()];

        let mut content = String::new();

        for candidate in &candidates {
            if candidate.ends_with("manifest.json") || *candidate == "manifest.json" {
                entry
                    .read_to_string(&mut content)
                    .map_err(|e| format!("read manifest.json: {e}"))?;
                if let Ok(m) = serde_json::from_str::<PrebuildManifest>(&content) {
                    base_uri = m.base_uri;
                }
                break;
            }

            if (candidate.starts_with("graphs/") || candidate.contains("/graphs/"))
                && candidate.ends_with(".json")
            {
                entry
                    .read_to_string(&mut content)
                    .map_err(|e| format!("read graph json: {e}"))?;
                let graph: StaticGraph =
                    serde_json::from_str(&content).map_err(|e| format!("parse graph: {e}"))?;
                graphs.insert(graph.graphid.clone(), graph);
                break;
            }

            if (candidate.starts_with("business_data/") || candidate.contains("/business_data/"))
                && candidate.ends_with(".json")
            {
                entry
                    .read_to_string(&mut content)
                    .map_err(|e| format!("read resource json: {e}"))?;
                // Try as array first, then single
                if let Ok(arr) = serde_json::from_str::<Vec<StaticResource>>(&content) {
                    resources.extend(arr);
                } else {
                    let r: StaticResource = serde_json::from_str(&content)
                        .map_err(|e| format!("parse resource: {e}"))?;
                    resources.push(r);
                }
                break;
            }

            if (candidate.starts_with("collections/") || candidate.contains("/collections/"))
                && candidate.ends_with(".json")
            {
                entry
                    .read_to_string(&mut content)
                    .map_err(|e| format!("read collection json: {e}"))?;
                let c: SkosCollection =
                    serde_json::from_str(&content).map_err(|e| format!("parse collection: {e}"))?;
                collections.push(c);
                break;
            }

            // Pass through pagefind zip files (pagefind-ga.zip, pagefind-en.zip, etc.)
            if candidate.contains("pagefind-") && candidate.ends_with(".zip") {
                let mut file_content = Vec::new();
                entry
                    .read_to_end(&mut file_content)
                    .map_err(|e| format!("read pagefind zip: {e}"))?;
                // Extract just the filename
                let filename = candidate
                    .rsplit('/')
                    .next()
                    .unwrap_or(candidate)
                    .to_string();
                passthrough_files.insert(filename, file_content);
                break;
            }
        }
    }

    if graphs.is_empty() {
        return Err("prebuild archive contains no graph JSON files in graphs/".into());
    }
    if resources.is_empty() {
        return Err("prebuild archive contains no resource JSON files in business_data/".into());
    }

    Ok((base_uri, graphs, resources, collections, passthrough_files))
}

/// Initiate an index build from a remote source.
///
/// Returns immediately with a layer_id; poll `get_layer_status` for progress.
/// States: pending → fetching → parsing → building → writing → complete (or failed).
#[command]
pub async fn build_layer<R: Runtime>(
    app: AppHandle<R>,
    source_url: String,
    format: String,
    layer_name: String,
) -> Result<BuildLayerResult, String> {
    if format != "prebuild" && format != "built" {
        return Err(format!("unsupported format \"{format}\" — only \"prebuild\" and \"built\" are supported"));
    }

    let layer_id = uuid::Uuid::new_v4().to_string();
    let output_dir = layers_dir(&app)?.join(&layer_name);

    // Set initial status
    update_status(&app, &layer_id, "pending", 0.0);

    let id_clone = layer_id.clone();
    let output_dir_clone = output_dir.clone();
    let format_clone = format.clone();

    // Spawn async task — don't block the command handler
    tauri::async_runtime::spawn(async move {
        // 1. Fetch (file:// URLs read from disk; everything else uses reqwest)
        update_status(&app, &id_clone, "fetching", 0.1);
        let bytes: Vec<u8> = if source_url.starts_with("file://") {
            let path = source_url.strip_prefix("file://").unwrap_or(&source_url);
            match tokio::fs::read(path).await {
                Ok(b) => b,
                Err(e) => {
                    update_status_failed(&app, &id_clone, format!("read file failed: {e}"));
                    return;
                }
            }
        } else {
            match reqwest::get(&source_url).await {
                Ok(resp) => match resp.bytes().await {
                    Ok(b) => b.to_vec(),
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("fetch body failed: {e}"));
                        return;
                    }
                },
                Err(e) => {
                    update_status_failed(&app, &id_clone, format!("fetch failed: {e}"));
                    return;
                }
            }
        };

        if format_clone == "built" {
            // "built" format: extract pre-built artifacts directly (no build_to_memory)
            update_status(&app, &id_clone, "extracting", 0.4);
            if let Err(e) = extract_built_archive_sync(&bytes, &output_dir_clone) {
                update_status_failed(&app, &id_clone, format!("extract failed: {e}"));
                return;
            }

            // Validate: summary.bin must exist
            if !output_dir_clone.join("summary.bin").exists() {
                update_status_failed(
                    &app,
                    &id_clone,
                    "invalid package: summary.bin not found after extraction".into(),
                );
                return;
            }

            let output_path = output_dir_clone.to_string_lossy().to_string();
            update_status_complete(&app, &id_clone, output_path);
        } else {
            // "prebuild" format: parse, build, write
            // 2. Parse
            update_status(&app, &id_clone, "parsing", 0.3);
            let (base_uri, graphs, resources, collections, passthrough_files) =
                match parse_prebuild_archive(&bytes) {
                    Ok(v) => v,
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("parse failed: {e}"));
                        return;
                    }
                };

            // 3. Build
            update_status(&app, &id_clone, "building", 0.5);
            let artifacts =
                match build_to_memory(&base_uri, &graphs, &resources, &collections, None) {
                    Ok(a) => a,
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("build failed: {e}"));
                        return;
                    }
                };

            // 4. Write
            update_status(&app, &id_clone, "writing", 0.9);
            if let Err(e) = write_artifacts(&output_dir_clone, &artifacts).await {
                update_status_failed(&app, &id_clone, format!("write failed: {e}"));
                return;
            }

            // Also write graph JSON files (not included in build_to_memory output)
            for (graph_id, graph) in &graphs {
                let graph_path =
                    output_dir_clone.join("graphs").join(format!("{graph_id}.json"));
                if let Some(parent) = graph_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                if let Ok(json) = serde_json::to_vec(graph) {
                    let _ = tokio::fs::write(&graph_path, json).await;
                }
            }

            // Write passthrough files (pagefind zips, etc.)
            for (filename, content) in &passthrough_files {
                let dest = output_dir_clone.join(filename);
                let _ = tokio::fs::write(&dest, content).await;
            }

            // 5. Complete
            let output_path = output_dir_clone.to_string_lossy().to_string();
            update_status_complete(&app, &id_clone, output_path);
        }
    });

    Ok(BuildLayerResult {
        layer_id,
        output_path: "pending".to_string(),
    })
}

async fn write_artifacts(
    output_dir: &Path,
    artifacts: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    for (name, bytes) in artifacts {
        let path = output_dir.join(name);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Poll the build progress of a layer.
#[command]
pub async fn get_layer_status<R: Runtime>(
    app: AppHandle<R>,
    layer_id: String,
) -> Result<BuildLayerStatus, String> {
    let st = app.state::<BuilderState>();
    let map = st.lock().map_err(|e| format!("lock error: {e}"))?;
    map.get(&layer_id)
        .cloned()
        .ok_or_else(|| format!("unknown layer_id: {layer_id}"))
}

/// Check whether a named index directory exists on-device with a summary.bin.
/// Returns the directory path if found, None otherwise.
#[command]
pub async fn check_local_index<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<Option<String>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    // On Android, app_data_dir() returns the app root (/data/user/0/{pkg})
    // but `run-as` and standard Android APIs put files under files/ subdir.
    // Check both locations.
    for base in [app_data.join("files"), app_data.clone()] {
        let dir = base.join(&name);
        eprintln!("[check_local_index] checking: {}", dir.join("summary.bin").display());
        if dir.join("summary.bin").exists() {
            return Ok(Some(dir.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

/// Extract a pre-built tar.gz package directly to the output directory.
///
/// This handles the "built" format — artifacts are already compiled and just
/// need to be written to disk. Runs synchronously (tar iteration is not Send).
fn extract_built_archive_sync(bytes: &[u8], output_dir: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);

    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("mkdir {}: {e}", output_dir.display()))?;

    for entry_result in archive.entries().map_err(|e| format!("tar read error: {e}"))? {
        let mut entry = entry_result.map_err(|e| format!("tar entry error: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar path error: {e}"))?
            .to_path_buf();

        // Skip directories
        if entry.header().entry_type().is_dir() {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();

        // Strip leading ./
        let normalised = path_str.trim_start_matches("./");
        // Keep the path as-is — the tar contains flat files and pagefind subdirectories.
        let rel_path = normalised.to_string();

        if rel_path.is_empty() {
            continue;
        }

        let dest = output_dir.join(&rel_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }

        let mut content = Vec::new();
        entry
            .read_to_end(&mut content)
            .map_err(|e| format!("read {rel_path}: {e}"))?;

        std::fs::write(&dest, &content)
            .map_err(|e| format!("write {}: {e}", dest.display()))?;
    }

    // On desktop, extract zip archives so the asset protocol can serve individual
    // files (needed because custom URI scheme protocols like rmindex:// don't work
    // when the webview loads from localhost in dev mode). On mobile, tiles/pages/
    // pagefind are served from zip via rmindex/pfzip — no extraction needed.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    extract_zips_for_desktop(output_dir)?;

    Ok(())
}

/// On desktop, extract tiles.zip, pages.zip, and pagefind-*.zip into directories
/// so the asset protocol can serve individual files.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn extract_zips_for_desktop(output_dir: &Path) -> Result<(), String> {
    if let Ok(entries) = std::fs::read_dir(output_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.ends_with(".zip") {
                let dir_name = name_str.trim_end_matches(".zip");
                let target_dir = output_dir.join(dir_name);
                if target_dir.exists() {
                    continue; // already extracted
                }
                let file = std::fs::File::open(entry.path())
                    .map_err(|e| format!("open {name_str}: {e}"))?;
                let mut archive = zip::ZipArchive::new(file)
                    .map_err(|e| format!("read {name_str}: {e}"))?;
                archive.extract(&target_dir)
                    .map_err(|e| format!("extract {name_str}: {e}"))?;
                eprintln!("[builder] extracted {name_str} → {dir_name}/");
            }
        }
    }
    Ok(())
}

/// Check if a layer has pagefind zip files.
fn layer_has_pagefind_check(layer_path: &Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(layer_path) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("pagefind-") && name_str.ends_with(".zip") {
                return true;
            }
        }
    }
    false
}

/// List all locally-built layers.
#[command]
pub async fn list_layers<R: Runtime>(app: AppHandle<R>) -> Result<Vec<LayerInfo>, String> {
    let dir = layers_dir(&app)?;
    let mut layers = Vec::new();

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(layers), // directory doesn't exist yet
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("summary.bin").exists() {
            let layer_id = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            layers.push(LayerInfo {
                layer_id,
                output_path: path.to_string_lossy().to_string(),
                has_pagefind: layer_has_pagefind_check(&path),
            });
        }
    }

    Ok(layers)
}

/// Remove a layer's files from disk.
#[command]
pub async fn remove_layer_files<R: Runtime>(
    app: AppHandle<R>,
    layer_name: String,
) -> Result<(), String> {
    let dir = layers_dir(&app)?.join(&layer_name);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Check if a specific layer has pagefind indices.
#[command]
pub async fn layer_has_pagefind<R: Runtime>(
    app: AppHandle<R>,
    layer_name: String,
) -> Result<bool, String> {
    let dir = layers_dir(&app)?.join(&layer_name);
    Ok(layer_has_pagefind_check(&dir))
}
