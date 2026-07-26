/**
 * Build a BuNaMo morphology layer.
 *
 * Data-gen is Python (scripts/build-bunamo-data.py, using the tested Gramadan v2
 * engine over the BuNaMo database) -> data/processed/bunamo_lexical_entry_data.csv,
 * a business-data CSV whose rows are `forms` tiles keyed by the shared goi slug
 * (goi-<normHead>-<pos>). This script is the head-BUILD half: it turns that CSV
 * into a v2 head at data/bunamo-v2/ via the same parseStaticGraph -> prebuild ->
 * regen-layer-v2 pipeline as build-logainm-layer.mjs.
 *
 * Each resource carries ONLY the `forms` nodegroup (no headword, no senses): the
 * slug is identical to the wiktionary/tearma goi entry for the same lemma+POS, so
 * the Layers engine composes them — senses from wiktionary, full paradigm here.
 * No pagefind stage: these resources enrich existing entries (already indexed by
 * the base layers) and carry no standalone headword to index.
 *
 * Data source: BuNaMo (github.com/michmech/BuNaMo) — LICENSE: ODbL-1.0
 * (share-alike DATABASE license, (c) Foras na Gaeilge).
 *
 * Usage: node scripts/build-bunamo-layer.mjs [--skip-data]
 * Output: data/processed/bunamo_lexical_entry_data.csv, data/prebuild-bunamo/,
 *         data/bunamo-v2/ (head.sqlite + chunks/ + graph.json).
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
import * as pagefind from '../app/node_modules/pagefind/lib/index.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const namespace = 'https://flaxandteal.org/ontology/goidelic#';
// Shared lexical_entry graph — MUST match wiktionary/tearma/macbain/logainm so
// goi slugs resolve to the same resource UUIDs and compose per-nodegroup.
const GRAPH_ID = '449c8695-253e-521b-8994-27701ce22305';
// uuid5(ALIZARIN_NS, "layer/bunamo") — layer-internal tile-id namespace.
const LAYER_NAMESPACE = '9c3b8f0e-2b8a-5c7e-9f4d-1a2b3c4d5e6f'; // placeholder-ns; only scopes tile ids
const BUNAMO_TAG = 'BN';

// Resource-UUID derivation — MUST match the Rust emitter (and macbain layer): the
// composed entry id is uuid5(uuid5(ALIZARIN_NS, "resource/{graphId}"), resourceId).
// A Pagefind hit's `url` is this uuid, so it resolves to the full composed entry.
const ALIZARIN_NS = '1a79f1c8-9505-4bea-a18e-28a053f725ca';
function uuidv5(name, ns) {
  const nsb = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const b = Buffer.from(createHash('sha1').update(Buffer.concat([nsb, Buffer.from(name, 'utf8')])).digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const RESOURCE_NS = uuidv5(`resource/${GRAPH_ID}`, ALIZARIN_NS);
const resourceIdToUuid = (rid) => uuidv5(rid, RESOURCE_NS);

// Accent-insensitive search: index each form's diacritic-stripped variant too.
function stripDiacritics(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }

// --- 0: (re)generate the business-data CSV via the Python Gramadan emitter ---
const csvOutPath = resolve(root, 'data/processed/bunamo_lexical_entry_data.csv');
if (!process.argv.includes('--skip-data')) {
  console.log('[build-bunamo] Running Python data emitter (Gramadan v2)...');
  const py = resolve(root, '.venv/bin/python');
  execFileSync(py, [resolve(root, 'scripts/build-bunamo-data.py')], { stdio: 'inherit' });
}
if (!existsSync(csvOutPath)) {
  console.error(`[build-bunamo] business-data CSV missing: ${csvOutPath}`);
  process.exit(1);
}
const csvContent = readFileSync(csvOutPath, 'utf8');

const t0 = performance.now();

// --- NAPI or WASM backend ---
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  setNapiModule(napi);
  usingNapi = true;
  console.log('[build-bunamo] Using NAPI backend');
} catch (e) {
  console.log('[build-bunamo] NAPI not available, falling back to WASM');
  await initWasm();
}

// --- Build lexical_entry model ---
const modelDir = resolve(root, 'models/lexical_entry');
const graphCsv = readFileSync(resolve(modelDir, 'graph.csv'), 'utf8');
const nodesCsv = readFileSync(resolve(modelDir, 'nodes.csv'), 'utf8');
const collectionsCsvPath = resolve(modelDir, 'collections.csv');
const collectionsCsv = existsSync(collectionsCsvPath) ? readFileSync(collectionsCsvPath, 'utf8') : null;

console.log('[build-bunamo] Building graph from model CSVs...');
const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
const graphId = graph.graphid;
console.log(`[build-bunamo] Graph: ${graphId}, Collections: ${collections.length}`);

const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
typedGraph.setDescriptorTemplate('name', '<Headword>');
typedGraph.setDescriptorTemplate('description', '<Gloss>');

const tBd = performance.now();
const result = buildResourcesFromBusinessCsv(csvContent, graph, collections, 'en', false, LAYER_NAMESPACE);
const resources = result?.business_data?.resources || [];
console.log(`[build-bunamo] Built ${resources.length} resources (${elapsed(tBd)})`);

// Migrate concept -> reference (same as logainm/macbain)
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

const cacheResult = registry.populateCachesFromJson(JSON.stringify(resources), typedGraph, true, false, true);
const enrichedResources = cacheResult.resources || resources;
console.log(`[build-bunamo] Descriptors computed for ${enrichedResources.length} resources`);

// --- Write prebuild directory ---
const prebuildDir = resolve(root, 'data/prebuild-bunamo');
execSync(`rm -rf "${prebuildDir}"`);
mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });

writeFileSync(resolve(prebuildDir, `graphs/resource_models/${graphId}.json`), JSON.stringify(graph));
writeFileSync(
  resolve(prebuildDir, `business_data/${graphId}.json`),
  JSON.stringify({ business_data: { resources: enrichedResources } })
);
for (const collection of collections) {
  const cid = collection.collectionid || collection.id;
  if (!cid) continue;
  writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.json`), JSON.stringify(collection));
  try {
    const xml = collectionsToSkosXml([collection], namespace);
    writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.xml`), xml);
  } catch (e) {
    console.warn(`[build-bunamo] SKOS XML failed for ${cid}: ${e.message}`);
  }
}
writeFileSync(resolve(prebuildDir, 'manifest.json'), JSON.stringify({
  base_uri: namespace,
  source: 'bunamo',
  source_tag: BUNAMO_TAG,
  built: new Date().toISOString(),
  license: 'ODbL-1.0',
}));
console.log(`[build-bunamo] Prebuild written to ${prebuildDir}`);

// --- Run regen-layer-v2 (Rust emit) -> data/bunamo-v2 ---
const outDir = resolve(root, 'data/bunamo-v2');
console.log('[build-bunamo] Running regen-layer-v2 (cargo, v2-emit)...');
const srcTauri = resolve(root, 'app/src-tauri');
execFileSync('cargo', [
  'run', '--release', '--example', 'regen-layer-v2', '--features', 'v2-emit',
  '--manifest-path', resolve(srcTauri, 'Cargo.toml'),
  '--', 'data/prebuild-bunamo', 'data/bunamo-v2', GRAPH_ID,
], { stdio: 'inherit' });

// --- Pagefind: one ga record per goi entry, keyed on INFLECTED forms ---------
// BuNaMo carries no headword/senses to index, but its paradigm means a search for
// an inflected surface form ("fir") should surface the lemma entry ("fear"). One
// record per resource: url = composed entry uuid, content = distinct forms (+
// diacritic-stripped) so the hit resolves to the full entry and ranks BELOW
// headword matches (the app ranks by meta.title = lemma, which a form-only hit
// never matches). Irish-only layer => a single 'GA' dialect for every record.
// pagefind-en / pagefind-sampla are emitted EMPTY (valid indices) so the app's
// per-language base resolution (pagefind-<lang>/) never 404s on the bunamo layer.
{
  const tPf = performance.now();
  console.log('\n[build-bunamo] === Pagefind forms index ===');

  const lemmaJsonPath = resolve(root, 'data/processed/bunamo_lemmas.json');
  const lemmas = existsSync(lemmaJsonPath) ? JSON.parse(readFileSync(lemmaJsonPath, 'utf8')) : {};

  // Group distinct written forms by ResourceID from the business CSV. Column 0 =
  // ResourceID, column 2 = written_rep (0-indexed: id, grammar_class, written_rep...).
  const lines = csvContent.split('\n');
  const header = lines[0].split(',');
  const idIdx = header.indexOf('ResourceID');
  const wrIdx = header.indexOf('written_rep');
  const formsByRid = new Map();
  const parseRow = (line) => {
    // Minimal CSV field split honouring double-quoted fields (forms have no
    // embedded commas, but gram_features does — we only read id + written_rep).
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = parseRow(lines[i]);
    const rid = cols[idIdx];
    const wr = (cols[wrIdx] || '').trim();
    if (!rid || !wr) continue;
    if (!formsByRid.has(rid)) formsByRid.set(rid, new Set());
    formsByRid.get(rid).add(wr);
  }

  const { index: gaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
  const { index: enIndex } = await pagefind.createIndex({ forceLanguage: 'en' });
  const { index: samplaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
  if (!gaIndex || !enIndex || !samplaIndex) {
    console.error('[build-bunamo] Failed to create pagefind indices');
    process.exit(1);
  }

  // BuNaMo is Irish-only: one dialect for the whole layer.
  const DIALECT_CODES = ['GA'];
  const DIALECT_DISPLAY = 'Irish';

  let gaCount = 0;
  for (const [rid, formSet] of formsByRid) {
    const forms = [...formSet];
    const lemma = lemmas[rid] || forms[0];
    // content = every distinct form plus its diacritic-stripped variant.
    const bag = new Set();
    for (const f of [lemma, ...forms]) {
      if (!f) continue;
      bag.add(f);
      bag.add(stripDiacritics(f));
    }
    await gaIndex.addCustomRecord({
      url: resourceIdToUuid(rid),
      content: [...bag].join(' '),
      language: 'ga',
      meta: { title: lemma, dialect: DIALECT_DISPLAY },
      filters: { dialect: DIALECT_CODES },
    });
    gaCount++;
  }
  console.log(`[build-bunamo] Pagefind records: ga=${gaCount} (en/sampla empty)`);

  await gaIndex.writeFiles({ outputPath: resolve(outDir, 'pagefind-ga') });
  await enIndex.writeFiles({ outputPath: resolve(outDir, 'pagefind-en') });
  await samplaIndex.writeFiles({ outputPath: resolve(outDir, 'pagefind-sampla') });

  for (const dir of ['pagefind-ga', 'pagefind-en', 'pagefind-sampla']) {
    const src = resolve(outDir, dir);
    const dest = resolve(outDir, `${dir}.zip`);
    if (existsSync(src)) {
      execSync(`cd "${src}" && rm -f "${dest}" && zip -0 -q -r "${dest}" .`);
      console.log(`[build-bunamo] Zipped ${dir}`);
    }
  }
  console.log(`[build-bunamo] Pagefind total: ${elapsed(tPf)}`);
  await pagefind.close();
}

console.log(`[build-bunamo] Done (${elapsed(t0)})`);
console.log(`[build-bunamo] Head: ${outDir}`);
