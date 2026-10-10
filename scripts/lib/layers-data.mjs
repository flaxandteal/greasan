/**
 * layers-data.mjs — the single source of truth for the Layer catalogue.
 *
 * One entry per known data layer: its licensing/attribution, types, formats,
 * links (UPSTREAM source/provenance), description, Gréasán integration config,
 * and downloads (DOWNSTREAM artifact). Consumed by:
 *   - build-layer-catalogue.mjs — the FULL `layer-v2` head (real resource_count
 *     from each built head).
 *   - build-core.mjs            — the SKELETON Layer resources shipped in the core
 *     bundle (placeholder counts). An installed layer's own fuller Layer resource
 *     (same `layer-<slug>` ResourceID) overrides+supplements this skeleton via the
 *     store's cross-layer tile merge.
 *
 * Concept labels MUST match models/layer/collections.csv.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ALIZARIN_NS = '1a79f1c8-9505-4bea-a18e-28a053f725ca';

export const GREASAN_DATA_REPO = 'flaxandteal/greasan-data';

/** Layers whose data ships as a pre-built parquet-head zip on greasan-data
 * releases, so they are DOWNLOADABLE (install) even in a core-only build where
 * nothing is bundled. Excludes: tearma (file-picker, not redistributable),
 * person/note (app-generated, internal), basemap (its own PMTiles build). */
export const DOWNLOADABLE_SLUGS = new Set([
  'wiktionary', 'macbain', 'bunamo', 'gramadan-forms', 'place',
  'example-tatoeba', 'example-gaois', 'example-udt', 'concept',
]);

/** greasan-data release asset URL for a built parquet head (`<head>.zip`). */
export function greasanDataAssetUrl(head, tag) {
  return `https://github.com/${GREASAN_DATA_REPO}/releases/download/${tag}/${head}.zip`;
}

/** The pinned bundle tag from bundle-pin.json, so skeleton install URLs track the
 * pinned greasan-data release. null if the pin is absent. */
export function readBundleTag(root) {
  try { return JSON.parse(readFileSync(resolve(root, 'bundle-pin.json'), 'utf8')).tag || null; }
  catch { return null; }
}

