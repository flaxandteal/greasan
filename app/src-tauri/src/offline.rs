//! First-run offline setup for the self-contained build.
//!
//! The shipped app bundles, as Tauri `bundle.resources`:
//!   * `heads/<corpus>.zip`  - a v2 head (`head.sqlite` + `manifest.json` +
//!     `graph.json` + `chunks/`), zipped so it is ONE bundled file per corpus
//!     (no directory-enumeration of the APK asset tree needed on Android).
//!   * `pagefind/<index>/pagefind-<lang>.zip` - the Pagefind text index, served
//!     as-is from the zip by the `pfzip` custom protocol.
//!
//! On first launch we unpack the heads into `<app_data>/heads/<corpus>/` (a real
//! fs path - `rusqlite` cannot open a file inside the bundle) and copy the
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
/// re-extract instead of reusing a stale layout. v3: lexical-entry graph gained
/// the `gender` node + all concepts re-emitted through the shared RdmCache, so the
/// old unpacked heads must be replaced (they lack gender / have stale concept ids).
// Version-agnostic sentinel: prep has run at least once. It no longer gates
// extraction (per-layer snapshot_id comparison does), so it never needs bumping -
// a changed layer re-extracts on its own hash, an unchanged one is left alone.
const READY_MARKER: &str = ".offline-ready";

struct CorpusSpec {
    /// Layer name - the `dynamicLayers` registry key and V2 layer name.
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
    // Téarma is NOT bundled - it cannot be shipped (licensing), so it is built
    // on-device (tbx-v2 → FTS5 `search.sqlite` sidecar) and installed as a
    // layer, not a bundled corpus. See `family.ts`'s `tearma` suggested layer.
    CorpusSpec {
        // Computed morphology (Gramadán forms): a reduced-order REPLACEMENT for
        // bunamo. Ships only grammar_class per noun (~1.6MB vs bunamo's ~7.8MB);
        // its own graph declares the compute-tiles fxg, so greasan-gramadan
        // materialises the full paradigm on device (headword from wiktionary,
        // class from here). Pagefind is ga-only, over the inflected forms
        // recovered from the build-time paradigm (search "fir" -> lemma "fear"),
        // exactly as bunamo provided - the forms exist at build time even though
        // the tiles ship class-only. Zips live in the head dir (index == head).
        name: "gramadan-forms",
        head: "gramadan-forms-v2",
        index: "gramadan-forms-v2",
        langs: &["ga"],
    },
    CorpusSpec {
        // Logainm placenames - its OWN graph (schema.org/Place), NOT the shared
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
        // Logainm toponymic CONCEPTS (ontolex:LexicalConcept) - the meaning a
        // placename evokes. OWN graph (Lexical Concept), its own head so it is
        // full-hydratable (a placename's concept_entry is hydrated against it).
        // Reached only via placename/entry links, so no pagefind.
        name: "concept",
        head: "concept-v2",
        index: "concept-v2",
        langs: &[],
    },
    CorpusSpec {
        // Corpus examples - own graph; head bundled for hydrate + cited_by. Two
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
        // UD Irish treebank - gold-tagged, exact goi-<lemma>-<pos> links (CC BY-SA 4.0).
        name: "example-udt",
        head: "example-udt-v2",
        index: "example-udt-v2",
        langs: &["sampla"],
    },
    CorpusSpec {
        // Person graph - seeded "User" that authors notes. No pagefind.
        name: "person",
        head: "person-v2",
        index: "person-v2",
        langs: &[],
    },
    CorpusSpec {
        // Note/flag graph - the MUTABLE layer, re-emitted on each flag. No pagefind.
        name: "note",
        head: "note-v2",
        index: "note-v2",
        langs: &[],
    },
    CorpusSpec {
        // Layer catalogue - metadata describing each data layer. Queried on its
        // own for the layer UI; not composed into the lexical stack. No pagefind.
        name: "layer",
        head: "layer-v2",
        index: "layer-v2",
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
    /// Pagefind index name - the frontend builds `http://pfzip.localhost/<index>/`.
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

/// A head dir is a PRESENT (active) layer iff it carries at least one
/// `tiles_*.parquet`. An empty `heads/<head>/` left by an un-bundled head (a base
/// build ships only the skeleton `layer-v2`) or a partial extraction is NOT a
/// layer. Mirrors `has_parquet_tiles` (builder_plugin.rs) / the read-side check in
/// v2.rs.
fn head_has_tiles(dir: &std::path::Path) -> bool {
    fs::read_dir(dir).ok().is_some_and(|rd| {
        rd.flatten().any(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.starts_with("tiles_") && n.ends_with(".parquet")
        })
    })
}

/// Build the (idempotent) list of resolved layers for the given app-data dir.
///
/// Only CORPORA heads with actual tile data are returned as active layers. A head
/// that isn't bundled in this build (every corpus but `layer-v2` in a core-only
/// build) is surfaced as a KNOWN layer via the skeleton catalogue (installable),
/// NOT listed as an installed-but-empty layer - which is what made core-only show
/// "N layers · N on" with amber shields.
fn resolved_layers(app_data: &std::path::Path) -> Vec<OfflineLayer> {
    CORPORA
        .iter()
        .filter_map(|c| {
            let head_dir = app_data.join("heads").join(c.head);
            if !head_has_tiles(&head_dir) {
                return None;
            }
            Some(OfflineLayer {
                name: c.name.to_string(),
                head_dir: head_dir.to_string_lossy().to_string(),
                pagefind_index: c.index.to_string(),
            })
        })
        .collect()
}

/// The `snapshot_id` a head carries in its manifest.json - a content hash stamped
/// by whatever produced the layer. None if the manifest is absent/unreadable.
fn head_snapshot(manifest: &std::path::Path) -> Option<String> {
    let bytes = fs::read(manifest).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("snapshot_id")?.as_str().map(str::to_string)
}

/// The bundled `{head -> snapshot_id}` index (heads-versions.json, generated at
/// build time from the shipped heads' manifests). Empty when the resource is
/// absent (a build predating this scheme), in which case callers keep the older
/// "head present = current" behaviour rather than re-extracting every launch.
fn bundled_head_versions<R: Runtime>(app: &AppHandle<R>) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if let Ok(bytes) = read_resource_bytes(app, "heads-versions.json") {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            for (k, v) in map {
                if let Some(s) = v.as_str() {
                    out.insert(k, s.to_string());
                }
            }
        }
    }
    out
}

