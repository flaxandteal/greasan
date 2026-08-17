export type FamilyId = 'goidelic' | 'scots';

export interface SearchLangOption {
  id: string;
  label: string;
}

export interface DialectOption {
  value: string;
  label: string;
  group: string;
  /** Short block-caps code, e.g. "GA.CON". Empty for general dialects. */
  code: string;
}

export interface LayerConfig {
  baseUrl: string;
  name: string;
}

/**
 * How a layer presents itself in the layer sheet and on `.ge-layer-tag` chips.
 * Keyed by layer name. The swatch colour is the legend link: the same token
 * bars the chip on a sense and the row in the sheet, so "where did this come
 * from" is answerable without reading either label.
 */
export interface LayerPresentation {
  label: string;
  /** CSS colour (token reference preferred) - see `--layer-*` in tokens.css. */
  swatch: string;
  /**
   * `source_label` values this layer emits, lowercased. Used to colour the
   * per-sense chips; a layer whose data carries no source label simply gets
   * no chip tint, which is the existing behaviour.
   */
  sourceLabels?: string[];
}

/**
 * A user-installable layer source shown in the Layer Manager's "Add a layer"
 * list. No longer hardcoded here - the list is derived from the layer CATALOGUE
 * (each installable layer carries an `install` block in its `layer-v2` config;
 * see layers-catalogue.ts `LayerInstall`). This interface is just the shape
 * LayerManager maps those catalogue entries into.
 */
export interface SuggestedLayer {
  name: string;
  url: string;
  label: string;
  format: 'built' | 'prebuild' | 'prebuild-v2' | 'tbx' | 'tbx-v2';
}

export interface FamilyConfig {
  id: FamilyId;
  label: string;
  coreBase: string;
  graphId: string;
  exampleGraphId: string;
  rdfBase: string;
  dialectOptions: DialectOption[];
  defaultDialects: string[];
  sortLocale: string;
  searchLangs: SearchLangOption[];
  defaultLayers: LayerConfig[];
  /** Per-layer display config, keyed by layer name. Unlisted layers fall back
   *  to their raw name and a neutral swatch. */
  layerPresentation?: Record<string, LayerPresentation>;
}

/** Swatch colour for a layer name, or a neutral default. */
export function layerSwatch(familyId: FamilyId, layerName: string): string {
  return FAMILIES[familyId]?.layerPresentation?.[layerName]?.swatch ?? 'var(--layer-default)';
}

/** Swatch colour for a `source_label` chip value, or '' when unattributable. */
/** The display name of the layer that stamps `sourceLabel` (e.g. 'gf' → 'Gramadán',
 *  'bn' → 'BuNaMo'), for naming a per-source paradigm tab. Falls back to the raw
 *  code so an unknown source is still shown rather than swallowed. */
export function sourceLabelName(familyId: FamilyId, sourceLabel: string): string {
  const pres = FAMILIES[familyId]?.layerPresentation;
  const needle = sourceLabel.trim().toLowerCase();
  if (pres) {
    for (const p of Object.values(pres)) {
      if (p.sourceLabels?.includes(needle)) return p.label;
    }
  }
  return sourceLabel;
}

export function sourceLabelSwatch(familyId: FamilyId, sourceLabel: string): string {
  const pres = FAMILIES[familyId]?.layerPresentation;
  if (!pres) return '';
  // A merged chip ("MacBain+Wiktionary") has no single colour - leave it plain.
  if (sourceLabel.includes('+')) return '';
  const needle = sourceLabel.trim().toLowerCase();
  for (const p of Object.values(pres)) {
    if (p.sourceLabels?.includes(needle)) return p.swatch;
  }
  return '';
}

/**
 * Look up the short block-caps code for a dialect label, e.g. "Connacht Irish"
 * → "GA.CON", "Irish" → "GA".
 *
 * Tolerant of the "(General)" qualifier being present or absent: sense dialects
 * arrive already stripped ("Irish"), while entry/settings labels keep it
 * ("Irish (General)"). Both resolve to the language-generic code.
 */
export function dialectCode(familyId: FamilyId, dialectLabel: string): string {
  const opts = FAMILIES[familyId]?.dialectOptions ?? [];
  const strip = (s: string) => s.replace(/\s*\(General\)$/, '').trim();
  const target = strip(dialectLabel);
  const opt =
    opts.find(d => d.value === dialectLabel) ??
    opts.find(d => strip(d.value) === target);
  return opt?.code || '';
}

export const DEFAULT_FAMILY: FamilyId = 'goidelic';

