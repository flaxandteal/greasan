/**
 * Build a Téarma.ie layer as a prebuild archive.
 *
 * Usage: node scripts/build-tearma-layer.mjs [--csv <path>]
 *
 * Default CSV: data/processed/tearma_lexical_entry_data.csv
 *
 * Output: data/tearma-layer.tar.gz (prebuild archive consumable by Tauri build_layer)
 *
 * Process:
 *   1. alizarin: model CSVs + business CSV → graphs + resources
 *   2. populateCaches for descriptors
 *   3. ros-madair-build: prebuild → binary index
 *   4. Pagefind indices for headword + gloss search
 *   5. tar.gz the result
 */

import { createRequire } from 'module';
import {
  initWasm,
  buildGraphFromModelCsvs,
  buildResourcesFromBusinessCsv,
  collectionsToSkosXml,
  createResourceRegistry,
  parseStaticGraph,
  setNapiModule,
} from '../app/node_modules/alizarin/dist/alizarin.js';
import * as pagefind from './lib/pagefind-fork.mjs';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const namespace = 'https://flaxandteal.org/ontology/goidelic#';

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }

function stripDiacritics(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

// Parse --csv argument
let csvPath = resolve(root, 'data/processed/tearma_lexical_entry_data.csv');
const csvArgIdx = process.argv.indexOf('--csv');
if (csvArgIdx !== -1 && process.argv[csvArgIdx + 1]) {
  csvPath = resolve(process.argv[csvArgIdx + 1]);
}

if (!existsSync(csvPath)) {
  console.error(`[build-tearma] CSV not found: ${csvPath}`);
  console.error('[build-tearma] Run the TBX pipeline first:');
  console.error('  uv run python -m goidelic.run --config config.toml --tbx data/raw/25.10.01-tearma.ie-concepts.tbx --layer-code TÉ');
  process.exit(1);
}

// NAPI or WASM backend
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  setNapiModule(napi);
  usingNapi = true;
  console.log('[build-tearma] Using NAPI backend');
} catch (e) {
  console.log(`[build-tearma] NAPI not available, falling back to WASM`);
  await initWasm();
}

const t0 = performance.now();

// --- Build lexical_entry model only ---

const modelDir = resolve(root, 'models/lexical_entry');
const graphCsv = readFileSync(resolve(modelDir, 'graph.csv'), 'utf8');
const nodesCsv = readFileSync(resolve(modelDir, 'nodes.csv'), 'utf8');
const collectionsCsvPath = resolve(modelDir, 'collections.csv');
const collectionsCsv = existsSync(collectionsCsvPath)
  ? readFileSync(collectionsCsvPath, 'utf8')
  : null;

console.log('[build-tearma] Building graph from model CSVs...');
const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
const graphId = graph.graphid;
console.log(`[build-tearma] Graph: ${graphId}, Collections: ${collections.length}`);

// StaticGraph + descriptors
const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
typedGraph.setDescriptorTemplate('name', '<Headword>');
typedGraph.setDescriptorTemplate('description', '<Gloss>');
// `slug` carries the part_of_speech REFERENCE so Pagefind can resolve it to a POS
// label via the controlled-list collection vocab (CLM) - see build-wiktionary-layer.
typedGraph.setDescriptorTemplate('slug', '<Part of Speech>');

// Build resources
const tBd = performance.now();
const bdCsv = readFileSync(csvPath, 'utf8');
// Layer-specific UUID namespace so tile IDs don't collide with other layers
// (uuid5 of alizarin base namespace + "layer/tearma")
const layerNamespace = '14b35a4a-7420-5d80-89a3-ad00565dc430';
const result = buildResourcesFromBusinessCsv(bdCsv, graph, collections, 'en', false, layerNamespace);
const resources = result?.business_data?.resources || [];
console.log(`[build-tearma] Built ${resources.length} resources (${elapsed(tBd)})`);

// Migrate concept → reference
for (const node of graph.nodes) {
  if (node.datatype === 'concept-list') {
    node.datatype = 'reference';
    node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection };
  } else if (node.datatype === 'concept') {
    node.datatype = 'reference';
    node.config = { ...node.config, controlledList: node.config?.rdmCollection };
  }
}

// --- Populate caches ---

const registry = createResourceRegistry();
// JSON.stringify on all ~193k resources at once overflows V8's max string
// length (~512MB). mergeFromResourcesJson is additive, and tearma entries only
// cross-reference concepts (resolved via rdmCache), not each other, so merging
// in slices keeps each string well under the cap without breaking enrichment.
const MERGE_BATCH = 20000;
for (let i = 0; i < resources.length; i += MERGE_BATCH) {
  registry.mergeFromResourcesJson(
    JSON.stringify(resources.slice(i, i + MERGE_BATCH)), true, true,
  );
}