/// First-run offline preparation. Unpacks bundled heads + Pagefind zips into the
/// app-data dir, and always returns the resolved layer set. Safe to call on every
/// startup: a layer is (re-)extracted only when it is MISSING or its extracted
/// snapshot_id differs from the bundled one - so an app update re-provisions just
/// the layers whose data actually changed, not all ~400MB.
#[tauri::command]
pub fn v2_prepare_offline<R: Runtime>(app: AppHandle<R>) -> Result<Vec<OfflineLayer>, String> {
    let app_data: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&app_data).map_err(|e| format!("mkdir {}: {e}", app_data.display()))?;

    let marker = app_data.join(READY_MARKER);
    let heads_root = app_data.join("heads");
    let files_root = app_data.join("files");
    let bundled_versions = bundled_head_versions(&app);

    for c in CORPORA {
        // Head: heads/<head>.zip -> <app_data>/heads/<head>/
        let head_dest = heads_root.join(c.head);
        // Keep the extracted layer iff it's present AND its snapshot matches the
        // bundled one. When either version is unknown (no versions index, or a head
        // stamped before this scheme) fall back to "present = keep", so we never
        // re-extract needlessly. Missing head, or a changed snapshot, drops through
        // to a fresh unpack.
        if head_dest.exists() {
            let bundled = bundled_versions.get(c.head);
            let extracted = head_snapshot(&head_dest.join("manifest.json"));
            let changed = matches!((bundled, &extracted), (Some(b), Some(e)) if b != e);
            if changed {
                eprintln!(
                    "[offline] {} snapshot {:?} -> {:?}; re-extracting",
                    c.head, extracted, bundled
                );
            } else {
                continue;
            }
        }
        let head_rel = format!("heads/{}.zip", c.head);
        // A head whose zip is not bundled (e.g. a base-only build that ships core
        // metadata + basemap + the skeleton layer-v2, and installs corpus layers at
        // runtime) is simply skipped - the app boots to the zero-corpus state with
        // the known-layer catalogue. This is presence, not content: a stale/wrong
        // head is still caught by the snapshot_id check above, so tolerance here does
        // not weaken that guard. Full builds assert head presence at package time
        // (build-apk.sh), so a forgotten head in a data-bundled release still fails
        // loudly rather than silently here. Read the zip BEFORE touching the dir so an
        // un-bundled head leaves NO empty heads/<head>/ (which head_has_tiles would
        // otherwise still have to exclude).
        let head_bytes = match read_resource_bytes(&app, &head_rel) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[offline] head {} not bundled ({e}); skipping", c.head);
                continue;
            }
        };
        // Remove any partial prior extraction, then unpack fresh.
        let _ = fs::remove_dir_all(&head_dest);
        fs::create_dir_all(&head_dest)
            .map_err(|e| format!("mkdir {}: {e}", head_dest.display()))?;
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
