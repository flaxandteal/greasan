/**
 * Build Wiktionary layer as a tar.gz package.
 *
 * Usage: node scripts/build-wiktionary-layer.mjs [--fixture]
 *
 * Output: data/wiktionary-layer.tar.gz
 *
 * Process:
 *   1. alizarin: model CSVs + business CSV -> graphs + resources
 *   2. populateCaches for descriptors
 *   3. ros-madair-build: prebuild -> binary index
 *   4. Pagefind indices for headword + gloss + example search
 *   5. tar.gz the result
 *
 * Metadata (graphs, collections, _all.json) is NOT written here —
 * that's build-core.mjs's job. This script only produces data artifacts.
 */

import { createRequire } from 'module';
import { initWasm, buildGraphFromModelCsvs, buildResourcesFromBusinessCsv, collectionsToSkosXml, createResourceRegistry, parseStaticGraph, setNapiModule, setBackend } from '../app/node_modules/alizarin/dist/alizarin.js';
import * as pagefind from '../app/node_modules/pagefind/lib/index.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const fixture = process.argv.includes('--fixture');
const namespace = 'https://flaxandteal.org/ontology/goidelic#';

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }

/** Strip diacritics (fadas, graves) for accent-insensitive search. */
function stripDiacritics(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

// Try NAPI first (native Rust — handles all operations).
// Fall back to WASM if NAPI unavailable.
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  setNapiModule(napi);
  usingNapi = true;
  console.log('[build-wiktionary] Using NAPI backend (native Rust)');
} catch (e) {
  console.log(`[build-wiktionary] NAPI not available (${e.message?.split('\n')[0]}), falling back to WASM`);
  await initWasm();
}

const t0 = performance.now();

// --- Model definitions ---
// Build order matters: external_example first (entries reference examples)

const models = [
  {
    name: 'external_example',
    dir: 'models/external_example',
    bdFile: fixture
      ? 'data/processed/fixture_example_data.csv'
      : 'data/processed/example_data.csv',
    descriptors: {
      name: '<Sentence>',
      description: '<English Translation>',
      slug: '<Source>:<Source ID>:<Highlights>',
    },
  },
  {
    name: 'lexical_entry',
    dir: 'models/lexical_entry',
    bdFile: fixture
      ? 'data/processed/fixture_lexical_entry_data.csv'
      : 'data/processed/lexical_entry_data.csv',
    descriptors: {
      name: '<Headword>',
      description: '<Gloss>',
      // `slug` carries the part_of_speech REFERENCE (concept UUID) so the Pagefind
      // builder can resolve it to a POS label via the controlled-list collection
      // (the CLM vocab) — mediated by the reference system, not the raw CSV string.
      // Nothing reads a lexical entry's slug (only layer slugs are consumed), so
      // this is a safe, search-only repurpose.
      slug: '<Part of Speech>',
    },
  },
];

// --- Build all models ---

const allGraphMeta = {};     // graphId -> meta for _all.json
const allCollections = [];   // all collections across models
const allResources = {};     // graphId -> resources array
const allGraphObjs = {};     // graphId -> plain graph object
const allTypedGraphs = {};    // graphId -> StaticGraph (NAPI or WASM, for populateCaches)

const prebuildDir = resolve(root, 'data/prebuild-wiktionary');
mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });

