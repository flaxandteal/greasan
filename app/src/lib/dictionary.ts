import { client, graphManager, RDM, staticStore } from 'alizarin';
import {
  SparqlStore,
} from 'ros-madair-alizarin';
import { ready } from './wasm';
import { getPagefind, resetPagefind, type PagefindInstance } from './pagefind';
import { FAMILIES, DEFAULT_FAMILY, type FamilyConfig, type FamilyId } from './family';
import { diagStart, diagEnd } from './diagnostics';
import { loadEntryV2 } from './dictionary-v2';
import { prepareOffline, descriptors, hydrateV2, citedBy, searchDisplay, searchFts } from './v2';

let activeFamilyConfig: FamilyConfig = FAMILIES[DEFAULT_FAMILY];

/** Strip diacritics (fadas, graves) for accent-insensitive search. */
function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

/** `token` present as a whole word in `text`, accent- and case-insensitive.
 * Used to spot a hit whose match is an inflected FORM (BuNaMo indexes the whole
 * forms bag as its record content) rather than the headword. */
function tokenInText(token: string, text: string): boolean {
  const tok = stripDiacritics(token).trim().toLowerCase();
  if (!tok) return false;
  return stripDiacritics(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).includes(tok);
}

export interface EntrySummary {
  uri: string;
  headword: string;
  pos: string;
  gloss?: string;
  excerpt?: string;
  dialect?: string;
  /** Internal ranking hint: the query matched an inflected form of this entry
   * (not its headword), e.g. "tiocfaidh" -> tar. Set in searchOneInstance. */
  _formHit?: boolean;
  /** Internal filter hint: this hit came from the BuNaMo layer, i.e. the entry is
   * in the curated morphology core. Set in searchOneInstance. */
  _inBunamo?: boolean;
}

export interface ExternalExample {
  resourceId: string;
  ga: string;
  en: string;
  src: 'tatoeba' | 'gaois' | 'udt';
  id?: string;
  hl: [number, number][];
}

export interface EntryDetail {
  uri: string;
  headword: string;
  pos: string;
  dialect?: string;
  /** Gender concept label ('masculine'/'feminine'), when known - shown in the title. */
  gender?: string;
  /** Grammatical class token from BuNaMo: noun declension ('1'..'5'), verb conjugation,
   *  adjective declension. Combined with pos/gender into the title badge (e.g. 'm1'). */
  grammarClass?: string;
  /** Confidence of `grammarClass`: 'attested' (explicit source/BuNaMo) vs
   *  'inferred'/'uncertain' (gramadan guess). Non-attested renders a '?' beside
   *  the class badge. */
  grammarClassConfidence?: string;
  senses: Array<{ gloss: string; examples: string[]; sourceLabel?: string; dialect?: string }>;
  forms: Array<{ writtenRep: string; tags: string[] }>;
  ipa: string[];
  etymologies: Array<{ text: string; sourceLabel?: string }>;
  cognates: Array<{ headword: string; language: string; entryId?: string }>;
  externalExamples: ExternalExample[];
  /** Placenames whose name is constituted by this word (reverse `element_entry`
   *  lookup into the `place` layer). Count is exact; sample is a resolved page. */
  placenames?: { count: number; sample: Array<{ resourceId: string; name: string }> };
}

export interface ExampleDetail {
  resourceId: string;
  sentence: string;
  translation: string;
  source: string;
  sourceId: string;
  highlights: string;
  /** Sub-corpus / collection (Gaois), split to the ga side for display. */
  collection: string;
  /** Source citation (e.g. legal instrument reference). */
  citation: string;
  sourceUrl: string;
  /** Headwords this sentence illustrates (from the resource's `illustrates`
   *  tiles), each with the character span(s) of its surface form. */
  headwords: Array<{ resourceId: string; headword: string; spans: [number, number][] }>;
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

// Serialise all async &mut self calls on the SparqlStore.
// wasm_bindgen holds RefCell borrows across await points - concurrent
// async calls on the same store cause "recursive use of an object" panics.
let storeMutex: Promise<void> = Promise.resolve();
function withStoreMut<T>(fn: () => Promise<T>): Promise<T> {
  const prev = storeMutex;
  let release!: () => void;
  storeMutex = new Promise(r => (release = r));
  return prev.then(fn).finally(release);
}

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
  // Invalidate dialect cache - the layer may introduce new dialect values
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

