/**
 * Build core metadata bundle (no tiles, no pagefind).
 *
 * Usage: node scripts/build-core.mjs
 *
 * Produces: app/public/core-goidelic/
 *   - resource_models/_all.json
 *   - graphs/{id}.json (wrapped for alizarin)
 *   - collections/{id}.json
 *   - concept_hierarchy.json, concept_tree.bin, concept_intervals.bin
 *   - Empty ros-madair binaries: summary.bin, dictionary.bin,
 *     resource_map.bin, page_meta.json (from 0-resource build)
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

// --- Run ros-madair-build with 0 resources -> valid empty binaries ---

const buildBin = resolve(root, 'scripts/ros-madair-build');
if (!existsSync(buildBin)) {
  console.error('[build-core] ros-madair-build binary not found at', buildBin);
  process.exit(1);
}

const graphIds = Object.keys(allGraphMeta);
const pageSize = parseInt(process.env.ROS_MADAIR_PAGE_SIZE || '200', 10);
console.log(`\n[build-core] Running ros-madair-build (0 resources, page_size=${pageSize})...`);
try {
  execSync(
    `"${buildBin}" "${prebuildDir}" "${coreDir}" ${pageSize} "${namespace}"`,
    { stdio: 'inherit' }
  );
  console.log(`[build-core] Core built at ${coreDir}`);
} catch (e) {
  console.error('[build-core] ros-madair-build failed:', e.message);
  process.exit(1);
}

// Wrap graph JSON for alizarin
for (const graphId of graphIds) {
  const graphFile = resolve(coreDir, `graphs/${graphId}.json`);
  if (!existsSync(graphFile)) continue;
  const rawGraph = JSON.parse(readFileSync(graphFile, 'utf8'));
  if (!rawGraph.graph) {
    writeFileSync(graphFile, JSON.stringify({ graph: [rawGraph] }));
    console.log(`[build-core] Wrapped graph ${graphId} for alizarin`);
  }
}

console.log(`\n[build-core] Total: ${elapsed(t0)}`);
console.log(`[build-core] Output: ${coreDir}`);