let rdmCache = null;
if (usingNapi) {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  rdmCache = new napi.NapiRdmCache();
  for (const collection of collections) {
    const cid = collection.collectionid || collection.id;
    if (!cid) continue;
    const allConcepts = collection.__allConcepts || {};
    const concepts = Object.values(allConcepts).map(c => ({
      id: c.id,
      prefLabels: c.prefLabels || {},
      broader: c.broader || [],
      narrower: (c.children || []).map(ch => ch.id || ch),
    }));
    rdmCache.addCollectionFromJson(cid, JSON.stringify(concepts));
  }
}

// Descriptor computation, BATCHED. A single populateCachesFromJson over all 193k
// resources OOMs on a loaded machine - the V8 JSON string, the NAPI parse and the
// output all live at once. enrich=false (the cross-ref __cache is unused by the
// tearma Pagefind and the tile-built head), so per-resource descriptors don't need
// the full set and chunks are independent. Peak memory becomes ~one chunk instead
// of the whole corpus; the POS slug descriptor still computes per resource.
const CHUNK = 25000;
const enrichedResources = [];
for (let i = 0; i < resources.length; i += CHUNK) {
  const chunk = resources.slice(i, i + CHUNK);
  const r = registry.populateCachesFromJson(JSON.stringify(chunk), typedGraph, false, false, true);
  enrichedResources.push(...(r.resources || chunk));
  console.log(`[build-tearma] Descriptors: ${Math.min(i + CHUNK, resources.length)}/${resources.length}`);
}
console.log(`[build-tearma] Descriptors computed for ${enrichedResources.length} resources`);

// --- Write prebuild directory ---

const prebuildDir = resolve(root, 'data/prebuild-tearma');
mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });

writeFileSync(
  resolve(prebuildDir, `graphs/resource_models/${graphId}.json`),
  JSON.stringify(graph)
);
// Stream the business_data file in batches: at 193k resources a single
// JSON.stringify of the whole array overflows V8's max string length (~512MB).
// Each resource is stringified in small groups and appended, so no single JS
// string is huge; the on-disk file is still one valid JSON document.
const bdPath = resolve(prebuildDir, `business_data/${graphId}.json`);
writeFileSync(bdPath, '{"business_data":{"resources":[');
const WRITE_BATCH = 5000;
for (let i = 0; i < enrichedResources.length; i += WRITE_BATCH) {
  const chunk = enrichedResources.slice(i, i + WRITE_BATCH).map((r) => JSON.stringify(r)).join(',');
  appendFileSync(bdPath, i > 0 ? ',' + chunk : chunk);
}
appendFileSync(bdPath, ']}}');

for (const collection of collections) {
  const cid = collection.collectionid || collection.id;
  if (cid) {
    writeFileSync(
      resolve(prebuildDir, `reference_data/collections/${cid}.json`),
      JSON.stringify(collection)
    );
    try {
      const xml = collectionsToSkosXml([collection], namespace);
      writeFileSync(
        resolve(prebuildDir, `reference_data/collections/${cid}.xml`),
        xml
      );
    } catch (e) {
      console.warn(`[build-tearma] SKOS XML failed for ${cid}: ${e.message}`);
    }
  }
}

// Write manifest
writeFileSync(
  resolve(prebuildDir, 'manifest.json'),
  JSON.stringify({
    base_uri: namespace,
    source: 'tearma.ie',
    built: new Date().toISOString(),
  })
);

console.log(`[build-tearma] Prebuild written to ${prebuildDir}`);

// --- Run ros-madair-build ---

const outputDir = resolve(root, 'data/tearma-index');
mkdirSync(outputDir, { recursive: true });

const buildBin = resolve(root, 'scripts/ros-madair-build');
if (!existsSync(buildBin)) {
  console.error('[build-tearma] ros-madair-build binary not found at', buildBin);
  process.exit(1);
}

const pageSize = parseInt(process.env.ROS_MADAIR_PAGE_SIZE || '200', 10);
console.log(`[build-tearma] Running ros-madair-build (page_size=${pageSize})...`);
try {
  execSync(
    `"${buildBin}" "${prebuildDir}" "${outputDir}" ${pageSize} "${namespace}"`,
    { stdio: 'inherit' }
  );
} catch (e) {
  console.error('[build-tearma] ros-madair-build failed:', e.message);
  process.exit(1);
}

// Wrap graph JSON for alizarin
const graphFile = resolve(outputDir, `graphs/${graphId}.json`);
if (existsSync(graphFile)) {
  const rawGraph = JSON.parse(readFileSync(graphFile, 'utf8'));
  if (!rawGraph.graph) {
    writeFileSync(graphFile, JSON.stringify({ graph: [rawGraph] }));
  }
}

// --- Pagefind indices ---

console.log('[build-tearma] Building Pagefind indices...');
const tPf = performance.now();