for (const model of models) {
  const tModel = performance.now();
  console.log(`\n[build-wiktionary] === ${model.name} ===`);

  // Check if business data exists
  const bdPath = resolve(root, model.bdFile);
  if (!existsSync(bdPath)) {
    console.log(`[build-wiktionary] Skipping ${model.name}: ${model.bdFile} not found`);
    continue;
  }

  // 1. Build graph from model CSVs
  const graphCsv = readFileSync(resolve(root, model.dir, 'graph.csv'), 'utf8');
  const nodesCsv = readFileSync(resolve(root, model.dir, 'nodes.csv'), 'utf8');
  const collectionsCsvPath = resolve(root, model.dir, 'collections.csv');
  const collectionsCsv = existsSync(collectionsCsvPath)
    ? readFileSync(collectionsCsvPath, 'utf8')
    : null;

  const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
  const graphId = graph.graphid;
  console.log(`[build-wiktionary] Graph: ${graphId}`);
  console.log(`[build-wiktionary] Collections: ${collections.length}`);

  // 2. Build backend-appropriate StaticGraph and set descriptor templates (if any)
  const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
  if (model.descriptors) {
    for (const [type, template] of Object.entries(model.descriptors)) {
      typedGraph.setDescriptorTemplate(type, template);
    }
    console.log(`[build-wiktionary] Descriptor templates set for ${model.name}`);
  }

  // 3. Build resources from business data CSV
  const tBd = performance.now();
  const bdCsv = readFileSync(bdPath, 'utf8');
  // Layer-specific UUID namespace so tile IDs don't collide with other layers
  // (uuid5 of alizarin base namespace + "layer/wiktionary-goidelic")
  const layerNamespace = '020572f1-e1c6-53dd-b743-8a7b9112f4a3';
  const result = buildResourcesFromBusinessCsv(bdCsv, graph, collections, 'en', false, layerNamespace);
  const resources = result?.business_data?.resources || [];
  console.log(`[build-wiktionary] Built ${resources.length} resources (${elapsed(tBd)})`);

  // 4. Migrate concept/concept-list -> reference
  for (const node of graph.nodes) {
    if (node.datatype === 'concept-list') {
      node.datatype = 'reference';
      node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection };
      console.log(`[build-wiktionary] Migrated ${node.alias}: concept-list -> reference (multiValue)`);
    } else if (node.datatype === 'concept') {
      node.datatype = 'reference';
      node.config = { ...node.config, controlledList: node.config?.rdmCollection };
      console.log(`[build-wiktionary] Migrated ${node.alias}: concept -> reference`);
    }
  }

  // Store
  allGraphMeta[graphId] = {
    graphid: graph.graphid,
    name: graph.name,
    iconclass: graph.iconclass,
    isresource: graph.isresource,
    slug: graph.slug,
  };
  allCollections.push(...collections);
  allResources[graphId] = resources;
  allGraphObjs[graphId] = graph;
  allTypedGraphs[graphId] = typedGraph;

  // Write graph to prebuild
  writeFileSync(
    resolve(prebuildDir, `graphs/resource_models/${graphId}.json`),
    JSON.stringify(graph)
  );
  writeFileSync(
    resolve(prebuildDir, `business_data/${graphId}.json`),
    JSON.stringify({ business_data: { resources } })
  );

  // Write collection SKOS XML + JSON to prebuild reference_data
  for (const collection of collections) {
    const cid = collection.collectionid || collection.id;
    if (cid) {
      // JSON
      writeFileSync(
        resolve(prebuildDir, `reference_data/collections/${cid}.json`),
        JSON.stringify(collection)
      );
      // XML
      try {
        const xml = collectionsToSkosXml([collection], namespace);
        writeFileSync(
          resolve(prebuildDir, `reference_data/collections/${cid}.xml`),
          xml
        );
      } catch (e) {
        console.warn(`[build-wiktionary] SKOS XML failed for ${cid}: ${e.message}`);
      }
    }
  }
}

// --- populateCaches: compute descriptors and embed references ---

const graphIds = Object.keys(allResources);
console.log(`\n[build-wiktionary] === populateCaches (${graphIds.length} graphs) ===`);

// Phase 1: Register all resources in registry (summaries for cross-graph resolution)
const tReg = performance.now();
const registry = createResourceRegistry();
for (const graphId of graphIds) {
  const resources = allResources[graphId];
  if (!resources.length) continue;
  registry.mergeFromResourcesJson(JSON.stringify(resources), true, true);
  console.log(`[build-wiktionary] Registered ${graphId} (${resources.length} resources)`);
}
console.log(`[build-wiktionary] Registry phase: ${elapsed(tReg)}`);

