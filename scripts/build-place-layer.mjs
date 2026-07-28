/**
 * Build the Logainm PLACE layer (ontologically-correct successor to the old
 * build-logainm-layer.mjs, which wrongly modelled placenames as lexical_entry
 * "words" linked by cognate_entry_id).
 *
 * Places are now their OWN class (models/place, schema.org/Place, its own
 * graph_id). Each place's Irish name is decomposed into constituent dictionary
 * elements (cill, baile, dún, …) by the SAME tokeniser/matcher as the old build
 * (matchElements/stripMutation/normalizeHead), but emitted on the `name_elements`
 * nodegroup: element_entry (resource-instance -> the goi lexical_entry UUID) +
 * element_surface (the token). Opening a goi entry and running cited_by(…,
 * 'element_entry') then yields every place whose name contains that element.
 *
 * Inputs (data/raw/, from scripts/pull-logainm-places.mjs):
 *   logainm-names.jsonl, logainm-places.jsonl, logainm-parents.jsonl,
 *   logainm-categories.json
 * goi lookup: data/processed/lexical_entry_data.csv (wiktionary+tearma heads) and
 *   data/processed/bunamo_lexical_entry_data.csv (inflected forms).
 *
 * Usage: node scripts/build-place-layer.mjs
 * Output: models/place/collections.csv (reconciled), data/prebuild-place/,
 *         data/place-v2/ (head.sqlite + chunks/ + graph.json + pagefind zips).
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
const ALIZARIN_NS = '1a79f1c8-9505-4bea-a18e-28a053f725ca';
const PLACE_TAG = 'LG';

// Shared lexical_entry graph — element_entry must resolve to the SAME goi resource
// UUIDs the wiktionary/macbain/tearma/bunamo heads carry, so the cross-graph link
// points at the real dictionary entry.
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
/** goi ResourceID -> the lexical_entry resource UUID (the cross-graph link target). */
const goiUuid = (rid) => uuidv5(rid, LEX_RESOURCE_NS);

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }
function stripDiacritics(text) { return text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC'); }

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

// ============================================================================
// Placename -> element adapter (VERBATIM from build-logainm-layer.mjs)
// ============================================================================

const STOPWORDS = new Set([
  'an', 'na', 'a', 'agus', 'ó', 'de', 'do', 'in', 'ar', 'le', 'don', 'den',
  'os', 'um', 'go', 'sa', 'san', 'ina', 'faoi', 'idir', 'thar', 'roimh',
  'chuig', 'as', 'is', 'nó', 'ná',
]);

function stripMutation(word) {
  let w = word;
  if (/^t-/i.test(w)) w = w.slice(2);
  else if (/^ts[^h]/i.test(w)) w = w.slice(1);
  else if (/^h[aeiouáéíóúàèìòù]/i.test(w)) w = w.slice(1);
  if (/^bhf/i.test(w)) w = w.slice(2);
  else if (/^(mb|gc|nd|ng|bp|dt)/i.test(w)) w = w.slice(1);
  else if (/^[bcdfgmpst]h[aeiouáéíóúàèìòùlrn]/i.test(w)) w = w[0] + w.slice(2);
  return w;
}

/** Decompose an Irish placename into its Logainm elements → goi ResourceIDs.
 *  Matches against the KNOWN 211-element glossary (formsIndex), not the open
 *  dictionary, and links to the POS-resolved goi headword (elementResolve) — so
 *  homographs no longer resolve to an arbitrary [0]. Returns Map<goiRid, token>. */
function matchElements(name, formsIndex, elementResolve) {
  const matched = new Map();
  const words = name
    .replace(/[’']/g, "'")
    .split(/[\s\-]+/)
    .map(w => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter(Boolean);
  for (const raw of words) {
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (lower.length < 2) continue;
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
// Feature-category CODE -> English collection label
// ============================================================================
// Reuse the seeded collection labels (Townland/Parish/River/…) where sensible;
// everything else maps to a title-cased Logainm label added to the collection.
const CATEGORY_LABEL = {
  BF: 'Townland', FB: 'Sub-townland', PAR: 'Parish', BAR: 'Barony',
  CON: 'County', CR: 'County', CTH: 'City', CUIGE: 'Province',
  B: 'Town', ID: 'Population Centre', GR: 'Hamlet', SRB: 'Village',
  D: 'Locality', SR: 'Street', BOTHAR: 'Road', COS: 'Footpath', CB: 'Crossroads',
  DR: 'Bridge', RSCRS: 'Racecourse', TR: 'Electoral District',
  ABH: 'River', SRUTHAN: 'Stream', CAN: 'Canal', L: 'Lake', TUR: 'Turlough',
  OIL: 'Island', TOB: 'Well', EAS: 'Waterfall', IN: 'Estuary', GOIL: 'Creek',
  LE: 'Church', REILIG: 'Graveyard', SL: 'Mountain', CN: 'Hill', GL: 'Valley',
  COM: 'Coomb', LOG: 'Hollow', MALA: 'Hillside', BA: 'Bay', CUAN: 'Harbour',
  TRA: 'Beach', RINN: 'Point', AILL: 'Cliff', ATH: 'Ford', BEAR: 'Pass',
  CAIS: 'Castle', CAL: 'Port', CALADH: 'Landing Place', CAOL: 'Channel',
  CARN: 'Cairn', CE: 'Quay', COILL: 'Wood', CRG: 'Rock', CT: 'Promontory',
  DUMHACH: 'Sandhill', EISC: 'Fissure', GALLAN: 'Standing Stone', GNE: 'Feature',
  GS: 'Man-made Feature', IMFH: 'Enclosure', MNG: 'Minor Feature',
  OITIR: 'Sandbank', POLL: 'Hole', POR: 'Bog', PRC: 'Field', RIASC: 'Marsh',
  SC: 'Monument', SCEIR: 'Reef', TAN: 'Shoal', TEACH: 'House', TUAMA: 'Tomb',
  UAIMH: 'Cave', geadan: 'Other',
};
const labelForCode = (code) => (code && CATEGORY_LABEL[code]) || (code ? 'Other' : '');

// ============================================================================
// STAGE A: Load raw pulls
// ============================================================================
const t0 = performance.now();

function requireFile(p) {
  if (!existsSync(p)) {
    console.error(`[build-place] Missing input: ${p}\n[build-place] Run: node scripts/pull-logainm-places.mjs`);
    process.exit(1);
  }
  return p;
}

console.log('[build-place] Loading raw pulls...');
// names -> per place {ga:[], en:[]}
const places = new Map();
for (const line of readFileSync(requireFile(resolve(root, 'data/raw/logainm-names.jsonl')), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (rec.place == null) continue;
  if (!places.has(rec.place)) places.set(rec.place, { ga: [], en: [], cat: '', topic: '', lat: '', long: '', parents: [] });
  const p = places.get(rec.place);
  if (rec.lang === 'ga' && rec.name) p.ga.push(rec.name);
  else if (rec.lang === 'en' && rec.name) p.en.push(rec.name);
}
// per-place meta
for (const line of readFileSync(requireFile(resolve(root, 'data/raw/logainm-places.jsonl')), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (rec.place == null) continue;
  if (!places.has(rec.place)) places.set(rec.place, { ga: [], en: [], cat: '', topic: '', lat: '', long: '', parents: [] });
  const p = places.get(rec.place);
  p.cat = rec.cat || ''; p.topic = rec.topic || ''; p.lat = rec.lat || ''; p.long = rec.long || '';
}
// parents
for (const line of readFileSync(requireFile(resolve(root, 'data/raw/logainm-parents.jsonl')), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (rec.place == null || rec.parent == null) continue;
  const p = places.get(rec.place);
  if (p) p.parents.push(rec.parent);
}
console.log(`[build-place] ${places.size} distinct places loaded`);

// ============================================================================
// STAGE B: Reconcile models/place/collections.csv with categories present
// ============================================================================
console.log('[build-place] Reconciling feature-type collection...');
const usedCodes = new Set();
for (const p of places.values()) if (p.cat) usedCodes.add(p.cat);
const usedLabels = new Set();
for (const code of usedCodes) { const l = labelForCode(code); if (l) usedLabels.add(l); }

const collectionsCsvPath = resolve(root, 'models/place/collections.csv');
const collLines = readFileSync(collectionsCsvPath, 'utf8').split('\n').filter(l => l.trim());
const collHeader = collLines[0];
const collName = 'Place Feature Types';
const existingLabels = new Map(); // lower -> canonical
let maxSort = 0;
const collRows = [];
for (let i = 1; i < collLines.length; i++) {
  const f = parseCsvLine(collLines[i]);
  const label = f[1]; const so = parseInt(f[3] || '0', 10) || 0;
  if (label) { existingLabels.set(label.toLowerCase(), label); collRows.push(collLines[i]); if (so > maxSort) maxSort = so; }
}
let added = 0;
for (const label of [...usedLabels].sort()) {
  if (!existingLabels.has(label.toLowerCase())) {
    maxSort += 1; added += 1;
    existingLabels.set(label.toLowerCase(), label);
    collRows.push([csvEscape(collName), csvEscape(label), '', String(maxSort)].join(','));
  }
}
writeFileSync(collectionsCsvPath, [collHeader, ...collRows].join('\n') + '\n');
console.log(`[build-place] Collection: ${existingLabels.size} labels (${added} added). Codes in data: ${usedCodes.size}`);

// ============================================================================
// STAGE C: goi lookup (headwords + written forms + bunamo inflected forms)
// ============================================================================
console.log('[build-place] Building goi lookup...');
// Union the goi-emitting layers (Wiktionary + Téarma + BuNaMo, all goi-<head>-<pos>)
// so a toponymic element absent from Wiktionary still resolves via Téarma/BuNaMo;
// MacBain's unique gd-<head>-etym entries are a last-resort fallback.
const gaLookup = new Map();   // normalised headword -> goi ResourceID[]
const gdFallback = new Map(); // normalised headword -> gd- ResourceID (MacBain, Scottish-only)
function loadLexicalCsv(relPath) {
  const path = resolve(root, relPath);
  if (!existsSync(path)) { console.warn(`[build-place]   skip (missing): ${relPath}`); return; }
  const lines = readFileSync(path, 'utf8').split('\n');
  const header = lines[0].split(',');
  const ridIdx = header.indexOf('ResourceID');
  const hwIdx = header.indexOf('headword');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const f = parseCsvLine(lines[i]);
    const rid = f[ridIdx] || '';
    const hw = f[hwIdx] || '';
    if (!hw) continue;
    const key = normalizeHead(hw);
    if (rid.startsWith('goi-')) {
      if (!gaLookup.has(key)) gaLookup.set(key, []);
      const arr = gaLookup.get(key);
      if (!arr.includes(rid)) arr.push(rid);
    } else if (rid.startsWith('gd-')) {
      if (!gdFallback.has(key)) gdFallback.set(key, rid);
    }
  }
}
loadLexicalCsv('data/processed/lexical_entry_data.csv');        // Wiktionary
loadLexicalCsv('data/processed/tearma_lexical_entry_data.csv'); // Téarma
loadLexicalCsv('data/processed/bunamo_lexical_entry_data.csv'); // BuNaMo
loadLexicalCsv('data/processed/macbain_lexical_entry_data.csv'); // MacBain (gd fallback)
console.log(`[build-place] goi lookup: ${gaLookup.size} headwords, ${gdFallback.size} gd fallbacks`);

// --- Logainm element glossary: the authoritative toponymic element vocabulary.
// Decompose placenames against THESE known forms; resolve each to the right goi
// headword+POS once. See scripts/pull-logainm-glossary.mjs.
const glossaryPath = resolve(root, 'data/raw/logainm-glossary.json');
if (!existsSync(glossaryPath)) {
  console.error(`[build-place] Element glossary not found: ${glossaryPath}`);
  console.error('[build-place] Run: node scripts/pull-logainm-glossary.mjs');
  process.exit(1);
}
const glossary = JSON.parse(readFileSync(glossaryPath, 'utf8'));

// Qualifier ADJECTIVES in placenames (colour/size/quality). Else default NOUN —
// the toponymic default. Logainm carries no POS; consulted only when the dictionary
// has both a noun and an adjective for the spelling. Keys normalizeHead-folded.
const ELEMENT_ADJ = new Set([
  'mór', 'beag', 'fada', 'gearr', 'leathan', 'dubh', 'bán', 'rua', 'dearg',
  'buí', 'glas', 'gorm', 'liath', 'donn', 'fionn', 'riabhach', 'odhar', 'geal',
  'sean', 'nua', 'garbh', 'mín', 'maol', 'breac', 'cam',
].map(normalizeHead));
const goiPos = (rid) => rid.split('-').slice(2).join('-');

const elementResolve = new Map(); // element.id -> { rid, headword }
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
  if (!rid) rid = gdFallback.get(normalizeHead(el.headword)) || null;
  if (rid) { elementResolve.set(el.id, { rid, headword: el.headword }); elResolved++; }
  else { elUnmatched++; }
}
console.log(`[build-place] elements: ${elResolved}/${glossary.length} resolved to goi (${elAmbiguous} POS-ambiguous), ${elUnmatched} with no dictionary entry`);

const formsIndex = new Map(); // normalizeHead(form) -> element.id
for (const el of glossary) {
  for (const form of [el.headword, ...el.forms]) {
    const key = normalizeHead(form);
    if (key && !formsIndex.has(key)) formsIndex.set(key, el.id);
  }
}

// ============================================================================
// STAGE D: Build the graph (need PLACE graph_id + RESOURCE_NS before CSV)
// ============================================================================
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  setNapiModule(require('@alizarin/napi'));
  usingNapi = true;
  console.log('[build-place] Using NAPI backend');
} catch (e) {
  console.log('[build-place] NAPI not available, falling back to WASM');
  await initWasm();
}

const modelDir = resolve(root, 'models/place');
const graphCsv = readFileSync(resolve(modelDir, 'graph.csv'), 'utf8');
const nodesCsv = readFileSync(resolve(modelDir, 'nodes.csv'), 'utf8');
const collectionsCsv = readFileSync(collectionsCsvPath, 'utf8');

console.log('[build-place] Building graph from model CSVs...');
const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
const graphId = graph.graphid;
const PLACE_RESOURCE_NS = uuidv5(`resource/${graphId}`, ALIZARIN_NS);
const placeUuid = (pid) => uuidv5(`place-${pid}`, PLACE_RESOURCE_NS);
const LAYER_NAMESPACE = uuidv5('layer/place', ALIZARIN_NS);
console.log(`[build-place] PLACE graph_id: ${graphId}  (${graph.nodes.length} nodes, ${collections.length} collections)`);

const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
typedGraph.setDescriptorTemplate('name', '<Name>');
typedGraph.setDescriptorTemplate('description', '<English Name>');

// ============================================================================
// STAGE E: Emit business-data CSV
// ============================================================================
const CSV_COLUMNS = [
  'ResourceID', 'name', 'name_en', 'feature_type', 'logainm_id', 'logainm_url',
  'latitude', 'longitude', 'location', 'within', 'element_entry', 'element_surface',
];

/** A place centroid as a GeoJSON FeatureCollection Point ([lon, lat]), or '' if no geometry. */
function centroidFeatureCollection(lat, long) {
  if (!lat || !long) return '';
  const lo = Number(long), la = Number(lat);
  if (!Number.isFinite(lo) || !Number.isFinite(la)) return '';
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lo, la] } }],
  });
}

