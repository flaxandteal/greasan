/**
 * Build a Logainm placenames layer.
 *
 * Reads the raw Linked-Logainm name pull (data/raw/logainm-names.jsonl, produced
 * by scripts/pull-logainm-names.mjs) and builds a v2 head where each Irish
 * placename is a resource whose constituent ELEMENTS (cill, baile, dún, …) are
 * linked to the goi dictionary entries via the `cognate_entry_id` node - the
 * same node the app's reverse-cognate `cited_by` machinery walks. Opening
 * `goi-cill-noun` then yields every placename containing `cill` (Cill Airne, …).
 *
 * Each place is keyed by its Logainm place ID (`lg-<N>-proper-noun`), NOT by its
 * name - hundreds of distinct places share a name and must not merge.
 *
 * Usage: node scripts/build-logainm-layer.mjs
 * Output: data/prebuild-logainm/ (prebuild) and data/logainm-v2/ (v2 head via
 *         the regen-layer-v2 cargo example) + pagefind indices.
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

// RFC 4122 v5 (SHA-1) - byte-identical to Python uuid.uuid5 / the Rust uuid5 the
// pipeline uses. So a place's cognate_entry_id UUIDs equal the goi resource UUIDs
// (the cross-layer link that composes on the shared lexical_entry graph).
function uuidv5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const b = Buffer.from(createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const namespace = 'https://flaxandteal.org/ontology/goidelic#';
const ALIZARIN_NS = '1a79f1c8-9505-4bea-a18e-28a053f725ca';
// uuid5(ALIZARIN_NS, "layer/logainm") - layer-internal tile-id namespace.
const LAYER_NAMESPACE = uuidv5('layer/logainm', ALIZARIN_NS);
const LOGAINM_TAG = 'LG';

// Shared lexical_entry graph - MUST match macbain/wiktionary/core so cross-layer
// cognate_entry_id links resolve to the same goi resource UUIDs.
const GRAPH_ID = '449c8695-253e-521b-8994-27701ce22305';
const RESOURCE_NS = uuidv5(`resource/${GRAPH_ID}`, ALIZARIN_NS);

/** ResourceID -> alizarin resource UUID. uuid5(uuid5(ALIZARIN_NS,"resource/{graphId}"), resourceId). */
function resourceIdToUuid(resourceId) {
  return uuidv5(resourceId, RESOURCE_NS);
}

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }

