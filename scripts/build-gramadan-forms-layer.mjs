/**
 * Build the `gramadan-forms` COMPUTED layer.
 *
 * A reduced-order alternative to the bulky `bunamo-v2` forms layer: instead of
 * shipping the full precomputed paradigm per noun, this layer ships only the
 * `grammar_class_group` tile (declension value + confidence) - a tiny signpost.
 * The forms themselves are materialised ON DEVICE by greasan-gramadan, driven by
 * the compute-tiles function this layer declares on its OWN graph.
 *
 * How it fires (see HANDOFF-computed-layers.md + graph-functions-registry):
 *   - This layer's graph.json carries ONE functions_x_graphs entry:
 *       function_id = COMPUTE_TILES_FUNCTION_ID, config = { provider:
 *       GRAMADAN_PROVIDER_ID, nodegroup: <forms ng>, member_of: "gramadan-forms" }.
 *   - The app composes this overlay graph over the base (LayeredGraph), so the
 *     fxg is visible at hydrate. A resource is a "member" iff it has a tile in
 *     THIS layer's parquet (the grammar_class_group tile) - so presence is
 *     necessary and sufficient to trigger generation.
 *   - greasan-gramadan reads headword (base wiktionary layer) + grammar_class
 *     (this layer) + gender (base) and emits the `forms` tiles. Attested forms
 *     (bunamo-v2, if also installed) win the merge; this fills the gaps.
 *
 * Each resource carries ONLY `grammar_class_group` (no headword, no forms): the
 * goi slug is identical to the wiktionary entry for the same lemma+POS, so the
 * Layers engine composes them. No pagefind: computed forms are generated on
 * device, not indexable at build time (a v1 limitation).
 *
 * Data source: BuNaMo grammatical class (github.com/michmech/BuNaMo) - ODbL-1.0.
 *
 * Usage: node scripts/build-gramadan-forms-layer.mjs [--skip-data]
 * Output: data/processed/gramadan_forms_class.csv, data/prebuild-gramadan-forms/,
 *         data/gramadan-forms-v2/ (parquet + graph.json with the fxg).
 */

import { createRequire } from 'module';
import { makeRdmCache } from './lib/rdm-cache.mjs';
import {
  initWasm,
  buildGraphFromModelCsvs,
  buildResourcesFromBusinessCsv,
  collectionsToSkosXml,
  createResourceRegistry,
  parseStaticGraph,
  setNapiModule,
} from '../app/node_modules/alizarin/dist/alizarin.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const namespace = 'https://flaxandteal.org/ontology/goidelic#';
// Shared lexical_entry graph - MUST match wiktionary/bunamo so goi slugs resolve
// to the same resource UUIDs and compose per-nodegroup.
const GRAPH_ID = '449c8695-253e-521b-8994-27701ce22305';
// layer-internal tile-id namespace (only scopes tile ids, distinct per layer).
const LAYER_NAMESPACE = 'b7d4e2a1-6c3f-5e88-9a2d-4f1b0c9e7a63';

// The compute-tiles wiring - MUST match alizarin-core / greasan-gramadan.
const COMPUTE_TILES_FUNCTION_ID = '60000000-0000-0000-0000-000000000002';
const GRAMADAN_PROVIDER_ID = '70000000-0000-0000-0000-000000000001';
// The fxg's member_of MUST equal the installed head dir basename (offline.rs
// unpacks bundled heads to <app_data>/heads/<head>/, and the app's layer_id_of
// is that basename). So it is the HEAD name, not a bare slug.
const HEAD_NAME = 'gramadan-forms-v2';
const LAYER_ID = HEAD_NAME;

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }

// Minimal CSV field split honouring double-quoted fields.
function parseRow(line) {
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
}

// --- 0: (re)generate the bunamo data CSV, then reduce to class-only -----------
const bunamoCsvPath = resolve(root, 'data/processed/bunamo_lexical_entry_data.csv');
if (!process.argv.includes('--skip-data')) {
  console.log('[gramadan-forms] Running Python data emitter (Gramadan v2)...');
  const py = resolve(root, '.venv/bin/python');
  execFileSync(py, [resolve(root, 'scripts/build-bunamo-data.py')], { stdio: 'inherit' });
}
if (!existsSync(bunamoCsvPath)) {
  console.error(`[gramadan-forms] bunamo CSV missing: ${bunamoCsvPath} (run without --skip-data)`);
  process.exit(1);
}

// Reduce: one grammar_class_group row per NOUN resource. grammar_class + its
// confidence sit on the lemma row (subsequent form rows leave them blank); the
// slug suffix "-noun" selects nouns (greasan-gramadan v1 is the noun path).
const bunamoLines = readFileSync(bunamoCsvPath, 'utf8').split('\n');
const bHeader = parseRow(bunamoLines[0]);
const bId = bHeader.indexOf('ResourceID');
const bClass = bHeader.indexOf('grammar_class');
const bConf = bHeader.indexOf('grammar_class_confidence');
const classByRid = new Map();
for (let i = 1; i < bunamoLines.length; i++) {
  if (!bunamoLines[i]) continue;
  const cols = parseRow(bunamoLines[i]);
  const rid = cols[bId];
  if (!rid || !rid.endsWith('-noun')) continue;
  const cls = (cols[bClass] || '').trim();
  if (!cls || classByRid.has(rid)) continue; // first non-empty class wins
  classByRid.set(rid, { grammar_class: cls, grammar_class_confidence: (cols[bConf] || '').trim() });
}
console.log(`[gramadan-forms] ${classByRid.size} noun resources with a grammar class`);