const DIALECT_LABEL_TO_CODE = {
  'Irish': 'GA', 'Irish (General)': 'GA',
  'Connacht Irish': 'GA.CON', 'Connemara Irish': 'GA.CON',
  'Ulster Irish': 'GA.ULS', 'Donegal Irish': 'GA.ULS',
  'Munster Irish': 'GA.MUN', 'Kerry Irish': 'GA.MUN', 'Waterford Irish': 'GA.MUN',
  'Scottish Gaelic': 'GD', 'Scottish Gaelic (General)': 'GD',
  'Highland Gaelic': 'GD.HLD', 'Hebridean Gaelic': 'GD.HEB', 'Argyll Gaelic': 'GD.ARG',
  'Manx': 'GV', 'Manx (General)': 'GV',
};

const dialectValueIndex = registry.getValueToResourcesIndex(
  typedGraph, 'dialect', true, rdmCache
);
const resourceDialectCodes = {};
for (const [label, resourceIds] of Object.entries(dialectValueIndex)) {
  const subLabels = label.split('|');
  const codes = subLabels.map(l => DIALECT_LABEL_TO_CODE[l.trim()] || l.trim());
  for (const rid of resourceIds) {
    if (!resourceDialectCodes[rid]) resourceDialectCodes[rid] = new Set();
    for (const code of codes) resourceDialectCodes[rid].add(code);
  }
}

function getDialectCodes(resource) {
  const uuid = resource.resourceinstance?.resourceinstanceid;
  const codes = resourceDialectCodes[uuid];
  return codes ? [...codes] : ['GA'];
}

// POS label per resource - part_of_speech REFERENCE (on descriptors.slug) resolved
// through the controlled-list collection vocab (CLM). See build-wiktionary-layer.
const conceptToLabel = {};
for (const c of collections) {
  for (const [id, con] of Object.entries(c.__allConcepts || {})) {
    const pl = con?.prefLabels || {};
    conceptToLabel[id] = pl.en?.value || pl[Object.keys(pl)[0]]?.value || '';
  }
}
const posOf = (ri) => conceptToLabel[ri?.descriptors?.slug] || '';

const { index: gaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
const { index: enIndex } = await pagefind.createIndex({ forceLanguage: 'en' });

if (!gaIndex || !enIndex) {
  console.error('[build-tearma] Failed to create pagefind indices');
  process.exit(1);
}

let gaCount = 0, enCount = 0;

for (const resource of enrichedResources) {
  const ri = resource.resourceinstance;
  const uuid = ri?.resourceinstanceid;
  const headword = ri?.name;
  if (!headword || !uuid) continue;

  const gloss = ri?.descriptors?.description || '';
  const pos = posOf(ri);
  const dialectCodes = getDialectCodes(resource);
  const dialectDisplay = dialectCodes.reduce((a, b) => a.length >= b.length ? a : b, '');

  const headwordNorm = stripDiacritics(headword);
  await gaIndex.addCustomRecord({
    url: uuid,
    content: headword === headwordNorm ? headword : `${headword} ${headwordNorm}`,
    language: 'ga',
    meta: { title: headword, gloss, dialect: dialectDisplay, pos },
    filters: { dialect: dialectCodes },
  });
  gaCount++;

  if (gloss) {
    await enIndex.addCustomRecord({
      url: uuid,
      content: gloss,
      language: 'en',
      meta: { title: gloss, headword, dialect: dialectDisplay, pos },
      filters: { dialect: dialectCodes },
    });
    enCount++;
  }
}

await gaIndex.writeFiles({ outputPath: resolve(outputDir, 'pagefind-ga') });
await enIndex.writeFiles({ outputPath: resolve(outputDir, 'pagefind-en') });

// Zip pagefind directories
for (const dir of ['pagefind-ga', 'pagefind-en']) {
  const src = resolve(outputDir, dir);
  const dest = resolve(outputDir, `${dir}.zip`);
  if (existsSync(src)) {
    execSync(`cd "${src}" && zip -0 -q -r "${dest}" .`);
  }
}

console.log(`[build-tearma] Pagefind: ga=${gaCount}, en=${enCount} (${elapsed(tPf)})`);

// --- Zip bulk data and remove extracted directories ---

for (const dir of ['tiles', 'pages']) {
  const src = resolve(outputDir, dir);
  const dest = resolve(outputDir, `${dir}.zip`);
  if (existsSync(src)) {
    // zip fails on empty directories; only zip if there are files
    try {
      execSync(`cd "${src}" && zip -0 -q -r "${dest}" .`);
      console.log(`[build-tearma] Zipped ${dir} → ${dir}.zip`);
    } catch {
      console.log(`[build-tearma] ${dir}/ empty or zip failed, skipping zip`);
    }
    execSync(`rm -rf "${src}"`);
  }
}
for (const dir of ['pagefind-ga', 'pagefind-en']) {
  const src = resolve(outputDir, dir);
  if (existsSync(src)) {
    execSync(`rm -rf "${src}"`);
  }
}

// --- Package as tar.gz ---

const tarFile = resolve(root, 'data/tearma-layer.tar.gz');
console.log(`[build-tearma] Packaging ${tarFile}...`);
execSync(`tar -czf "${tarFile}" -C "${outputDir}" .`);

console.log(`[build-tearma] Done (${elapsed(t0)})`);
console.log(`[build-tearma] Output: ${tarFile}`);
