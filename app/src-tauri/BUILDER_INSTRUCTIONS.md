# Builder Plugin Implementation Instructions

These instructions are for a Claude Code instance working on the RosMadair repo and this Tauri plugin. Two scopes of work: an upstream change in `ros-madair-core`, then filling in the stubbed Tauri commands here.

## Scope A: ros-madair-core change (upstream)

**Repo:** `/home/philtweir/Cód/Oscailte/magic/RosMadair`

### What to change

The `IndexBuilder` in `crates/ros-madair-builder/src/lib.rs` has a `build(&self, output_dir: &str)` method that does everything: quantize records, build indexes, and write files to disk via `fs::write()`. The Tauri plugin needs the same pipeline but returning artifacts as bytes instead of writing to disk — it controls where files land (app data directory).

**Add `build_to_memory()` to `ros-madair-core`**, not to `ros-madair-builder` (avoid PyO3 dependency in the Tauri plugin).

The function should live in `crates/ros-madair-core/src/build.rs` (or a new `crates/ros-madair-core/src/builder.rs` if build.rs is getting unwieldy). It must be a **library function**, not tied to PyO3.

#### Scope and approach

Extract `build_to_memory()` accepting `StaticResource` directly — `ros-madair-core` already depends on `alizarin-core`, so no new dependency. This matches the CLI binary builder's richer representation and avoids the fidelity gap where the PyO3 builder's thin `ResourceData` loses `cache`, `scopes`, and `resourceinstance.descriptors`.

**Leave the CLI binary builder alone** — it has its own concerns (prebuild dir loading, vocabulary XML copying, verbose logging, `live_page_meta` filtering) that don't need to be forced through this abstraction. Refactor only `IndexBuilder::build()` in `ros-madair-builder` to delegate.

The PyO3 `IndexBuilder` currently constructs its own thin `ResourceData` from JSON. When refactoring it to delegate to `build_to_memory()`, it should convert its internal representation to `StaticResource` before calling. This may mean the PyO3 builder gains fields it didn't previously populate (cache, scopes) — that's fine, leave them empty/default.

#### Things `build_to_memory()` does NOT need to cover

These are binary-builder-specific concerns — don't try to replicate them:

- `live_page_meta` filtering (dropping empty pages from `page_meta.json`)
- Graph JSON file copying to output (callers can handle this themselves if needed)
- Vocabulary XML file copying
- Debug logging / timing

#### Suggested API

```rust
use std::collections::HashMap;
use alizarin_core::StaticResource; // already a dep of ros-madair-core

/// All output artifacts as in-memory byte buffers.
/// Keys are relative paths matching the on-disk layout, e.g.:
///   "summary.bin", "dictionary.bin", "resource_map.bin",
///   "page_meta.json", "resource_names.json",
///   "pages/page_0000.dat", "tiles/tile_0000.dat",
///   "all.nt", "concept_hierarchy.json",
///   "concept_intervals.bin", "concept_tree.bin"
///
/// Note: graph JSON files are NOT included — callers that need them
/// should write the raw graph JSON separately.
pub fn build_to_memory(
    base_uri: &str,
    graphs: &HashMap<String, StaticGraph>,
    resources: &[StaticResource],
    vocabulary_collections: &[SkosCollection],
    page_size: Option<usize>,
) -> Result<HashMap<String, Vec<u8>>, String> { ... }
```

`StaticResource` carries `resourceinstance` (with `descriptors`, name, slug), tiles, cache, and scopes — everything the build pipeline needs without a separate metadata map.

Then refactor `IndexBuilder::build()` in `ros-madair-builder` to delegate. The PyO3 builder will need to construct `StaticResource` from its internal representation:

```rust
pub fn build(&self, output_dir: &str, page_size: Option<usize>) -> PyResult<()> {
    let static_resources = self.to_static_resources()?; // convert internal repr

    let artifacts = ros_madair_core::build_to_memory(
        &self.base_uri,
        &self.graphs,
        &static_resources,
        &self.vocabulary_collections,
        page_size,
    ).map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e))?;

    for (name, bytes) in &artifacts {
        let path = std::path::Path::new(output_dir).join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyIOError, _>(e.to_string()))?;
        }
        std::fs::write(&path, bytes)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyIOError, _>(e.to_string()))?;
    }
    Ok(())
}
```

#### What NOT to change

- Don't touch `ros-madair-client` (browser WASM) — it fetches over HTTP, doesn't need this.
- Don't touch `ros-madair-alizarin` — it re-exports client + alizarin, no build logic.
- Don't add TBX parsing or format conversion to ros-madair-core. Source format handling is the Tauri plugin's concern.

### Testing

- Existing tests in the workspace must still pass.
- Add a test in `ros-madair-core` that calls `build_to_memory()` with a minimal fixture (1-2 resources, 1 graph) and asserts the expected keys are present in the output map and that `summary.bin` / `dictionary.bin` are non-empty.
- `IndexBuilder::build()` must produce identical output before and after the refactor — byte-for-byte if deterministic, or structurally equivalent if not.

### Types the Tauri plugin needs from ros-madair-core

The plugin will depend on `ros-madair-core` as a path dependency. It needs these to be `pub`:

- `build_to_memory` (the new function)
- `StaticGraph` (re-exported from alizarin-core or accessible via ros-madair-core)
- `StaticResource` (re-exported from alizarin-core — the full resource representation)
- `SkosCollection` (if vocabulary support is needed)

Check that these are accessible from `ros_madair_core::` without going through PyO3.

---

