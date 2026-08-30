/**
 * build-external-example-layer.mjs
 *
 * Builds the External Example v2 layer/head from the rich business CSV that
 * src/goidelic/examples.py emits (data/processed/example_layer_data.csv):
 * one example resource per sentence, carrying sentence / sentence_en /
 * provenance{source, source_id, highlights, collection, citation} and an
 * `illustrates` nodegroup (headword_entry -> goi lexical_entry UUID, surface,
 * span) - the mirror of place-v2's name_elements.
 *
 * This REPLACES the v1 core-goidelic external_example graph. Unlike
 * build-place-layer, there is no matching here - examples.py already resolved
 * illustrations; we only convert the goi ResourceID in `headword_entry` to the
 * cross-graph resource UUID and emit the head.
 *
 * Output: data/external_example-v2/ (head.sqlite + chunks/ + graph.json + pagefind zips).
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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const namespace = 'https://flaxandteal.org/ontology/goidelic#';
const ALIZARIN_NS = '1a79f1c8-9505-4bea-a18e-28a053f725ca';

// One layer per corpus - kept separate so the two licences (Tatoeba CC BY 2.0 /
// Gaois CC BY 4.0) live in distinct heads that can be bundled/toggled
// independently. Split is a pure filter over the already-matched
// example_layer_data.csv (ResourceID prefix ex-<source>-), so it needs no
// re-run of the corpus match.
const SOURCE = (process.argv[2] || '').toLowerCase();
const SOURCES = {
  tatoeba: { name: 'Tatoeba Example', tag: 'TA', license: 'CC-BY-2.0 (Tatoeba)' },
  gaois: { name: 'Gaois Example', tag: 'GA', license: 'CC-BY-4.0 (Gaois - Fiontar & Scoil na Gaeilge, DCU; legislation © Government of Ireland)' },
  udt: { name: 'UD Irish Example', tag: 'UD', license: 'CC BY-SA 4.0 (Universal Dependencies, UD_Irish-IDT)' },
};
if (!SOURCES[SOURCE]) {
  console.error('[build-example] Usage: node scripts/build-external-example-layer.mjs <tatoeba|gaois|udt>');
  process.exit(1);
}
const SRC = SOURCES[SOURCE];
const EXAMPLE_TAG = SRC.tag;
// Shared lexical_entry graph - headword_entry must resolve to the SAME goi
// resource UUIDs the wiktionary/tearma/bunamo/macbain heads carry.
const LEX_GRAPH_ID = '449c8695-253e-521b-8994-27701ce22305';

function uuidv5(name, ns) {
  const nsb = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const b = Buffer.from(createHash('sha1').update(Buffer.concat([nsb, Buffer.from(name, 'utf8')])).digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // v5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const LEX_RESOURCE_NS = uuidv5(`resource/${LEX_GRAPH_ID}`, ALIZARIN_NS);
const goiUuid = (rid) => uuidv5(rid, LEX_RESOURCE_NS);
function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }
function stripDiacritics(text) { return text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC'); }

function csvEscape(value) {
  if (value == null || value === '') return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function parseCsvLine(line) {
  const fields = []; let field = ''; let inQuote = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (inQuote) {
      if (ch === '"' && line[j + 1] === '"') { field += '"'; j++; }
      else if (ch === '"') inQuote = false;
      else field += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ',') { fields.push(field); field = ''; }
    else field += ch;
  }
  fields.push(field);
  return fields;
}

const t0 = performance.now();
function requireFile(p) {
  if (!existsSync(p)) {
    console.error(`[build-example] Missing input: ${p}\n[build-example] Run the examples pipeline (src/goidelic/examples.py) first.`);
    process.exit(1);
  }
  return p;
}

// ============================================================================
// STAGE A: Backend
// ============================================================================
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  setNapiModule(require('@alizarin/napi'));
  usingNapi = true;
  console.log('[build-example] Using NAPI backend');
} catch (e) {
  console.log('[build-example] NAPI not available, falling back to WASM');
  await initWasm();
}

// ============================================================================
// STAGE B: Build graph from model CSVs
// ============================================================================
const modelDir = resolve(root, 'models/external_example');
// Override the graph name per source so each corpus gets its own graph_id
// (buildGraphFromModelCsvs derives the id from the name/class).
const graphCsv = readFileSync(resolve(modelDir, 'graph.csv'), 'utf8').replace(/^External Example,/m, `${SRC.name},`);
const nodesCsv = readFileSync(resolve(modelDir, 'nodes.csv'), 'utf8');
const collectionsCsv = readFileSync(resolve(modelDir, 'collections.csv'), 'utf8');

console.log('[build-example] Building graph from model CSVs...');
const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
const graphId = graph.graphid;
const EXAMPLE_RESOURCE_NS = uuidv5(`resource/${graphId}`, ALIZARIN_NS);
const exampleUuid = (rid) => uuidv5(rid, EXAMPLE_RESOURCE_NS);
const LAYER_NAMESPACE = uuidv5('layer/external_example', ALIZARIN_NS);
console.log(`[build-example] EXAMPLE graph_id: ${graphId}  (${graph.nodes.length} nodes, ${collections.length} collections)`);

const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
typedGraph.setDescriptorTemplate('name', '<Sentence>');
typedGraph.setDescriptorTemplate('description', '<English Translation>');

// ============================================================================
// STAGE C: Read examples.py's business CSV, convert headword_entry -> UUID
// ============================================================================
const layerCsvPath = requireFile(resolve(root, 'data/processed/example_layer_data.csv'));
const inLines = readFileSync(layerCsvPath, 'utf8').split('\n').filter((l) => l.length);
const header = parseCsvLine(inLines[0]);
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const HEADWORD_COL = col['headword_entry'];

// Rebuild the CSV verbatim except headword_entry (goi ResourceID -> goi UUID).
const outRows = [inLines[0]];
const pagefindMeta = []; // {rid, sentence, sentence_en}
let rowCount = 0, linkCount = 0;
const seenExample = new Set();
const RID_PREFIX = `ex-${SOURCE}-`;
for (let i = 1; i < inLines.length; i++) {
  const f = parseCsvLine(inLines[i]);
  const rid = f[col['ResourceID']];
  if (!rid.startsWith(RID_PREFIX)) continue; // this layer holds one corpus only
  const goiRid = f[HEADWORD_COL];
  if (goiRid) { f[HEADWORD_COL] = goiUuid(goiRid); linkCount++; }
  outRows.push(f.map(csvEscape).join(','));
  rowCount++;
  const sentence = f[col['sentence']];
  if (rid && sentence && !seenExample.has(rid)) {
    seenExample.add(rid);
    pagefindMeta.push({ rid, sentence, sentence_en: f[col['sentence_en']] || '' });
  }
}
const csvContent = outRows.join('\n') + '\n';
console.log(`[build-example] ${seenExample.size} example resources, ${rowCount} rows, ${linkCount} illustrates links`);

// ============================================================================
// STAGE D: Build resources + prebuild + v2 head
// ============================================================================
const tBd = performance.now();
const result = buildResourcesFromBusinessCsv(csvContent, graph, collections, 'en', false, LAYER_NAMESPACE);
const resources = result?.business_data?.resources || [];
console.log(`[build-example] Built ${resources.length} resources (${elapsed(tBd)})`);

// Migrate concept -> reference (same as place/logainm/bunamo/macbain)
for (const node of graph.nodes) {
  if (node.datatype === 'concept-list') {
    node.datatype = 'reference';
    node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection };
  } else if (node.datatype === 'concept') {
    node.datatype = 'reference';
    node.config = { ...node.config, controlledList: node.config?.rdmCollection };
  }
}

const registry = createResourceRegistry();
registry.mergeFromResourcesJson(JSON.stringify(resources), true, true);

if (usingNapi) {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  const rdmCache = new napi.NapiRdmCache();
  for (const collection of collections) {
    const cid = collection.collectionid || collection.id;
    if (!cid) continue;
    const allConcepts = collection.__allConcepts || {};
    const concepts = Object.values(allConcepts).map((c) => ({
      id: c.id, prefLabels: c.prefLabels || {}, broader: c.broader || [],
      narrower: (c.children || []).map((ch) => ch.id || ch),
    }));
    rdmCache.addCollectionFromJson(cid, JSON.stringify(concepts));
  }
}

const cacheResult = registry.populateCachesFromJson(JSON.stringify(resources), typedGraph, true, false, true);
const enrichedResources = cacheResult.resources || resources;
console.log(`[build-example] Descriptors computed for ${enrichedResources.length} resources`);

// --- Write prebuild directory ---
const prebuildDir = resolve(root, `data/prebuild-example-${SOURCE}`);
execSync(`rm -rf "${prebuildDir}"`);
mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });

writeFileSync(resolve(prebuildDir, `graphs/resource_models/${graphId}.json`), JSON.stringify(graph));
writeFileSync(resolve(prebuildDir, `business_data/${graphId}.json`), JSON.stringify({ business_data: { resources: enrichedResources } }));
for (const collection of collections) {
  const cid = collection.collectionid || collection.id;
  if (!cid) continue;
  writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.json`), JSON.stringify(collection));
  try {
    const xml = collectionsToSkosXml([collection], namespace);
    writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.xml`), xml);
  } catch (e) { console.warn(`[build-example] SKOS XML failed for ${cid}: ${e.message}`); }
}
writeFileSync(resolve(prebuildDir, 'manifest.json'), JSON.stringify({
  base_uri: namespace, source: SOURCE, source_tag: EXAMPLE_TAG,
  built: new Date().toISOString(), license: SRC.license,
}));
console.log(`[build-example] Prebuild written to ${prebuildDir}`);

// --- Run regen-layer-v2 -> data/external_example-v2 ---
const outDir = resolve(root, `data/example-${SOURCE}-v2`);
console.log('[build-example] Running regen-layer-v2 (cargo, v2-emit)...');
const srcTauri = resolve(root, 'app/src-tauri');
execFileSync('cargo', [
  'run', '--release', '--example', 'regen-layer-v2', '--features', 'v2-emit',
  '--manifest-path', resolve(srcTauri, 'Cargo.toml'),
  '--', `data/prebuild-example-${SOURCE}`, `data/example-${SOURCE}-v2`, graphId,
], { stdio: 'inherit' });

// ============================================================================
// STAGE E: Pagefind (ga + sampla carry the sentence; en carries the translation)
// ============================================================================
console.log('[build-example] Building Pagefind indices...');
const tPf = performance.now();
const { index: gaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
const { index: enIndex } = await pagefind.createIndex({ forceLanguage: 'en' });
const { index: samplaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
if (!gaIndex || !enIndex || !samplaIndex) { console.error('[build-example] Failed to create pagefind indices'); process.exit(1); }
let samplaCount = 0;
for (const m of pagefindMeta) {
  const uuid = exampleUuid(m.rid);
  const bag = new Set();
  for (const s of [m.sentence, m.sentence_en]) { if (!s) continue; bag.add(s); bag.add(stripDiacritics(s)); }
  const record = {
    url: uuid,
    content: [...bag].join(' '),
    meta: { title: m.sentence, sentence_en: m.sentence_en, dialect: 'GA', kind: 'example' },
    filters: { dialect: ['GA'], kind: ['example'] },
  };
  await samplaIndex.addCustomRecord({ ...record, language: 'ga' });
  samplaCount++;
}
await gaIndex.writeFiles({ outputPath: resolve(outDir, 'pagefind-ga') });
await enIndex.writeFiles({ outputPath: resolve(outDir, 'pagefind-en') });
await samplaIndex.writeFiles({ outputPath: resolve(outDir, 'pagefind-sampla') });
for (const dir of ['pagefind-ga', 'pagefind-en', 'pagefind-sampla']) {
  const src = resolve(outDir, dir);
  const dest = resolve(outDir, `${dir}.zip`);
  if (existsSync(src)) execSync(`cd "${src}" && rm -f "${dest}" && zip -0 -q -r "${dest}" .`);
}
await pagefind.close();
console.log(`[build-example] Pagefind: sampla=${samplaCount} (ga/en base parity) (${elapsed(tPf)})`);

console.log(`[build-example] Done (${elapsed(t0)})`);
console.log(`[build-example] EXAMPLE graph_id: ${graphId}`);
console.log(`[build-example] Head: ${outDir}`);