const classCsvPath = resolve(root, 'data/processed/gramadan_forms_class.csv');
{
  const rows = ['ResourceID,grammar_class,grammar_class_confidence'];
  for (const [rid, v] of classByRid) {
    rows.push(`${rid},${v.grammar_class},${v.grammar_class_confidence}`);
  }
  writeFileSync(classCsvPath, rows.join('\n') + '\n');
  console.log(`[gramadan-forms] Wrote class-only CSV: ${classCsvPath}`);
}
const csvContent = readFileSync(classCsvPath, 'utf8');

const t0 = performance.now();

// --- NAPI or WASM backend ---
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  setNapiModule(napi);
  usingNapi = true;
  console.log('[gramadan-forms] Using NAPI backend');
} catch (e) {
  console.log('[gramadan-forms] NAPI not available, falling back to WASM');
  await initWasm();
}

// --- Build lexical_entry model ---
const modelDir = resolve(root, 'models/lexical_entry');
const graphCsv = readFileSync(resolve(modelDir, 'graph.csv'), 'utf8');
const nodesCsv = readFileSync(resolve(modelDir, 'nodes.csv'), 'utf8');
const collectionsCsvPath = resolve(modelDir, 'collections.csv');
const collectionsCsv = existsSync(collectionsCsvPath) ? readFileSync(collectionsCsvPath, 'utf8') : null;

console.log('[gramadan-forms] Building graph from model CSVs...');
const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
const graphId = graph.graphid;

// Declare the compute-tiles fxg on THIS layer's graph (over the forms nodegroup
// the shared model already defines). This is what makes it a computed layer.
const writtenRep = graph.nodes.find((n) => n.alias === 'written_rep');
if (!writtenRep?.nodegroup_id) {
  console.error('[gramadan-forms] cannot find the forms nodegroup (written_rep node)');
  process.exit(1);
}
const formsNg = writtenRep.nodegroup_id;
graph.functions_x_graphs = [
  ...(graph.functions_x_graphs || []),
  {
    id: 'f0110000-0000-4000-8000-000000000001',
    function_id: COMPUTE_TILES_FUNCTION_ID,
    graph_id: graphId,
    config: { provider: GRAMADAN_PROVIDER_ID, nodegroup: formsNg, member_of: LAYER_ID, cache: true },
  },
];
console.log(`[gramadan-forms] compute-tiles fxg over forms nodegroup ${formsNg} (member_of=${LAYER_ID})`);

const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
typedGraph.setDescriptorTemplate('name', '<Headword>');
typedGraph.setDescriptorTemplate('description', '<Gloss>');

const tBd = performance.now();
const result = buildResourcesFromBusinessCsv(csvContent, graph, collections, 'en', false, LAYER_NAMESPACE, makeRdmCache(collections, root, usingNapi));
const resources = result?.business_data?.resources || [];
console.log(`[gramadan-forms] Built ${resources.length} resources (grammar_class_group only) (${elapsed(tBd)})`);

// Migrate concept/concept-list -> reference (same as the other layers).
for (const node of graph.nodes) {
  if (node.datatype === 'concept-list') {
    node.datatype = 'reference';
    node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection };
  } else if (node.datatype === 'concept') {
    node.datatype = 'reference';
    node.config = { ...node.config, controlledList: node.config?.rdmCollection };
  }
}

// --- Write prebuild directory ---
const prebuildDir = resolve(root, 'data/prebuild-gramadan-forms');
execSync(`rm -rf "${prebuildDir}"`);
mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });

writeFileSync(resolve(prebuildDir, `graphs/resource_models/${graphId}.json`), JSON.stringify(graph));
writeFileSync(
  resolve(prebuildDir, `business_data/${graphId}.json`),
  JSON.stringify({ business_data: { resources } })
);
for (const collection of collections) {
  const cid = collection.collectionid || collection.id;
  if (!cid) continue;
  writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.json`), JSON.stringify(collection));
  try {
    const xml = collectionsToSkosXml([collection], namespace);
    writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.xml`), xml);
  } catch (e) {
    console.warn(`[gramadan-forms] SKOS XML failed for ${cid}: ${e.message}`);
  }
}
writeFileSync(resolve(prebuildDir, 'manifest.json'), JSON.stringify({
  base_uri: namespace,
  source: 'gramadan-forms',
  source_tag: 'GF',
  built: new Date().toISOString(),
  license: 'ODbL-1.0',
  computed: true,
}));
console.log(`[gramadan-forms] Prebuild written to ${prebuildDir}`);

// --- Run regen-layer-v2 (Rust emit) -> data/gramadan-forms-v2 ---
const outDir = resolve(root, 'data/gramadan-forms-v2');
console.log('[gramadan-forms] Running regen-layer-v2 (cargo, v2-emit)...');
const srcTauri = resolve(root, 'app/src-tauri');
execFileSync('cargo', [
  'run', '--release', '--example', 'regen-layer-v2', '--features', 'v2-emit',
  '--manifest-path', resolve(srcTauri, 'Cargo.toml'),
  '--', 'data/prebuild-gramadan-forms', 'data/gramadan-forms-v2', GRAPH_ID,
], { stdio: 'inherit' });

// Verify the fxg survived the emit into the head graph.json (the app reads this
// as the overlay graph; if the emit dropped functions_x_graphs, nothing fires).
const headGraph = resolve(outDir, 'graph.json');
if (existsSync(headGraph)) {
  const raw = readFileSync(headGraph, 'utf8');
  const ok = raw.includes(GRAMADAN_PROVIDER_ID) && raw.includes(LAYER_ID);
  console.log(`[gramadan-forms] head graph.json carries the fxg: ${ok ? 'YES' : 'NO (!)'}`);
  if (!ok) process.exit(1);
}

console.log(`[gramadan-forms] Done (${elapsed(t0)})`);
console.log(`[gramadan-forms] Head: ${outDir}`);
