/**
 * Build core metadata bundle (no tiles, no pagefind).
 *
 * Usage: node scripts/build-core.mjs
 *
 * Produces: app/public/core-goidelic/
 *   - resource_models/_all.json
 *   - graphs/{id}.json (wrapped for alizarin)
 *   - collections/{id}.json
 *   - concept_hierarchy.json (flat collection-id index for the app)
 *
 * Schema-only, written entirely from Node - no v1 ros-madair-build step.
 * The core bundle carries no tiles/pages/summary.bin (nothing consumes them);
 * data comes from v2 layers installed via Settings.
 *
 * This is the schema-only bundle that the app loads on startup.
 * Actual data comes from layers (Wiktionary, Tearma, etc.) installed via Settings.
 */

import { createRequire } from 'module';
import {
  initWasm,
  buildGraphFromModelCsvs,
  collectionsToSkosXml,
  parseStaticGraph,
  setNapiModule,
} from '../app/node_modules/alizarin/dist/alizarin.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const namespace = 'https://flaxandteal.org/ontology/goidelic#';

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }

// NAPI or WASM backend
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  setNapiModule(napi);
  usingNapi = true;
  console.log('[build-core] Using NAPI backend');
} catch (e) {
  console.log(`[build-core] NAPI not available (${e.message?.split('\n')[0]}), falling back to WASM`);
  await initWasm();
}

const t0 = performance.now();

// --- Model definitions (same as build-index.mjs, but no business data needed) ---

const models = [
  {
    name: 'external_example',
    dir: 'models/external_example',
    descriptors: {
      name: '<Sentence>',
      description: '<English Translation>',
      slug: '<Source>:<Source ID>:<Highlights>',
    },
  },
  {
    name: 'lexical_entry',
    dir: 'models/lexical_entry',
    descriptors: {
      name: '<Headword>',
      description: '<Gloss>',
    },
  },
];

// --- Build all models (graph + collections only, no business data) ---

const allGraphMeta = {};
const allCollections = [];
const allGraphObjs = {};

const prebuildDir = resolve(root, 'data/prebuild-core');
mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });

for (const model of models) {
  console.log(`\n[build-core] === ${model.name} ===`);

  const graphCsv = readFileSync(resolve(root, model.dir, 'graph.csv'), 'utf8');
  const nodesCsv = readFileSync(resolve(root, model.dir, 'nodes.csv'), 'utf8');
  const collectionsCsvPath = resolve(root, model.dir, 'collections.csv');
  const collectionsCsv = existsSync(collectionsCsvPath)
    ? readFileSync(collectionsCsvPath, 'utf8')
    : null;

  const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
  const graphId = graph.graphid;
  console.log(`[build-core] Graph: ${graphId}`);
  console.log(`[build-core] Collections: ${collections.length}`);

  // Migrate concept/concept-list -> reference (same as build-index.mjs)
  for (const node of graph.nodes) {
    if (node.datatype === 'concept-list') {
      node.datatype = 'reference';
      node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection };
      console.log(`[build-core] Migrated ${node.alias}: concept-list -> reference (multiValue)`);
    } else if (node.datatype === 'concept') {
      node.datatype = 'reference';
      node.config = { ...node.config, controlledList: node.config?.rdmCollection };
      console.log(`[build-core] Migrated ${node.alias}: concept -> reference`);
    }
  }

  allGraphMeta[graphId] = {
    graphid: graph.graphid,
    name: graph.name,
    iconclass: graph.iconclass,
    isresource: graph.isresource,
    slug: graph.slug,
  };
  allCollections.push(...collections);
  allGraphObjs[graphId] = graph;

  // Write graph to prebuild (ros-madair-build needs them)
  writeFileSync(
    resolve(prebuildDir, `graphs/resource_models/${graphId}.json`),
    JSON.stringify(graph)
  );

  // Write empty business data (ros-madair-build expects the file)
  writeFileSync(
    resolve(prebuildDir, `business_data/${graphId}.json`),
    JSON.stringify({ business_data: { resources: [] } })
  );

  // Write collection SKOS XML + JSON to prebuild
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
        console.warn(`[build-core] SKOS XML failed for ${cid}: ${e.message}`);
      }
    }
  }
}

// --- Write alizarin metadata to core output ---

const coreDir = resolve(root, 'app/public/core-goidelic');
mkdirSync(coreDir, { recursive: true });
mkdirSync(resolve(coreDir, 'resource_models'), { recursive: true });
mkdirSync(resolve(coreDir, 'collections'), { recursive: true });
mkdirSync(resolve(coreDir, 'graphs'), { recursive: true });

// _all.json
writeFileSync(
  resolve(coreDir, 'resource_models/_all.json'),
  JSON.stringify({ models: allGraphMeta })
);

// Collection JSON files
for (const collection of allCollections) {
  const cid = collection.collectionid || collection.id;
  if (cid) {
    writeFileSync(
      resolve(coreDir, `collections/${cid}.json`),
      JSON.stringify(collection)
    );
  }
}

// --- Graph JSON (wrapped for alizarin), written directly ---
// The v1 ros-madair-build binary used to copy these out of the prebuild and
// emit empty pages/tiles/summary.bin. The core bundle is schema-only and
// nothing consumes those artifacts (load_core_graph reads graphs/{id}.json;
// load_core_collections reads concept_hierarchy.json + collections/{id}.json),
// so we write the graphs straight from the in-memory objects and skip the v1
// build entirely.
for (const [graphId, graph] of Object.entries(allGraphObjs)) {
  writeFileSync(
    resolve(coreDir, `graphs/${graphId}.json`),
    JSON.stringify({ graph: [graph] })
  );
}

// --- concept_hierarchy.json: the collection-id index the app reads to
// enumerate core collections. collect_collection_ids (builder_plugin.rs)
// harvests any bare-UUID string, so a flat id list suffices. ---
const coreCollectionIds = [
  ...new Set(allCollections.map((c) => c.collectionid || c.id).filter(Boolean)),
];
writeFileSync(
  resolve(coreDir, 'concept_hierarchy.json'),
  JSON.stringify(coreCollectionIds)
);
console.log(
  `[build-core] Core built at ${coreDir} ` +
    `(${Object.keys(allGraphObjs).length} graphs, ${coreCollectionIds.length} collections; v2, no ros-madair-build)`
);

console.log(`\n[build-core] Total: ${elapsed(t0)}`);
console.log(`[build-core] Output: ${coreDir}`);
