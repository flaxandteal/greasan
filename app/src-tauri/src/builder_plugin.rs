use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

use alizarin_core::{build_resources_from_business_csv, BusinessDataCsvOptions};
use flate2::read::GzDecoder;
use pagefind::api::PagefindIndex;
use pagefind::options::PagefindServiceConfig;
use ros_madair_core::{build_to_memory, SkosCollection, StaticGraph, StaticResource};
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager, Runtime};

use crate::tbx_parser;
use crate::BuilderState;

/// Copy a content:// URI to a local file via JNI ContentResolver.
/// Uses openFileDescriptor to get a raw Unix fd, then copies entirely in Rust.
/// Only ~5 JNI calls total — no JNI in the I/O loop.
#[cfg(target_os = "android")]
fn copy_content_uri_to_file(uri_str: &str, dest: &std::path::Path) -> Result<usize, String> {
    use jni::objects::{JObject, JValueGen};
    use std::os::unix::io::FromRawFd;

    eprintln!("[builder] copy_content_uri_to_file: {uri_str} -> {}", dest.display());

    let ctx = crate::android_ctx::context()?;
    eprintln!("[builder] got ndk_context");
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JVM: {e}"))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("JNI attach: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    eprintln!("[builder] JNI attached");

    // Parse the content:// URI
    let j_uri_str = env.new_string(uri_str).map_err(|e| format!("new_string: {e}"))?;
    let uri = env.call_static_method(
        "android/net/Uri", "parse",
        "(Ljava/lang/String;)Landroid/net/Uri;",
        &[JValueGen::Object(&j_uri_str.into())],
    ).map_err(|e| format!("Uri.parse: {e}"))?
    .l().map_err(|e| format!("Uri.parse.l: {e}"))?;

    eprintln!("[builder] JNI: parsed URI");

    // Get ContentResolver
    let resolver = env.call_method(
        &activity, "getContentResolver",
        "()Landroid/content/ContentResolver;", &[],
    ).map_err(|e| format!("getContentResolver: {e}"))?
    .l().map_err(|e| format!("getContentResolver.l: {e}"))?;

    eprintln!("[builder] JNI: got ContentResolver");

    // Open a ParcelFileDescriptor in read mode
    let mode = env.new_string("r").map_err(|e| format!("new_string mode: {e}"))?;
    let pfd = env.call_method(
        &resolver, "openFileDescriptor",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
        &[JValueGen::Object(&uri), JValueGen::Object(&mode.into())],
    ).map_err(|e| format!("openFileDescriptor: {e}"))?
    .l().map_err(|e| format!("openFileDescriptor.l: {e}"))?;

    if pfd.is_null() {
        return Err("openFileDescriptor returned null".into());
    }

    eprintln!("[builder] JNI: got ParcelFileDescriptor");

    // Detach the raw Unix fd — we own it now, Java won't close it
    let fd = env.call_method(&pfd, "detachFd", "()I", &[])
        .map_err(|e| format!("detachFd: {e}"))?
        .i().map_err(|e| format!("detachFd.i: {e}"))?;

    eprintln!("[builder] JNI: detached fd={fd}, switching to pure Rust I/O");

    // From here on: pure Rust, no JNI calls
    let mut src = unsafe { std::fs::File::from_raw_fd(fd) };

    if let Err(e) = std::fs::create_dir_all(dest.parent().unwrap_or(dest)) {
        return Err(format!("create_dir_all: {e}"));
    }
    let mut dst = std::fs::File::create(dest).map_err(|e| format!("create dest: {e}"))?;

    let total = std::io::copy(&mut src, &mut dst)
        .map_err(|e| format!("io::copy: {e}"))? as usize;

    eprintln!("[builder] copied {total} bytes to {}", dest.display());
    Ok(total)
}

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

/// Extract a tar.gz VERBATIM into `dest`, preserving the archive's directory
/// structure (only stripping a leading `./`). Used to lay an emit-layout prebuild
/// (`graphs/resource_models/`, `business_data/`, `reference_data/`, `manifest.json`)
/// back onto disk so the emitter can stream it. Unlike `extract_built_archive_sync`
/// it has no desktop zip-unpacking side effect.
#[cfg(feature = "v2-emit")]
fn extract_tar_gz_verbatim(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
    for entry_result in archive.entries().map_err(|e| format!("tar read error: {e}"))? {
        let mut entry = entry_result.map_err(|e| format!("tar entry error: {e}"))?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| format!("tar path error: {e}"))?
            .to_path_buf();
        let rel = path.to_string_lossy();
        let rel = rel.trim_start_matches("./");
        if rel.is_empty() {
            continue;
        }
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("read {rel}: {e}"))?;
        std::fs::write(&out, &buf).map_err(|e| format!("write {}: {e}", out.display()))?;
    }
    Ok(())
}