function stripDiacritics(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

// Identity normalization for goi matching: fold acute/grave to a macron (length
// preserved), matching docs/goidelic-slug-identity.md - so element matches align
// with the goi slug identity (dún = dūn).
const _MACRON = { 'à': 'ā', 'á': 'ā', 'è': 'ē', 'é': 'ē', 'ì': 'ī', 'í': 'ī', 'ò': 'ō', 'ó': 'ō', 'ù': 'ū', 'ú': 'ū' };
function normalizeHead(text) {
  const s = text.normalize('NFC').toLowerCase();
  return Array.from(s, (ch) => _MACRON[ch] || ch).join('');
}

function csvEscape(value) {
  if (value == null || value === '') return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuote = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (inQuote) {
      if (ch === '"' && line[j + 1] === '"') { field += '"'; j++; }
      else if (ch === '"') inQuote = false;
      else field += ch;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      fields.push(field); field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

// ============================================================================
// Irish placename -> element adapter
// ============================================================================

// Function words that are not lexical elements - skip so every placename doesn't
// link to "an"/"na". (Real elements like mór/beag/ard are intentionally kept.)
const STOPWORDS = new Set([
  'an', 'na', 'a', 'agus', 'ó', 'de', 'do', 'in', 'ar', 'le', 'don', 'den',
  'os', 'um', 'go', 'sa', 'san', 'ina', 'faoi', 'idir', 'thar', 'roimh',
  'chuig', 'as', 'is', 'na', 'ó', 'nó', 'ná', 'agus',
]);

/** Reverse initial mutation (lenition / eclipsis / t-,h- prefixes) on one word. */
function stripMutation(word) {
  let w = word;
  // t-prefix (an t-uisce), t before s (an tSráid), h-prefix (na hÉireann)
  if (/^t-/i.test(w)) w = w.slice(2);
  else if (/^ts[^h]/i.test(w)) w = w.slice(1);
  else if (/^h[aeiouáéíóúàèìòù]/i.test(w)) w = w.slice(1);
  // eclipsis: bhf->f, then mb->b gc->c nd->d ng->g bp->p dt->t (drop first char)
  if (/^bhf/i.test(w)) w = w.slice(2);
  else if (/^(mb|gc|nd|ng|bp|dt)/i.test(w)) w = w.slice(1);
  // lenition: C + h + (vowel|l|r|n) -> C + rest
  else if (/^[bcdfgmpst]h[aeiouáéíóúàèìòùlrn]/i.test(w)) w = w[0] + w.slice(2);
  return w;
}

/** Given an Irish placename, return the set of matched goi ResourceIDs. */
function matchElements(name, formsIndex, elementResolve) {
  const matched = new Map(); // goi ResourceID -> element surface form (for cognate_headword)
  const words = name
    .replace(/[’']/g, "'")
    .split(/[\s\-]+/)
    .map(w => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter(Boolean);
  for (const raw of words) {
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (lower.length < 2) continue;
    // Match against KNOWN Logainm element forms only (not the open dictionary),
    // mutation-stripped first. This is precision-first: a word links only if it
    // is a real toponymic element, and then to the POS-resolved goi headword -
    // no more picking [0] among homographs. Incidental dictionary hits (a rare
    // word that happens to be a headword) are correctly NOT treated as elements.
    for (const cand of [stripMutation(lower), lower]) {
      const elId = formsIndex.get(normalizeHead(cand));
      if (elId == null) continue;
      const resolved = elementResolve.get(elId);
      if (resolved && !matched.has(resolved.rid)) matched.set(resolved.rid, cand);
      break;
    }
  }
  return matched;
}

// ============================================================================
// STAGE A: Load raw pull, aggregate per place
// ============================================================================

const t0 = performance.now();

const rawPath = resolve(root, 'data/raw/logainm-names.jsonl');
if (!existsSync(rawPath)) {
  console.error(`[build-logainm] Raw pull not found: ${rawPath}`);
  console.error('[build-logainm] Run: node scripts/pull-logainm-names.mjs');
  process.exit(1);
}

console.log('[build-logainm] Loading raw pull...');
const places = new Map(); // placeId -> { ga: [], en: [] }
{
  const lines = readFileSync(rawPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.place == null) continue; // drop category-label leakage (id 0 / null)
    if (!places.has(rec.place)) places.set(rec.place, { ga: [], en: [] });
    const p = places.get(rec.place);
    if (rec.lang === 'ga' && rec.name) p.ga.push(rec.name);
    else if (rec.lang === 'en' && rec.name) p.en.push(rec.name);
  }
}
console.log(`[build-logainm] ${places.size} distinct places loaded`);

// ============================================================================
// STAGE B: goi lookup + element matching + CSV
// ============================================================================

console.log('[build-logainm] Building goi lookup...');
const gaLookup = new Map();       // normalised headword -> goi ResourceID[]
const gaFormsLookup = new Map();  // normalised written_rep -> goi ResourceID
const gdFallback = new Map();     // normalised headword -> gd- ResourceID (MacBain, Scottish-only)

// Union the goi-emitting layers so a toponymic element absent from Wiktionary can
// still resolve through Téarma or BuNaMo (all emit the SAME goi-<head>-<pos>
// slug, so they compose to one resource). MacBain's UNIQUE entries are gd-<head>-
// etym (Scottish-only) - kept as a last-resort fallback (user's "or macbain, if
// not"). Recovers ~11 of the 29 Wiktionary-missing elements.
function loadLexicalCsv(relPath) {
  const path = resolve(root, relPath);
  if (!existsSync(path)) { console.warn(`[build-logainm]   skip (missing): ${relPath}`); return; }
  const lines = readFileSync(path, 'utf8').split('\n');
  const header = lines[0].split(',');
  const ridIdx = header.indexOf('ResourceID');
  const hwIdx = header.indexOf('headword');
  const wrIdx = header.indexOf('written_rep');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = parseCsvLine(lines[i]);
    const rid = fields[ridIdx] || '';
    const hw = fields[hwIdx] || '';
    const wr = wrIdx >= 0 ? (fields[wrIdx] || '') : '';
    if (rid.startsWith('goi-')) {
      if (hw) {
        const key = normalizeHead(hw);
        if (!gaLookup.has(key)) gaLookup.set(key, []);
        const arr = gaLookup.get(key);
        if (!arr.includes(rid)) arr.push(rid);
      }
      if (wr && !hw) {
        const key = normalizeHead(wr);
        if (!gaFormsLookup.has(key)) gaFormsLookup.set(key, rid);
      }
    } else if (rid.startsWith('gd-') && hw) {
      // MacBain Scottish-only etymology entry - last-resort element target.
      const key = normalizeHead(hw);
      if (!gdFallback.has(key)) gdFallback.set(key, rid);
    }
  }
}
loadLexicalCsv('data/processed/lexical_entry_data.csv');      // Wiktionary (goi)
loadLexicalCsv('data/processed/tearma_lexical_entry_data.csv'); // Téarma (goi)
loadLexicalCsv('data/processed/bunamo_lexical_entry_data.csv'); // BuNaMo (goi)
loadLexicalCsv('data/processed/macbain_lexical_entry_data.csv'); // MacBain (gd fallback)
console.log(`[build-logainm] goi lookup: ${gaLookup.size} headwords, ${gaFormsLookup.size} forms, ${gdFallback.size} gd fallbacks`);

// ============================================================================
// Logainm element glossary - the authoritative toponymic element vocabulary
// (baile, cill, mór, …). Decompose placenames against THESE known forms, not the
// open dictionary, and resolve each element to the right goi headword+POS once.
// See scripts/pull-logainm-glossary.mjs → data/raw/logainm-glossary.json.
// ============================================================================
const glossaryPath = resolve(root, 'data/raw/logainm-glossary.json');
if (!existsSync(glossaryPath)) {
  console.error(`[build-logainm] Element glossary not found: ${glossaryPath}`);
  console.error('[build-logainm] Run: node scripts/pull-logainm-glossary.mjs');
  process.exit(1);
}
const glossary = JSON.parse(readFileSync(glossaryPath, 'utf8'));

// Qualifier ADJECTIVES used in placenames (colour / size / quality). Everything
// else defaults to the NOUN sense - the toponymic default (a height, a church).
// Logainm carries no POS, so this small curated set (keys normalizeHead-folded)
// is the disambiguator - but ONLY consulted when the dictionary actually has both
// a noun and an adjective for the spelling; unambiguous elements auto-resolve.
const ELEMENT_ADJ = new Set([
  'mór', 'beag', 'fada', 'gearr', 'leathan', 'dubh', 'bán', 'rua', 'dearg',
  'buí', 'glas', 'gorm', 'liath', 'donn', 'fionn', 'riabhach', 'odhar', 'geal',
  'sean', 'nua', 'garbh', 'mín', 'maol', 'breac', 'cam',
].map(normalizeHead));

/** POS suffix of a goi ResourceID: goi-<head>-<pos> → <pos>. */
function goiPos(rid) { return rid.split('-').slice(2).join('-'); }

// element.id -> { rid (POS-resolved goi ResourceID), headword }.
const elementResolve = new Map();
let elResolved = 0, elAmbiguous = 0, elUnmatched = 0;
for (const el of glossary) {
  const cands = gaLookup.get(normalizeHead(el.headword)) || [];
  let rid = null;
  if (cands.length === 1) {
    rid = cands[0];
  } else if (cands.length > 1) {
    elAmbiguous++;
    const want = ELEMENT_ADJ.has(normalizeHead(el.headword)) ? 'adjective' : 'noun';
    rid = cands.find(r => goiPos(r) === want) || cands.find(r => goiPos(r) === 'noun') || cands[0];
  }
  // Last resort: a MacBain Scottish-only (gd-) entry for the element's spelling.
  if (!rid) rid = gdFallback.get(normalizeHead(el.headword)) || null;
  if (rid) { elementResolve.set(el.id, { rid, headword: el.headword }); elResolved++; }
  else { elUnmatched++; }
}
console.log(`[build-logainm] elements: ${elResolved}/${glossary.length} resolved to goi (${elAmbiguous} POS-ambiguous), ${elUnmatched} with no dictionary entry`);

// normalizeHead(form) -> element.id, over every element's forms + headword.
const formsIndex = new Map();
for (const el of glossary) {
  for (const form of [el.headword, ...el.forms]) {
    const key = normalizeHead(form);
    if (key && !formsIndex.has(key)) formsIndex.set(key, el.id);
  }
}

const CSV_COLUMNS = [
  'ResourceID', 'headword', 'part_of_speech', 'dialect',
  'gloss', 'source_label',
  'cognate_headword', 'cognate_language', 'cognate_entry_id',
  // related_entries deliberately omitted (as in macbain): a resource-instance-list
  // to goi resources makes ros-madair page those referenced resources into THIS
  // layer with no tile data -> 404s. cited_by reverses cognate_entry_id alone.
];

const rowsByRid = [];
let placesWithGa = 0;
let matchedCount = 0;         // places with >=1 element link
let totalElementLinks = 0;
const elementFreq = new Map(); // goi ResourceID -> #places linking it

const sortedPlaceIds = [...places.keys()].sort((a, b) => a - b);
for (const pid of sortedPlaceIds) {
  const p = places.get(pid);
  if (p.ga.length === 0) continue; // MVP: only places with an Irish name
  placesWithGa++;
  const headword = p.ga[0];
  const gloss = p.en[0] || '';
  const rid = `lg-${pid}-proper-noun`;

  const matched = matchElements(headword, formsIndex, elementResolve);
  if (matched.size > 0) {
    matchedCount++;
    totalElementLinks += matched.size;
  }

  const elements = [...matched.entries()]; // [goiRid, surface][]
  const maxRows = Math.max(1, elements.length);
  const rows = [];
  for (let i = 0; i < maxRows; i++) {
    const row = { ResourceID: rid };
    if (i === 0) {
      row.headword = headword;
      row.part_of_speech = 'proper noun';
      row.dialect = 'Irish';
      row.gloss = gloss;
      row.source_label = LOGAINM_TAG;
    }
    if (i < elements.length) {
      const [goiRid, surface] = elements[i];
      row.cognate_headword = surface;
      row.cognate_language = 'Irish';
      row.cognate_entry_id = resourceIdToUuid(goiRid);
      elementFreq.set(goiRid, (elementFreq.get(goiRid) || 0) + 1);
    }
    rows.push(row);
  }
  rowsByRid.push(rows);
}

const csvRows = [CSV_COLUMNS.join(',')];
for (const rows of rowsByRid) {
  for (const row of rows) {
    csvRows.push(CSV_COLUMNS.map(c => csvEscape(row[c] || '')).join(','));
  }
}
const csvContent = csvRows.join('\n') + '\n';
const csvOutPath = resolve(root, 'data/processed/logainm_lexical_entry_data.csv');
mkdirSync(resolve(root, 'data/processed'), { recursive: true });
writeFileSync(csvOutPath, csvContent);

console.log(`[build-logainm] Places with Irish name: ${placesWithGa}`);
console.log(`[build-logainm] Places with >=1 element link: ${matchedCount} (${(100 * matchedCount / placesWithGa).toFixed(1)}%)`);
console.log(`[build-logainm] Total element links: ${totalElementLinks}`);
console.log(`[build-logainm] CSV: ${csvRows.length - 1} data rows -> ${csvOutPath}`);
// Top elements by placename count
const topEls = [...elementFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('[build-logainm] Top elements:', topEls.map(([r, n]) => `${r}=${n}`).join(', '));

// ============================================================================
// STAGE C: build graph + prebuild + v2 head + pagefind
// ============================================================================

// NAPI or WASM backend
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  setNapiModule(napi);
  usingNapi = true;
  console.log('[build-logainm] Using NAPI backend');
} catch (e) {
  console.log('[build-logainm] NAPI not available, falling back to WASM');
  await initWasm();
}

const modelDir = resolve(root, 'models/lexical_entry');
const graphCsv = readFileSync(resolve(modelDir, 'graph.csv'), 'utf8');
const nodesCsv = readFileSync(resolve(modelDir, 'nodes.csv'), 'utf8');
const collectionsCsvPath = resolve(modelDir, 'collections.csv');
const collectionsCsv = existsSync(collectionsCsvPath) ? readFileSync(collectionsCsvPath, 'utf8') : null;

console.log('[build-logainm] Building graph from model CSVs...');
const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
const graphId = graph.graphid;
console.log(`[build-logainm] Graph: ${graphId}, Collections: ${collections.length}`);

const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
typedGraph.setDescriptorTemplate('name', '<Headword>');
typedGraph.setDescriptorTemplate('description', '<Gloss>');

const tBd = performance.now();
const result = buildResourcesFromBusinessCsv(csvContent, graph, collections, 'en', false, LAYER_NAMESPACE);
const resources = result?.business_data?.resources || [];
console.log(`[build-logainm] Built ${resources.length} resources (${elapsed(tBd)})`);

// Migrate concept -> reference (same as macbain)
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
console.log(`[build-logainm] Descriptors computed for ${enrichedResources.length} resources`);

// --- Write prebuild directory ---
const prebuildDir = resolve(root, 'data/prebuild-logainm');
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
    console.warn(`[build-logainm] SKOS XML failed for ${cid}: ${e.message}`);
  }
}
writeFileSync(resolve(prebuildDir, 'manifest.json'), JSON.stringify({
  base_uri: namespace,
  source: 'linked-logainm',
  built: new Date().toISOString(),
  license: 'CC-BY-4.0',
}));
console.log(`[build-logainm] Prebuild written to ${prebuildDir}`);

// --- Run regen-layer-v2 (Rust emit) -> data/logainm-v2 ---
const outDir = resolve(root, 'data/logainm-v2');
console.log('[build-logainm] Running regen-layer-v2 (cargo, v2-emit)...');
const srcTauri = resolve(root, 'app/src-tauri');
execFileSync('cargo', [
  'run', '--release', '--example', 'regen-layer-v2', '--features', 'v2-emit',
  '--manifest-path', resolve(srcTauri, 'Cargo.toml'),
  '--', 'data/prebuild-logainm', 'data/logainm-v2', GRAPH_ID,
], { stdio: 'inherit' });

// --- Pagefind indices (ga headword + en gloss) alongside the head ---
console.log('[build-logainm] Building Pagefind indices...');
const tPf = performance.now();
const { index: gaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
const { index: enIndex } = await pagefind.createIndex({ forceLanguage: 'en' });
if (!gaIndex || !enIndex) {
  console.error('[build-logainm] Failed to create pagefind indices');
  process.exit(1);
}
let gaCount = 0, enCount = 0;
for (const resource of enrichedResources) {
  const ri = resource.resourceinstance;
  const uuid = ri?.resourceinstanceid;
  const headword = ri?.name;
  if (!headword || !uuid) continue;
  const gloss = ri?.descriptors?.description || '';
  const headwordNorm = stripDiacritics(headword);
  await gaIndex.addCustomRecord({
    url: uuid,
    content: headword === headwordNorm ? headword : `${headword} ${headwordNorm}`,
    language: 'ga',
    meta: { title: headword, gloss, dialect: 'GA' },
    filters: { dialect: ['GA'] },
  });
  gaCount++;
  if (gloss) {
    await enIndex.addCustomRecord({
      url: uuid,
      content: gloss,
      language: 'en',
      meta: { title: gloss, headword, dialect: 'GA' },
      filters: { dialect: ['GA'] },
    });
    enCount++;
  }
}
await gaIndex.writeFiles({ outputPath: resolve(outDir, 'pagefind-ga') });
await enIndex.writeFiles({ outputPath: resolve(outDir, 'pagefind-en') });
for (const dir of ['pagefind-ga', 'pagefind-en']) {
  const src = resolve(outDir, dir);
  const dest = resolve(outDir, `${dir}.zip`);
  if (existsSync(src)) execSync(`cd "${src}" && zip -0 -q -r "${dest}" .`);
}
console.log(`[build-logainm] Pagefind: ga=${gaCount}, en=${enCount} (${elapsed(tPf)})`);

console.log(`[build-logainm] Done (${elapsed(t0)})`);
console.log(`[build-logainm] Head: ${outDir}`);