// Build RDM cache for concept UUID -> label resolution
let rdmCache = null;
if (usingNapi) {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  rdmCache = new napi.NapiRdmCache();
  for (const collection of allCollections) {
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
  console.log(`[build-wiktionary] RDM cache loaded with ${allCollections.length} collections`);
}

// Phase 2: Compute descriptors + enrich relationships in one pass
for (const graphId of graphIds) {
  const tCache = performance.now();
  const typedGraph = allTypedGraphs[graphId];
  const resources = allResources[graphId];
  if (!resources.length) continue;

  const result = registry.populateCachesFromJson(
    JSON.stringify(resources), typedGraph, true, false, true
  );
  if (result.hasUnknown && result.unknownReferences?.length) {
    console.warn(`[build-wiktionary] ${graphId}: ${result.unknownReferences.length} unknown references`);
  }
  allResources[graphId] = result.resources || resources;
  console.log(`[build-wiktionary] Descriptors + caches for ${graphId}: ${(result.resources || []).length} resources (${elapsed(tCache)})`);

  // Re-merge so downstream consumers see enriched data
  registry.mergeFromResourcesJson(JSON.stringify(allResources[graphId]), true);
}

// --- Write updated business data (with caches) ---

for (const graphId of graphIds) {
  const resources = allResources[graphId];
  writeFileSync(
    resolve(prebuildDir, `business_data/${graphId}.json`),
    JSON.stringify({ business_data: { resources } })
  );
}

console.log(`[build-wiktionary] Prebuild written to ${prebuildDir}`);

// --- Run ros-madair-build ---

const outputDir = resolve(root, fixture ? 'data/wiktionary-fixture-index' : 'data/wiktionary-index');
mkdirSync(outputDir, { recursive: true });

const buildBin = resolve(root, 'scripts/ros-madair-build');
if (!existsSync(buildBin)) {
  console.error('[build-wiktionary] ros-madair-build binary not found at', buildBin);
  process.exit(1);
}

const pageSize = parseInt(process.env.ROS_MADAIR_PAGE_SIZE || '200', 10);
console.log(`\n[build-wiktionary] Running ros-madair-build (page_size=${pageSize})...`);
console.log(`[build-wiktionary] Graphs: ${graphIds.length}, Collections: ${allCollections.length}`);
try {
  execSync(
    `"${buildBin}" "${prebuildDir}" "${outputDir}" ${pageSize} "${namespace}"`,
    { stdio: 'inherit' }
  );
  console.log(`[build-wiktionary] Index built at ${outputDir}`);
} catch (e) {
  console.error('[build-wiktionary] ros-madair-build failed:', e.message);
  process.exit(1);
}

// --- Wrap graph JSON for alizarin ---
for (const graphId of graphIds) {
  const graphFile = resolve(outputDir, `graphs/${graphId}.json`);
  if (!existsSync(graphFile)) continue;
  const rawGraph = JSON.parse(readFileSync(graphFile, 'utf8'));
  if (!rawGraph.graph) {
    writeFileSync(graphFile, JSON.stringify({ graph: [rawGraph] }));
    console.log(`[build-wiktionary] Wrapped graph ${graphId} for alizarin`);
  }
}

// --- Build pagefind search indices from descriptor-enriched resources ---

const lexicalGraphId = Object.entries(allGraphMeta).find(([_, m]) => m.slug === 'lexical_entry')?.[0];
const exampleGraphId = Object.entries(allGraphMeta).find(([_, m]) => m.slug === 'external_example')?.[0];

if (lexicalGraphId) {
  const tPf = performance.now();
  console.log(`\n[build-wiktionary] === Pagefind search indices ===`);

  const lexicalResources = allResources[lexicalGraphId];
  console.log(`[build-wiktionary] Lexical entries: ${lexicalResources.length}`);

  const DIALECT_LABEL_TO_CODE = {
    'Irish': 'GA',
    'Irish (General)': 'GA',
    'Connacht Irish': 'GA.CON',
    'Connemara Irish': 'GA.CON',
    'Ulster Irish': 'GA.ULS',
    'Donegal Irish': 'GA.ULS',
    'Munster Irish': 'GA.MUN',
    'Kerry Irish': 'GA.MUN',
    'Waterford Irish': 'GA.MUN',
    'Scottish Gaelic': 'GD',
    'Scottish Gaelic (General)': 'GD',
    'Highland Gaelic': 'GD.HLD',
    'Hebridean Gaelic': 'GD.HEB',
    'Argyll Gaelic': 'GD.ARG',
    'Manx': 'GV',
    'Manx (General)': 'GV',
    'Scots (General)': 'SCO',
    'Ulster Scots': 'SCO.ULS',
  };

  const dialectValueIndex = registry.getValueToResourcesIndex(
    allTypedGraphs[lexicalGraphId], 'dialect', true, rdmCache
  );
  console.log(`[build-wiktionary] dialectValueIndex keys:`, Object.keys(dialectValueIndex));
  const resourceDialectCodes = {};
  for (const [label, resourceIds] of Object.entries(dialectValueIndex)) {
    const subLabels = label.split('|');
    const codes = subLabels.map(l => DIALECT_LABEL_TO_CODE[l.trim()] || l.trim());
    for (const rid of resourceIds) {
      if (!resourceDialectCodes[rid]) resourceDialectCodes[rid] = new Set();
      for (const code of codes) resourceDialectCodes[rid].add(code);
    }
  }
  console.log(`[build-wiktionary] Dialect codes mapped for ${Object.keys(resourceDialectCodes).length} resources`);
  const codeDist = {};
  for (const codes of Object.values(resourceDialectCodes)) {
    for (const code of codes) {
      codeDist[code] = (codeDist[code] || 0) + 1;
    }
  }
  console.log(`[build-wiktionary] Dialect code distribution:`, codeDist);

  function getDialectCodes(resource) {
    const uuid = resource.resourceinstance?.resourceinstanceid;
    const codes = resourceDialectCodes[uuid];
    return codes ? [...codes] : ['GA'];
  }

  // POS label per resource — resolved from the part_of_speech REFERENCE (carried on
  // descriptors.slug) through the controlled-list collection vocab (the CLM data),
  // so search can distinguish e.g. baile-noun from baile-adjective.
  const conceptToLabel = {};
  for (const c of allCollections) {
    for (const [id, con] of Object.entries(c.__allConcepts || {})) {
      const pl = con?.prefLabels || {};
      conceptToLabel[id] = pl.en?.value || pl[Object.keys(pl)[0]]?.value || '';
    }
  }
  const posOf = (ri) => conceptToLabel[ri?.descriptors?.slug] || '';

  // Create per-language pagefind indices
  const { index: gaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
  const { index: enIndex } = await pagefind.createIndex({ forceLanguage: 'en' });
  const { index: samplaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });

  if (!gaIndex || !enIndex || !samplaIndex) {
    console.error('[build-wiktionary] Failed to create pagefind indices');
    process.exit(1);
  }

  let gaCount = 0, enCount = 0, samplaCount = 0;
  const total = lexicalResources.length;

  for (const resource of lexicalResources) {
    const ri = resource.resourceinstance;
    const uuid = ri?.resourceinstanceid;
    const headword = ri?.name;
    if (!headword || !uuid) continue;

    const gloss = ri?.descriptors?.description || '';
    const pos = posOf(ri);
    const dialectCodes = getDialectCodes(resource);
    const dialectDisplay = dialectCodes.reduce((a, b) => a.length >= b.length ? a : b, '');

    // Ceannfhocail (ga) — headword search
    const headwordNorm = stripDiacritics(headword);
    await gaIndex.addCustomRecord({
      url: uuid,
      content: headword === headwordNorm ? headword : `${headword} ${headwordNorm}`,
      language: 'ga',
      meta: { title: headword, gloss, dialect: dialectDisplay, pos },
      filters: { dialect: dialectCodes },
    });
    gaCount++;

    if (gaCount % 5000 === 0) {
      process.stderr.write(`\r[build-wiktionary] Pagefind: ${gaCount}/${total} entries...`);
    }

    // Gluais (en) — gloss search
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

    // Samplai — collect example sentences from __cache
    const examples = [];
    const cache = resource.__cache;
    if (cache && exampleGraphId) {
      for (const tileCache of Object.values(cache)) {
        if (!tileCache || typeof tileCache !== 'object') continue;
        for (const nodeCache of Object.values(tileCache)) {
          if (!nodeCache || typeof nodeCache !== 'object') continue;
          const entries = nodeCache._ || [];
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (entry?.graphId !== exampleGraphId && entry?.type !== exampleGraphId) continue;
            const sentence = entry?.descriptors?.name;
            if (sentence) examples.push(sentence);
          }
        }
      }
    }

    if (examples.length > 0) {
      const exampleText = examples.join(' ');
      const exampleTextNorm = stripDiacritics(exampleText);
      await samplaIndex.addCustomRecord({
        url: uuid,
        content: exampleText === exampleTextNorm ? exampleText : `${exampleText} ${exampleTextNorm}`,
        language: 'ga',
        meta: { title: headword, gloss, dialect: dialectDisplay },
        filters: { dialect: dialectCodes },
      });
      samplaCount++;
    }
  }

  if (total >= 5000) process.stderr.write('\n');
  console.log(`[build-wiktionary] Pagefind indexing: ${elapsed(tPf)}`);
  console.log(`[build-wiktionary] Pagefind records: ga=${gaCount}, en=${enCount}, sampla=${samplaCount}`);

  const tWrite = performance.now();
  await gaIndex.writeFiles({ outputPath: resolve(outputDir, 'pagefind-ga') });
  await enIndex.writeFiles({ outputPath: resolve(outputDir, 'pagefind-en') });
  await samplaIndex.writeFiles({ outputPath: resolve(outputDir, 'pagefind-sampla') });

  // Zip each pagefind directory for on-device use via Tauri pfzip protocol.
  const tZip = performance.now();
  for (const dir of ['pagefind-ga', 'pagefind-en', 'pagefind-sampla']) {
    const src = resolve(outputDir, dir);
    const dest = resolve(outputDir, `${dir}.zip`);
    if (existsSync(src)) {
      execSync(`cd "${src}" && zip -0 -q -r "${dest}" .`);
      console.log(`[build-wiktionary] Zipped ${dir}`);
    }
  }
  console.log(`[build-wiktionary] Pagefind zip: ${elapsed(tZip)}`);
  console.log(`[build-wiktionary] Pagefind write: ${elapsed(tWrite)}`);
  console.log(`[build-wiktionary] Pagefind total: ${elapsed(tPf)}`);
} else {
  console.warn('[build-wiktionary] No lexical_entry graph found, skipping pagefind');
}