export const FAMILIES: Record<FamilyId, FamilyConfig> = {
  goidelic: {
    id: 'goidelic',
    label: 'Goidelic',
    coreBase: '/core-goidelic/',
    graphId: '449c8695-253e-521b-8994-27701ce22305',
    exampleGraphId: '6d502e2e-7fe6-5414-99e4-ac981cebc493',
    rdfBase: 'https://flaxandteal.org/ontology/goidelic#',
    dialectOptions: [
      { value: 'Irish (General)', label: 'Irish (General)', group: 'Irish', code: 'GA' },
      { value: 'Connacht Irish', label: 'Connacht Irish', group: 'Irish', code: 'GA.CON' },
      { value: 'Ulster Irish', label: 'Ulster Irish', group: 'Irish', code: 'GA.ULS' },
      { value: 'Munster Irish', label: 'Munster Irish', group: 'Irish', code: 'GA.MUN' },
      { value: 'Scottish Gaelic (General)', label: 'Scottish Gaelic (General)', group: 'Scottish Gaelic', code: 'GD' },
      { value: 'Highland Gaelic', label: 'Highland Gaelic', group: 'Scottish Gaelic', code: 'GD.HLD' },
      { value: 'Hebridean Gaelic', label: 'Hebridean Gaelic', group: 'Scottish Gaelic', code: 'GD.HEB' },
      { value: 'Argyll Gaelic', label: 'Argyll Gaelic', group: 'Scottish Gaelic', code: 'GD.ARG' },
      { value: 'Manx (General)', label: 'Manx (General)', group: 'Manx', code: 'GV' },
    ],
    defaultDialects: [
      'GA', 'GA.CON', 'GA.ULS', 'GA.MUN',
      'GD.ARG',
    ],
    sortLocale: 'ga',
    searchLangs: [
      { id: 'ga', label: 'Ceannfhocail' },
      { id: 'en', label: 'Gluais' },
      { id: 'sampla', label: 'Samplaí' },
    ],
    // Keyed by v2 layer name (see V2_LAYERS / the installed layer registry).
    // sourceLabels are the codes the pipeline stamps on senses: "WK" from
    // normalise.py, "MB" from build-macbain-layer.mjs, "TE" from the TBX run.
    layerPresentation: {
      wiktionary: { label: 'Vicífhoclóir', swatch: 'var(--layer-wk)', sourceLabels: ['wk'] },
      macbain: { label: 'MacBain (1911)', swatch: 'var(--layer-mb)', sourceLabels: ['mb'] },
      // 'té' is stamped by fresh builds; 'te' matches legacy builds pre-fada.
      tearma: { label: 'Téarma', swatch: 'var(--layer-te)', sourceLabels: ['té', 'te'] },
      // Morphology only - no senses, so no source chips ever carry "BN".
      bunamo: { label: 'BuNaMo', swatch: 'var(--layer-bn)', sourceLabels: ['bn'] },
      // Computed morphology: greasan-gramadan stamps 'gf' on every generated
      // form, so its paradigm tab is named + attributed distinctly from attested.
      'gramadan-forms': { label: 'Gramadán', swatch: 'var(--layer-bn)', sourceLabels: ['gf'] },
      // Sense-less / infrastructural layers: named + coloured for the sheet,
      // but they emit no per-sense source chips (no sourceLabels).
      // Logainm/Tatoeba/Gaois are proper nouns (no translation). concept/person/
      // note keep English descriptors - a human can Gaelicise them, we don't MT.
      place: { label: 'Logainm', swatch: 'var(--layer-place)' },
      concept: { label: 'Concepts', swatch: 'var(--layer-concept)' },
      'example-tatoeba': { label: 'Tatoeba', swatch: 'var(--layer-tatoeba)' },
      'example-gaois': { label: 'Gaois', swatch: 'var(--layer-gaois)' },
      'example-udt': { label: 'UD Irish', swatch: 'var(--layer-udt)' },
      person: { label: 'Users', swatch: 'var(--layer-person)' },
      note: { label: 'Notes', swatch: 'var(--layer-note)' },
    },
    defaultLayers: [],
  },
  scots: {
    id: 'scots',
    label: 'Scots',
    coreBase: '/core-scots/',
    graphId: 'scots-lexical-entry-graph-placeholder',
    exampleGraphId: 'scots-example-graph-placeholder',
    rdfBase: 'https://flaxandteal.org/ontology/goidelic#',
    dialectOptions: [
      { value: 'Scots (General)', label: 'Scots (General)', group: 'Scots', code: 'SCO' },
      { value: 'Ulster Scots', label: 'Ulster Scots', group: 'Scots', code: 'SCO.ULS' },
    ],
    defaultDialects: ['SCO', 'SCO.ULS'],
    sortLocale: 'sco',
    searchLangs: [
      { id: 'sco', label: 'Scots' },
      { id: 'en', label: 'English' },
    ],
    defaultLayers: [],
  },
};