  storeReady = true;
  return sparqlStore;
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
 * Pagefind comes exclusively from dynamic layers - no base index pagefind. */
/**
 * Layers whose Pagefind index is bundled but deliberately kept OUT of the main
 * search: search returns dictionary headwords only. `place` placenames are
 * discovered via the reverse-lookup on a word entry, not by searching for them.
 * (Flip this - remove `place` - when we add dedicated place search.)
 */
const NON_SEARCH_LAYERS: ReadonlySet<string> = new Set(['place', 'concept', 'example-tatoeba', 'example-gaois', 'example-udt', 'person', 'note', 'layer']);

// Form-of index layers. Their Pagefind records key on inflected surface forms
// (e.g. "tháinig") and resolve, via the shared entry uuid, to entries RENDERED
// by other layers - they inject no display content of their own. So they stay
// searchable even when hidden from the layer stack: hiding BuNaMo (morphology)
// shouldn't stop "tháinig" from finding "tar".
const FORM_INDEX_LAYERS: ReadonlySet<string> = new Set(['bunamo']);

function allPagefindBasesForLang(lang: SearchLang): { base: string; layer: string }[] {
  const bases: { base: string; layer: string }[] = [];
  const dir = lang === 'en' ? 'pagefind-en' : lang === 'sampla' ? 'pagefind-sampla' : `pagefind-${lang}`;
  // Samplaí is EXAMPLE-granular: it searches the example layers' own sampla index
  // (each record is one sentence, url = example UUID → tap opens the example page),
  // NOT the headword-granular base index. So for sampla we include ONLY the example
  // layers (which are NON_SEARCH for ga/en); for ga/en we skip those layers.
  const sampla = lang === 'sampla';
  for (const layer of dynamicLayers) {
    // Hidden layers drop out of search, EXCEPT form-of indexes (see above):
    // their hits point at entries other layers render, so hiding them from the
    // stack shouldn't remove inflected-form lookup.
    if (hiddenLayers.has(layer.name) && !FORM_INDEX_LAYERS.has(layer.name)) continue;
    const isExample = layer.name.startsWith('example-');
    if (sampla ? !isExample : NON_SEARCH_LAYERS.has(layer.name)) continue;
    if (!layer.pagefindBase) continue;
    bases.push({ base: layer.pagefindBase + dir + '/', layer: layer.name });
  }
  return bases;
}

/** Search a single pagefind instance, returning raw mapped results. */
async function searchOneInstance(
  pagefindBase: string,
  query: string,
  lang: SearchLang,
  dialects?: string[],
  rawToken?: string,
  fromBunamo?: boolean,
): Promise<EntrySummary[]> {
  const pf = await getPagefind(pagefindBase);

  // Build dialect filter - only apply if it actually excludes something.
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
        pos: d.meta.pos || '',
        gloss: d.meta.title || undefined,
        dialect,
      };
    }
    const headword = d.meta.title;
    // Form-hit: the query is a whole word in this record's content but NOT its
    // headword. BuNaMo's record content is the entry's forms bag, so this catches
    // an inflected surface form the user typed ("tiocfaidh" -> tar) and lets the
    // ranker lift its lemma. Only meaningful for headword (ga) search; the
    // wiktionary index's content is just the headword, so it never false-fires.
    const formHit =
      lang !== 'en' &&
      lang !== 'sampla' &&
      !!rawToken &&
      stripDiacritics(headword).toLowerCase() !== stripDiacritics(rawToken).toLowerCase() &&
      tokenInText(rawToken, (d as { content?: string }).content || '');
    return {
      uri,
      headword,
      pos: d.meta.pos || '',
      // Samplaí: the sentence is the title (headword); the translation is the
      // subtitle (gloss). Don't surface pagefind's raw excerpt - its `content`
      // concatenates the sentence, its accent-stripped copy, and the translation,
      // which reads as the same line three times.
      gloss: lang === 'sampla' ? (d.meta.sentence_en || undefined) : (d.meta.gloss || undefined),
      dialect,
      _formHit: formHit,
      _inBunamo: !!fromBunamo,
    };
  });
}

/** Fold a set of dialect labels (from the composed entry, e.g. "Irish",
 * "Scottish Gaelic", "Munster Irish") to a branch code - GA / GD / GV, or "G"
 * when the slug spans more than one Goidelic branch. Mirrors the layer builders'
 * DIALECT_LABEL_TO_CODE, but branch-only (the search badge shows the branch). */
function dialectsToCode(labels: string[]): string {
  const branches = new Set<string>();
  for (const l of labels) {
    if (/scottish|gaelic/i.test(l)) branches.add('GD');
    else if (/manx/i.test(l)) branches.add('GV');
    else if (/irish/i.test(l)) branches.add('GA');
  }
  return branches.size > 1 ? 'G' : ([...branches][0] || '');
}

/**
 * Reverse an Irish initial mutation on the (first) word of a query: lenition,
 * eclipsis, and t-/h- prefixes. Mirrors the logainm layer builder's stripMutation.
 * Morphology layers index the bare stem ("táinig"), but a user types the lenited
 * surface form ("tháinig") - stripping lets the two meet. Returns the word
 * unchanged when it carries no recognisable mutation.
 */
export function stripInitialMutation(word: string): string {
  let w = word.trim();
  // t-prefix (an t-uisce), t before s (an tSráid), h-prefix (na hÉireann)
  if (/^t-/i.test(w)) w = w.slice(2);
  else if (/^ts[^h]/i.test(w)) w = w.slice(1);
  else if (/^h[aeiouáéíóúàèìòù]/i.test(w)) w = w.slice(1);
  // eclipsis: bhf->f, then mb->b gc->c nd->d ng->g bp->p dt->t
  if (/^bhf/i.test(w)) w = w.slice(2);
  else if (/^(mb|gc|nd|ng|bp|dt)/i.test(w)) w = w.slice(1);
  // lenition: C + h + (vowel|l|r|n) -> C + rest
  else if (/^[bcdfgmpst]h[aeiouáéíóúàèìòùlrn]/i.test(w)) w = w[0] + w.slice(2);
  return w;
}

