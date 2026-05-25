use tauri_build::{Attributes, InlinedPlugin};

fn main() {
    tauri_build::try_build(
        Attributes::new()
            .plugin(
                "ros-madair-builder",
                InlinedPlugin::new()
                    .commands(&["build_layer", "get_layer_status", "list_layers"]),
            ),
    )
    .expect("failed to run tauri-build");
}