/// The graph id whose `business_data/<id>.json` is largest — the corpus graph
/// shipped as the head's `graph.json`.
#[cfg(feature = "v2-emit")]
fn primary_graph_id(src: &Path) -> Result<String, String> {
    let bd = src.join("business_data");
    let mut best: Option<(u64, String)> = None;
    for e in std::fs::read_dir(&bd)
        .map_err(|e| format!("read business_data: {e}"))?
        .flatten()
    {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) == Some("json") {
            let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
            let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
            if best.as_ref().map_or(true, |(b, _)| sz > *b) {
                best = Some((sz, stem));
            }
        }
    }
    best.map(|(_, id)| id)
        .ok_or_else(|| "prebuild has no business_data/*.json".to_string())
}

/// Copy any `pagefind-*.zip` indices bundled beside the prebuild into the head
/// dir. (Absent for a bare prebuild; present if the packager bundled search.)
#[cfg(feature = "v2-emit")]
fn copy_pagefind_indices(src: &Path, dest: &Path) {
    if let Ok(entries) = std::fs::read_dir(src) {
        for e in entries.flatten() {
            let name = e.file_name();
            let ns = name.to_string_lossy();
            if ns.starts_with("pagefind-") && ns.ends_with(".zip") {
                let _ = std::fs::copy(e.path(), dest.join(&*ns));
            }
        }
    }
}