const csvRows = [CSV_COLUMNS.join(',')];
let placesWithGa = 0, matchedCount = 0, totalElementLinks = 0, withGeo = 0, withWithin = 0;
const elementFreq = new Map();
const featureFreq = new Map();
const pagefindMeta = []; // {uuid?, id, name, name_en, feature}

const sortedIds = [...places.keys()].sort((a, b) => a - b);
for (const pid of sortedIds) {
  const p = places.get(pid);
  if (p.ga.length === 0) continue; // MVP: only places with an Irish name
  placesWithGa++;
  const name = p.ga[0];
  const nameEn = p.en[0] || '';
  const rid = `place-${pid}`;
  const feature = labelForCode(p.cat);
  if (feature) featureFreq.set(feature, (featureFreq.get(feature) || 0) + 1);
  if (p.lat && p.long) withGeo++;
  // within: parents present in the pulled set only (best-effort)
  const withinUuids = [...new Set(p.parents)].filter(par => places.has(par)).map(placeUuid);
  if (withinUuids.length) withWithin++;

  const matched = matchElements(name, formsIndex, elementResolve);
  if (matched.size > 0) { matchedCount++; totalElementLinks += matched.size; }
  const elements = [...matched.entries()]; // [goiRid, surface][]

  const maxRows = Math.max(1, elements.length);
  for (let i = 0; i < maxRows; i++) {
    const row = { ResourceID: rid };
    if (i === 0) {
      row.name = name;
      row.name_en = nameEn;
      row.feature_type = feature;
      row.logainm_id = String(pid);
      row.logainm_url = p.topic;
      row.latitude = p.lat;
      row.longitude = p.long;
      row.location = centroidFeatureCollection(p.lat, p.long);
      row.within = withinUuids.join(',');
    }
    if (i < elements.length) {
      const [goiRid, surface] = elements[i];
      row.element_entry = goiUuid(goiRid);
      row.element_surface = surface;
      elementFreq.set(goiRid, (elementFreq.get(goiRid) || 0) + 1);
    }
    csvRows.push(CSV_COLUMNS.map(c => csvEscape(row[c] || '')).join(','));
  }
  pagefindMeta.push({ id: pid, name, name_en: nameEn, feature });
}
const csvContent = csvRows.join('\n') + '\n';
mkdirSync(resolve(root, 'data/processed'), { recursive: true });
writeFileSync(resolve(root, 'data/processed/place_business_data.csv'), csvContent);

