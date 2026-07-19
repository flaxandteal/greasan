import { client, graphManager, RDM, staticStore } from 'alizarin';
import {
  SparqlStore,
} from 'ros-madair-alizarin';
import { ready } from './wasm';
import { getPagefind, resetPagefind, type PagefindInstance } from './pagefind';
import { FAMILIES, DEFAULT_FAMILY, type FamilyConfig, type FamilyId } from './family';
import { diagStart, diagEnd } from './diagnostics';
import { loadEntryV2 } from './dictionary-v2';

let activeFamilyConfig: FamilyConfig = FAMILIES[DEFAULT_FAMILY];

/** Strip diacritics (fadas, graves) for accent-insensitive search. */
function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

export interface EntrySummary {
  uri: string;
  headword: string;
  pos: string;
  gloss?: string;
  excerpt?: string;
  dialect?: string;
}

export interface ExternalExample {
  resourceId: string;
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
  dialect?: string;
  senses: Array<{ gloss: string; examples: string[]; sourceLabel?: string }>;
  forms: Array<{ writtenRep: string; tags: string[] }>;
  ipa: string[];
  etymologies: Array<{ text: string; sourceLabel?: string }>;
  cognates: Array<{ headword: string; language: string; entryId?: string }>;
  externalExamples: ExternalExample[];
}

export interface ExampleDetail {
  resourceId: string;
  sentence: string;
  translation: string;
  source: string;
  sourceId: string;
  highlights: string;
  sourceUrl: string;
}

export interface DynamicLayerInfo {
  name: string;
  baseUrl: string;
  /** Base path for per-language pagefind indices within this layer, if available. */
  pagefindBase: string | null;
}

// Exported for debug console access
export let sparqlStore: SparqlStore | null = null;
let storeReady = false;
let modelPromise: ReturnType<typeof graphManager.loadGraph> | null = null;
let exampleModelPromise: ReturnType<typeof graphManager.loadGraph> | null = null;

// Serialise all async &mut self calls on the SparqlStore.
// wasm_bindgen holds RefCell borrows across await points — concurrent
// async calls on the same store cause "recursive use of an object" panics.
let storeMutex: Promise<void> = Promise.resolve();
function withStoreMut<T>(fn: () => Promise<T>): Promise<T> {
  const prev = storeMutex;
  let release!: () => void;
  storeMutex = new Promise(r => (release = r));
  return prev.then(fn).finally(release);
}

// Map concept UUIDs to source labels (populated at build time)
// These are deterministic from the collections.csv for the ExternalExample graph
let sourceConceptMap: Record<string, 'tatoeba' | 'gaois'> | null = null;

// Dynamic layers added at runtime (e.g. from TBX import via Tauri builder)
const dynamicLayers: DynamicLayerInfo[] = [];


function teardown(): void {
  if (sparqlStore) {
    sparqlStore = null;
  }
  // Reset graphManager internals
  (graphManager as any)._initialized = false;
  if ((graphManager as any).graphs) (graphManager as any).graphs.clear();
  try { RDM.clear?.(); } catch { /* may not exist */ }
  resetPagefind();
  storeReady = false;
  storeMutex = Promise.resolve();
  modelPromise = null;
  exampleModelPromise = null;
  sourceConceptMap = null;
  dialectCache.clear();
  dynamicLayers.length = 0;
  (window as any).sparqlStore = null;
}

export function switchFamily(familyId: FamilyId): void {
  teardown();
  activeFamilyConfig = FAMILIES[familyId];
  // Eagerly start initialising the new store
  ensureStore();
}

export function getActiveFamilyId(): FamilyId {
  return activeFamilyConfig.id;
}

/**
 * Add a dynamic layer at runtime.
 * The layer's tiles become available via SparqlStore immediately.
 * If pagefindBase is provided, the layer's Pagefind index is included in search.
 */
export async function addDynamicLayer(baseUrl: string, name: string, pagefindBase?: string): Promise<void> {
  const store = await ensureStore();
  await withStoreMut(() => store.addLayer(baseUrl, name));
  dynamicLayers.push({ name, baseUrl, pagefindBase: pagefindBase ?? null });
  // Invalidate dialect cache — the layer may introduce new dialect values
  dialectCache.clear();
}