/// Write in-memory graph + resources + collections to a temp prebuild dir and run
/// the streaming emitter → a v2 head in `out_dir` (head.sqlite + chunks +
/// graph.json). The v2 counterpart of `build_to_memory` + `write_artifacts`, for
/// the tbx-v2 on-device Téarma build. Base_uri is the canonical
/// `https://example.org/` every v2 head composes under (see the prebuild-v2 note).
#[cfg(feature = "v2-emit")]
fn write_prebuild_and_emit_v2(
    out_dir: &Path,
    graph: &StaticGraph,
    resources: &[StaticResource],
    collections: &[SkosCollection],
) -> Result<(), String> {
    let src = out_dir.join(".prebuild-src");
    let _ = std::fs::remove_dir_all(&src);
    let gid = graph.graphid.clone();
    let models = src.join("graphs/resource_models");
    let bd = src.join("business_data");
    let cols_dir = src.join("reference_data/collections");
    for d in [&models, &bd, &cols_dir] {
        std::fs::create_dir_all(d).map_err(|e| format!("mkdir {}: {e}", d.display()))?;
    }
    std::fs::write(
        models.join(format!("{gid}.json")),
        serde_json::to_vec(graph).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let wrapper = serde_json::json!({ "business_data": { "resources": resources } });
    std::fs::write(
        bd.join(format!("{gid}.json")),
        serde_json::to_vec(&wrapper).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    for col in collections {
        std::fs::write(
            cols_dir.join(format!("{}.json", col.id)),
            serde_json::to_vec(col).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    std::fs::write(
        src.join("manifest.json"),
        r#"{"base_uri":"https://example.org/"}"#,
    )
    .map_err(|e| e.to_string())?;

    ros_madair_emit::emit(
        src.to_str().ok_or("non-utf8 prebuild path")?,
        out_dir.to_str().ok_or("non-utf8 out path")?,
        "https://example.org/",
    )
    .map_err(|e| format!("emit: {e}"))?;

    std::fs::copy(models.join(format!("{gid}.json")), out_dir.join("graph.json"))
        .map_err(|e| format!("copy graph.json: {e}"))?;
    let _ = std::fs::remove_dir_all(&src);
    Ok(())
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
    if !matches!(
        format.as_str(),
        "prebuild" | "prebuild-v2" | "built" | "tbx" | "tbx-v2"
    ) {
        return Err(format!(
            "unsupported format \"{format}\" — only \"prebuild\", \"prebuild-v2\", \"built\", \"tbx\", and \"tbx-v2\" are supported"
        ));
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
        // 1. Fetch (content:// via JNI, file:// from disk, otherwise reqwest)
        update_status(&app, &id_clone, "fetching", 0.1);
        // For Android content:// URIs, stream to a temp file via JNI first
        #[allow(unused_mut)]
        let mut local_file_path: Option<PathBuf> = None;
        #[cfg(target_os = "android")]
        if source_url.starts_with("content://") {
            let temp_path = output_dir_clone.join("_import.tbx");
            match copy_content_uri_to_file(&source_url, &temp_path) {
                Ok(n) => {
                    eprintln!("[builder] copied content URI to disk: {n} bytes");
                    local_file_path = Some(temp_path);
                }
                Err(e) => {
                    update_status_failed(&app, &id_clone, format!("content URI read failed: {e}"));
                    return;
                }
            }
        }
        let bytes: Vec<u8> = if let Some(ref path) = local_file_path {
            match tokio::fs::read(path).await {
                Ok(b) => b,
                Err(e) => {
                    update_status_failed(&app, &id_clone, format!("read temp file failed: {e}"));
                    return;
                }
            }
        } else if source_url.starts_with("file://") {
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

        // Clean up temp file from content URI copy
        if let Some(ref path) = local_file_path {
            let _ = std::fs::remove_file(path);
        }

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
        } else if format_clone == "tbx" {
            // "tbx" format: parse TBX XML → CSV → build resources → build index
            // Used for Téarma data that must be built on-device.

            // 2. Parse TBX XML into term records
            update_status(&app, &id_clone, "parsing", 0.2);
            let mut records = match tbx_parser::parse_tbx(&bytes) {
                Ok(r) => r,
                Err(e) => {
                    update_status_failed(&app, &id_clone, format!("TBX parse failed: {e}"));
                    return;
                }
            };

            eprintln!("[builder] parsed {} TBX records", records.len());

            // 2b. Declension enrichment (gramadan): fill classless noun/verb
            // classes + stamp confidence, matching the Python pipeline.
            tbx_parser::enrich_records(&mut records);

            // 3. Generate business-data CSV
            let csv_data = match tbx_parser::records_to_csv(&records, "TE") {
                Ok(c) => c,
                Err(e) => {
                    update_status_failed(&app, &id_clone, format!("CSV generation failed: {e}"));
                    return;
                }
            };

            // 4. Load graph model and collections from the core bundle
            update_status(&app, &id_clone, "building", 0.4);

            let graph = match load_core_graph(&app, LEXICAL_ENTRY_GRAPH_ID) {
                Ok(g) => g,
                Err(e) => {
                    update_status_failed(&app, &id_clone, format!("load graph failed: {e}"));
                    return;
                }
            };

            let collections = match load_core_collections(&app) {
                Ok(c) => c,
                Err(e) => {
                    update_status_failed(&app, &id_clone, format!("load collections failed: {e}"));
                    return;
                }
            };

            // 5. Build StaticResources from CSV
            let resources = match build_resources_from_business_csv(
                &csv_data,
                &graph,
                &collections,
                BusinessDataCsvOptions {
                    strict_concepts: false,
                    uuid_namespace: Some(TEARMA_UUID_NS.to_string()),
                    ..Default::default()
                },
            ) {
                Ok(r) => r,
                Err(e) => {
                    update_status_failed(
                        &app,
                        &id_clone,
                        format!("build resources failed: {e}"),
                    );
                    return;
                }
            };

            eprintln!("[builder] built {} resources from CSV", resources.len());

            // 6. Build binary index artifacts
            update_status(&app, &id_clone, "building", 0.6);
            let base_uri = default_base_uri();
            let mut graphs = HashMap::new();
            graphs.insert(graph.graphid.clone(), graph.clone());

            let artifacts =
                match build_to_memory(&base_uri, &graphs, &resources, &collections, None) {
                    Ok(a) => a,
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("build failed: {e}"));
                        return;
                    }
                };

            // 7. Write artifacts to disk
            update_status(&app, &id_clone, "writing", 0.8);
            if let Err(e) = write_artifacts(&output_dir_clone, &artifacts).await {
                update_status_failed(&app, &id_clone, format!("write failed: {e}"));
                return;
            }

            // Write graph JSON
            for (graph_id, g) in &graphs {
                let graph_path =
                    output_dir_clone.join("graphs").join(format!("{graph_id}.json"));
                if let Some(parent) = graph_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                if let Ok(json) = serde_json::to_vec(g) {
                    let _ = tokio::fs::write(&graph_path, json).await;
                }
            }

            // 8. Build pagefind search indices
            update_status(&app, &id_clone, "indexing", 0.85);

            // Set descriptor templates so we can extract headword + gloss
            let mut desc_graph = graph.clone();
            if let Err(e) = desc_graph.set_descriptor_template("name", "<Headword>") {
                eprintln!("[builder] warning: set name template failed: {e}");
            }
            if let Err(e) = desc_graph.set_descriptor_template("description", "<Gloss>") {
                eprintln!("[builder] warning: set description template failed: {e}");
            }
            // `IndexedGraph` was removed from alizarin-core (sandbox
            // 2.0.0-alpha.122+): `StaticGraph` now indexes itself lazily and
            // owns `build_descriptors`, so we pass the graph directly.
            let indexed_graph = desc_graph;

            // Pagefind futures are !Send (lol_html uses Rc), so run in a
            // blocking task with a dedicated single-threaded runtime.
            let pf_output = output_dir_clone.clone();
            let pf_result = tokio::task::spawn_blocking(move || {
                build_pagefind_indices_sync(&indexed_graph, &resources, &pf_output)
            })
            .await;

            match pf_result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => eprintln!("[builder] pagefind failed (non-fatal): {e}"),
                Err(e) => eprintln!("[builder] pagefind task panicked: {e}"),
            }

            // 9. Complete
            let output_path = output_dir_clone.to_string_lossy().to_string();
            update_status_complete(&app, &id_clone, output_path);
        } else if format_clone == "tbx-v2" {
            // "tbx-v2": Téarma from TBX → a v2 HEAD (installable/loadable as a v2
            // layer), with gramadan declension enrichment — the on-device
            // counterpart of the Python pipeline. Same parse+enrich+build as
            // "tbx", but emits a v2 head instead of v1 flat artifacts.
            #[cfg(not(feature = "v2-emit"))]
            {
                update_status_failed(&app, &id_clone, "tbx-v2 requires a v2-emit build".into());
                return;
            }
            #[cfg(feature = "v2-emit")]
            {
                update_status(&app, &id_clone, "parsing", 0.2);
                let mut records = match tbx_parser::parse_tbx(&bytes) {
                    Ok(r) => r,
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("TBX parse failed: {e}"));
                        return;
                    }
                };
                tbx_parser::enrich_records(&mut records);
                let csv_data = match tbx_parser::records_to_csv(&records, "TE") {
                    Ok(c) => c,
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("CSV generation failed: {e}"));
                        return;
                    }
                };
                // Graph + collections from the core bundle (asset resolver — keep
                // on the async worker, not spawn_blocking).
                update_status(&app, &id_clone, "building", 0.4);
                let graph = match load_core_graph(&app, LEXICAL_ENTRY_GRAPH_ID) {
                    Ok(g) => g,
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("load graph failed: {e}"));
                        return;
                    }
                };
                let collections = match load_core_collections(&app) {
                    Ok(c) => c,
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("load collections failed: {e}"));
                        return;
                    }
                };
                // Build resources + emit are CPU-heavy at Téarma scale — off the
                // async worker.
                let out = output_dir_clone.clone();
                let emit_res = tokio::task::spawn_blocking(move || -> Result<usize, String> {
                    let resources = build_resources_from_business_csv(
                        &csv_data,
                        &graph,
                        &collections,
                        BusinessDataCsvOptions {
                            strict_concepts: false,
                            uuid_namespace: Some(TEARMA_UUID_NS.to_string()),
                            ..Default::default()
                        },
                    )
                    .map_err(|e| format!("build resources failed: {e}"))?;
                    let n = resources.len();
                    write_prebuild_and_emit_v2(&out, &graph, &resources, &collections)?;
                    // Build pagefind indices INTO the head dir so the emitted v2
                    // layer is searchable (headword + gloss). Same builder as the
                    // v1 "tbx" branch; the zips land beside head.sqlite where the
                    // v2 loader/`layer_has_pagefind_check` expect them. Non-fatal:
                    // a head with no index still loads, it just won't surface in
                    // search. Pagefind's futures are !Send, but this closure is
                    // already on a spawn_blocking thread with no active runtime,
                    // so build_pagefind_indices_sync's own current-thread runtime
                    // is safe here.
                    let mut desc_graph = graph.clone();
                    let _ = desc_graph.set_descriptor_template("name", "<Headword>");
                    let _ = desc_graph.set_descriptor_template("description", "<Gloss>");
                    if let Err(e) = build_pagefind_indices_sync(&desc_graph, &resources, &out) {
                        eprintln!("[builder] tbx-v2 pagefind failed (non-fatal): {e}");
                    }
                    Ok(n)
                })
                .await;
                match emit_res {
                    Ok(Ok(n)) => eprintln!("[builder] tbx-v2 emitted {n} resources"),
                    Ok(Err(e)) => {
                        update_status_failed(&app, &id_clone, e);
                        return;
                    }
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("tbx-v2 task panicked: {e}"));
                        return;
                    }
                }
                let output_path = output_dir_clone.to_string_lossy().to_string();
                update_status_complete(&app, &id_clone, output_path);
            }
        } else if format_clone == "prebuild-v2" {
            // "prebuild-v2": extract the emit-layout prebuild verbatim, then run
            // the streaming emitter to produce a v2 head (head.sqlite + chunks),
            // which the app loads natively via currentV2HeadDirs — NOT the v1
            // flat artifacts build_to_memory writes. Emit is memory-bounded (see
            // HANDOFF-streaming-build.md); requires the v2-emit build.
            #[cfg(not(feature = "v2-emit"))]
            {
                update_status_failed(
                    &app,
                    &id_clone,
                    "prebuild-v2 requires a v2-emit build".into(),
                );
                return;
            }
            #[cfg(feature = "v2-emit")]
            {
                update_status(&app, &id_clone, "extracting", 0.25);
                let src = output_dir_clone.join(".prebuild-src");
                let _ = std::fs::remove_dir_all(&src);
                if let Err(e) = extract_tar_gz_verbatim(&bytes, &src) {
                    update_status_failed(&app, &id_clone, format!("extract failed: {e}"));
                    return;
                }

                // EVERY v2 head composes under this base_uri (regen-layer-v2 and
                // v2_emit_overlay both hardcode it); `Layers::open` REFUSES to
                // compose heads that disagree on it, which silently breaks
                // cross-layer hydrate. The prebuild manifest's base_uri is the
                // ontology namespace (goidelic#), NOT the compose base_uri — do
                // not read it here.
                let base_uri = "https://example.org/".to_string();

                // The graph shipped as the head's graph.json = the one carrying
                // the most business data (its resources are the corpus).
                let graph_id = match primary_graph_id(&src) {
                    Ok(g) => g,
                    Err(e) => {
                        update_status_failed(&app, &id_clone, e);
                        return;
                    }
                };

                update_status(&app, &id_clone, "building", 0.4);
                let src_s = src.to_string_lossy().to_string();
                let out_s = output_dir_clone.to_string_lossy().to_string();
                // Emit is CPU-heavy + blocking (~seconds for a small layer, tens
                // of minutes for tearma); keep it off the async worker thread.
                let emit_res = tokio::task::spawn_blocking(move || {
                    // Stringify the error inside the closure: emit's
                    // Box<dyn Error> is not Send and can't cross spawn_blocking.
                    ros_madair_emit::emit(&src_s, &out_s, &base_uri).map_err(|e| e.to_string())
                })
                .await;
                match emit_res {
                    Ok(Ok(_summary)) => {}
                    Ok(Err(e)) => {
                        update_status_failed(&app, &id_clone, format!("emit failed: {e}"));
                        return;
                    }
                    Err(e) => {
                        update_status_failed(&app, &id_clone, format!("emit task panicked: {e}"));
                        return;
                    }
                }

                update_status(&app, &id_clone, "writing", 0.9);
                // emit does not write graph.json — the head needs it as its base
                // model (mirrors regen-layer-v2 copying it post-emit).
                let graph_src = src
                    .join("graphs/resource_models")
                    .join(format!("{graph_id}.json"));
                if let Err(e) =
                    std::fs::copy(&graph_src, output_dir_clone.join("graph.json"))
                {
                    update_status_failed(
                        &app,
                        &id_clone,
                        format!("copy graph.json ({}): {e}", graph_src.display()),
                    );
                    return;
                }
                // Carry through any pagefind indices bundled in the prebuild.
                copy_pagefind_indices(&src, &output_dir_clone);
                // Head is self-contained now; drop the extracted source.
                let _ = std::fs::remove_dir_all(&src);

                let output_path = output_dir_clone.to_string_lossy().to_string();
                update_status_complete(&app, &id_clone, output_path);
            }
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

/// List locally-built v2 layers (a `head.sqlite` present), so `restoreV2Layers`
/// can re-register them into the active head-dir set on startup. The v2 sibling
/// of `list_layers` (which keys on the v1 `summary.bin`).
#[command]
pub async fn list_v2_layers<R: Runtime>(app: AppHandle<R>) -> Result<Vec<LayerInfo>, String> {
    let dir = layers_dir(&app)?;
    let mut layers = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(layers),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("head.sqlite").exists() {
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

// ── Pagefind index building ──────────────────────────────────────────────────

/// Strip diacritics (fadas, graves) for accent-insensitive search.
fn strip_diacritics(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfd()
        .filter(|c| !matches!(c, '\u{0300}'..='\u{036f}'))
        .nfc()
        .collect()
}

/// Build pagefind-ga and pagefind-en search indices from resources.
///
/// Mirrors the pattern in build-tearma-layer.mjs: headword index (ga) and
/// gloss index (en), each with dialect filter codes.
///
/// Runs synchronously with an internal single-threaded tokio runtime because
/// pagefind's futures are !Send (lol_html uses Rc internally).
fn build_pagefind_indices_sync(
    indexed_graph: &StaticGraph,
    resources: &[StaticResource],
    output_dir: &Path,
) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("pagefind runtime: {e}"))?;

    rt.block_on(build_pagefind_indices_inner(indexed_graph, resources, output_dir))
}

async fn build_pagefind_indices_inner(
    indexed_graph: &StaticGraph,
    resources: &[StaticResource],
    output_dir: &Path,
) -> Result<(), String> {
    // Create two pagefind indices: Irish headwords and English glosses
    let ga_config = PagefindServiceConfig::builder()
        .force_language("ga".to_string())
        .build();
    let en_config = PagefindServiceConfig::builder()
        .force_language("en".to_string())
        .build();

    let mut ga_index =
        PagefindIndex::new(Some(ga_config)).map_err(|e| format!("pagefind ga init: {e}"))?;
    let mut en_index =
        PagefindIndex::new(Some(en_config)).map_err(|e| format!("pagefind en init: {e}"))?;

    let mut ga_count = 0u32;
    let mut en_count = 0u32;

    for resource in resources {
        let uuid = &resource.resourceinstance.resourceinstanceid;
        let tiles = match &resource.tiles {
            Some(t) => t,
            None => continue,
        };

        // Compute descriptors from tile data using templates
        let descriptors = indexed_graph.build_descriptors(tiles);
        let headword = descriptors
            .name
            .as_deref()
            .unwrap_or("")
            .trim();
        if headword.is_empty() {
            continue;
        }

        let gloss = descriptors
            .description
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();

        // Dialect codes default to GA for Téarma
        let dialect_codes = vec!["GA".to_string()];

        // Headword index (ga)
        let headword_norm = strip_diacritics(headword);
        let content = if headword == headword_norm {
            headword.to_string()
        } else {
            format!("{headword} {headword_norm}")
        };

        let mut meta = BTreeMap::new();
        meta.insert("title".to_string(), headword.to_string());
        meta.insert("gloss".to_string(), gloss.clone());
        meta.insert("dialect".to_string(), "GA".to_string());

        let mut filters = BTreeMap::new();
        filters.insert("dialect".to_string(), dialect_codes.clone());

        if let Err(e) = ga_index
            .add_custom_record(
                uuid.clone(),
                content,
                "ga".to_string(),
                Some(meta),
                Some(filters.clone()),
                None,
            )
            .await
        {
            eprintln!("[pagefind] ga record failed for {uuid}: {e}");
            continue;
        }
        ga_count += 1;

        // Gloss index (en)
        if !gloss.is_empty() {
            let mut en_meta = BTreeMap::new();
            en_meta.insert("title".to_string(), gloss.clone());
            en_meta.insert("headword".to_string(), headword.to_string());
            en_meta.insert("dialect".to_string(), "GA".to_string());

            if let Err(e) = en_index
                .add_custom_record(
                    uuid.clone(),
                    gloss.clone(),
                    "en".to_string(),
                    Some(en_meta),
                    Some(filters),
                    None,
                )
                .await
            {
                eprintln!("[pagefind] en record failed for {uuid}: {e}");
            } else {
                en_count += 1;
            }
        }
    }

    eprintln!("[builder] pagefind records: ga={ga_count}, en={en_count}");

    // Write indices to disk and zip them
    let ga_dir = output_dir.join("pagefind-ga");
    let en_dir = output_dir.join("pagefind-en");

    ga_index
        .write_files(Some(ga_dir.to_string_lossy().to_string()))
        .await
        .map_err(|e| format!("pagefind ga write: {e}"))?;

    en_index
        .write_files(Some(en_dir.to_string_lossy().to_string()))
        .await
        .map_err(|e| format!("pagefind en write: {e}"))?;

    // Zip each pagefind directory for on-device serving via pfzip protocol
    for dir_name in ["pagefind-ga", "pagefind-en"] {
        let src = output_dir.join(dir_name);
        let dest = output_dir.join(format!("{dir_name}.zip"));
        if src.exists() {
            zip_directory_store(&src, &dest)?;
            // Remove extracted directory — zip is the canonical format
            let _ = std::fs::remove_dir_all(&src);
        }
    }

    eprintln!("[builder] pagefind indices written and zipped");
    Ok(())
}

/// Create a zip archive from a directory (store mode, no compression — pagefind
/// files are already compressed internally).
fn zip_directory_store(src_dir: &Path, dest: &Path) -> Result<(), String> {
    let file =
        std::fs::File::create(dest).map_err(|e| format!("create zip {}: {e}", dest.display()))?;
    let mut zip_writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    fn add_dir_recursive(
        zip_writer: &mut zip::ZipWriter<std::fs::File>,
        base: &Path,
        current: &Path,
        options: zip::write::SimpleFileOptions,
    ) -> Result<(), String> {
        for entry in
            std::fs::read_dir(current).map_err(|e| format!("read dir {}: {e}", current.display()))?
        {
            let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
            let path = entry.path();
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("strip prefix: {e}"))?;
            let name = rel.to_string_lossy().to_string();

            if path.is_dir() {
                add_dir_recursive(zip_writer, base, &path, options)?;
            } else {
                let data = std::fs::read(&path)
                    .map_err(|e| format!("read {}: {e}", path.display()))?;
                zip_writer
                    .start_file(&name, options)
                    .map_err(|e| format!("zip start {name}: {e}"))?;
                std::io::Write::write_all(zip_writer, &data)
                    .map_err(|e| format!("zip write {name}: {e}"))?;
            }
        }
        Ok(())
    }

    add_dir_recursive(&mut zip_writer, src_dir, src_dir, options)?;
    zip_writer
        .finish()
        .map_err(|e| format!("zip finish: {e}"))?;
    Ok(())
}

