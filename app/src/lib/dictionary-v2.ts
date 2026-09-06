// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * v2 entry loader - produces the SAME `EntryDetail` the UI consumes, but from
 * the v2 cross-layer hydrate (`v2_hydrate_layers`) + closure label resolution,
 * instead of the v1 SparqlStore → populate → alizarin-proxy path.
 *
 * The v2 hydrate returns a schema-aware JSON tree keyed by nodegroup ALIAS. Two
 * shape facts drive the flattener (both confirmed against the real merged
 * wiktionary+macbain hydrate of the shared uuid e98ed0c3-…):
 *
 *  1. Every text value is a *localized string* object, not a bare string:
 *       { "en": { "value": "fear", "direction": "ltr" } }
 *     - so `localStr()` unwraps `.<lang>.value` (preferring `en`).
 *  2. Only part_of_speech, dialect and forms[].gram_features are RAW concept
 *     UUIDs needing closure resolution. source_label / etymology_source are
 *     PLAIN localized strings ("WK" / "MB"), NOT uuids - matching v1, which read
 *     them with `String(...)` rather than `getDisplay()`.
 *
 * This is the entry-detail path. Requires src-tauri built with `--features v2`
 * (the `v2_*` invokes reject otherwise).
 */
import { invoke } from '@tauri-apps/api/core';
import { hydrateLayers, citedBy, descriptors } from './v2';
import type { EntryDetail } from './dictionary';

/** Cache the closure map per headDirs stack (keyed by the ordered join). */
const closureCache = new Map<string, Promise<Record<string, string>>>();

function getClosure(headDirs: string[]): Promise<Record<string, string>> {
  const key = headDirs.join(' ');
  let p = closureCache.get(key);
  if (!p) {
    p = invoke<Record<string, string>>('v2_closure', { headDirs }).catch((err) => {
      console.warn('[dictionary-v2] closure load failed:', err);
      return {} as Record<string, string>;
    });
    closureCache.set(key, p);
  }
  return p;
}

/** Reset the module-level closure cache (e.g. on family switch). */
export function resetV2Closure(): void {
  closureCache.clear();
}

/**
 * Warm the closure cache for a head-dir stack in the background, so the FIRST
 * entry open does not pay for it on the critical path. `v2_closure` opens a fresh
 * cold DuckReader per layer dir and reads each concept catalog (~260ms/dir cold,
 * ~2s across the full stack) - and `loadEntryV2` awaits it in a `Promise.all`
 * alongside the hydrate, so until it is cached the visible entry is blocked on it.
 * Fire-and-forget from bootstrap (idempotent; getClosure de-dupes by key). This is
 * the closure-side sibling of the duck reader-pool prewarm.
 */
export function warmClosure(headDirs: string[]): void {
  void getClosure(headDirs);
}

/** Unwrap a localized-string value `{<lang>:{value}}` (or a bare string) to text. */
function localStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const obj = v as Record<string, any>;
    // Preferred: { en: { value } }; else first lang entry carrying a value.
    const candidates = [obj.en, ...Object.values(obj)];
    for (const c of candidates) {
      if (c && typeof c === 'object' && typeof c.value === 'string') return c.value;
    }
    // Or a flat { value } object.
    if (typeof obj.value === 'string') return obj.value;
  }
  return '';
}

// Acute + grave + macron fold to a single length marker - "graphically identical
// up to acute↔grave". Length is PRESERVED (fear ≠ fēar), only the accent
// CONVENTION is neutralised (Irish á = Scottish à = macron ā). Mirrors the
// macbain builder's `normalizeHead` and the pipeline `goi_slug` identity.
const _MACRON: Record<string, string> = {
  'à': 'ā', 'á': 'ā', 'è': 'ē', 'é': 'ē', 'ì': 'ī', 'í': 'ī',
  'ò': 'ō', 'ó': 'ō', 'ù': 'ū', 'ú': 'ū',
};

/** Identity form of a headword for SAME-LEXEME matching (not slug-building, so no
 *  punctuation stripping): casefold + NFC, then fold accent convention. Two
 *  headwords are the same lexeme iff their normHead is equal. */
export function normHead(s: string): string {
  return Array.from(s.normalize('NFC').toLowerCase(), (ch) => _MACRON[ch] ?? ch).join('');
}

