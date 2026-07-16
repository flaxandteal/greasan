mod builder_plugin;
mod index_files;
mod pagefind_zip;
mod tbx_parser;
/// v2 static-assets pilot (ros-madair-query + SQLite head + native tile
/// hydration). Off by default; `--features v2`.
#[cfg(feature = "v2")]
mod v2;

use std::collections::HashMap;
use std::sync::Mutex;

pub type BuilderState = Mutex<HashMap<String, builder_plugin::BuildLayerStatus>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
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
    ]);
    #[cfg(feature = "v2")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        builder_plugin::build_layer,
        builder_plugin::get_layer_status,
        builder_plugin::list_layers,
        builder_plugin::check_local_index,
        builder_plugin::remove_layer_files,
        builder_plugin::layer_has_pagefind,
        v2::v2_hydrate,
        v2::v2_query,
        v2::v2_query_layers,
        v2::v2_hydrate_layers,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