// ── Core bundle loading for TBX builds ──────────────────────────────────────

const LEXICAL_ENTRY_GRAPH_ID: &str = "449c8695-253e-521b-8994-27701ce22305";
const TEARMA_UUID_NS: &str = "14b35a4a-7420-5d80-89a3-ad00565dc430";
const CORE_PREFIX: &str = "core-goidelic";

/// Load a StaticGraph from the core bundle embedded in the frontend dist.
///
/// Uses Tauri's asset resolver (works in production builds where frontend
/// assets are embedded in the binary). Falls back to reading from the
/// frontendDist directory for dev builds.
fn load_core_graph<R: Runtime>(app: &AppHandle<R>, graph_id: &str) -> Result<StaticGraph, String> {
    let asset_path = format!("{CORE_PREFIX}/graphs/{graph_id}.json");
    let bytes = load_core_asset(app, &asset_path)?;
    // The core bundle ships the Arches export wrapper `{"graph":[<graph>]}`; the
    // prebuild/head path uses a flat StaticGraph. Accept either — flat first,
    // then unwrap the wrapper.
    if let Ok(g) = serde_json::from_slice::<StaticGraph>(&bytes) {
        return Ok(g);
    }
    #[derive(serde::Deserialize)]
    struct ArchesGraphExport {
        graph: Vec<StaticGraph>,
    }
    let export: ArchesGraphExport = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse graph {graph_id}: {e}"))?;
    export
        .graph
        .into_iter()
        .find(|g| g.graphid == graph_id)
        .ok_or_else(|| format!("graph {graph_id}: not found in export"))
}

