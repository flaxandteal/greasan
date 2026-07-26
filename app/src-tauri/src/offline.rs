//! First-run offline setup for the self-contained build.
//!
//! The shipped app bundles, as Tauri `bundle.resources`:
//!   * `heads/<corpus>.zip`  — a v2 head (`head.sqlite` + `manifest.json` +
//!     `graph.json` + `chunks/`), zipped so it is ONE bundled file per corpus
//!     (no directory-enumeration of the APK asset tree needed on Android).
//!   * `pagefind/<index>/pagefind-<lang>.zip` — the Pagefind text index, served
//!     as-is from the zip by the `pfzip` custom protocol.
//!
//! On first launch we unpack the heads into `<app_data>/heads/<corpus>/` (a real
//! fs path — `rusqlite` cannot open a file inside the bundle) and copy the
//! Pagefind zips into `<app_data>/files/<index>/<lang>.zip` (where the existing
//! `pfzip` handler already looks). A marker file makes this idempotent.
//!
//! Reading the bundled bytes differs by platform: on desktop `resource_dir()` is
//! a real filesystem path, so `std::fs` reads it directly; on Android
//! `resource_dir()` is `asset://localhost/`, unreadable by `std::fs`, so we read
//! the APK asset through the NDK `AssetManager`.

use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// Bump this when the bundled artifact FORMAT changes, so already-installed apps
/// re-extract instead of reusing a stale layout.
const READY_MARKER: &str = ".offline-ready-v2";

struct CorpusSpec {
    /// Layer name — the `dynamicLayers` registry key and V2 layer name.
    name: &'static str,
    /// Head basename: matches the emitted `data/<head>` dir and bundled
    /// `heads/<head>.zip`.
    head: &'static str,
    /// Pagefind index name: matches `data/<index>` and the `pfzip` URL segment.
    index: &'static str,
    /// Pagefind languages present for this corpus.
    langs: &'static [&'static str],
}

/// Ordered base-first: wiktionary (base) -> macbain (etymology overlay) ->
/// tearma. Mirrors `V2_LAYERS` in `dictionary.ts`.
const CORPORA: &[CorpusSpec] = &[
    CorpusSpec {
        name: "wiktionary",
        head: "wiktionary-v2-full",
        index: "wiktionary-index",
        langs: &["en", "ga", "sampla"],
    },
    CorpusSpec {
        name: "macbain",
        head: "macbain-v2",
        index: "macbain-index",
        langs: &["en", "ga"],
    },
    CorpusSpec {
        name: "tearma",
        head: "tearma-v2",
        index: "tearma-index",
        langs: &["ga", "en"],
    },
    CorpusSpec {
        // Morphology enrichment (BuNaMo): forms + grammar_class compose onto the
        // shared goi ids. Pagefind is ga-only (inflected surface forms). Its
        // pagefind zips live in the head dir, so index == head basename.
        name: "bunamo",
        head: "bunamo-v2",
        index: "bunamo-v2",
        langs: &["ga"],
    },
    CorpusSpec {
        // Logainm placenames — its OWN graph (schema.org/Place), NOT the shared
        // lexical_entry model, so it composes as a separate model in the stack.
        // name_elements.element_entry links each name to the goi dictionary entry
        // its elements come from (reverse lookup via `cited_by`). Pagefind is
        // ga-only (Irish + English name text); zips live in the head dir.
        name: "place",
        head: "place-v2",
        index: "place-v2",
        langs: &["ga"],
    },
    CorpusSpec {
        // Corpus examples — own graph; head bundled for hydrate + cited_by. Two
        // heads keep the licences distinct (Tatoeba CC BY 2.0 / Gaois CC BY 4.0).
        // sampla pagefind (example-granular) carried for the sample search.
        name: "example-tatoeba",
        head: "example-tatoeba-v2",
        index: "example-tatoeba-v2",
        langs: &["sampla"],
    },
    CorpusSpec {
        name: "example-gaois",
        head: "example-gaois-v2",
        index: "example-gaois-v2",
        langs: &["sampla"],
    },
    CorpusSpec {
        // Person graph — seeded "User" that authors notes. No pagefind.
        name: "person",
        head: "person-v2",
        index: "person-v2",
        langs: &[],
    },
    CorpusSpec {
        // Note/flag graph — the MUTABLE layer, re-emitted on each flag. No pagefind.
        name: "note",
        head: "note-v2",
        index: "note-v2",
        langs: &[],
    },
];

/// One resolved layer returned to the frontend after first-run prep.
#[derive(Serialize)]
pub struct OfflineLayer {
    /// Layer name (registry key).
    pub name: String,
    /// Absolute path to the unpacked head dir (fed to the `v2_*` commands).
    pub head_dir: String,
    /// Pagefind index name — the frontend builds `http://pfzip.localhost/<index>/`.
    pub pagefind_index: String,
}

/// Read a bundled resource file's bytes.
///
/// Desktop: `resource_dir()` is a real fs path. Android: it is
/// `asset://localhost/`, so `std::fs` fails and we fall through to the APK
/// `AssetManager`.
fn read_resource_bytes<R: Runtime>(app: &AppHandle<R>, rel: &str) -> Result<Vec<u8>, String> {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(rel);
        match fs::read(&p) {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                // Expected on Android (asset:// path). Log once and fall through.
                eprintln!("[offline] resource_dir read miss {}: {e}", p.display());
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        return read_android_asset(rel);
    }

    #[allow(unreachable_code)]
    Err(format!("bundled resource not found: {rel}"))
}

