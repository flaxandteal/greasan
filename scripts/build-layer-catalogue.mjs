/**
 * build-layer-catalogue.mjs
 *
 * Builds the `layer-v2` head: the Layer catalogue - one Layer resource per data
 * layer in the stack, describing its licensing + attribution, types, formats,
 * links, description, build statistics, and Gréasán integration config. Shipped
 * by default as the source for finding + installing layers, independent of
 * whether each layer's data is loaded.
 *
 * Mirrors build-flag-layers.mjs (build graph → seed via repeated-rows business
 * CSV → regen-layer-v2 emit). Statistics (resource_count) are read from each
 * layer's existing head at build time; layers without a head (e.g. the basemap)
 * carry no count.
 *
 * Output: data/layer-v2/ (head.sqlite + chunks + graph.json).
 */
import { createRequire } from 'module';
import { makeRdmCache } from './lib/rdm-cache.mjs';
import {
  initWasm, buildGraphFromModelCsvs, buildResourcesFromBusinessCsv,
  createResourceRegistry, parseStaticGraph, setNapiModule, collectionsToSkosXml,
} from '../app/node_modules/alizarin/dist/alizarin.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { LAYERS, buildBusinessCsv, uuidv5, ALIZARIN_NS } from './lib/layers-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const namespace = 'https://flaxandteal.org/ontology/goidelic#';

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

// --- build → seed → emit (mirrors build-flag-layers.mjs) ---
const t0 = performance.now();
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  setNapiModule(require('@alizarin/napi'));
  usingNapi = true;
  console.log('[build-layer] Using NAPI backend');
} catch {
  console.log('[build-layer] NAPI not available, falling back to WASM');
  await initWasm();
}

const graphCsv = readFileSync(resolve(root, 'models/layer/graph.csv'), 'utf8');
const nodesCsv = readFileSync(resolve(root, 'models/layer/nodes.csv'), 'utf8');
const collectionsCsv = readFileSync(resolve(root, 'models/layer/collections.csv'), 'utf8');
const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
const graphId = graph.graphid;
console.log(`[build-layer] graph_id: ${graphId} (${graph.nodes.length} nodes)`);

const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
typedGraph.setDescriptorTemplate('name', '<Name>');

const businessCsv = buildBusinessCsv(LAYERS, countResources);
writeFileSync(resolve(root, 'data/layer-business.csv'), businessCsv);
console.log(`[build-layer] business CSV: ${businessCsv.split('\n').length - 1} rows, ${LAYERS.length} layers`);

const LAYER_NAMESPACE = uuidv5('layer/catalogue', ALIZARIN_NS);
const result = buildResourcesFromBusinessCsv(businessCsv, graph, collections, 'en', false, LAYER_NAMESPACE, makeRdmCache(collections, root, usingNapi));
const resources = result?.business_data?.resources || [];

for (const node of graph.nodes) {
  if (node.datatype === 'concept-list') { node.datatype = 'reference'; node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection }; }
  else if (node.datatype === 'concept') { node.datatype = 'reference'; node.config = { ...node.config, controlledList: node.config?.rdmCollection }; }
}

const registry = createResourceRegistry();
registry.mergeFromResourcesJson(JSON.stringify(resources), true, true);
const cacheResult = registry.populateCachesFromJson(JSON.stringify(resources), typedGraph, true, false, true);
const enriched = cacheResult.resources || resources;
console.log(`[build-layer] ${enriched.length} Layer resources built`);

const prebuildDir = resolve(root, 'data/prebuild-layer');
execSync(`rm -rf "${prebuildDir}"`);
mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });
writeFileSync(resolve(prebuildDir, `graphs/resource_models/${graphId}.json`), JSON.stringify(graph));
writeFileSync(resolve(prebuildDir, `business_data/${graphId}.json`), JSON.stringify({ business_data: { resources: enriched } }));
// Controlled lists → reference_data, so the reference (ex-concept) fields resolve.
for (const collection of collections) {
  const cid = collection.collectionid || collection.id;
  if (!cid) continue;
  writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.json`), JSON.stringify(collection));
  try {
    writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.xml`), collectionsToSkosXml([collection], namespace));
  } catch (e) { console.warn(`[build-layer] SKOS XML failed for ${cid}: ${e.message}`); }
}
writeFileSync(resolve(prebuildDir, 'manifest.json'), JSON.stringify({
  base_uri: namespace, source: 'layer', source_tag: 'LY',
  built: '1970-01-01T00:00:00Z', license: 'CC0 (app-generated catalogue)',
}));

console.log('[build-layer] running regen-layer-v2...');
execFileSync('cargo', [
  'run', '--release', '--example', 'regen-layer-v2', '--features', 'v2-emit',
  '--manifest-path', resolve(root, 'app/src-tauri', 'Cargo.toml'),
  '--', 'data/prebuild-layer', 'data/layer-v2', graphId,
], { stdio: 'inherit' });

console.log(`[build-layer] Done (${elapsed(t0)}). Head at data/layer-v2/ (graph ${graphId}).`);
