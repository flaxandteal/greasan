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
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const namespace = 'https://flaxandteal.org/ontology/goidelic#';
const ALIZARIN_NS = '1a79f1c8-9505-4bea-a18e-28a053f725ca';

function uuidv5(name, ns) {
  const nsb = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const b = Buffer.from(createHash('sha1').update(Buffer.concat([nsb, Buffer.from(name, 'utf8')])).digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }
function csvEscape(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

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

// --- Layer catalogue metadata. Concept labels MUST match models/layer/collections.csv. ---
const LAYERS = [
  { slug: 'wiktionary', head: 'wiktionary-v2-full', name: 'Vicífhoclóir · Wiktionary',
    licence: 'CC BY-SA 4.0', attribution: 'Wiktionary contributors (CC BY-SA 4.0)',
    types: ['Glosses', 'Senses', 'Etymology', 'Pronunciation', 'Cognates'], formats: ['Arches JSON', 'RM'],
    swatch: 'var(--layer-wk)', default_on: 'true', descType: 'Overview',
    desc: 'Crowd-sourced Irish and Scottish Gaelic dictionary content extracted from Wiktionary - glosses, senses, etymologies, pronunciations and cognates.',
    config: { searchable: true, langs: ['ga', 'en'],
      install: { name: 'wiktionary-goidelic', url: 'http://localhost:8080/wiktionary-layer.tar.gz', format: 'built' } },
    links: [{ t: 'Wiktionary', u: 'https://www.wiktionary.org/', ty: 'Homepage' }, { t: 'Data dumps', u: 'https://dumps.wikimedia.org/', ty: 'Source' }], downloads: [] },
  { slug: 'macbain', head: 'macbain-v2', name: 'MacBain (1911)',
    licence: 'Public Domain', attribution: "MacBain's Etymological Dictionary of the Gaelic Language (1911) - public domain",
    types: ['Etymology', 'Cognates', 'Glosses'], formats: ['Arches JSON', 'RM'],
    swatch: 'var(--layer-mb)', default_on: 'true', descType: 'Overview',
    desc: "Alexander MacBain's 1911 etymological dictionary of Scottish Gaelic - etymologies and cognates. Out of copyright.",
    config: { searchable: true, langs: ['ga', 'en'],
      install: { name: 'macbain', url: 'http://localhost:8080/macbain-layer.tar.gz', format: 'built' } },
    links: [{ t: 'Archive.org', u: 'https://archive.org/details/etymologicaldict00macbuoft', ty: 'Source' }], downloads: [] },
  { slug: 'tearma', head: 'tearma-v2', name: 'Téarma',
    licence: 'No open reuse licence', attribution: 'Téarma.ie - terminology data (c) Foras na Gaeilge; implementation (c) Gaois, Fiontar & Scoil na Gaeilge, DCU. Not redistributed; loaded on-device from your own downloaded TBX.',
    types: ['Terminology', 'Glosses'], formats: ['TBX', 'RM'],
    swatch: 'var(--layer-te)', default_on: 'true', descType: 'Overview',
    desc: 'The National Terminology Database for Irish - domain-specific terminology across many fields.',
    config: { searchable: true, langs: ['ga', 'en'],
      // url:'' → the "choose a file" flow: Téarma can't ship, so the user picks a
      // TBX they downloaded from tearma.ie and it builds on-device.
      install: { name: 'tearma', url: '', format: 'tbx-v2' } },
    links: [{ t: 'Téarma.ie', u: 'https://www.tearma.ie/', ty: 'Homepage' }],
    downloads: [{ f: 'RM', u: '', n: 'Regenerated as an RM head from the source TBX.' }] },
  { slug: 'bunamo', head: 'bunamo-v2', name: 'BuNaMo',
    licence: 'CC BY 4.0', attribution: 'BuNaMo (Gramadán) - Michal Boleslav Měchura (CC BY 4.0)',
    types: ['Grammar', 'Morphology'], formats: ['RM'],
    swatch: 'var(--layer-bn)', default_on: 'true', descType: 'Overview',
    desc: 'Irish morphology database - full inflectional paradigms, composed onto the shared lemma ids via Gramadán.',
    config: { searchable: true, langs: ['ga'] },
    links: [{ t: 'BuNaMo (GitHub)', u: 'https://github.com/michmech/BuNaMo', ty: 'Source' }], downloads: [] },
  { slug: 'place', head: 'place-v2', name: 'Logainm',
    licence: 'CC BY 4.0', attribution: 'Ó Logainm.ie (CC BY 4.0), athraithe / modified',
    types: ['Placenames'], formats: ['Arches JSON', 'RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Irish placenames from the Placenames Database of Ireland (Logainm), each linked to the dictionary headwords that constitute it.',
    config: { searchable: false, map: true },
    links: [{ t: 'Logainm.ie', u: 'https://www.logainm.ie/', ty: 'Homepage' }, { t: 'Linked Logainm', u: 'https://www.logainm.ie/en/inf/proj-machines', ty: 'Documentation' }], downloads: [] },
  { slug: 'example-tatoeba', head: 'example-tatoeba-v2', name: 'Tatoeba',
    licence: 'CC BY 2.0', attribution: 'Tatoeba (CC BY 2.0)',
    types: ['Examples'], formats: ['RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Example sentences from the Tatoeba project, linked to the headwords they illustrate.',
    config: { searchable: true, langs: ['sampla'] },
    links: [{ t: 'Tatoeba', u: 'https://tatoeba.org/', ty: 'Homepage' }], downloads: [] },
  { slug: 'example-gaois', head: 'example-gaois-v2', name: 'Gaois',
    licence: 'CC BY 4.0', attribution: 'Gaois - Parallel Corpus of Legislation (Fiontar & Scoil na Gaeilge, DCU; CC BY 4.0). Legislation © Government of Ireland.',
    types: ['Examples'], formats: ['RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Bilingual example sentences from the Gaois Parallel Corpus of Legislation.',
    config: { searchable: true, langs: ['sampla'] },
    links: [{ t: 'Gaois', u: 'https://www.gaois.ie/', ty: 'Homepage' }], downloads: [] },
  { slug: 'person', head: 'person-v2', name: 'Person',
    licence: 'CC0 1.0', attribution: 'App-generated',
    types: ['Annotations'], formats: ['RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Internal person records - the seeded User who authors notes and flags.',
    config: { searchable: false, internal: true }, links: [], downloads: [] },
  { slug: 'note', head: 'note-v2', name: 'Nótaí · Notes',
    licence: 'CC0 1.0', attribution: 'App-generated (user notes)',
    types: ['Annotations'], formats: ['RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'User notes and flags attached to resources - the app\'s mutable overlay.',
    config: { searchable: false, internal: true, mutable: true }, links: [], downloads: [] },
  { slug: 'basemap', head: '', name: 'Léarscáil · Basemap',
    licence: 'ODbL 1.0', attribution: '© OpenMapTiles © OpenStreetMap contributors',
    types: ['Basemap'], formats: ['PMTiles'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Self-rendered greyscale OpenStreetMap vector basemap for the placenames map. Generated offline with Planetiler.',
    config: { map: true, glyphs: false },
    links: [{ t: 'OpenStreetMap © licence', u: 'https://www.openstreetmap.org/copyright', ty: 'Licence' }, { t: 'OpenMapTiles', u: 'https://openmaptiles.org/', ty: 'Source' }],
    downloads: [{ f: 'PMTiles', u: '', n: 'Generated by scripts/build-basemap.sh (Planetiler, OSM extract).' }] },
];

const CSV_COLUMNS = [
  'ResourceID', 'name', 'slug', 'icon', 'layer_type', 'layer_format',
  'licence', 'attribution', 'description_type', 'description_text',
  'resource_count', 'statistics_block', 'integration_slug', 'default_on', 'swatch', 'config_block',
  'link_title', 'link_url', 'link_type', 'download_format', 'download_url', 'download_notes',
];

function buildBusinessCsv() {
  const rows = [CSV_COLUMNS.join(',')];
  const blank = (obj) => CSV_COLUMNS.map((c) => csvEscape(obj[c] ?? '')).join(',');
  for (const L of LAYERS) {
    const rc = countResources(L.head);
    const rid = `layer-${L.slug}`;
    // Row 1: all scalars (root + licensing + description + statistics + integration).
    rows.push(blank({
      ResourceID: rid, name: L.name, slug: L.slug, icon: L.icon || '',
      layer_type: L.types.join(','), layer_format: L.formats.join(','),
      licence: L.licence, attribution: L.attribution,
      description_type: L.descType, description_text: L.desc,
      resource_count: rc,
      statistics_block: JSON.stringify({ resourceCount: rc === '' ? null : Number(rc), head: L.head || null, builtBy: 'build-layer-catalogue' }),
      integration_slug: L.head || L.slug, default_on: L.default_on, swatch: L.swatch,
      config_block: JSON.stringify(L.config || {}),
    }));
    // One row per link (n-card).
    for (const lk of L.links) rows.push(blank({ ResourceID: rid, link_title: lk.t, link_url: lk.u, link_type: lk.ty }));
    // One row per download (n-card, nested under integration).
    for (const d of L.downloads) rows.push(blank({ ResourceID: rid, download_format: d.f, download_url: d.u, download_notes: d.n }));
  }
  return rows.join('\n') + '\n';
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

const businessCsv = buildBusinessCsv();
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
