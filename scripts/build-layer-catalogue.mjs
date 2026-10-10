/**
 * build-layer-catalogue.mjs
 *
 * Builds the `layer-v2` head: the Layer catalogue - one Layer resource per data
 * layer in the stack, describing its licensing + attribution, types, formats,
 * links, description, build statistics, and Gréasán integration config. Shipped
 * by default as the source for finding + installing layers, independent of
 * whether each layer's data is loaded.
 *
 * The build→seed→write-prebuild core lives in scripts/lib/layer-emit.mjs (shared
 * with build-parquet-layers.mjs, which bakes a single layer-<slug> resource into
 * each corpus head). Statistics (resource_count) are read from each layer's
 * existing head at build time; layers without a head (e.g. the basemap) carry
 * none.
 *
 * Output: data/layer-v2/ (tiles_*.parquet + concept_catalog + graph.json).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { LAYERS, readBundleTag } from './lib/layers-data.mjs';
import { initBackend, buildLayerArtifacts, writeLayerPrebuild } from './lib/layer-emit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// --skeleton: the SKELETON catalogue shipped in core/base builds - every Layer
// resource's metadata + install URLs, but NO resource_count (no built heads to
// read). An installed layer's own fuller Layer resource (same ResourceID)
// overrides+supplements this via the store's cross-layer tile merge.
const SKELETON = process.argv.slice(2).includes('--skeleton');

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }

/** Best-effort resource count from a layer's head spine table (via python3
 * sqlite3 - the sqlite3 CLI isn't always present). '' if unavailable. */
function countResources(head) {
  if (!head) return '';
  const db = resolve(root, `data/${head}/head.sqlite`);
  if (!existsSync(db)) return '';
  try {
    const py = `import sqlite3\nc=sqlite3.connect(r"${db}")\nt=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'spine_%'")]\nprint(c.execute(f"SELECT COUNT(*) FROM {t[0]}").fetchone()[0] if t else "")`;
    return execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

const t0 = performance.now();
const usingNapi = await initBackend(root);
console.log(`[build-layer] ${usingNapi ? 'Using NAPI backend' : 'NAPI not available, falling back to WASM'}`);

const bundleTag = readBundleTag(root);
// Skeleton builds read no heads (there are none) → empty counts; the installed
// layer supplies the real resource_count when it overrides the skeleton.
const { graphId, graph, collections, enriched, businessCsv } = buildLayerArtifacts({
  root, layers: LAYERS, countResources: SKELETON ? () => '' : countResources, bundleTag, usingNapi,
});
console.log(`[build-layer] graph_id: ${graphId} (${graph.nodes.length} nodes)`);
console.log(`[build-layer] mode: ${SKELETON ? 'SKELETON (no counts)' : 'full'}; greasan-data URLs: ${bundleTag ? `tag ${bundleTag}` : 'none (bundle-pin.json absent)'}`);
writeFileSync(resolve(root, 'data/layer-business.csv'), businessCsv);
console.log(`[build-layer] business CSV: ${businessCsv.split('\n').length - 1} rows, ${LAYERS.length} layers`);
console.log(`[build-layer] ${enriched.length} Layer resources built`);

const prebuildDir = resolve(root, 'data/prebuild-layer');
execSync(`rm -rf "${prebuildDir}"`);
writeLayerPrebuild(prebuildDir, { graphId, graph, enriched, collections }, { merge: false });

// regen-parquet-v2 (the v2-duck emitter; the sqlite head engine + its v2-emit
// feature were removed in the DuckDB+Parquet cutover). Writes tiles_*.parquet +
// concept_catalog + graph.json to data/layer-v2. Mirrors build-bunamo-layer.mjs.
console.log('[build-layer] running regen-parquet-v2...');
execFileSync('cargo', [
  'run', '--release', '--example', 'regen-parquet-v2',
  '--manifest-path', resolve(root, 'app/src-tauri', 'Cargo.toml'),
  '--', 'data/prebuild-layer', 'data/layer-v2',
], { stdio: 'inherit' });

console.log(`[build-layer] Done (${elapsed(t0)}). Head at data/layer-v2/ (graph ${graphId}).`);
