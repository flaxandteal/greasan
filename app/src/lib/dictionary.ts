import { client, graphManager, staticStore, RDM } from 'alizarin';
import { SparqlStore } from 'ros-madair';
import { ready } from './wasm';

const INDEX_BASE = '/index/';
const GRAPH_ID = '449c8695-253e-521b-8994-27701ce22305';
const EXAMPLE_GRAPH_ID = '6d502e2e-7fe6-5414-99e4-ac981cebc493';
const RDF_BASE = 'https://flaxandteal.org/ontology/ga-wiktionary#';

export interface EntrySummary {
  uri: string;
  headword: string;
  pos: string;
}

export interface ExternalExample {
  ga: string;
  en: string;
  src: 'tatoeba' | 'gaois';
  id?: string;
  hl: [number, number][];
}

export interface EntryDetail {
  uri: string;
  headword: string;
  pos: string;
  senses: Array<{ gloss: string; examples: string[] }>;
  forms: Array<{ writtenRep: string; tags: string[] }>;
  ipa: string[];
  externalExamples: ExternalExample[];
}

// Exported for debug console access
export let sparqlStore: SparqlStore | null = null;
let storeReady = false;
let resourceIndex: EntrySummary[] | null = null;
let modelPromise: ReturnType<typeof graphManager.loadGraph> | null = null;

// Map concept UUIDs to source labels (populated at build time)
// These are deterministic from the collections.csv for the ExternalExample graph
let sourceConceptMap: Record<string, 'tatoeba' | 'gaois'> | null = null;

async function ensureStore(): Promise<SparqlStore> {
  if (sparqlStore && storeReady) return sparqlStore;

  await ready;

  sparqlStore = new SparqlStore(INDEX_BASE);
  // Expose on window for debug
  (window as any).sparqlStore = sparqlStore;

  const archesClient = new client.ArchesClientRemoteStatic(INDEX_BASE, {
    graphIdToGraphFile: (graphId: string) => `graphs/${graphId}.json`,
  });
  graphManager.archesClient = archesClient;
  staticStore.archesClient = archesClient;
  RDM.archesClient = archesClient;

  try {
    await sparqlStore.load_summary();
  } catch (err) {
    console.warn('[dictionary] load_summary partial failure (concept intervals?):', err);
  }

  await graphManager.initialize();

  // Pre-load the graph model (needed for alias-based access)
  modelPromise = graphManager.loadGraph(GRAPH_ID);

  storeReady = true;
  return sparqlStore;
}

async function loadResourceIndex(): Promise<EntrySummary[]> {
  if (resourceIndex) return resourceIndex;

  const resp = await fetch(`${INDEX_BASE}resource_names.json`);
  if (!resp.ok) throw new Error(`Failed to load resource_names.json: ${resp.status}`);
  const names: Record<string, string> = await resp.json();

  resourceIndex = Object.entries(names).map(([uuid, name]) => ({
    uri: uuid,
    headword: name,
    pos: '',
  }));
  return resourceIndex;
}

/** Build source concept UUID → label map from the Example Sources collection. */
async function ensureSourceConceptMap(): Promise<Record<string, 'tatoeba' | 'gaois'>> {
  if (sourceConceptMap) return sourceConceptMap;

  sourceConceptMap = {};
  try {
    // Load all collections and find "Example Sources"
    const collections = await RDM.getCollections?.() || [];
    for (const coll of collections) {
      const concepts = coll?.concepts || coll?.__allConcepts;
      if (!concepts) continue;
      const conceptList = concepts instanceof Map ? [...concepts.values()] : Object.values(concepts);
      for (const concept of conceptList) {
        const label = (concept?.label || concept?.prefLabel || '').toLowerCase();
        const id = concept?.conceptid || concept?.id;
        if (id && label === 'tatoeba') sourceConceptMap[id] = 'tatoeba';
        else if (id && label === 'gaois') sourceConceptMap[id] = 'gaois';
      }
    }
  } catch {
    // Fallback: map will be empty, source will default to 'tatoeba'
  }
  return sourceConceptMap;
}

/** Extract ExternalExample[] from __cache on an entry resource. */
function extractExamplesFromCache(cache: any): ExternalExample[] {
  if (!cache || typeof cache !== 'object') return [];

  const examples: ExternalExample[] = [];
  for (const tileCache of Object.values(cache as Record<string, any>)) {
    if (!tileCache || typeof tileCache !== 'object') continue;
    for (const nodeCache of Object.values(tileCache as Record<string, any>)) {
      if (!nodeCache || typeof nodeCache !== 'object') continue;
      // resource-instance-list entries have a _ array
      const entries = (nodeCache as any)._ || [];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        // Only process entries from the example graph
        if (entry?.graphId !== EXAMPLE_GRAPH_ID && entry?.type !== EXAMPLE_GRAPH_ID) continue;
        const desc = entry?.descriptors;
        if (!desc?.name) continue;

        // Parse slug: "conceptUUID:source_id:highlights"
        const slug = desc.slug || '';
        const firstColon = slug.indexOf(':');
        const secondColon = firstColon >= 0 ? slug.indexOf(':', firstColon + 1) : -1;

        let srcConceptId = '';
        let sourceId = '';
        let hlStr = '';
        if (secondColon >= 0) {
          srcConceptId = slug.slice(0, firstColon);
          sourceId = slug.slice(firstColon + 1, secondColon);
          hlStr = slug.slice(secondColon + 1);
        } else if (firstColon >= 0) {
          srcConceptId = slug.slice(0, firstColon);
          sourceId = slug.slice(firstColon + 1);
        }

        // Determine source from concept UUID
        const src = sourceConceptMap?.[srcConceptId] || 'tatoeba';

        // Parse highlights: "6,11;17,23" → [[6,11],[17,23]]
        const hl: [number, number][] = hlStr
          ? hlStr.split(';').map(pair => {
              const [s, e] = pair.split(',').map(Number);
              return [s, e] as [number, number];
            }).filter(([s, e]) => !isNaN(s) && !isNaN(e))
          : [];

        examples.push({
          ga: desc.name,
          en: desc.description || '',
          src,
          id: sourceId || undefined,
          hl,
        });
      }
    }
  }
  return examples;
}