/** Resolve a raw concept/reference value to its label via the closure map. */
function makeLabel(map: Record<string, string>) {
  return (v: unknown): string => {
    if (v == null) return '';
    // Reference fields hydrate as a raw uuid string.
    if (typeof v === 'string') return map[v] ?? v;
    // Defensive: card-1 reference could arrive as an object wrapping a uuid.
    if (typeof v === 'object') {
      const obj = v as Record<string, any>;
      const id = obj.resourceId ?? obj.id ?? obj.value ?? obj.concept_id;
      if (typeof id === 'string') return map[id] ?? id;
    }
    return '';
  };
}

/** Normalise a nodegroup value that may be card-1 (object) or card-n (array). */
function asArray(v: unknown): any[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Pull the (text, sourceLabel) etymology rows out of a hydrated tree. */
function extractEtymologies(tree: Record<string, any>): EntryDetail['etymologies'] {
  const out: EntryDetail['etymologies'] = [];
  for (const e of asArray(tree.etymology)) {
    const text = localStr(e?.etymology_text);
    const sourceLabel = localStr(e?.etymology_source);
    if (text) out.push({ text, sourceLabel: sourceLabel || undefined });
  }
  return out;
}

/** Pull the cognate rows out of a hydrated tree, resolving nothing (plain str). */
function extractCognates(tree: Record<string, any>): EntryDetail['cognates'] {
  const out: EntryDetail['cognates'] = [];
  for (const c of asArray(tree.cognates)) {
    const hw = localStr(c?.cognate_headword);
    const language = localStr(c?.cognate_language);
    const ref = asArray(c?.cognate_entry_id)[0];
    const entryId = ref && typeof ref === 'object' ? (ref.resourceId ?? ref.id ?? '') : '';
    if (hw) out.push({ headword: hw, language, entryId: entryId || undefined });
  }
  return out;
}

/** Fold `incoming` etymologies into `target`, dedup by text, merge source labels ('+'). */
function mergeEtymologies(target: EntryDetail['etymologies'], incoming: EntryDetail['etymologies']): void {
  for (const etym of incoming) {
    const existing = target.find((e) => e.text === etym.text);
    if (existing) {
      if (etym.sourceLabel) {
        const labels = new Set((existing.sourceLabel ?? '').split('+').filter(Boolean));
        labels.add(etym.sourceLabel);
        existing.sourceLabel = [...labels].sort().join('+');
      }
    } else {
      target.push({ ...etym });
    }
  }
}

/** Fold `incoming` cognates into `target`, dedup by headword+language. */
function mergeCognates(target: EntryDetail['cognates'], incoming: EntryDetail['cognates']): void {
  for (const cog of incoming) {
    const key = cog.headword + ' ' + (cog.language ?? '');
    if (!target.some((c) => c.headword + ' ' + (c.language ?? '') === key)) {
      target.push({ ...cog });
    }
  }
}

/**
 * Pull the sense rows out of a hydrated tree, stamping each with the DIALECT of
 * the entry it came from. Dialect is an entry-level property (all senses in one
 * resource share it), so it is resolved once at the call site (`label(tree.dialect)`)
 * and passed in. This is what lets a lexeme card show senses from multiple dialects
 * each tagged with its own - the main entry's, plus each cognate citer's.
 */
function extractSenses(tree: Record<string, any>, label: (v: unknown) => string): EntryDetail['senses'] {
  const out: EntryDetail['senses'] = [];
  for (const s of asArray(tree.senses)) {
    const gloss = localStr(s?.gloss);
    const example = localStr(s?.example);
    const sourceLabel = localStr(s?.source_label);
    // Per-tile dialect: the `sense_dialect` concept node (goi dialect-on-tiles),
    // resolved via the closure map. On a merged goi resource each sense carries the
    // dialect of the entry it came from - so one card shows Irish + Scottish senses.
    // Strip the "(General)" qualifier so Téarma's "Irish (General)" folds onto "Irish".
    const dialect = label(s?.sense_dialect).replace(/\s*\(General\)$/, '');
    if (gloss) {
      out.push({
        gloss,
        examples: example ? [example] : [],
        sourceLabel: sourceLabel || undefined,
        dialect: dialect || undefined,
      });
    }
  }
  return out;
}

/**
 * Fold `incoming` senses into `target`, dedup by gloss+examples+DIALECT (combining
 * source labels with '+'). Dialect is part of the key ON PURPOSE: the same gloss in
 * two dialects (Irish "man" / Scottish "man") stays two tagged senses, not one - that
 * is the point of the per-dialect tag. Same gloss+dialect from two publishers still
 * collapses, merging their labels.
 */
function mergeSenses(target: EntryDetail['senses'], incoming: EntryDetail['senses']): void {
  const keyOf = (s: EntryDetail['senses'][number]) =>
    s.gloss + ' ' + s.examples.join(' ') + ' ' + (s.dialect ?? '');
  for (const sense of incoming) {
    const existing = target.find((s) => keyOf(s) === keyOf(sense));
    if (existing) {
      if (sense.sourceLabel) {
        const labels = new Set((existing.sourceLabel ?? '').split('+').filter(Boolean));
        labels.add(sense.sourceLabel);
        existing.sourceLabel = [...labels].sort().join('+');
      }
    } else {
      target.push({ ...sense });
    }
  }
}

/**
 * Load an entry through the v2 stack and flatten to `EntryDetail`, applying the
 * exact v1 flattening + dedup rules against the v2 JSON tree.
 */
export async function loadEntryV2(uri: string, headDirs: string[]): Promise<EntryDetail | null> {
  try {
    const [treeRaw, map] = await Promise.all([hydrateLayers(headDirs, uri), getClosure(headDirs)]);
    const tree = treeRaw as Record<string, any> | null;
    if (!tree || typeof tree !== 'object' || !tree.resourceinstanceid) return null;

    const label = makeLabel(map);

    const headword = localStr(tree.headword);
    const pos = label(tree.part_of_speech);
    const dialect = label(tree.dialect);
    // Grammatical class (BuNaMo): noun declension / verb conjugation / adjective
    // declension - a plain localized string on the composed tree ('1'..'5', 'irr', '').
    // grammar_class + its confidence live NESTED under the `grammar_class_group`
    // semantic nodegroup (the model promoted grammar_class to a nodegroup with a
    // confidence reference - commit 9d6e23d). Top-level `tree.grammar_class` no
    // longer exists, so the declension stopped rendering; read from the group.
    const gcgRaw = tree.grammar_class_group;
    const gcg = (Array.isArray(gcgRaw) ? gcgRaw[0] : gcgRaw) as Record<string, unknown> | undefined;
    const grammarClass = localStr(gcg?.grammar_class) || undefined;
    // Confidence ('attested' / 'inferred' / 'uncertain'); non-attested gets a '?'
    // beside the declension in the UI.
    const grammarClassConfidence = localStr(gcg?.grammar_class_confidence) || undefined;

    // Pronunciation - cardinality n.
    const ipa: string[] = [];
    for (const p of asArray(tree.pronunciation)) {
      const val = localStr(p?.ipa_value);
      if (val) ipa.push(val);
    }

    // Senses - cardinality n, deduplicated across layers (merge identical
    // gloss+examples, combine source labels with '+').
    const senses: EntryDetail['senses'] = [];
    mergeSenses(senses, extractSenses(tree, label));

    // Forms - cardinality n. gram_features are raw concept uuids → closure.
    const forms: EntryDetail['forms'] = [];
    for (const f of asArray(tree.forms)) {
      const writtenRep = localStr(f?.written_rep);
      const tags: string[] = [];
      for (const feat of asArray(f?.gram_features)) {
        const tag = label(feat);
        if (tag && tag !== '(pending)' && tag !== '(unresolved)') tags.push(tag);
      }
      // Source code of the layer that supplied this form (e.g. 'gf' computed,
      // 'bn' attested) - drives one paradigm tab per contributing layer.
      const source = localStr(f?.form_source_label) || undefined;
      if (writtenRep) forms.push({ writtenRep, tags, source });
    }

    // Gender (lexinfo:gender) is an inherent entry-level property - a concept
    // reference resolved to its label via the closure, exactly like part_of_speech.
    // Fall back to scanning BuNaMo form tiles for a masculine/feminine tag when the
    // entry node is empty (older heads predating the gender node).
    let gender: string | undefined = label(tree.gender) || undefined;
    if (!gender) {
      for (const f of forms) {
        const g = f.tags.find((t) => t === 'masculine' || t === 'feminine');
        if (g) { gender = g; break; }
      }
    }

    // Etymology - cardinality n, deduplicated by text, merge source labels.
    // NOTE: the v2 alias is `etymology` (singular).
    const etymologies: EntryDetail['etymologies'] = [];
    mergeEtymologies(etymologies, extractEtymologies(tree));

    // Cognates - cardinality n. cognate_entry_id hydrates as [{resourceId}].
    const cognates: EntryDetail['cognates'] = [];
    mergeCognates(cognates, extractCognates(tree));

    // The cross-reference enrichment (reverse-cognate fold, external examples,
    // placenames) is DEFERRED to `enrichEntryV2` so the base entry renders without
    // waiting on ~5 more FFI round-trips. The caller (loadEntryFlagged) fires the
    // enrichment and folds it into the displayed entry when it resolves.
    return {
      uri,
      headword,
      pos,
      dialect: dialect || undefined,
      gender,
      grammarClass,
      grammarClassConfidence,
      senses,
      forms,
      ipa,
      etymologies,
      cognates,
      externalExamples: [],
      placenames: undefined,
    };
  } catch (err) {
    console.warn('[dictionary-v2] loadEntryV2 failed:', err);
    return null;
  }
}

/**
 * The DEFERRED cross-reference enrichment for an already-loaded base entry: the
 * reverse-cognate fold, external examples, and placenames - each a batch of FFI
 * round-trips that must not block the base entry render. Returns only the fields
 * to merge over the base (`etymologies`/`cognates` are the base's, now folded).
 * Best-effort per section; a failure just leaves that section un-enriched.
 */
export async function enrichEntryV2(
  uri: string,
  headDirs: string[],
  base: EntryDetail,
): Promise<Partial<EntryDetail>> {
  const headword = base.headword;
  const etymologies = base.etymologies.map((e) => ({ ...e }));
  const cognates = base.cognates.map((c) => ({ ...c }));

  // Reverse-cognate continuum: entries that CITE this one via `cognate_entry_id`
  // (e.g. MacBain "fear" citing Irish "fear") surface their etymology/cognates.
  // SAME-LEXEME gate applied BEFORE hydration via one batched `descriptors`
  // (display_name = <Headword>, no hydration); hydrate ONLY the matches.
  try {
    const citers = (await citedBy(headDirs, uri, 'cognate_entry_id')).filter(
      (c) => c && c !== uri,
    );
    const citerHeads = citers.length ? await descriptors(headDirs, citers) : {};
    const sameLexeme = citers.filter(
      (c) => normHead(citerHeads[c] ?? '') === normHead(headword),
    );
    const citerTrees = await Promise.all(
      sameLexeme.map((c) => hydrateLayers(headDirs, c).catch(() => null)),
    );
    for (const ct of citerTrees) {
      if (!ct || typeof ct !== 'object') continue;
      const citer = ct as Record<string, any>;
      mergeEtymologies(etymologies, extractEtymologies(citer));
      mergeCognates(cognates, extractCognates(citer));
    }
  } catch (err) {
    console.warn('[dictionary-v2] cited_by enrichment skipped:', err);
  }

  // External example sentences: the ExternalExample graph is not shipped, so
  // resolve the sentence cheaply from the spine descriptor (ONE indexed batch, no
  // hydration). Full detail is deferred to on-interaction.
  const externalExamples: EntryDetail['externalExamples'] = [];
  for (const head of headDirs.filter((d) => d.includes('/example-'))) {
    const src: 'tatoeba' | 'gaois' | 'udt' =
      head.includes('tatoeba') ? 'tatoeba' : head.includes('udt') ? 'udt' : 'gaois';
    try {
      const ids = await citedBy([head], uri, 'headword_entry');
      if (!ids.length) continue;
      const sentences = await descriptors([head], ids);
      for (const id of ids) {
        const ga = sentences[id];
        if (ga) externalExamples.push({ resourceId: id, ga, en: '', src, hl: [] });
      }
    } catch (err) {
      console.warn(`[dictionary-v2] examples (${src}) skipped:`, err);
    }
  }

  // Placenames: resources in the `place` layer whose name is constituted by this
  // word (reverse of `name_elements.element_entry`). `element_entry` lives in the
  // place graph, so run it place-authoritative (against the place head alone).
  // Keep the full count; resolve display names for a small sample via descriptors.
  let placenames: EntryDetail['placenames'];
  try {
    const placeHead = headDirs.find((d) => d.includes('place-v2'));
    if (placeHead) {
      const placeIds = await citedBy([placeHead], uri, 'element_entry');
      if (placeIds.length) {
        const sampleIds = placeIds.slice(0, 24);
        const names = await descriptors([placeHead], sampleIds);
        const sample = sampleIds
          .map((id) => ({ resourceId: id, name: names[id] || '' }))
          .filter((p) => p.name);
        placenames = { count: placeIds.length, sample };
      }
    }
  } catch (err) {
    console.warn('[dictionary-v2] placenames skipped:', err);
  }

  return { etymologies, cognates, externalExamples, placenames };
}
