/**
 * concept-emit.mjs — mint headword LexicalConcept resources into a corpus
 * prebuild as a SECOND model, so a corpus head (wiktionary, macbain) carries
 * `tiles_lexical_concept` next to its `tiles_lexical_entry`.
 *
 * A LexicalConcept groups a headword's per-POS LexicalEntries (POS-independent):
 *   ResourceID `goi-<normhead>-concept`, `concept_headword` = the entry UUIDs.
 * Both the WK pipeline and MacBain mint the SAME concept id (deterministic
 * `conceptUuid`), so the store's cross-layer tile merge UNIONS them: WK/MacBain
 * contribute `concept_headword` (grouping, deduped at hydrate); MacBain also
 * contributes etymology/cognates. See models/lexical_concept + the plan.
 *
 * Callers build a list of concept specs; this module turns them into the
 * repeated-rows business CSV, builds+enriches the resources, and writes the
 * concept graph + business_data into the given prebuild dir (merge: never
 * clobbers the corpus's own model files).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { makeRdmCache } from './rdm-cache.mjs';
import { uuidv5, ALIZARIN_NS, csvEscape } from './layers-data.mjs';
import {
  buildGraphFromModelCsvs, buildResourcesFromBusinessCsv,
  createResourceRegistry, parseStaticGraph,
} from '../../app/node_modules/alizarin/dist/alizarin.js';

const NAMESPACE = 'https://flaxandteal.org/ontology/goidelic#';
const LEX_GRAPH_ID = '449c8695-253e-521b-8994-27701ce22305';

/** Entry-resource UUID for a `goi-<...>` lexical_entry ResourceID (the same UUID
 * every lexical layer mints, so concept_headword points at the shared entries). */
export function goiUuid(rid) {
  return uuidv5(rid, uuidv5(`resource/${LEX_GRAPH_ID}`, ALIZARIN_NS));
}

/** Headword identity: NFC + casefold + grave/acute → macron (length-preserving).
 * MUST match the .mjs builders' local `normalizeHead` (build-place-layer /
 * build-macbain-layer: NFC + toLowerCase + macron, NO whitespace→hyphen and NO
 * punctuation strip) so the concept id a headword yields here equals the one
 * concept-v2 + MacBain each compute, and the tiles union. */
const MACRON = { 'à':'ā','á':'ā','è':'ē','é':'ē','ì':'ī','í':'ī','ò':'ō','ó':'ō','ù':'ū','ú':'ū' };
export function normalizeHead(text) {
  const s = (text || '').normalize('NFC').toLowerCase();
  return Array.from(s, (ch) => MACRON[ch] || ch).join('');
}

/** The concept ResourceID for a headword (POS-independent). */
export function conceptResourceId(headword) {
  return `goi-${normalizeHead(headword)}-concept`;
}

/** Build the lexical_concept graph + its deterministic uuid helpers. */
export function conceptGraph(root) {
  const { graph } = buildGraphFromModelCsvs(
    readFileSync(resolve(root, 'models/lexical_concept/graph.csv'), 'utf8'),
    readFileSync(resolve(root, 'models/lexical_concept/nodes.csv'), 'utf8'),
    NAMESPACE, null,
  );
  const graphId = graph.graphid;
  const CONCEPT_RESOURCE_NS = uuidv5(`resource/${graphId}`, ALIZARIN_NS);
  const conceptUuid = (rid) => uuidv5(rid, CONCEPT_RESOURCE_NS);
  return { graph, graphId, conceptUuid };
}

const CONCEPT_COLUMNS = [
  'ResourceID', 'label', 'concept_headword',
  'etymology_text', 'etymology_source',
  'cognate_headword', 'cognate_language', 'cognate_entry_id',
];

/**
 * Repeated-rows business CSV from concept specs. Each spec:
 *   { resourceId, label, headwordUuids: string[],
 *     etymology?: { text, source }, cognates?: [{ headword, language, entryId }] }
 * `headwordUuids` + `cognates` are card-n → one list item per row (row 0 carries
 * the scalars: label + etymology). `entryId` is a bare entry UUID (goiUuid).
 */
export function conceptBusinessCsv(specs) {
  const rows = [CONCEPT_COLUMNS.join(',')];
  const blank = (o) => CONCEPT_COLUMNS.map((c) => csvEscape(o[c] ?? '')).join(',');
  for (const s of specs) {
    const heads = s.headwordUuids || [];
    const cogs = s.cognates || [];
    const n = Math.max(1, heads.length, cogs.length);
    for (let i = 0; i < n; i++) {
      const row = { ResourceID: s.resourceId };
      if (i === 0) {
        row.label = s.label || '';
        if (s.etymology) { row.etymology_text = s.etymology.text; row.etymology_source = s.etymology.source; }
      }
      if (i < heads.length) row.concept_headword = heads[i];
      if (i < cogs.length) {
        row.cognate_headword = cogs[i].headword;
        row.cognate_language = cogs[i].language;
        if (cogs[i].entryId) row.cognate_entry_id = cogs[i].entryId;
      }
      rows.push(blank(row));
    }
  }
  return rows.join('\n') + '\n';
}

/**
 * Build the concept resources from specs and MERGE the lexical_concept model
 * (graph + business_data) into `prebuildDir` as a second model. Returns the
 * resource count. Mirrors the layer-emit "bake into a corpus prebuild" pattern.
 */
export function emitConceptsIntoPrebuild({ root, prebuildDir, specs, usingNapi, layerNamespace }) {
  const { graph, graphId } = conceptGraph(root);
  const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
  typedGraph.setDescriptorTemplate('name', '<Label>');

  const csv = conceptBusinessCsv(specs);
  const raw = buildResourcesFromBusinessCsv(
    csv, graph, [], 'en', false, layerNamespace, makeRdmCache([], root, usingNapi),
  );
  const resources = raw?.business_data?.resources || [];

  const reg = createResourceRegistry();
  reg.mergeFromResourcesJson(JSON.stringify(resources), true, true);
  const enriched = reg.populateCachesFromJson(JSON.stringify(resources), typedGraph, true, false, true).resources || resources;

  mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
  mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
  writeFileSync(resolve(prebuildDir, `graphs/resource_models/${graphId}.json`), JSON.stringify(graph));
  writeFileSync(resolve(prebuildDir, `business_data/${graphId}.json`), JSON.stringify({ business_data: { resources: enriched } }));
  return enriched.length;
}