export async function search(query: string): Promise<EntrySummary[]> {
  if (!query.trim()) return [];
  const q = query.toLowerCase();

  try {
    ensureStore().catch(() => {});
    const all = await loadResourceIndex();

    const prefixMatches: EntrySummary[] = [];
    const substringMatches: EntrySummary[] = [];

    for (const entry of all) {
      const hw = entry.headword.toLowerCase();
      if (hw.startsWith(q)) prefixMatches.push(entry);
      else if (hw.includes(q)) substringMatches.push(entry);
    }

    return [...prefixMatches, ...substringMatches].slice(0, 50);
  } catch (err) {
    console.warn('[dictionary] Search failed:', err);
    return [];
  }
}

/** Recursively convert Maps (from ros-madair WASM) to plain objects for serde. */
function mapsToObjects(val: any): any {
  if (val instanceof Map) {
    const obj: Record<string, any> = {};
    for (const [k, v] of val) obj[k] = mapsToObjects(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(mapsToObjects);
  return val;
}

export async function loadEntry(uri: string): Promise<EntryDetail | null> {
  try {
    const store = await ensureStore();
    const model = await modelPromise!;

    // Load tiles from ros-madair's binary index
    // v2 format returns { tiles: [...], __cache: ..., __scopes: ... }
    const resourceUri = `${RDF_BASE}/resource/${uri}`;
    const rawResult = await store.load_tiles_for_resource(resourceUri);
    const result = mapsToObjects(rawResult);

    // Handle both v2 format (object with tiles) and legacy v1 (plain array)
    const tiles = Array.isArray(result) ? result : result?.tiles;
    const cache = Array.isArray(result) ? null : result?.__cache;

    console.log('[dictionary] raw result type:', typeof result, Array.isArray(result) ? 'array' : 'object');
    console.log('[dictionary] result keys:', result && typeof result === 'object' ? Object.keys(result) : 'N/A');
    console.log('[dictionary] __cache present:', cache != null, cache ? Object.keys(cache).length + ' tile caches' : '');

    if (!Array.isArray(tiles) || tiles.length === 0) return null;

    // Create an alizarin resource instance and feed it tiles
    const instance = model.makeInstance(uri, null, false, true);
    instance.$.wasmWrapper.loadTiles(tiles);
    await instance.$.ensureTilesLoaded();
    await instance.$.populate(false);

    // Expose for debug console
    (window as any).alizarinAsset = instance;

    // Read values via alias-based proxy access (the alizarin way)
    const headword = String(await instance.headword ?? '');

    const posVm = await instance.part_of_speech;
    const pos = posVm?.getDisplay ? await posVm.getDisplay() : String(posVm ?? '');

    // Pronunciation — cardinality n
    const ipaValues: string[] = [];
    if (await instance.__has('pronunciation')) {
      for (const p of await instance.pronunciation ?? []) {
        const resolved = await p;
        const val = String(await resolved?.ipa_value ?? '');
        if (val) ipaValues.push(val);
      }
    }

    // Senses — cardinality n
    const senses: EntryDetail['senses'] = [];
    if (await instance.__has('senses')) {
      for (const s of await instance.senses ?? []) {
        const resolved = await s;
        const gloss = String(await resolved?.gloss ?? '');
        const example = String(await resolved?.example ?? '');
        if (gloss) senses.push({ gloss, examples: example ? [example] : [] });
      }
    }

    // Forms — cardinality n
    const forms: EntryDetail['forms'] = [];
    if (await instance.__has('forms')) {
      for (const f of await instance.forms ?? []) {
        const resolved = await f;
        const writtenRep = String(await resolved?.written_rep ?? '');
        const tags: string[] = [];
        const featList = await resolved?.gram_features;
        if (featList?.[Symbol.iterator]) {
          for (const feat of featList) {
            const r = await feat;
            const label = r?.getDisplay ? await r.getDisplay() : String(r ?? '');
            if (label && label !== '(pending)' && label !== '(unresolved)') tags.push(label);
          }
        }
        if (writtenRep) forms.push({ writtenRep, tags });
      }
    }

    instance.$.release();

    // Look up headword from resource index (more reliable than alizarin alias)
    const index = await loadResourceIndex();
    const displayHeadword = headword || index.find(e => e.uri === uri)?.headword || '';

    // Extract external examples from __cache (populated by populateCaches at build time)
    await ensureSourceConceptMap();
    const externalExamples = extractExamplesFromCache(cache);
    console.log(`[dictionary] loaded ${externalExamples.length} external examples for "${displayHeadword}"`);

    return { uri, headword: displayHeadword, pos, senses, forms, ipa: ipaValues, externalExamples };
  } catch (err) {
    console.warn('[dictionary] loadEntry failed:', err);
    return null;
  }
}