/// Read a file bundled in the APK `assets/` via the NDK `AssetManager`.
#[cfg(target_os = "android")]
fn read_android_asset(rel: &str) -> Result<Vec<u8>, String> {
    use std::ffi::CString;
    use std::io::Read;
    use std::ptr::NonNull;

    // JavaVM + Android Context. Bridged in from tao at startup (see
    // `android_ctx`); the accessor returns Err instead of panic-aborting if the
    // context is somehow unavailable.
    let ctx = crate::android_ctx::context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("android: JavaVM::from_raw: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("android: attach_current_thread: {e}"))?;
    let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };

    // Context.getAssets() -> AssetManager (Java object)
    let asset_mgr_obj = env
        .call_method(
            &context,
            "getAssets",
            "()Landroid/content/res/AssetManager;",
            &[],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("android: getAssets: {e}"))?;

    // AAssetManager_fromJava -> *AAssetManager
    let aasset_mgr = unsafe {
        ndk_sys::AAssetManager_fromJava(env.get_raw() as *mut _, asset_mgr_obj.as_raw() as *mut _)
    };
    let aasset_mgr = NonNull::new(aasset_mgr)
        .ok_or_else(|| "android: AAssetManager_fromJava returned null".to_string())?;
    let manager = unsafe { ndk::asset::AssetManager::from_ptr(aasset_mgr) };

    let cpath = CString::new(rel).map_err(|e| format!("android: CString: {e}"))?;
    let mut asset = manager
        .open(cpath.as_c_str())
        .ok_or_else(|| format!("android: asset not found in APK: {rel}"))?;

    let mut buf = Vec::new();
    asset
        .read_to_end(&mut buf)
        .map_err(|e| format!("android: read asset {rel}: {e}"))?;
    Ok(buf)
}

/// Unpack a zip (given as bytes) into `dest`, preserving internal structure.
fn extract_zip_bytes(bytes: Vec<u8>, dest: &std::path::Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("open zip: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue; // skip unsafe / absolute names
        };
        let out = dest.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("mkdir {}: {e}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut f = fs::File::create(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("write {}: {e}", out.display()))?;
    }
    Ok(())
}

/// Build the (idempotent) list of resolved layers for the given app-data dir.
fn resolved_layers(app_data: &std::path::Path) -> Vec<OfflineLayer> {
    CORPORA
        .iter()
        .map(|c| OfflineLayer {
            name: c.name.to_string(),
            head_dir: app_data
                .join("heads")
                .join(c.head)
                .to_string_lossy()
                .to_string(),
            pagefind_index: c.index.to_string(),
        })
        .collect()
}

/// First-run offline preparation. Unpacks bundled heads + Pagefind zips into the
/// app-data dir on first launch (idempotent via a marker), and always returns the
/// resolved layer set. Safe to call on every startup.
#[tauri::command]
pub fn v2_prepare_offline<R: Runtime>(app: AppHandle<R>) -> Result<Vec<OfflineLayer>, String> {
    let app_data: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&app_data).map_err(|e| format!("mkdir {}: {e}", app_data.display()))?;

    let marker = app_data.join(READY_MARKER);
    if marker.exists() {
        return Ok(resolved_layers(&app_data));
    }

    let heads_root = app_data.join("heads");
    let files_root = app_data.join("files");

    for c in CORPORA {
        // Head: heads/<head>.zip -> <app_data>/heads/<head>/
        let head_dest = heads_root.join(c.head);
        // Remove any partial prior extraction, then unpack fresh.
        let _ = fs::remove_dir_all(&head_dest);
        fs::create_dir_all(&head_dest)
            .map_err(|e| format!("mkdir {}: {e}", head_dest.display()))?;
        let head_rel = format!("heads/{}.zip", c.head);
        let head_bytes = read_resource_bytes(&app, &head_rel)?;
        eprintln!(
            "[offline] extracting {} ({} bytes) -> {}",
            head_rel,
            head_bytes.len(),
            head_dest.display()
        );
        extract_zip_bytes(head_bytes, &head_dest)?;

        // Pagefind: pagefind/<index>/pagefind-<lang>.zip -> <app_data>/files/<index>/pagefind-<lang>.zip
        let pf_dest_dir = files_root.join(c.index);
        fs::create_dir_all(&pf_dest_dir)
            .map_err(|e| format!("mkdir {}: {e}", pf_dest_dir.display()))?;
        for lang in c.langs {
            let zip_name = format!("pagefind-{lang}.zip");
            let pf_rel = format!("pagefind/{}/{}", c.index, zip_name);
            let pf_bytes = read_resource_bytes(&app, &pf_rel)?;
            let pf_dest = pf_dest_dir.join(&zip_name);
            eprintln!(
                "[offline] copying {} ({} bytes) -> {}",
                pf_rel,
                pf_bytes.len(),
                pf_dest.display()
            );
            fs::write(&pf_dest, &pf_bytes)
                .map_err(|e| format!("write {}: {e}", pf_dest.display()))?;
        }
    }

    fs::write(&marker, b"ready").map_err(|e| format!("write marker: {e}"))?;
    eprintln!("[offline] first-run prep complete: {}", marker.display());
    Ok(resolved_layers(&app_data))
}