## Scope B: Tauri plugin implementation (this repo)

**Repo:** `/home/philtweir/Cód/Oscailte/Gréasán`
**File:** `app/src-tauri/src/builder_plugin.rs`

### Current state

The plugin skeleton defines three commands, all returning `Err("not yet implemented")`:

| Command | Input | Output |
|---|---|---|
| `build_layer` | `source_url: String, format: String, layer_name: String` | `BuildLayerResult { layer_id, output_path }` |
| `get_layer_status` | `layer_id: String` | `BuildLayerStatus { state, progress, error }` |
| `list_layers` | — | `Vec<LayerInfo>` |

### What to implement

#### 1. `build_layer`

High-level flow:

```
source_url → fetch bytes → parse into alizarin format → build_to_memory() → write to app data dir
```

Steps:
1. Generate a `layer_id` (UUID or slugified `layer_name`).
2. Set initial status to `pending` in Tauri managed state (`Mutex<HashMap<String, BuildLayerStatus>>`).
3. Spawn an async task (don't block the command handler).
4. In the async task:
   a. Update status to `fetching`. Fetch `source_url` via `reqwest`.
   b. Update status to `parsing`. Parse the fetched data into alizarin's `StaticGraph` + `StaticTile` format. The `format` field tells you what parser to use (start with `"prebuild"` = already in alizarin prebuild format; `"tbx"` = TBX terminology format — defer this).
   c. Update status to `building`. Call `ros_madair_core::build_to_memory()`.
   d. Update status to `writing`. Write artifacts to `{app_data_dir}/layers/{layer_name}/`.
   e. Update status to `complete` with `output_path` set.
   f. On any error, set status to `failed` with error message.
5. Return `BuildLayerResult { layer_id, output_path: "pending" }` immediately (caller polls via `get_layer_status`).

#### 2. `get_layer_status`

Read from the managed `Mutex<HashMap<String, BuildLayerStatus>>`. Return the status for the given `layer_id`, or error if not found.

States: `pending → fetching → parsing → building → writing → complete` (or `failed` at any point).

The `progress` field is a float 0.0–1.0. Set it coarsely per phase (0.0 pending, 0.1 fetching, 0.3 parsing, 0.5 building, 0.9 writing, 1.0 complete). Fine-grained progress within `build_to_memory()` is not worth plumbing initially.

#### 3. `list_layers`

Scan `{app_data_dir}/layers/` for directories containing a `summary.bin`. Return `Vec<LayerInfo>` with `layer_id` (directory name) and `output_path` (absolute path).

### Dependencies to add to `app/src-tauri/Cargo.toml`

```toml
ros-madair-core = { path = "../../../../magic/RosMadair/crates/ros-madair-core" }
# alizarin-core only if StaticGraph/StaticTile types aren't re-exported by ros-madair-core
reqwest = { version = "0.12", features = ["rustls-tls"], default-features = false }
uuid = { version = "1", features = ["v4"] }
tokio = { version = "1", features = ["fs"] }
```

### Managed state setup

In `app/src-tauri/src/lib.rs`, add managed state to the Tauri app builder:

```rust
use std::sync::Mutex;
use std::collections::HashMap;
use crate::builder_plugin::BuildLayerStatus;

// In run():
.manage(Mutex::new(HashMap::<String, BuildLayerStatus>::new()))
```

### Frontend contract

**Do not change command signatures.** The TypeScript bindings in `app/src/lib/tauri-builder.ts` must continue to match. The frontend will:

1. Call `buildLayer({ sourceUrl, format, layerName })` → get `{ layerId, outputPath }`
2. Poll `getLayerStatus(layerId)` until `state === "complete"` or `state === "failed"`
3. Convert `outputPath` to a webview-accessible URL via `convertFileSrc(outputPath, 'asset')`
4. Pass that URL to `sparqlStore.addLayer(url, layerName)`

The `protocol-asset` scope in `tauri.conf.json` is already set to `$APPDATA/**`, which covers the layers directory.

### Output directory structure

Each layer produces the standard ros-madair index layout:

```
{app_data_dir}/layers/{layer_name}/
├── summary.bin
├── dictionary.bin
├── resource_map.bin
├── page_meta.json
├── pages/
│   └── page_0000.dat ...
├── tiles/
│   └── tile_0000.dat ...
└── ...
```

### Testing

- Create a small prebuild fixture (10-20 entries from the ga-wiktionary pipeline output or a hand-crafted minimal set).
- Test the pure-compute path independently of Tauri: call `build_to_memory()` directly with the fixture, assert expected output keys.
- For integration testing within Tauri, use `tauri::test` utilities or just verify manually via dev tools console:
  ```js
  // Should return { layerId: "...", outputPath: "pending" }
  await window.__TAURI__.core.invoke('plugin:ros-madair-builder|build_layer', {
    sourceUrl: 'https://example.com/prebuild.tar.gz',
    format: 'prebuild',
    layerName: 'test'
  });
  ```

### Architecture notes

- **ros-madair-core is called natively** — same Rust process, no WASM, no FFI. This is the whole point of using Tauri instead of Capacitor.
- The browser WASM path (`ros-madair-client` / `SparqlStore`) continues to handle querying. The builder plugin only handles *creating* new layers. Once a layer is built and written to disk, the frontend loads it via `SparqlStore.addLayer()` using the asset protocol URL.
- The `ros-madair-alizarin` combined WASM (which bundles `SparqlStore` + alizarin) is what the frontend imports. The Tauri plugin is a separate, native-only concern.