console.log(`[build-place] Places with Irish name: ${placesWithGa}`);
console.log(`[build-place] Places with >=1 element: ${matchedCount} (${(100 * matchedCount / placesWithGa).toFixed(1)}%)`);
console.log(`[build-place] Total element links: ${totalElementLinks}; geo: ${withGeo} (${(100 * withGeo / placesWithGa).toFixed(1)}%); with within: ${withWithin}`);
{
  const topEls = [...elementFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('[build-place] Top elements:', topEls.map(([r, n]) => `${r}=${n}`).join(', '));
  const topFeat = [...featureFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('[build-place] Top feature types:', topFeat.map(([f, n]) => `${f}=${n}`).join(', '));
}

// ============================================================================
// STAGE F: Build resources + prebuild + v2 head
// ============================================================================
const tBd = performance.now();
const result = buildResourcesFromBusinessCsv(csvContent, graph, collections, 'en', false, LAYER_NAMESPACE);
const resources = result?.business_data?.resources || [];
console.log(`[build-place] Built ${resources.length} resources (${elapsed(tBd)})`);

// Migrate concept -> reference (same as logainm/bunamo/macbain)
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
    const concepts = Object.values(allConcepts).map(c => ({
      id: c.id, prefLabels: c.prefLabels || {}, broader: c.broader || [],
      narrower: (c.children || []).map(ch => ch.id || ch),
    }));
    rdmCache.addCollectionFromJson(cid, JSON.stringify(concepts));
  }
}