export interface SearchFilters {
  /** Include multi-word phrase entries in headword (ga) results. Default false. */
  showPhrases?: boolean;
  /** Restrict to these raw POS values (e.g. ["noun","verb"]). Empty/undefined = all. */
  pos?: string[];
  /** Restrict to entries in the BuNaMo morphology core (~13k noun/adj/verb with
   * attested inflection). Headword (ga) search only - BuNaMo has no gloss index. */
  bunamoOnly?: boolean;
}

export async function search(
  query: string,
  lang: SearchLang = 'ga',
  dialects?: string[],
  filters?: SearchFilters,
): Promise<EntrySummary[]> {
  if (!query.trim()) return [];

  try {
    // Two text engines, per layer: Pagefind for shipped layers, FTS5 for
    // on-device-built ones (Téarma). Each layer's index is separate anyway, so
    // we query both and merge - the merge below re-ranks by our own text tiers,
    // so the engines' incompatible scores never need reconciling (no RRF).
    const bases = allPagefindBasesForLang(lang);
    // v2_search_fts probes each dir for `search.sqlite` and skips those without
    // one, so passing the whole active stack is safe. Samplaí has no FTS column,
    // so FTS only joins headword (ga) / gloss (en) search.
    const ftsField: 'headword' | 'gloss' | null =
      lang === 'en' ? 'gloss' : lang === 'sampla' ? null : 'headword';
    const ftsDirs = ftsField ? currentV2HeadDirs() : [];
    if (bases.length === 0 && ftsDirs.length === 0) return []; // nothing to search

    // Normalize query: strip diacritics so "focal" matches "fócal"
    const normQuery = stripDiacritics(query);

    // Initial-mutation-aware search: a user types the lenited/eclipsed surface
    // form ("tháinig", "dtáinig") but morphology layers (BuNaMo) index the bare
    // stem ("táinig"). Search the mutation-stripped variant too, so an inflected
    // surface form still lands on its lemma. ga only; only when stripping the
    // mutation actually changes the word (so "tar" isn't double-searched).
    const queryStrs = [normQuery];
    if (lang === 'ga') {
      const demut = stripDiacritics(stripInitialMutation(query));
      if (demut && demut !== normQuery) queryStrs.push(demut);
    }

    // 1-2 char queries: prefix/substring matching floods with hits (and is slow),
    // so do an EXACT-WORD search instead (pagefind double-quote syntax) - short
    // lemmas like "bó" / "cú" / "ó" stay findable without the noise.
    const mkPfQuery = (q: string) => { const t = q.trim(); return t.length < 3 ? `"${t}"` : t; };

    // Query all Pagefind instances (once per query variant) + the FTS sidecars
    // in parallel. Tag each result set with the query index that produced it, so
    // hits found ONLY via the demutated query (exact matches of an inflected form
    // the user typed) can be ranked as strong hits below. Same-uri hits dedupe.
    const demutIdx = queryStrs.length > 1 ? queryStrs.length - 1 : -1;
    const [pfTagged, ftsHits] = await Promise.all([
      Promise.all(
        bases.flatMap(({ base, layer }) =>
          queryStrs.map((q, qi) =>
            searchOneInstance(base, mkPfQuery(q), lang, dialects, q, layer === 'bunamo')
              .then(rs => ({ qi, rs }))
              .catch(err => {
                console.warn(`[dictionary] Search failed for ${base}:`, err);
                return { qi, rs: [] as EntrySummary[] };
              })
          )
        )
      ),
      ftsField && ftsDirs.length
        ? searchFts(ftsDirs, query, ftsField, 50).catch(err => {
            console.warn('[dictionary] FTS search failed:', err);
            return [];
          })
        : Promise.resolve([]),
    ]);
    // URIs surfaced by the mutation-stripped query - the lemma owns the inflected
    // surface form the user actually typed, so it deserves a strong rank tier.
    const demutMatchUris = new Set<string>();
    // URIs whose match was an inflected FORM (not the headword) - "tiocfaidh"
    // finds tar via its forms bag. OR'd across every layer and query variant.
    const formMatchUris = new Set<string>();
    // URIs returned by the BuNaMo layer, i.e. entries in the curated morphology
    // core - the set the "core vocabulary" filter restricts to.
    const bunamoUris = new Set<string>();
    const pfSets: EntrySummary[][] = [];
    for (const { qi, rs } of pfTagged) {
      pfSets.push(rs);
      if (qi === demutIdx) for (const r of rs) demutMatchUris.add(r.uri);
      for (const r of rs) {
        if (r._formHit) formMatchUris.add(r.uri);
        if (r._inBunamo) bunamoUris.add(r.uri);
      }
    }
    const resultSets: EntrySummary[][] = [...pfSets];
    if (ftsHits.length) {
      // The FTS index carries no dialect column, but every FTS-built layer is
      // Téarma, which is uniformly Irish → tag GA (matches the Pagefind builder's
      // hardcoded GA, and keeps Téarma headwords from being dimmed as non-GA).
      // headword/POS get canonicalised from the head by searchDisplay below.
      resultSets.push(
        ftsHits.map(h => ({
          uri: h.uri,
          headword: h.headword,
          pos: '',
          gloss: lang === 'en' ? h.snippet || h.gloss || undefined : h.gloss || undefined,
          dialect: 'GA',
        }))
      );
    }

    // Merge across layers, UNIONING dialects for a shared slug. The slug is
    // dialect-neutral (goi-<head>-<pos>), so the same uri comes back from
    // different heads - e.g. wiktionary GA + macbain GD for "fear". First-wins
    // would show only the leading layer's dialect; instead, if a slug spans more
    // than one Goidelic branch (GA/GD/GV) we tag it "G" (both), matching the
    // dialect-neutral slug and the composed entry the user will see on open.
    const byUri = new Map<string, EntrySummary>();
    const branchesByUri = new Map<string, Set<string>>();
    for (const results of resultSets) {
      for (const r of results) {
        if (!byUri.has(r.uri)) {
          byUri.set(r.uri, r);
          branchesByUri.set(r.uri, new Set<string>());
        } else {
          // Gloss union: the forms-only BuNaMo record (no gloss) can win first-seen
          // for a lemma that ALSO comes back glossed from Wiktionary - "tar" would
          // then show glossless. Fill a missing gloss from any layer that has one.
          const kept = byUri.get(r.uri)!;
          if (!kept.gloss && r.gloss) kept.gloss = r.gloss;
        }
        const branch = (r.dialect || '').split('.')[0];
        if (branch) branchesByUri.get(r.uri)!.add(branch);
      }
    }
    let merged: EntrySummary[] = [];
    for (const [uri, r] of byUri) {
      if (branchesByUri.get(uri)!.size > 1) r.dialect = 'G';
      merged.push(r);
    }

    // Canonical display from the COMPOSED heads - headword/POS/dialect come from
    // the richest layer that owns each slug, not whichever Pagefind record won
    // the per-layer cap + dedup. Fixes bare/duplicate rows leaking from the
    // forms-only BuNaMo layer (no POS, dialect shown as raw "Irish"). Gloss is a
    // tile, so it stays from Pagefind. Best-effort: falls through on error.
    try {
      const disp = await searchDisplay(currentV2HeadDirs(), merged.map((r) => r.uri));
      for (const r of merged) {
        const d = disp[r.uri];
        if (!d) continue;
        if (d.headword) r.headword = d.headword;
        if (d.pos) r.pos = d.pos;
        const code = dialectsToCode(d.dialects);
        if (code) r.dialect = code;
      }
    } catch (err) {
      console.warn('[dictionary] searchDisplay failed:', err);
    }

    // Normalise any residual raw language label to its branch code. Form-index
    // (BuNaMo) hits carry a plain "Irish" in their Pagefind meta; if searchDisplay
    // didn't canonicalise it, without this it would be dimmed as non-GA and badged
    // "Irish" rather than shown as a Gaeilge (GA) result.
    for (const r of merged) {
      if (r.dialect && !/^G/.test(r.dialect)) {
        r.dialect = dialectsToCode([r.dialect]) || r.dialect;
      }
    }

    // Collapse residual dialect-split duplicates. A lexeme that still carries a
    // legacy `ga-`/`gd-` slug in one head (e.g. an un-migrated MacBain entry keyed
    // to a pre-`goi-` Wiktionary id) surfaces as a second row beside the neutral
    // `goi-` "G" row. Keep only the broadest-dialect row per (headword, pos): "G"
    // (both branches) wins over a single-branch "GA"/"GD". This is a DISPLAY de-dup
    // - the dropped URI is a distinct resource, so full content only merges once the
    // slug is unified upstream (rebuild the offending head). Same-breadth ties keep
    // the first seen.
    const breadth = (d: string) => (d === 'G' ? 3 : d ? 1 : 0);
    const bestByKey = new Map<string, EntrySummary>();
    const collapseKey = (r: EntrySummary) =>
      `${r.headword.normalize('NFC').toLowerCase()} ${(r.pos || '').toLowerCase()}`;
    for (const r of merged) {
      const key = collapseKey(r);
      const prev = bestByKey.get(key);
      if (!prev || breadth(r.dialect || '') > breadth(prev.dialect || '')) bestByKey.set(key, r);
    }
    merged = [...bestByKey.values()];

    const q = query.toLowerCase();
    const qNorm = normQuery.toLowerCase();
    // Whole-word match: the query as a complete token in a multi-word / compound
    // headword ("mór" in "cnoc mór"), accent-insensitive. Regexes built once, word
    // boundaries = start/end/space/hyphen.
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordReQ = new RegExp(`(^|[\\s-])${esc(q)}($|[\\s-])`);
    const wordReNorm = new RegExp(`(^|[\\s-])${esc(qNorm)}($|[\\s-])`);
    // Tier order: exact-with-accent > exact-up-to-accent > mutation-exact >
    // prefix/compound-with-accent > prefix-up-to-accent > whole-word-in-headword >
    // everything else (substring, gloss, inflected). exact-up-to-accent sits ABOVE
    // the prefix tiers so a whole headword ("bó" searched as "bo") outranks a
    // compound/prefix ("bo-…"). mutation-exact sits just below exact: if the user
    // typed an inflected/mutated surface form ("tháinig") the lemma that owns it
    // ("tar") is what they want, so lift it above prefix/substring/gloss noise.
    const wholeWord = (t: string): boolean =>
      wordReQ.test(t) || wordReNorm.test(stripDiacritics(t));
    const textTier = (r: EntrySummary): number => {
      const t = (lang === 'en' ? r.gloss || '' : r.headword).toLowerCase();
      if (t === q) return 0;
      if (stripDiacritics(t) === qNorm) return 1;
      // Exact surface form the user typed - a stripped initial mutation
      // ("tháinig") or an inflected form ("tiocfaidh") - resolves to its lemma.
      // Lift it above prefix/substring/gloss noise.
      if (demutMatchUris.has(r.uri) || formMatchUris.has(r.uri)) return 2;
      if (t.startsWith(q)) return 3;
      if (stripDiacritics(t).startsWith(qNorm)) return 4;
      if (wholeWord(t)) return 5;
      return 6;
    };
    // Branch demotion: this is a Gaeilge-first dictionary, so within any text tier
    // Scottish Gaelic / Manx-only entries sink below Irish. GA* (incl. GA.MUN /
    // GA.ULS) and G (a slug spanning both branches, so Irish-carrying) stay up;
    // GD / GV / uncoded drop. Keeps a Gaidhlig-only "fear" pronoun from topping
    // the Irish noun. Subordinate to the text tier (a better match still wins).
    const branchPenalty = (r: EntrySummary): number => {
      const branch = (r.dialect || '').split('.')[0].toUpperCase();
      return branch === 'GA' || branch === 'G' ? 0 : 1;
    };
    const rank = (r: EntrySummary): number => textTier(r) * 2 + branchPenalty(r);

    // Facet filters (drawer), applied BEFORE the 50-cap so hidden rows don't eat
    // slots. Phrase-hide is headword-search only (the user browses phrases via
    // Samplaí); POS applies to entry results (ga/en), never example sentences.
    // ...unless the user explicitly selected the "phrase" POS, which IS multi-word
    // (hiding it would leave that filter permanently empty).
    if (lang === 'ga' && !filters?.showPhrases && !filters?.pos?.includes('phrase')) {
      merged = merged.filter((r) => !/\s/.test(r.headword.trim()));
    }
    if (lang !== 'sampla' && filters?.pos?.length) {
      const want = new Set(filters.pos.map((p) => p.toLowerCase()));
      merged = merged.filter((r) => want.has((r.pos || '').toLowerCase()));
    }
    // Core-vocabulary filter: keep only entries BuNaMo returned. ga only - BuNaMo
    // indexes forms (pagefind-ga), not glosses, so it can't gate an en search.
    if (lang === 'ga' && filters?.bunamoOnly) {
      merged = merged.filter((r) => bunamoUris.has(r.uri));
    }

    merged.sort((a, b) => rank(a) - rank(b));

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
 * This way tilesLoaded() returns true and ensureTilesLoaded never fires - no
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


// ---------------------------------------------------------------------------
// v2 entry-detail path (static-assets pilot), behind a feature flag.
//
// `loadEntryV2` sources the SAME `EntryDetail` from the v2 cross-layer hydrate
// (`v2_hydrate_layers`) + closure label resolution instead of the v1
// SparqlStore-populate path. v1 `loadEntry` above stays untouched and default.
// ---------------------------------------------------------------------------


/**
 * A v2 pilot layer: a native head (for cross-layer hydrate) plus a Pagefind
 * base (for text search). `headDir` is consumed by the Rust `v2_*` commands;
 * `pagefindBase` feeds `collectPagefindBases`/search via the `dynamicLayers`
 * registry.
 */
export interface V2LayerConfig {
  /** Stable layer name - the `dynamicLayers` registry key. */
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
 * DEV-PATH CONSTANT - the v2 pilot layer set (base -> overlay: wiktionary then
 * macbain). `headDir` values are absolute repo paths the native `v2_*` commands
 * open directly (`Path::new(dir)`) - valid for `tauri dev` on the pilot machine
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
  {
    name: 'tearma',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/tearma-v2',
    pagefindBase: '/layer-tearma/',
  },
  {
    // Morphology enrichment (BuNaMo via Gramadán): composes full paradigms onto the
    // shared goi ids. Carries no senses/headwords - only `forms` + `grammar_class`.
    // Its Pagefind index holds inflected surface forms so a form search finds the
    // lemma (auto-ranked below headword matches). Order is precedence-neutral for the
    // card-n `forms` nodegroup (cross-layer merge is a union), so append at the end.
    name: 'bunamo',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/bunamo-v2',
    pagefindBase: '/layer-bunamo/',
  },
  {
    // Logainm placenames - its OWN graph (schema.org/Place), composed as a
    // separate model in the stack (does NOT merge into the lexical_entry tree).
    // Pagefind ga index = Irish + English name text; feature_type in meta.
    name: 'place',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/place-v2',
    pagefindBase: '/layer-place/',
  },
  {
    // Logainm toponymic CONCEPTS (ontolex:LexicalConcept) - the geographic
    // MEANING a placename evokes. OWN graph (Lexical Concept), full-hydratable as
    // its own head: a placename's `concept_entry` is hydrated concept-authoritative
    // via conceptHeadDir(), mirroring placeHeadDir(). Infrastructure, not a user
    // toggle; no Pagefind (reached only through placename/entry links).
    name: 'concept',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/concept-v2',
    pagefindBase: '/layer-concept/',
  },
  {
    // Corpus examples - OWN graph (like place): example resources + an
    // `illustrates` nodegroup linking to goi entries. Kept as two separate heads
    // so the licences stay distinct (Tatoeba CC BY 2.0 / Gaois CC BY 4.0). The
    // entry page finds a headword's examples via cited_by('headword_entry').
    name: 'example-tatoeba',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/example-tatoeba-v2',
    pagefindBase: '/layer-example-tatoeba/',
  },
  {
    name: 'example-gaois',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/example-gaois-v2',
    pagefindBase: '/layer-example-gaois/',
  },
  {
    // Person graph - seeded with the single "User" resource that authors notes.
    name: 'person',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/person-v2',
    pagefindBase: '/layer-person/',
  },
  {
    // Note/flag graph (oa:Annotation) - subject → any resource, author → User.
    // The MUTABLE layer: Flag ② re-emits this head on each new flag. Flags on a
    // resource = cited_by('subject'); own graph, so it never merges into entries.
    name: 'note',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/note-v2',
    pagefindBase: '/layer-note/',
  },
  {
    // Layer catalogue - describes each layer (licence, types, stats, …). Queried
    // on its own for the layer UI; not searched, not shown as a toggleable layer.
    name: 'layer',
    headDir: '/home/philtweir/Cód/Oscailte/Gréasán/data/layer-v2',
    pagefindBase: '/layer-layer/',
  },
];

/**
 * The ACTIVE v2 layer set. Defaults to the dev constant {@link V2_LAYERS} (vite
 * dev server: absolute head paths + the layer- middleware). In a built,
 * self-contained app {@link initOfflineLayers} replaces this with the app-data
 * head dirs (unpacked from the bundle) and pfzip Pagefind bases.
 */
let activeV2Layers: V2LayerConfig[] = V2_LAYERS;

/**
 * Layer names the user has hidden from composition - a VIEW filter, not an
 * uninstall: the head stays on disk and toggling back is free (Pagefind
 * instances are cached by base in `pagefind.ts`).
 *
 * No single layer is privileged: `ros-madair-read::Layers` resolves a per-MODEL
 * base (the first layer that carries the queried graph), not the global head 0,
 * and hydrate merges topmost-first across every layer that has the resource. The
 * only hard rule is that `Layers::open` errors on a zero-dir stack - so the sole
 * constraint enforced here is "never hide EVERY layer", not "never hide head 0".
 * That lets wiktionary be hidden (e.g. a Scottish-Gaelic-only view over macbain).
 */
let hiddenLayers: ReadonlySet<string> = new Set();

/** Replace the hidden-layer set. Guaranteed never to hide the whole stack. */
export function setHiddenLayers(names: Iterable<string>): void {
  const next = new Set(names);
  // RM needs a non-empty stack. If a request would hide every layer (a stale
  // persisted set, a family switch), keep the first one visible - but don't
  // otherwise privilege it: any single remaining layer is a valid base.
  const all = activeV2Layers.map((l) => l.name);
  if (all.length > 0 && all.every((n) => next.has(n))) next.delete(all[0]);
  hiddenLayers = next;
  // A hidden layer may have been the only source of some dialect values.
  dialectCache.clear();
}

export function getHiddenLayers(): ReadonlySet<string> {
  return hiddenLayers;
}

/** Ordered ACTIVE v2 layer head dirs (composition order, hidden layers dropped). */
export function currentV2HeadDirs(): string[] {
  // The `layer` catalogue is a META head (describes layers) - queried on its own
  // via layerCatalogueHeadDir(), never composed into the lexical/place stack.
  const visible = activeV2Layers.filter((l) => l.name !== 'layer' && !hiddenLayers.has(l.name));
  // setHiddenLayers already guards against an all-hidden set; this is the
  // belt-and-braces fallback so `Layers::open` never sees a zero-dir stack.
  const stack = visible.length > 0 ? visible : activeV2Layers.slice(0, 1);
  return stack.map((l) => l.headDir);
}

/**
 * The Logainm `place-v2` head dir, or undefined if that layer is not active.
 * The placenames map queries this head directly (its `spine_place`/`geo_bbox`
 * tables carry the point geometry), NOT the composed lexical stack - see
 * {@link geoPoints} / MapView. Tracks {@link initOfflineLayers} because it reads
 * the ACTIVE layer set, matching how `loadEntryV2` finds the same head.
 */
export function placeHeadDir(): string | undefined {
  return currentV2HeadDirs().find((d) => d.includes('place-v2'));
}

/**
 * The `concept-v2` head dir (Logainm meaning-concepts), or undefined if not
 * active. A placename's `concept_entry` (and, later, a sense's `evokes`) is
 * hydrated against THIS head as base - its `graph.json` is the LexicalConcept
 * model, which the composed lexical/place stack does not carry. Mirrors
 * {@link placeHeadDir}.
 */
export function conceptHeadDir(): string | undefined {
  return currentV2HeadDirs().find((d) => d.includes('concept-v2'));
}

/** The `layer-v2` catalogue head dir (meta layer), or undefined if not active. */
export function layerCatalogueHeadDir(): string | undefined {
  return activeV2Layers.find((l) => l.name === 'layer')?.headDir;
}

/**
 * Which layers actually carry `uri` - "coverage at cursor", the map-legend
 * readout for the open entry. One indexed descriptor lookup per layer, no
 * hydration and no graph load; a layer missing the resource returns no row.
 *
 * Reports on ALL installed layers, hidden ones included: the sheet needs to
 * distinguish "you turned this off" from "this has nothing to say here".
 */
export async function layerCoverage(uri: string): Promise<Set<string>> {
  const hits = await Promise.all(
    activeV2Layers.map(async (l) => {
      try {
        const found = await descriptors([l.headDir], [uri]);
        return found[uri] ? l.name : null;
      } catch {
        return null; // unreadable head - treat as no coverage, not an error
      }
    }),
  );
  return new Set(hits.filter((n): n is string => n !== null));
}

/**
 * DEV-ONLY back-compat alias. Prefer {@link currentV2HeadDirs}; this reflects the
 * dev defaults only and does NOT track {@link initOfflineLayers}.
 */
export const V2_HEAD_DIRS: string[] = V2_LAYERS.map((l) => l.headDir);

/**
 * First-run offline resolution. In a production/built app (not `tauri dev`),
 * unpack the bundled heads + Pagefind zips into app-data and point the active
 * layer set at those real paths, with Pagefind served from zip via the `pfzip`
 * custom protocol. No-op under vite dev (keeps the absolute-path + middleware
 * dev flow). Idempotent; safe to await once at startup before search/hydrate.
 */
export async function initOfflineLayers(): Promise<void> {
  if (import.meta.env.DEV) return; // dev uses V2_LAYERS + vite middleware
  const layers = await prepareOffline();
  activeV2Layers = layers.map((l) => ({
    name: l.name,
    headDir: l.head_dir,
    pagefindBase: `http://pfzip.localhost/${encodeURIComponent(l.pagefind_index)}/`,
  }));
}

/**
 * Register the v2 pilot layers WITHOUT touching the v1 engine.
 *
 * v1 `addDynamicLayer` also calls `SparqlStore.addLayer` (via `ensureStore`),
 * which is meaningless in v2 mode and fails against v2 heads. This v2 variant
 * only populates the `dynamicLayers` registry - enough for the `layers` store
 * (clears the "install a layer" empty state) and `collectPagefindBases`/search
 * - and never constructs a SparqlStore. Detail hydrate uses `V2_HEAD_DIRS`
 * natively (see `loadEntryV2`), not this registry.
 */
export function registerV2Layers(): void {
  dynamicLayers.length = 0;
  for (const layer of activeV2Layers) {
    // `|| null`: an installed v2 head has no pagefind base yet (empty string);
    // a null base is skipped by the search collector, an empty one would 404.
    dynamicLayers.push({ name: layer.name, baseUrl: layer.headDir, pagefindBase: layer.pagefindBase || null });
  }
  // A newly-registered layer may introduce new dialect values.
  dialectCache.clear();
}

/**
 * Register an INSTALLED v2 head (built on-device via `build_layer` format
 * `prebuild-v2`, or restored from disk) as an active layer so its resources join
 * the v2 head-dir set - `currentV2HeadDirs()` → hydrate/query/descriptors. Unlike
 * `addDynamicLayer` (v1 SparqlStore) this never constructs a store; it just adds
 * the head dir. Text search (Pagefind) for installed heads is a follow-on, so it
 * registers with a NULL pagefind base (search skips it; hydrate/badges still work).
 * Idempotent by name (reinstall replaces).
 */
export function addV2Layer(headDir: string, name: string): void {
  activeV2Layers = activeV2Layers.filter((l) => l.name !== name);
  activeV2Layers.push({ name, headDir, pagefindBase: '' });
  const i = dynamicLayers.findIndex((l) => l.name === name);
  if (i >= 0) dynamicLayers.splice(i, 1);
  dynamicLayers.push({ name, baseUrl: headDir, pagefindBase: null });
  dialectCache.clear();
}

/** Remove a single INSTALLED v2 head from the active set (the counterpart of
 *  addV2Layer). Drops ONLY the named layer - no store teardown - so the other
 *  heads stay registered; head dirs are read live via currentV2HeadDirs(). */
export function removeV2Layer(name: string): void {
  activeV2Layers = activeV2Layers.filter((l) => l.name !== name);
  const i = dynamicLayers.findIndex((l) => l.name === name);
  if (i >= 0) dynamicLayers.splice(i, 1);
  dialectCache.clear();
}

/** Load an entry's detail via the v2 cross-layer hydrate. */
export function loadEntryFlagged(uri: string, _knownHeadword?: string): Promise<EntryDetail | null> {
  return loadEntryV2(uri, currentV2HeadDirs());
}

/** Unwrap a v2 localized-string value `{<lang>:{value}}` (or a bare string). */
function exLocalStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, any>;
    for (const c of [o.en, o.ga, ...Object.values(o)]) {
      if (c && typeof c === 'object' && typeof c.value === 'string') return c.value;
    }
    if (typeof o.value === 'string') return o.value;
  }
  return '';
}