/// Load all SkosCollections from the core bundle.
fn load_core_collections<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<SkosCollection>, String> {
    // We know the collection files from the core bundle. List them by reading
    // the core-goidelic/collections/ directory via the asset resolver.
    // Since the asset resolver doesn't support directory listing, we'll try
    // loading known collection files by scanning the concept_hierarchy.
    //
    // Alternatively, load the collection IDs from the graph model's
    // collections list. For now, try each file from the known set.
    let collections_index_path = format!("{CORE_PREFIX}/concept_hierarchy.json");
    let mut collections = Vec::new();

    // Try to get collection IDs from the concept hierarchy
    if let Ok(hierarchy_bytes) = load_core_asset(app, &collections_index_path) {
        // The concept hierarchy contains collection references; extract unique collection IDs
        // by scanning the collections directory entries we know exist.
        // Parse the hierarchy to find collection file references.
        if let Ok(hierarchy) =
            serde_json::from_slice::<serde_json::Value>(&hierarchy_bytes)
        {
            // Collect all collection IDs mentioned in the hierarchy
            let mut collection_ids = std::collections::HashSet::new();
            collect_collection_ids(&hierarchy, &mut collection_ids);

            for cid in &collection_ids {
                let path = format!("{CORE_PREFIX}/collections/{cid}.json");
                match load_core_asset(app, &path) {
                    Ok(bytes) => {
                        match serde_json::from_slice::<SkosCollection>(&bytes) {
                            Ok(c) => collections.push(c),
                            Err(e) => eprintln!("[builder] skip collection {cid}: {e}"),
                        }
                    }
                    Err(_) => {} // collection file doesn't exist — skip
                }
            }
        }
    }

    // If we couldn't load from hierarchy, try well-known collection files
    if collections.is_empty() {
        eprintln!("[builder] falling back to brute-force collection scan");
        // Read all files matching collections/*.json from the asset resolver
        // This is a fallback — try the known IDs from the core bundle
        let known_ids = [
            "177b451e-8cf0-503f-bb78-7f52fee2f4d9",
            "1cb5f4c8-b73e-5f87-9e4a-b7b47c56e030",
            "8d23a615-f287-57d2-bd25-d557efe933b3",
            "c1727694-24a6-583e-bc48-922a65eebdf6",
            "c3783e31-1f09-555a-a3d6-ff9bdee4aa20",
        ];
        for cid in &known_ids {
            let path = format!("{CORE_PREFIX}/collections/{cid}.json");
            if let Ok(bytes) = load_core_asset(app, &path) {
                if let Ok(c) = serde_json::from_slice::<SkosCollection>(&bytes) {
                    collections.push(c);
                }
            }
        }
    }

    eprintln!("[builder] loaded {} collections", collections.len());
    Ok(collections)
}

