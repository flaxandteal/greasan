mod builder_plugin;
mod index_files;
mod pagefind_zip;

use std::collections::HashMap;
use std::sync::Mutex;

pub type BuilderState = Mutex<HashMap<String, builder_plugin::BuildLayerStatus>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BuilderState::default())
        .manage(pagefind_zip::PfZipState::default())
        .manage(index_files::LayerZipState::default())
        .register_uri_scheme_protocol("pfzip", pagefind_zip::handle_request)
        .register_uri_scheme_protocol("rmindex", index_files::handle_request)
        .invoke_handler(tauri::generate_handler![
            builder_plugin::build_layer,
            builder_plugin::get_layer_status,
            builder_plugin::list_layers,
            builder_plugin::check_local_index,
            builder_plugin::remove_layer_files,
            builder_plugin::layer_has_pagefind,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