/** Parse a ";"-separated "start,end" span string to tuples. */
function parseSpanString(s: string): [number, number][] {
  if (!s) return [];
  const out: [number, number][] = [];
  for (const part of s.split(';')) {
    const [a, b] = part.split(',').map((n) => parseInt(n, 10));
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push([a, b]);
  }
  return out;
}

export async function loadExample(resourceId: string): Promise<ExampleDetail | null> {
  // v2: the example is a resource in one of the example heads (Tatoeba / Gaois).
  // Hydrate it and read the headwords it illustrates - with their per-headword
  // spans - straight from its own `illustrates` tiles (no reverse lookup, no
  // surface-form matching). The v1 SparqlStore / core-goidelic path is retired.
  const headDirs = currentV2HeadDirs();
  const exampleHeads = headDirs.filter((d) => d.includes('/example-'));
  for (const head of exampleHeads) {
    try {
      const tree = (await hydrateV2(head, resourceId)) as any;
      const sentence = exLocalStr(tree?.sentence);
      if (!sentence) continue; // resource lives in the other head
      const translation = exLocalStr(tree.sentence_en);
      const prov = tree.provenance || {};
      const source = head.includes('tatoeba') ? 'Tatoeba' : head.includes('udt') ? 'UDT' : 'Gaois';
      const sourceId = exLocalStr(prov.source_id);
      const highlights = exLocalStr(prov.highlights);
      // Gaois collection is bilingual "ga|en" - keep the Irish side.
      const collection = exLocalStr(prov.collection).split('|')[0];
      const citation = exLocalStr(prov.citation);

      // Illustrated headwords straight from the resource's own tiles.
      const illusRaw = tree.illustrates;
      const illus = Array.isArray(illusRaw) ? illusRaw : illusRaw ? [illusRaw] : [];
      const rawHw = illus
        .map((r: any) => {
          // A resource-instance node hydrates as an array of {resourceId} (same
          // shape as cognate_entry_id in loadEntryV2), so unwrap the first element.
          let he = r?.headword_entry;
          if (Array.isArray(he)) he = he[0];
          const id = typeof he === 'string' ? he : he?.resourceId ?? he?.id ?? '';
          return { id: String(id || ''), span: exLocalStr(r?.span) };
        })
        .filter((x: { id: string }) => x.id);
      const labels = rawHw.length ? await descriptors(headDirs, rawHw.map((x: { id: string }) => x.id)) : {};
      const headwords: Array<{ resourceId: string; headword: string; spans: [number, number][] }> = [];
      const seen = new Set<string>();
      for (const x of rawHw) {
        if (seen.has(x.id)) continue;
        seen.add(x.id);
        const headword = labels[x.id] || '';
        if (headword) headwords.push({ resourceId: x.id, headword, spans: parseSpanString(x.span) });
      }

      // Real per-item link only where the source publishes one (Tatoeba). Gaois
      // has no per-tuid permalink - the citation carries the provenance instead.
      const sourceUrl = source === 'Tatoeba' && sourceId ? `https://tatoeba.org/sentences/${sourceId}` : '';

      return { resourceId, sentence, translation, source, sourceId, highlights, collection, citation, sourceUrl, headwords };
    } catch (err) {
      console.warn('[dictionary] loadExample hydrate failed:', err);
    }
  }
  return null;
}

export interface Flag {
  resourceId: string;
  text: string;
}

/**
 * Notes/flags attached to a resource - the reverse of `note.subject`. Runs
 * note-authoritative (`subject` is a note-graph node) against the note head in
 * the stack. Works for ANY resource (entry, example, place) - the caller just
 * passes the resource UUID.
 */
export async function loadFlags(uri: string): Promise<Flag[]> {
  try {
    const noteHead = currentV2HeadDirs().find((d) => d.includes('/note-v2'));
    if (!noteHead) return [];
    const ids = await citedBy([noteHead], uri, 'subject');
    if (!ids.length) return [];
    const texts = await descriptors([noteHead], ids);
    return ids.map((id) => ({ resourceId: id, text: texts[id] || '' })).filter((f) => f.text);
  } catch (err) {
    console.warn('[dictionary] loadFlags failed:', err);
    return [];
  }
}