export function uuidv5(name, ns) {
  const nsb = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const b = Buffer.from(createHash('sha1').update(Buffer.concat([nsb, Buffer.from(name, 'utf8')])).digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function csvEscape(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// --- Layer catalogue metadata. Concept labels MUST match models/layer/collections.csv. ---
export const LAYERS = [
  { slug: 'wiktionary', head: 'wiktionary-v2-full', name: 'Vicífhoclóir · Wiktionary',
    licence: 'CC BY-SA 4.0', attribution: 'Wiktionary contributors (CC BY-SA 4.0)',
    types: ['Glosses', 'Senses', 'Etymology', 'Pronunciation', 'Cognates'], formats: ['Arches JSON', 'RM'],
    swatch: 'var(--layer-wk)', default_on: 'true', descType: 'Overview',
    desc: 'Crowd-sourced Irish and Scottish Gaelic dictionary content extracted from Wiktionary - glosses, senses, etymologies, pronunciations and cognates.',
    // No `install`: this layer ships bundled in the APK and is auto-installed on
    // first run (v2_prepare_offline), like bunamo/place. Offering a catalogue
    // "Install" here only surfaced a dev-only http://localhost:8080 URL that fails
    // on-device. Re-add a real (GitHub-release) URL if OTA updates are wanted.
    config: { searchable: true, langs: ['ga', 'en'] },
    links: [{ t: 'Wiktionary', u: 'https://www.wiktionary.org/', ty: 'Homepage' }, { t: 'Data dumps', u: 'https://dumps.wikimedia.org/', ty: 'Source' }], downloads: [] },
  { slug: 'macbain', head: 'macbain-v2', name: 'MacBain (1911)',
    licence: 'Public Domain', attribution: "MacBain's Etymological Dictionary of the Gaelic Language (1911) - public domain",
    types: ['Etymology', 'Cognates', 'Glosses'], formats: ['Arches JSON', 'RM'],
    swatch: 'var(--layer-mb)', default_on: 'true', descType: 'Overview',
    desc: "Alexander MacBain's 1911 etymological dictionary of Scottish Gaelic - etymologies and cognates. Out of copyright.",
    // No `install`: bundled + auto-installed on first run (see wiktionary note).
    config: { searchable: true, langs: ['ga', 'en'] },
    links: [{ t: 'Archive.org', u: 'https://archive.org/details/etymologicaldict00macbuoft', ty: 'Source' }], downloads: [] },
  { slug: 'tearma', head: 'tearma-v2', name: 'Téarma',
    licence: 'No open reuse licence', attribution: 'Téarma.ie - terminology data (c) Foras na Gaeilge; implementation (c) Gaois, Fiontar & Scoil na Gaeilge, DCU. Not redistributed; loaded on-device from your own downloaded TBX.',
    types: ['Glosses', 'Terminology'], formats: ['TBX', 'RM'],
    swatch: 'var(--layer-te)', default_on: 'true', descType: 'Overview',
    desc: 'The National Terminology Database for Irish - domain-specific terminology across many fields.',
    config: { searchable: true, langs: ['ga', 'en'],
      // url:'' → the "choose a file" flow: Téarma can't ship, so the user picks a
      // TBX they downloaded from tearma.ie and it builds on-device.
      install: { name: 'tearma', url: '', format: 'tbx-v2' } },
    links: [{ t: 'Téarma.ie', u: 'https://www.tearma.ie/', ty: 'Homepage' }],
    downloads: [{ f: 'RM', u: '', n: 'Regenerated as an RM head from the source TBX.' }] },
  { slug: 'bunamo', head: 'bunamo-v2', name: 'BuNaMo',
    licence: 'CC BY 4.0', attribution: 'BuNaMo (Gramadán) - Michal Boleslav Měchura (CC BY 4.0)',
    types: ['Grammar', 'Morphology'], formats: ['RM'],
    swatch: 'var(--layer-bn)', default_on: 'true', descType: 'Overview',
    desc: 'Irish morphology database - full inflectional paradigms, composed onto the shared lemma ids via Gramadán.',
    config: { searchable: true, langs: ['ga'] },
    links: [{ t: 'BuNaMo (GitHub)', u: 'https://github.com/michmech/BuNaMo', ty: 'Source' }], downloads: [] },
  { slug: 'gramadan-forms', head: 'gramadan-forms-v2', name: 'Gramadán Forms (computed)',
    licence: 'CC BY 4.0', attribution: 'BuNaMo grammatical class (Gramadán) - Michal Boleslav Měchura (CC BY 4.0)',
    types: ['Grammar', 'Morphology'], formats: ['RM'],
    swatch: 'var(--layer-bn)', default_on: 'false', descType: 'Overview',
    desc: 'A compact computed alternative to BuNaMo: ships only the declension class per noun (a tiny signpost); the full paradigm is generated on device by Gramadán. Install this instead of BuNaMo to save space.',
    config: { searchable: false, langs: ['ga'] },
    links: [{ t: 'BuNaMo (GitHub)', u: 'https://github.com/michmech/BuNaMo', ty: 'Source' }], downloads: [] },
  { slug: 'place', head: 'place-v2', name: 'Logainm',
    licence: 'CC BY 4.0', attribution: 'Ó Logainm.ie (CC BY 4.0), athraithe / modified',
    types: ['Placenames'], formats: ['Arches JSON', 'RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Irish placenames from the Placenames Database of Ireland (Logainm), each linked to the dictionary headwords that constitute it.',
    config: { searchable: false, map: true },
    links: [{ t: 'Logainm.ie', u: 'https://www.logainm.ie/', ty: 'Homepage' }, { t: 'Linked Logainm', u: 'https://www.logainm.ie/en/inf/proj-machines', ty: 'Documentation' }], downloads: [] },
  { slug: 'example-tatoeba', head: 'example-tatoeba-v2', name: 'Tatoeba',
    licence: 'CC BY 2.0', attribution: 'Tatoeba (CC BY 2.0)',
    types: ['Examples'], formats: ['RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Example sentences from the Tatoeba project, linked to the headwords they illustrate.',
    config: { searchable: true, langs: ['sampla'] },
    links: [{ t: 'Tatoeba', u: 'https://tatoeba.org/', ty: 'Homepage' }], downloads: [] },
  { slug: 'example-gaois', head: 'example-gaois-v2', name: 'Gaois',
    licence: 'CC BY 4.0', attribution: 'Gaois - Parallel Corpus of Legislation (Fiontar & Scoil na Gaeilge, DCU; CC BY 4.0). Legislation © Government of Ireland.',
    types: ['Examples'], formats: ['RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Bilingual example sentences from the Gaois Parallel Corpus of Legislation.',
    config: { searchable: true, langs: ['sampla'] },
    links: [{ t: 'Gaois', u: 'https://www.gaois.ie/', ty: 'Homepage' }], downloads: [] },
  { slug: 'example-udt', head: 'example-udt-v2', name: 'UD Irish',
    licence: 'CC BY-SA 4.0', attribution: 'Irish Universal Dependencies Treebank (UD Irish-IDT, CC BY-SA 4.0)',
    // Primarily an examples layer (gold POS-tagged sentences), like Tatoeba/Gaois.
    types: ['Examples'], formats: ['RM'],
    swatch: 'var(--layer-udt)', default_on: 'true', descType: 'Overview',
    desc: 'Gold POS-tagged example sentences from the Irish Universal Dependencies treebank, linked unambiguously to the headwords they illustrate.',
    config: { searchable: true, langs: ['sampla'] },
    links: [{ t: 'UD Irish-IDT', u: 'https://universaldependencies.org/treebanks/ga_idt/', ty: 'Homepage' }], downloads: [] },
  { slug: 'concept', head: 'concept-v2', name: 'Concepts',
    licence: 'CC BY 4.0', attribution: 'Meaning-concepts derived from Logainm.ie (CC BY 4.0)',
    // NOTE: no dedicated "Concepts"/"Meanings" value exists in the Layer Types
    // collection - using 'Senses' as the closest existing tag (a LexicalConcept is
    // a meaning unit). Change here (and, for a new tag, in models/layer/collections.csv)
    // if a first-class Concepts type is wanted.
    types: ['Senses'], formats: ['Arches JSON', 'RM'],
    swatch: 'var(--layer-concept)', default_on: 'true', descType: 'Overview',
    desc: 'Meaning-concepts (LexicalConcept) that placenames evoke - hydrated against placename and entry links rather than searched directly.',
    config: { searchable: false, internal: true }, links: [], downloads: [] },
  { slug: 'person', head: 'person-v2', name: 'Person',
    licence: 'CC0 1.0', attribution: 'App-generated',
    types: ['Annotations'], formats: ['RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Internal person records - the seeded User who authors notes and flags.',
    config: { searchable: false, internal: true }, links: [], downloads: [] },
  { slug: 'note', head: 'note-v2', name: 'Nótaí · Notes',
    licence: 'CC0 1.0', attribution: 'App-generated (user notes)',
    types: ['Annotations'], formats: ['RM'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'User notes and flags attached to resources - the app\'s mutable overlay.',
    config: { searchable: false, internal: true, mutable: true }, links: [], downloads: [] },
  { slug: 'basemap', head: '', name: 'Léarscáil · Basemap',
    licence: 'ODbL 1.0', attribution: '© OpenMapTiles © OpenStreetMap contributors',
    types: ['Basemap'], formats: ['PMTiles'],
    swatch: 'var(--layer-default)', default_on: 'true', descType: 'Overview',
    desc: 'Self-rendered greyscale OpenStreetMap vector basemap for the placenames map. Generated offline with Planetiler.',
    config: { map: true, glyphs: false },
    links: [{ t: 'OpenStreetMap © licence', u: 'https://www.openstreetmap.org/copyright', ty: 'Licence' }, { t: 'OpenMapTiles', u: 'https://openmaptiles.org/', ty: 'Source' }],
    downloads: [{ f: 'PMTiles', u: '', n: 'Generated by scripts/build-basemap.sh (Planetiler, OSM extract).' }] },
];

export const CSV_COLUMNS = [
  'ResourceID', 'name', 'slug', 'icon', 'layer_type', 'layer_format',
  'licence', 'attribution', 'description_type', 'description_text',
  'resource_count', 'statistics_block', 'integration_slug', 'default_on', 'swatch', 'config_block',
  'link_title', 'link_url', 'link_type', 'download_format', 'download_url', 'download_notes',
];

/**
 * Emit the repeated-rows business CSV from the layer set.
 * `countResources(head) -> string` yields the real spine count (build-layer, from
 * each built head) or a placeholder (build-core, which has no heads) - defaults to
 * empty (no count).
 */
export function buildBusinessCsv(layers = LAYERS, countResources = () => '', { bundleTag = null } = {}) {
  const rows = [CSV_COLUMNS.join(',')];
  const blank = (obj) => CSV_COLUMNS.map((c) => csvEscape(obj[c] ?? '')).join(',');
  for (const L of layers) {
    const rc = countResources(L.head);
    const rid = `layer-${L.slug}`;
    // Downloadable layers get a greasan-data install URL baked into their skeleton,
    // so a core-only build can fetch them (they carry no bundled data). In a full
    // build that also bundles the head, this is an OTA/reinstall fallback.
    const dlUrl = bundleTag && DOWNLOADABLE_SLUGS.has(L.slug) && L.head
      ? greasanDataAssetUrl(L.head, bundleTag) : '';
    const config = dlUrl
      ? { ...(L.config || {}), install: { name: L.slug, url: dlUrl, format: 'built' } }
      : (L.config || {});
    const downloads = dlUrl
      ? [...L.downloads, { f: 'RM', u: dlUrl, n: 'Pre-built parquet head (greasan-data release).' }]
      : L.downloads;
    // Row 1: all scalars (root + licensing + description + statistics + integration).
    rows.push(blank({
      ResourceID: rid, name: L.name, slug: L.slug, icon: L.icon || '',
      layer_type: L.types.join(','), layer_format: L.formats.join(','),
      licence: L.licence, attribution: L.attribution,
      description_type: L.descType, description_text: L.desc,
      resource_count: rc,
      statistics_block: JSON.stringify({ resourceCount: rc === '' ? null : Number(rc), head: L.head || null, builtBy: 'build-layer-catalogue' }),
      integration_slug: L.head || L.slug, default_on: L.default_on, swatch: L.swatch,
      config_block: JSON.stringify(config),
    }));
    // One row per link (n-card).
    for (const lk of L.links) rows.push(blank({ ResourceID: rid, link_title: lk.t, link_url: lk.u, link_type: lk.ty }));
    // One row per download (n-card, nested under integration).
    for (const d of downloads) rows.push(blank({ ResourceID: rid, download_format: d.f, download_url: d.u, download_notes: d.n }));
  }
  return rows.join('\n') + '\n';
}
