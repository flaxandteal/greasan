/**
 * layer-emit.mjs — the shared Layer-catalogue emitter.
 *
 * Builds enriched Layer resources from the catalogue metadata (layers-data.mjs)
 * and writes them into a prebuild dir ready for regen-parquet-v2. Two callers:
 *
 *   - build-layer-catalogue.mjs — the FULL (or --skeleton) `layer-v2` META head:
 *     every Layer resource, fresh prebuild at data/prebuild-layer.
 *   - build-parquet-layers.mjs  — BAKES a single `layer-<slug>` resource INTO a
 *     corpus head's prebuild (merge mode) so the head emits a `tiles_layer.parquet`
 *     carrying its own fuller Layer resource. On install, the store's cross-layer
 *     tile merge (hydrateLayers, topmost wins) lets that resource override the
 *     skeleton's placeholder entry in the shipped catalogue.
 *
 * Identity is load-bearing: both the skeleton and a baked fragment MUST mint the
 * SAME `layer-<slug>` ResourceID *and* the SAME tile ids, or the merge supplements
 * instead of overriding. Both share LAYER_NAMESPACE (uuidv5('layer/catalogue')),
 * which this module owns — do not vary it per caller.
 */
import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { makeRdmCache } from './rdm-cache.mjs';
import { buildBusinessCsv, uuidv5, ALIZARIN_NS } from './layers-data.mjs';
import {
  initWasm, buildGraphFromModelCsvs, buildResourcesFromBusinessCsv,
  createResourceRegistry, parseStaticGraph, setNapiModule, collectionsToSkosXml,
} from '../../app/node_modules/alizarin/dist/alizarin.js';

export const LAYER_NAMESPACE = uuidv5('layer/catalogue', ALIZARIN_NS);
export const NAMESPACE = 'https://flaxandteal.org/ontology/goidelic#';

/** Init the alizarin backend (NAPI if present, else WASM). Idempotent-ish: call
 * once per process. Returns whether NAPI is in use (affects rdm-cache). */
export async function initBackend(root) {
  try {
    const require = createRequire(resolve(root, 'app/package.json'));
    setNapiModule(require('@alizarin/napi'));
    return true;
  } catch {
    await initWasm();
    return false;
  }
}

/**
 * Build the enriched Layer resources for `layers` (defaults to the full set) and
 * the (datatype-fixed) Layer graph + collections. `countResources(head)` yields
 * each layer's resource_count; `bundleTag` bakes greasan-data install URLs.
 *
 * Returns { graphId, graph, collections, enriched } — `graph.nodes` already has
 * concept/concept-list datatypes rewritten to `reference` (as the emitter needs).
 */
export function buildLayerArtifacts({ root, layers, countResources, bundleTag, usingNapi }) {
  const graphCsv = readFileSync(resolve(root, 'models/layer/graph.csv'), 'utf8');
  const nodesCsv = readFileSync(resolve(root, 'models/layer/nodes.csv'), 'utf8');
  const collectionsCsv = readFileSync(resolve(root, 'models/layer/collections.csv'), 'utf8');
  const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, NAMESPACE, collectionsCsv);
  const graphId = graph.graphid;

  const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
  typedGraph.setDescriptorTemplate('name', '<Name>');

  const businessCsv = buildBusinessCsv(layers, countResources, { bundleTag });
  const result = buildResourcesFromBusinessCsv(
    businessCsv, graph, collections, 'en', false, LAYER_NAMESPACE, makeRdmCache(collections, root, usingNapi),
  );
  const resources = result?.business_data?.resources || [];

  for (const node of graph.nodes) {
    if (node.datatype === 'concept-list') { node.datatype = 'reference'; node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection }; }
    else if (node.datatype === 'concept') { node.datatype = 'reference'; node.config = { ...node.config, controlledList: node.config?.rdmCollection }; }
  }

  const registry = createResourceRegistry();
  registry.mergeFromResourcesJson(JSON.stringify(resources), true, true);
  const cacheResult = registry.populateCachesFromJson(JSON.stringify(resources), typedGraph, true, false, true);
  const enriched = cacheResult.resources || resources;

  return { graphId, graph, collections, enriched, businessCsv };
}

/**
 * Write the Layer model (graph + business_data + collections) into `prebuildDir`.
 *
 * `merge`:
 *   - false (default): fresh catalogue prebuild — caller is responsible for the
 *     rm -rf; we create dirs and also write a manifest.json.
 *   - true: BAKE into an existing corpus prebuild — add only the Layer graph /
 *     business_data / collections files, never touch the corpus's own files or
 *     manifest. emit_parquet then emits the corpus tiles AND tiles_layer.
 */
export function writeLayerPrebuild(prebuildDir, { graphId, graph, enriched, collections }, { merge = false } = {}) {
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
      writeFileSync(resolve(prebuildDir, `reference_data/collections/${cid}.xml`), collectionsToSkosXml([collection], NAMESPACE));
    } catch (e) { console.warn(`[layer-emit] SKOS XML failed for ${cid}: ${e.message}`); }
  }
  if (!merge) {
    writeFileSync(resolve(prebuildDir, 'manifest.json'), JSON.stringify({
      base_uri: NAMESPACE, source: 'layer', source_tag: 'LY',
      built: '1970-01-01T00:00:00Z', license: 'CC0 (app-generated catalogue)',
    }));
  }
}

/** Resources in a prebuild's business_data file, i.e. the real resource_count of
 * the head that prebuild will emit. Reads the given graph id's business_data json
 * (the corpus primary model). Returns '' if unavailable. */
export function countPrebuildResources(prebuildDir, graphId) {
  try {
    const j = JSON.parse(readFileSync(resolve(prebuildDir, `business_data/${graphId}.json`), 'utf8'));
    const n = j?.business_data?.resources?.length;
    return Number.isFinite(n) ? String(n) : '';
  } catch { return ''; }
}