const cacheResult = registry.populateCachesFromJson(JSON.stringify(resources), typedGraph, true, false, true);
const enrichedResources = cacheResult.resources || resources;
console.log(`[build-place] Descriptors computed for ${enrichedResources.length} resources`);

// --- Write prebuild directory ---
const prebuildDir = resolve(root, 'data/prebuild-place');
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
  } catch (e) { console.warn(`[build-place] SKOS XML failed for ${cid}: ${e.message}`); }
}
writeFileSync(resolve(prebuildDir, 'manifest.json'), JSON.stringify({
  base_uri: namespace, source: 'linked-logainm-place', source_tag: PLACE_TAG,
  built: new Date().toISOString(), license: 'CC-BY-4.0',
}));
console.log(`[build-place] Prebuild written to ${prebuildDir}`);

// --- Run regen-layer-v2 -> data/place-v2 (pass the PLACE graph_id) ---
const outDir = resolve(root, 'data/place-v2');
console.log('[build-place] Running regen-layer-v2 (cargo, v2-emit)...');
const srcTauri = resolve(root, 'app/src-tauri');
execFileSync('cargo', [
  'run', '--release', '--example', 'regen-layer-v2', '--features', 'v2-emit',
  '--manifest-path', resolve(srcTauri, 'Cargo.toml'),
  '--', 'data/prebuild-place', 'data/place-v2', graphId,
], { stdio: 'inherit' });

