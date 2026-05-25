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

export interface SuggestedLayer {
  name: string;
  url: string;
  label: string;
  format: 'built' | 'prebuild';
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
  suggestedLayers: SuggestedLayer[];
}

/** Look up the short block-caps code for a dialect label, e.g. "Connacht Irish" → "GA.CON". */
export function dialectCode(familyId: FamilyId, dialectLabel: string): string {
  const opt = FAMILIES[familyId]?.dialectOptions.find(d => d.value === dialectLabel);
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
    defaultLayers: [],
    suggestedLayers: [
      {
        name: 'wiktionary-goidelic',
        url: 'file:///home/philtweir/Cód/Oscailte/Gréasán/data/wiktionary-layer.tar.gz',
        label: 'Wiktionary — Irish + Scottish Gaelic',
        format: 'built',
      },
      {
        name: 'wiktionary-fixture',
        url: 'file:///home/philtweir/Cód/Oscailte/Gréasán/data/wiktionary-fixture-layer.tar.gz',
        label: 'Wiktionary (fixture — ~60 lemmas)',
        format: 'built',
      },
      {
        name: 'tearma',
        url: 'file:///home/philtweir/Cód/Oscailte/Gréasán/data/tearma-layer.tar.gz',
        label: 'Téarma — Irish terminology',
        format: 'built',
      },
    ],
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
    suggestedLayers: [],
  },
};
