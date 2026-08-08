// SPDX-License-Identifier: AGPL-3.0-or-later
//! Byte-range access to the bundled vector basemap (`basemap/goidelic.pmtiles`)
//! so a pmtiles.js custom Source can random-access it with NO HTTP tile server -
//! the app stays offline. Desktop reads via `std::fs` seek; Android via the NDK
//! `AssetManager` (an `AAsset` is seekable). Returns RAW bytes (an ArrayBuffer on
//! the JS side) because pmtiles issues many small range reads.
//!
//! Tiles are rendered from OpenStreetMap data (ODbL 1.0); the map view shows the
//! "© OpenStreetMap contributors" attribution.

use std::io::{Read, Seek, SeekFrom};
use tauri::{AppHandle, Manager, Runtime};

/// Relative path of the bundled basemap under `resource_dir()` / the APK assets.
const BASEMAP_REL: &str = "basemap/goidelic.pmtiles";

/// Read up to `buf.len()` bytes, tolerating short reads until EOF. Returns the
/// number actually read (a range near EOF legitimately returns fewer).
fn read_fill<T: Read>(src: &mut T, buf: &mut [u8]) -> Result<usize, String> {
    let mut filled = 0;
    while filled < buf.len() {
        match src.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("basemap read: {e}")),
        }
    }
    Ok(filled)
}

#[cfg(target_os = "android")]
fn read_android_range(rel: &str, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    use std::ffi::CString;
    use std::ptr::NonNull;

    let ctx = crate::android_ctx::context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("android: JavaVM::from_raw: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("android: attach_current_thread: {e}"))?;
    let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
    let mgr_obj = env
        .call_method(&context, "getAssets", "()Landroid/content/res/AssetManager;", &[])
        .and_then(|v| v.l())
        .map_err(|e| format!("android: getAssets: {e}"))?;
    let aasset_mgr = unsafe {
        ndk_sys::AAssetManager_fromJava(env.get_raw() as *mut _, mgr_obj.as_raw() as *mut _)
    };
    let aasset_mgr =
        NonNull::new(aasset_mgr).ok_or_else(|| "android: AAssetManager null".to_string())?;
    let manager = unsafe { ndk::asset::AssetManager::from_ptr(aasset_mgr) };
    let cpath = CString::new(rel).map_err(|e| format!("android: CString: {e}"))?;
    let mut asset = manager
        .open(cpath.as_c_str())
        .ok_or_else(|| format!("android: asset not found: {rel}"))?;
    asset
        .seek(SeekFrom::Start(offset))
        .map_err(|e| format!("android: seek: {e}"))?;
    let mut buf = vec![0u8; length];
    let n = read_fill(&mut asset, &mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

fn read_range<R: Runtime>(app: &AppHandle<R>, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    // Desktop: resource_dir() is a real path. Android: it is asset://…, so fs
    // fails and we fall through to the AssetManager.
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(BASEMAP_REL);
        if let Ok(mut f) = std::fs::File::open(&p) {
            f.seek(SeekFrom::Start(offset))
                .map_err(|e| format!("basemap seek {}: {e}", p.display()))?;
            let mut buf = vec![0u8; length];
            let n = read_fill(&mut f, &mut buf)?;
            buf.truncate(n);
            return Ok(buf);
        }
    }

    #[cfg(target_os = "android")]
    {
        return read_android_range(BASEMAP_REL, offset, length);
    }

    #[allow(unreachable_code)]
    Err(format!("basemap not bundled: {BASEMAP_REL}"))
}

/// `length` bytes of the bundled basemap starting at `offset`, as raw bytes.
#[tauri::command]
pub fn basemap_range<R: Runtime>(
    app: AppHandle<R>,
    offset: u64,
    length: u32,
) -> Result<tauri::ipc::Response, String> {
    let bytes = read_range(&app, offset, length as usize)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Whether the basemap file is actually bundled - the frontend skips the basemap
/// layer (falling back to the hand-drawn outline) when tiles have not been built.
/// Checks the 127-byte PMTiles header is present.
#[tauri::command]
pub fn basemap_available<R: Runtime>(app: AppHandle<R>) -> bool {
    read_range(&app, 0, 127).map(|b| b.len() >= 127).unwrap_or(false)
}
