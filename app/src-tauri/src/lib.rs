mod builder_plugin;
mod index_files;
mod pagefind_zip;
mod tbx_parser;

/// Vector basemap (PMTiles) byte-range access for the offline map — reads the
/// bundled `goidelic.pmtiles`. Independent of the `v2` feature.
mod basemap;

/// Debug-only localhost navigation channel (adb-driven). `nav-server` feature.
#[cfg(feature = "nav-server")]
mod navserver;
/// v2 static-assets pilot (ros-madair-query + SQLite head + native tile
/// hydration). Off by default; `--features v2`.
#[cfg(feature = "v2")]
mod v2;

/// First-run offline setup: unpack bundled heads + Pagefind zips into app-data.
/// Part of the self-contained offline build; v2-gated (only the v2 path uses it).
#[cfg(feature = "v2")]
mod offline;

/// Android JNI context bridge — initializes `ndk_context` from tao's live
/// JavaVM + Activity, since Tauri v2's `WryActivity` never does it itself.
#[cfg(target_os = "android")]
mod android_ctx;

use std::collections::HashMap;
use std::sync::Mutex;

pub type BuilderState = Mutex<HashMap<String, builder_plugin::BuildLayerStatus>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|_app| {
            // Bridge tao's live Android context into `ndk_context` before any
            // JNI-dependent command (offline extract, content:// import) runs.
            // By the time setup runs, tao's `create` JNI callback has already
            // populated its context, so this is ready. No-op off Android.
            #[cfg(target_os = "android")]
            android_ctx::init_from_tao();
            #[cfg(feature = "nav-server")]
            navserver::start(_app.handle().clone());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(BuilderState::default())
        .manage(pagefind_zip::PfZipState::default())
        .manage(index_files::LayerZipState::default())
        .register_uri_scheme_protocol("pfzip", pagefind_zip::handle_request)
        .register_uri_scheme_protocol("rmindex", index_files::handle_request);

    // `generate_handler!` takes a plain path list (no cfg attrs inside), so the
    // two handler sets are spelled out; the non-v2 list is unchanged.
    #[cfg(not(feature = "v2"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        builder_plugin::build_layer,
        builder_plugin::get_layer_status,
        builder_plugin::list_layers,
        builder_plugin::check_local_index,
        builder_plugin::remove_layer_files,
        builder_plugin::layer_has_pagefind,
        basemap::basemap_range,
        basemap::basemap_available,
    ]);
    #[cfg(feature = "v2")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        builder_plugin::build_layer,
        builder_plugin::get_layer_status,
        builder_plugin::list_layers,
        builder_plugin::check_local_index,
        builder_plugin::remove_layer_files,
        builder_plugin::layer_has_pagefind,
        basemap::basemap_range,
        basemap::basemap_available,
        v2::v2_hydrate,
        v2::v2_query,
        v2::v2_query_layers,
        v2::v2_hydrate_layers,
        v2::v2_closure,
        v2::v2_descriptors,
        v2::v2_search_display,
        v2::v2_cited_by,
        v2::v2_geo_points,
        v2::v2_emit_overlay,
        offline::v2_prepare_offline,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
