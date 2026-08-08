/**
 * build-flag-layers.mjs
 *
 * Builds the two heads behind the "flag" feature:
 *   - person-v2 : a Person graph seeded with ONE resource, "User" (deterministic
 *                 UUID so Note.author links are stable).
 *   - note-v2   : a Note graph (oa:Annotation) - subject (resource-instance-list
 *                 → any resource), description (string), author (→ the User).
 *                 Seeded here with one sample note (flagging `baile`) so the read
 *                 path (cited_by('subject')) is verifiable before the write path
 *                 exists. The write path (Flag ②) re-emits note-v2 on each flag.
 *
 * Mirrors build-external-example-layer.mjs, minus Pagefind (flags aren't searched).
 * Output: data/person-v2/ and data/note-v2/ (head.sqlite + chunks + graph.json).
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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const namespace = 'https://flaxandteal.org/ontology/goidelic#';
const ALIZARIN_NS = '1a79f1c8-9505-4bea-a18e-28a053f725ca';

// A known goi lexical_entry UUID to hang the sample flag on (baile) - proves the
// cross-graph subject link + cited_by('subject') without needing the write path.
const SAMPLE_SUBJECT_UUID = '6478617d-74c7-5471-aa79-4de8aee53e74'; // baile

function uuidv5(name, ns) {
  const nsb = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const b = Buffer.from(createHash('sha1').update(Buffer.concat([nsb, Buffer.from(name, 'utf8')])).digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }
function csvEscape(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const t0 = performance.now();

// --- backend ---
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  setNapiModule(require('@alizarin/napi'));
  usingNapi = true;
  console.log('[build-flag] Using NAPI backend');
} catch {
  console.log('[build-flag] NAPI not available, falling back to WASM');
  await initWasm();
}

/** Build one v2 head from a model dir + an inline business CSV. Returns graphId. */
function emitHead(slug, modelDir, businessCsv, outSlug, descriptorTemplate) {
  const graphCsv = readFileSync(resolve(root, modelDir, 'graph.csv'), 'utf8');
  const nodesCsv = readFileSync(resolve(root, modelDir, 'nodes.csv'), 'utf8');
  const collectionsCsv = readFileSync(resolve(root, modelDir, 'collections.csv'), 'utf8');
  const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
  const graphId = graph.graphid;
  console.log(`[build-flag] ${slug} graph_id: ${graphId} (${graph.nodes.length} nodes)`);

  const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
  for (const [alias, tmpl] of Object.entries(descriptorTemplate)) typedGraph.setDescriptorTemplate(alias, tmpl);

  const LAYER_NAMESPACE = uuidv5(`layer/${slug}`, ALIZARIN_NS);
  const result = buildResourcesFromBusinessCsv(businessCsv, graph, collections, 'en', false, LAYER_NAMESPACE);
  const resources = result?.business_data?.resources || [];

  for (const node of graph.nodes) {
    if (node.datatype === 'concept-list') { node.datatype = 'reference'; node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection }; }
    else if (node.datatype === 'concept') { node.datatype = 'reference'; node.config = { ...node.config, controlledList: node.config?.rdmCollection }; }
  }

  const registry = createResourceRegistry();
  registry.mergeFromResourcesJson(JSON.stringify(resources), true, true);
  const cacheResult = registry.populateCachesFromJson(JSON.stringify(resources), typedGraph, true, false, true);
  const enrichedResources = cacheResult.resources || resources;
  console.log(`[build-flag] ${slug}: ${enrichedResources.length} resources`);

  const prebuildDir = resolve(root, `data/prebuild-${slug}`);
  execSync(`rm -rf "${prebuildDir}"`);
  mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
  mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
  mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });
  writeFileSync(resolve(prebuildDir, `graphs/resource_models/${graphId}.json`), JSON.stringify(graph));
  writeFileSync(resolve(prebuildDir, `business_data/${graphId}.json`), JSON.stringify({ business_data: { resources: enrichedResources } }));
  writeFileSync(resolve(prebuildDir, 'manifest.json'), JSON.stringify({
    base_uri: namespace, source: slug, source_tag: slug.toUpperCase().slice(0, 2),
    built: '1970-01-01T00:00:00Z', license: 'CC0 (app-generated)',
  }));

  const outDir = resolve(root, `data/${outSlug}`);
  console.log(`[build-flag] ${slug}: running regen-layer-v2...`);
  execFileSync('cargo', [
    'run', '--release', '--example', 'regen-layer-v2', '--features', 'v2-emit',
    '--manifest-path', resolve(root, 'app/src-tauri', 'Cargo.toml'),
    '--', `data/prebuild-${slug}`, `data/${outSlug}`, graphId,
  ], { stdio: 'inherit' });
  console.log(`[build-flag] ${slug}: head at ${outDir}`);
  return graphId;
}

// --- PERSON (seeded with "User") ---
const personGraphCsv = readFileSync(resolve(root, 'models/person/graph.csv'), 'utf8');
const personNodesCsv = readFileSync(resolve(root, 'models/person/nodes.csv'), 'utf8');
const { graph: personGraph } = buildGraphFromModelCsvs(personGraphCsv, personNodesCsv, namespace, readFileSync(resolve(root, 'models/person/collections.csv'), 'utf8'));
const PERSON_RESOURCE_NS = uuidv5(`resource/${personGraph.graphid}`, ALIZARIN_NS);
const USER_UUID = uuidv5('user', PERSON_RESOURCE_NS);
console.log(`[build-flag] seeded User UUID: ${USER_UUID}`);

emitHead('person', 'models/person', 'ResourceID,name\nuser,User\n', 'person-v2', { name: '<Name>' });

// --- NOTE (one sample flag on baile, authored by User) ---
const noteCsv =
  'ResourceID,description,subject,author\n' +
  `note-sample-1,${csvEscape('Sampla nóta don bhaile · sample flag')},${SAMPLE_SUBJECT_UUID},${USER_UUID}\n`;
emitHead('note', 'models/note', noteCsv, 'note-v2', { name: '<Description>' });

console.log(`[build-flag] Done (${elapsed(t0)}). Seeded User: ${USER_UUID}`);