// ============================================================================
// STAGE G: Pagefind (one ga record per place; empty en/sampla for base parity)
// ============================================================================
console.log('[build-place] Building Pagefind indices...');
const tPf = performance.now();
// url = placeUuid(id) == the builder's resourceinstanceid (both are
// uuid5(`place-<id>`, PLACE_RESOURCE_NS)), so a hit resolves to the head resource.
const { index: gaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
const { index: enIndex } = await pagefind.createIndex({ forceLanguage: 'en' });
const { index: samplaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
if (!gaIndex || !enIndex || !samplaIndex) { console.error('[build-place] Failed to create pagefind indices'); process.exit(1); }
let gaCount = 0;
for (const m of pagefindMeta) {
  const uuid = placeUuid(m.id);
  const bag = new Set();
  for (const s of [m.name, m.name_en]) { if (!s) continue; bag.add(s); bag.add(stripDiacritics(s)); }
  await gaIndex.addCustomRecord({
    url: uuid,
    content: [...bag].join(' '),
    language: 'ga',
    meta: { title: m.name, name_en: m.name_en, feature_type: m.feature || '', dialect: 'GA', kind: 'place' },
    filters: { dialect: ['GA'], feature_type: m.feature ? [m.feature] : [], kind: ['place'] },
  });
  gaCount++;
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
console.log(`[build-place] Pagefind: ga=${gaCount} (en/sampla empty) (${elapsed(tPf)})`);

console.log(`[build-place] Done (${elapsed(t0)})`);
console.log(`[build-place] PLACE graph_id: ${graphId}`);
console.log(`[build-place] Head: ${outDir}`);