// --- Zip bulk data and remove extracted directories ---
// Tiles and pages are served from zip at runtime (via rmindex protocol).
// Pagefind is served from zip via pfzip protocol. Remove extracted dirs to
// keep the tar.gz small (~25 entries instead of ~89k).

for (const dir of ['tiles', 'pages']) {
  const src = resolve(outputDir, dir);
  const dest = resolve(outputDir, `${dir}.zip`);
  if (existsSync(src)) {
    try {
      execSync(`cd "${src}" && zip -0 -q -r "${dest}" .`);
      console.log(`[build-wiktionary] Zipped ${dir} → ${dir}.zip`);
    } catch {
      console.log(`[build-wiktionary] ${dir}/ empty or zip failed, skipping zip`);
    }
    execSync(`rm -rf "${src}"`);
  }
}
for (const dir of ['pagefind-ga', 'pagefind-en', 'pagefind-sampla']) {
  const src = resolve(outputDir, dir);
  if (existsSync(src)) {
    execSync(`rm -rf "${src}"`);
  }
}

// --- Package as tar.gz ---

const tarFile = resolve(root, fixture ? 'data/wiktionary-fixture-layer.tar.gz' : 'data/wiktionary-layer.tar.gz');
console.log(`\n[build-wiktionary] Packaging ${tarFile}...`);
execSync(`tar -czf "${tarFile}" -C "${outputDir}" .`);

console.log(`[build-wiktionary] Done (${elapsed(t0)})`);
console.log(`[build-wiktionary] Output: ${tarFile}`);