/// Extract collection IDs from the concept_hierarchy.json structure.
/// The hierarchy is a nested JSON object where keys are collection UUIDs.
fn collect_collection_ids(value: &serde_json::Value, ids: &mut std::collections::HashSet<String>) {
    // UUIDs are 36 chars with 4 hyphens.
    fn is_uuid(s: &str) -> bool {
        s.len() == 36 && s.chars().filter(|c| *c == '-').count() == 4
    }
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map {
                if is_uuid(key) {
                    ids.insert(key.clone());
                }
                collect_collection_ids(val, ids);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_collection_ids(item, ids);
            }
        }
        // The concept_hierarchy is a LIST of collection objects whose id is a bare
        // UUID VALUE (not a key) — e.g. the small "Confidence Levels" collection.
        // Collect those too; a non-collection UUID just misses its file and is
        // skipped. Without this the confidence concepts never reach the head and
        // the declension '?' cannot resolve.
        serde_json::Value::String(s) if is_uuid(s) => {
            ids.insert(s.clone());
        }
        _ => {}
    }
}

/// Load a file from the core bundle using Tauri's asset resolver.
fn load_core_asset<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<Vec<u8>, String> {
    let resolver = app.asset_resolver();
    if let Some(asset) = resolver.get(path.to_string()) {
        return Ok(asset.bytes.clone());
    }

    // Fallback for dev mode: try reading from the public/ directory relative
    // to the Tauri config. This handles `tauri dev` where assets aren't bundled.
    // Try common locations.
    let dev_candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("public")
            .join(path),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist")
            .join(path),
    ];
    for candidate in &dev_candidates {
        if candidate.exists() {
            return std::fs::read(candidate)
                .map_err(|e| format!("read {}: {e}", candidate.display()));
        }
    }

    Err(format!(
        "core asset not found: {path} (tried asset resolver and filesystem fallbacks)"
    ))
}