/**
 * Remove a dynamic layer. Requires full teardown + reinit since SparqlStore
 * doesn't support removing individual layers.
 */
export async function removeDynamicLayer(name: string): Promise<void> {
  const idx = dynamicLayers.findIndex(l => l.name === name);
  if (idx < 0) return;

  const remaining = dynamicLayers.filter(l => l.name !== name);

  // Teardown clears dynamicLayers, so we rebuild from remaining
  teardown();
  const store = await ensureStore();

  for (const layer of remaining) {
    try {
      await withStoreMut(() => store.addLayer(layer.baseUrl, layer.name));
      dynamicLayers.push(layer);
    } catch (err) {
      console.warn(`[dictionary] re-addLayer "${layer.name}" failed:`, err);
    }
  }
}

export function getDynamicLayers(): readonly DynamicLayerInfo[] {
  return dynamicLayers;
}

async function ensureStore(): Promise<SparqlStore> {
  if (sparqlStore && storeReady) return sparqlStore;

  await ready;

  const coreBase = activeFamilyConfig.coreBase;

  sparqlStore = new SparqlStore(coreBase);
  // Expose on window for debug
  (window as any).sparqlStore = sparqlStore;

  const archesClient = new client.ArchesClientRemoteStatic(coreBase, {
    graphIdToGraphFile: (graphId: string) => `graphs/${graphId}.json`,
  });
  graphManager.archesClient = archesClient;
  staticStore.archesClient = archesClient;
  RDM.archesClient = archesClient;

  const dSummary = diagStart('loadSummary');
  try {
    await withStoreMut(() => sparqlStore!.loadSummary(coreBase));
    diagEnd(dSummary);
  } catch (err) {
    diagEnd(dSummary);
    console.warn('[dictionary] loadSummary partial failure (concept intervals?):', err);
  }

  for (const layer of activeFamilyConfig.defaultLayers) {
    const dLayer = diagStart(`addLayer "${layer.name}"`);
    try {
      await withStoreMut(() => sparqlStore!.addLayer(layer.baseUrl, layer.name));
      diagEnd(dLayer);
    } catch (err) {
      diagEnd(dLayer);
      console.warn(`[dictionary] addLayer "${layer.name}" failed:`, err);
    }
  }

  const dInit = diagStart('graphManager.initialize');
  await graphManager.initialize();
  diagEnd(dInit);

  // Pre-load graph models (needed for alias-based access)
  const dModels = diagStart('loadGraph (models)');
  const modelP = graphManager.loadGraph(activeFamilyConfig.graphId);
  modelPromise = Promise.resolve(modelP).then(r => { diagEnd(dModels); return r; });
  exampleModelPromise = graphManager.loadGraph(activeFamilyConfig.exampleGraphId);

  storeReady = true;
  return sparqlStore;
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


export type SearchLang = string;

const dialectCache = new Map<string, Set<string>>();

async function getAvailableDialects(pf: PagefindInstance, base: string): Promise<Set<string>> {
  const cached = dialectCache.get(base);
  if (cached) return cached;
  const available = await pf.filters();
  const result = new Set(Object.keys(available.dialect || {}));
  dialectCache.set(base, result);
  return result;
}

/** Collect all pagefind base paths to search for a given language.
 * Pagefind comes exclusively from dynamic layers — no base index pagefind. */
function allPagefindBasesForLang(lang: SearchLang): string[] {
  const bases: string[] = [];
  const dir = lang === 'en' ? 'pagefind-en' : lang === 'sampla' ? 'pagefind-sampla' : `pagefind-${lang}`;
  for (const layer of dynamicLayers) {
    if (!layer.pagefindBase) continue;
    bases.push(layer.pagefindBase + dir + '/');
  }
  return bases;
}

/** Search a single pagefind instance, returning raw mapped results. */
async function searchOneInstance(
  pagefindBase: string,
  query: string,
  lang: SearchLang,
  dialects?: string[],
): Promise<EntrySummary[]> {
  const pf = await getPagefind(pagefindBase);

  // Build dialect filter — only apply if it actually excludes something.
  // Expand sub-dialect codes to include their parent: GD.ARG → also match GD,
  // so general-dialect entries show when any sub-dialect is selected.
  const filters: Record<string, Record<string, string[]>> = {};
  if (dialects && dialects.length > 0) {
    const expanded = new Set(dialects);
    for (const d of dialects) {
      const dot = d.indexOf('.');
      if (dot > 0) expanded.add(d.substring(0, dot));
    }
    const available = await getAvailableDialects(pf, pagefindBase);
    const matching = [...expanded].filter(d => available.has(d));
    if (matching.length > 0 && matching.length < available.size) {
      filters.dialect = { any: matching };
    }
  }

  const searchOpts = Object.keys(filters).length > 0 ? { filters } : undefined;
  const dSearch = diagStart('pagefind search');
  const searchResult = await pf.search(query, searchOpts);
  const { results } = searchResult;
  const loaded = await Promise.all(results.slice(0, 50).map(r => r.data()));
  diagEnd(dSearch);

  return loaded.map(d => {
    const uri = d.url.replace(/^\//, '');
    const dialect = d.meta.dialect || undefined;
    if (lang === 'en') {
      return {
        uri,
        headword: d.meta.headword || d.meta.title,
        pos: '',
        gloss: d.meta.title || undefined,
        dialect,
      };
    }
    return {
      uri,
      headword: d.meta.title,
      pos: '',
      gloss: d.meta.gloss || undefined,
      excerpt: lang === 'sampla' ? d.excerpt : undefined,
      dialect,
    };
  });
}

export async function search(query: string, lang: SearchLang = 'ga', dialects?: string[]): Promise<EntrySummary[]> {
  if (!query.trim()) return [];
  // Skip pagefind entirely for very short queries — single/two-char searches
  // are expensive and return too many substring hits to be useful.
  if (query.trim().length < 3) return [];

  try {
    // v2 mode: search is pure Pagefind over the registered v2 layers — the v1
    // SparqlStore is never constructed. Only v1 needs ensureStore here.
    if (!USE_V2) await ensureStore();
    const bases = allPagefindBasesForLang(lang);
    if (bases.length === 0) return []; // No layers installed — no data to search

    // Normalize query: strip diacritics so "focal" matches "fócal"
    const normQuery = stripDiacritics(query);

    // Query all pagefind instances in parallel
    const resultSets = await Promise.all(
      bases.map(base =>
        searchOneInstance(base, normQuery, lang, dialects).catch(err => {
          console.warn(`[dictionary] Search failed for ${base}:`, err);
          return [] as EntrySummary[];
        })
      )
    );

    // Merge and deduplicate by URI (first occurrence wins)
    const seen = new Set<string>();
    const merged: EntrySummary[] = [];
    for (const results of resultSets) {
      for (const r of results) {
        if (seen.has(r.uri)) continue;
        seen.add(r.uri);
        merged.push(r);
      }
    }

    const q = query.toLowerCase();
    const qNorm = normQuery.toLowerCase();
    merged.sort((a, b) => {
      const aText = (lang === 'en' ? a.gloss || '' : a.headword).toLowerCase();
      const bText = (lang === 'en' ? b.gloss || '' : b.headword).toLowerCase();
      const aRank = aText === q ? 0 : aText.startsWith(q) ? 1
        : stripDiacritics(aText) === qNorm ? 2 : stripDiacritics(aText).startsWith(qNorm) ? 3 : 4;
      const bRank = bText === q ? 0 : bText.startsWith(q) ? 1
        : stripDiacritics(bText) === qNorm ? 2 : stripDiacritics(bText).startsWith(qNorm) ? 3 : 4;
      return aRank - bRank;
    });

    return merged.slice(0, 50);
  } catch (err) {
    console.warn('[dictionary] Search failed:', err);
    return [];
  }
}

/** Recursively convert serde_wasm_bindgen Maps to plain objects. */
function mapToObj(val: any): any {
  if (val instanceof Map) {
    const obj: Record<string, any> = {};
    for (const [k, v] of val) obj[k] = mapToObj(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(mapToObj);
  return val;
}

/** Pre-load tiles for a resource from the SparqlStore into the alizarin wrapper.
 *
 * Fetches tiles via SparqlStore.loadTilesForResource (HTTP range requests to the
 * layer's tile files) and loads them into the wrapper BEFORE populate() is called.
 * This way tilesLoaded() returns true and ensureTilesLoaded never fires — no
 * silent fallback to the ArchesClient.
 *
 * Must be called before populate() to avoid recursive mutable borrow of the store.
 */
async function preloadTiles(
  store: SparqlStore,
  resourceUri: string,
  instance: any,
): Promise<void> {
  const wrapper = instance.$.wasmWrapper;

  const result = await withStoreMut(() => store.loadTilesForResource(resourceUri));
  // serde_wasm_bindgen produces Maps; unwrap and convert to plain objects
  const rawTiles = result instanceof Map
    ? result.get('tiles')
    : Array.isArray(result)
      ? result
      : result?.tiles;

  if (Array.isArray(rawTiles) && rawTiles.length > 0) {
    wrapper.loadTiles(rawTiles.map(mapToObj));
  }
}

export async function loadEntry(uri: string, knownHeadword?: string): Promise<EntryDetail | null> {
  try {
    await ensureStore();
    const model = await modelPromise!;

    // Create an alizarin resource instance. Tiles are pre-loaded from the
    // SparqlStore before populate(), so ensureTilesLoaded never fires.
    const instance = model.makeInstance(uri, null, false, true);

    const resourceUri = `${activeFamilyConfig.rdfBase}/resource/${uri}`;
    await preloadTiles(sparqlStore!, resourceUri, instance);

    const dPopulate = diagStart('populate (entry)');
    await instance.$.populate(false);
    diagEnd(dPopulate);

    // Read values via alias-based proxy access (the alizarin way)
    const headword = String(await instance.headword ?? '');

    const posVm = await instance.part_of_speech;
    const pos = posVm?.getDisplay ? await posVm.getDisplay() : String(posVm ?? '');

    const dialectVm = await instance.dialect;
    const dialect = dialectVm?.getDisplay ? await dialectVm.getDisplay() : String(dialectVm ?? '');

    // Pronunciation — cardinality n
    const ipaValues: string[] = [];
    if (await instance.__has('pronunciation')) {
      for (const p of await instance.pronunciation ?? []) {
        const resolved = await p;
        const val = String(await resolved?.ipa_value ?? '');
        if (val) ipaValues.push(val);
      }
    }

    // Senses — cardinality n, deduplicated across layers
    const rawSenses: EntryDetail['senses'] = [];
    if (await instance.__has('senses')) {
      for (const s of await instance.senses ?? []) {
        const resolved = await s;
        const gloss = String(await resolved?.gloss ?? '');
        const example = String(await resolved?.example ?? '');
        const sourceLabel = String(await resolved?.source_label ?? '');
        if (gloss) rawSenses.push({ gloss, examples: example ? [example] : [], sourceLabel: sourceLabel || undefined });
      }
    }
    // Merge senses with identical gloss+examples, combining source labels
    const senses: EntryDetail['senses'] = [];
    for (const sense of rawSenses) {
      const key = sense.gloss + '\0' + sense.examples.join('\0');
      const existing = senses.find(s => s.gloss + '\0' + s.examples.join('\0') === key);
      if (existing && sense.sourceLabel) {
        const labels = new Set((existing.sourceLabel ?? '').split('+').filter(Boolean));
        labels.add(sense.sourceLabel);
        existing.sourceLabel = [...labels].sort().join('+');
      } else if (!existing) {
        senses.push({ ...sense });
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

    // Etymology — cardinality n, deduplicated across layers
    const rawEtymologies: Array<{ text: string; sourceLabel?: string }> = [];
    if (await instance.__has('etymology')) {
      for (const e of await instance.etymology ?? []) {
        const resolved = await e;
        const text = String(await resolved?.etymology_text ?? '');
        const sourceLabel = String(await resolved?.etymology_source ?? '');
        if (text) rawEtymologies.push({ text, sourceLabel: sourceLabel || undefined });
      }
    }
    // Deduplicate by text, merge source labels
    const etymologies: EntryDetail['etymologies'] = [];
    for (const etym of rawEtymologies) {
      const existing = etymologies.find(e => e.text === etym.text);
      if (existing && etym.sourceLabel) {
        const labels = new Set((existing.sourceLabel ?? '').split('+').filter(Boolean));
        labels.add(etym.sourceLabel);
        existing.sourceLabel = [...labels].sort().join('+');
      } else if (!existing) {
        etymologies.push({ ...etym });
      }
    }

    // Cognates — cardinality n
    const cognates: EntryDetail['cognates'] = [];
    if (await instance.__has('cognates')) {
      for (const c of await instance.cognates ?? []) {
        const resolved = await c;
        const hw = String(await resolved?.cognate_headword ?? '');
        const language = String(await resolved?.cognate_language ?? '');
        // cognate_entry_id is resource-instance: ViewModel with .id, or null
        const entryIdVm = await resolved?.cognate_entry_id;
        const entryId = entryIdVm?.id || '';
        if (hw) cognates.push({ headword: hw, language, entryId: entryId || undefined });
      }
    }

    // Reverse cognate links via queryPatterns — find entries that cite THIS
    // entry via cognate_entry_id (resource-instance). queryPatterns directly
    // queries predicate blocks to find matching subjects, avoiding the
    // page-level granularity problem of summaryToPage.
    const REV_MAX = 10;
    try {
      const resourceUri = `${activeFamilyConfig.rdfBase}/resource/${uri}`;
      const predUri = `${activeFamilyConfig.rdfBase}/node/cognate_entry_id`;
      const patterns = JSON.stringify([{ s: '?x', p: predUri, o: resourceUri }]);
      const citingUris: string[] = await withStoreMut(() => sparqlStore!.queryPatterns(patterns));
      for (const srcUri of citingUris.slice(0, REV_MAX)) {
        const srcId = srcUri.split('/resource/').pop() || '';
        if (!srcId || srcId === uri) continue;
        try {
          const srcInstance = model.makeInstance(srcId, null, false, true);
          await preloadTiles(sparqlStore!, srcUri, srcInstance);
          await srcInstance.$.populate(false);
          const srcHeadword = String(await srcInstance.headword ?? '');
          const srcDialectVm = await srcInstance.dialect;
          const srcDialect = srcDialectVm?.getDisplay ? await srcDialectVm.getDisplay() : '';
          const srcLang = srcDialect?.includes('Scottish') ? 'Scottish Gaelic'
            : srcDialect?.includes('Manx') ? 'Manx'
            : srcDialect?.includes('Irish') || srcDialect?.includes('Connacht') || srcDialect?.includes('Ulster') || srcDialect?.includes('Munster') ? 'Irish'
            : srcDialect || 'Unknown';
          if (srcHeadword) {
            const dedup = `${srcLang}:${srcHeadword}`;
            if (!cognates.some(c => `${c.language}:${c.headword}` === dedup)) {
              cognates.push({ headword: srcHeadword, language: srcLang, entryId: srcId });
            }
          }
          // Surface etymology from the citing entry
          if (await srcInstance.__has('etymology')) {
            for (const e of await srcInstance.etymology ?? []) {
              const resolved = await e;
              const text = String(await resolved?.etymology_text ?? '');
              const sourceLabel = String(await resolved?.etymology_source ?? '');
              if (text && !etymologies.some(et => et.text === text)) {
                etymologies.push({ text, sourceLabel: sourceLabel || undefined });
              }
            }
          }
        } catch (srcErr) {
          console.warn('[dictionary] reverse src load failed:', srcId, srcErr);
        }
      }
    } catch (revErr) {
      console.warn('[dictionary] reverse cognate lookup (non-fatal):', revErr);
    }

    // External examples — extract reference IDs from raw tile data (avoids
    // ResourceInstanceListViewModel which causes OOB via fire-and-forget promises),
    // then eagerly load each example resource to get sentence + translation text.
    const externalExamples: ExternalExample[] = [];
    try {
      const exRefList = instance.$.wasmWrapper.getValuesAtPath('external_examples', null);
      const exRefValues = exRefList.getAllValues();
      const refIds: string[] = [];
      for (const pv of exRefValues) {
        const rawData = pv.tileData;
        // tileData may be: a Map (serde_wasm_bindgen serializes JSON objects as Map),
        // an Array, or a Map whose values are Arrays of reference objects.
        const entries: any[] = [];
        if (rawData instanceof Map) {
          for (const v of rawData.values()) {
            if (Array.isArray(v)) entries.push(...v);
            else entries.push(v);
          }
        } else if (Array.isArray(rawData)) {
          entries.push(...rawData);
        }
        for (const entry of entries) {
          const rid = entry instanceof Map
            ? (entry.get('resourceId') || entry.get('resourceinstance_id') || '')
            : (entry?.resourceId || entry?.resourceinstance_id || '');
          if (rid) refIds.push(rid);
        }
      }

      // Eagerly load example resources in parallel, reusing the tile source handle
      if (refIds.length > 0) {
        const exampleModel = await exampleModelPromise!;
        const results = await Promise.all(
          refIds.slice(0, 20).map(async (refId) => {
            try {
              const exInstance = exampleModel.makeInstance(refId, null, false, true);
              const exUri = `${activeFamilyConfig.rdfBase}/resource/${refId}`;
              await preloadTiles(sparqlStore!, exUri, exInstance);
              await exInstance.$.populate(false);

              const sentence = String(await exInstance.sentence ?? '');
              const translation = String(await exInstance.sentence_en ?? '');

              let src: 'tatoeba' | 'gaois' = 'tatoeba';
              try {
                if (await exInstance.__has('provenance')) {
                  const prov = await exInstance.provenance;
                  const sourceVm = await prov?.source;
                  const sourceLabel = sourceVm?.getDisplay
                    ? await sourceVm.getDisplay()
                    : String(sourceVm ?? '');
                  if (sourceLabel.toLowerCase() === 'gaois') src = 'gaois';
                }
              } catch { /* source detection non-critical */ }

              return { resourceId: refId, ga: sentence, en: translation, src, hl: [] as [number, number][] };
            } catch {
              return null;
            }
          })
        );
        for (const r of results) {
          if (r && r.ga) externalExamples.push(r);
        }
      }
    } catch (exErr) {
      console.warn('[dictionary] external examples extraction (non-fatal):', exErr);
    }

    // Don't call instance.$.release() here — async syncTileData promises from
    // populate are still pending and would OOB on freed WASM PseudoValues.
    // WASM objects will be cleaned up by FinalizationRegistry or on next loadEntry.

    // Use headword from: alizarin tile > caller > empty
    const displayHeadword = headword || knownHeadword || '';

    return { uri, headword: displayHeadword, pos, dialect: dialect || undefined, senses, forms, ipa: ipaValues, etymologies, cognates, externalExamples };
  } catch (err) {
    console.warn('[dictionary] loadEntry failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// v2 entry-detail path (static-assets pilot), behind a feature flag.
//
// `loadEntryV2` sources the SAME `EntryDetail` from the v2 cross-layer hydrate
// (`v2_hydrate_layers`) + closure label resolution instead of the v1
// SparqlStore-populate path. v1 `loadEntry` above stays untouched and default.
// ---------------------------------------------------------------------------

/**
 * Feature flag: when true, entry detail is sourced from the v2 stack. Default
 * FALSE — the v1 SparqlStore path remains the shipping default. Requires
 * src-tauri built with `--features v2`.
 */
export const USE_V2 = true;

/**
 * A v2 pilot layer: a native head (for cross-layer hydrate) plus a Pagefind
 * base (for text search). `headDir` is consumed by the Rust `v2_*` commands;
 * `pagefindBase` feeds `collectPagefindBases`/search via the `dynamicLayers`
 * registry.
 */
export interface V2LayerConfig {
  /** Stable layer name — the `dynamicLayers` registry key. */
  name: string;
  /** v2 head dir (SQLite head + content-addressed chunks + graph.json). */
  headDir: string;
  /**
   * Pagefind base: the dir CONTAINING the per-language `pagefind-<lang>/`
   * subdirs (`allPagefindBasesForLang` appends `pagefind-<lang>/`). Relative &
   * same-origin so the vite dev server serves it through the `app/public/layer-*`
   * symlinks; production would use the pfzip custom protocol like v1.
   */
  pagefindBase: string;
}

/**
 * DEV-PATH CONSTANT — the v2 pilot layer set (base -> overlay: wiktionary then
 * macbain). `headDir` values are absolute repo paths the native `v2_*` commands
 * open directly (`Path::new(dir)`) — valid for `tauri dev` on the pilot machine
 * only; shipping needs real installed-layer resolution (Tauri path APIs / the
 * `dynamicLayers` registry). See the report's UI-run note.
 */
export const V2_LAYERS: V2LayerConfig[] = [
  {
    name: 'wiktionary',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/wiktionary-v2-full',
    pagefindBase: '/layer-wiktionary/',
  },
  {
    name: 'macbain',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/macbain-v2',
    pagefindBase: '/layer-macbain/',
  },
];

/** Ordered v2 layer head dirs (base first), derived from {@link V2_LAYERS}. */
export const V2_HEAD_DIRS: string[] = V2_LAYERS.map((l) => l.headDir);

/**
 * Register the v2 pilot layers WITHOUT touching the v1 engine.
 *
 * v1 `addDynamicLayer` also calls `SparqlStore.addLayer` (via `ensureStore`),
 * which is meaningless in v2 mode and fails against v2 heads. This v2 variant
 * only populates the `dynamicLayers` registry — enough for the `layers` store
 * (clears the "install a layer" empty state) and `collectPagefindBases`/search
 * — and never constructs a SparqlStore. Detail hydrate uses `V2_HEAD_DIRS`
 * natively (see `loadEntryV2`), not this registry.
 */
export function registerV2Layers(): void {
  dynamicLayers.length = 0;
  for (const layer of V2_LAYERS) {
    dynamicLayers.push({ name: layer.name, baseUrl: layer.headDir, pagefindBase: layer.pagefindBase });
  }
  // A newly-registered layer may introduce new dialect values.
  dialectCache.clear();
}

/**
 * Dispatch entry loading by the `USE_V2` flag. The UI calls this; v1 `loadEntry`
 * stays the default path when `USE_V2` is false.
 */
export function loadEntryFlagged(uri: string, knownHeadword?: string): Promise<EntryDetail | null> {
  return USE_V2 ? loadEntryV2(uri, V2_HEAD_DIRS) : loadEntry(uri, knownHeadword);
}

export async function loadExample(resourceId: string): Promise<ExampleDetail | null> {
  try {
    await ensureStore();
    const exampleModel = await exampleModelPromise!;

    const instance = exampleModel.makeInstance(resourceId, null, false, true);

    const resourceUri = `${activeFamilyConfig.rdfBase}/resource/${resourceId}`;
    await preloadTiles(sparqlStore!, resourceUri, instance);

    await instance.$.populate(false);

    const sentence = String(await instance.sentence ?? '');
    const translation = String(await instance.sentence_en ?? '');

    // Provenance — cardinality 1 semantic group
    let source = '';
    let sourceId = '';
    let highlights = '';

    if (await instance.__has('provenance')) {
      const prov = await instance.provenance;
      if (prov) {
        const sourceVm = await prov.source;
        source = sourceVm?.getDisplay ? await sourceVm.getDisplay() : String(sourceVm ?? '');
        sourceId = String(await prov.source_id ?? '');
        highlights = String(await prov.highlights ?? '');
      }
    }

    // Compute source URL from source label + sourceId
    const sourceLower = source.toLowerCase();
    let sourceUrl = '';
    if (sourceLower === 'tatoeba' && sourceId) {
      sourceUrl = `https://tatoeba.org/sentences/${sourceId}`;
    } else if (sourceLower === 'gaois' && sourceId) {
      sourceUrl = `https://www.gaois.ie/crp/en/?id=${encodeURIComponent(sourceId)}`;
    }

    // Don't release — async syncTileData promises still pending (see loadEntry comment)

    return { resourceId, sentence, translation, source, sourceId, highlights, sourceUrl };
  } catch (err) {
    console.warn('[dictionary] loadExample failed:', err);
    return null;
  }
}
