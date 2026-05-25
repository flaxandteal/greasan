/** Irish (default) locale — contains the current UI text as-is. */
const ga: Record<string, string> = {
  // Navigation
  'nav.search': 'Cuardaigh',
  'nav.starred': 'Réaltaí',
  'nav.settings': 'Socruithe',
  'nav.back': 'Ar ais',

  // Search
  'search.title': 'Gréasán',
  'search.placeholder': 'Cuardaigh focal\u2026',
  'search.clear': 'Glan cuardach',
  'search.results': '{count} results',
  'search.noResults': 'Níl toradh ar bith — no results found',
  'search.recentlyViewed': 'Recently viewed',
  'search.typeToSearch': 'Type to search',
  'search.settings': 'Socruithe',
  'search.info': 'Eolas',
  'search.noLayers': 'Suiteáil sraith foclóra i Socruithe chun tosú.',
  'search.goToSettings': 'Oscail Socruithe',

  // Entry detail
  'entry.title': 'Iontráil',
  'entry.senses': 'Bríonna \u00b7 Senses',
  'entry.forms': 'Foirmeacha \u00b7 Grammar forms',
  'entry.examples': 'Samplaí \u00b7 Examples',
  'entry.star': 'Réalta',
  'entry.unstar': 'Bain réalta',

  // Form groups
  'forms.nominative': 'Nominative',
  'forms.genitive': 'Genitive',
  'forms.dative': 'Dative',
  'forms.vocative': 'Vocative',
  'forms.lenited': 'Lenited',
  'forms.eclipsed': 'Eclipsed',
  'forms.other': 'Other',

  // Example detail
  'example.title': 'Sampla',
  'example.translation': 'Aistriúchán \u00b7 Translation',
  'example.source': 'Foinse \u00b7 Source',
  'example.viewSource': 'Féach ar an bhfoinse \u2192',

  // Starred
  'starred.title': 'Réaltaí',
  'starred.recent': 'Recent',
  'starred.empty': 'No starred entries yet',
  'starred.emptyHint': 'Tap the star on any entry to save it here',

  // Settings
  'settings.title': 'Socruithe',
  'settings.dictionary': 'Dictionary',
  'settings.layers': 'Layers',
  'settings.noLayers': 'No layers added',
  'settings.suggestedLayers': 'Sraitheanna ar fáil',
  'settings.layerName': 'Layer name',
  'settings.layerUrl': 'Source URL (prebuild archive)',
  'settings.layerUrlPackage': 'URL pacáiste (.tar.gz)',
  'settings.importLayer': 'Tóg ón bhfoinse',
  'settings.installPackage': 'Suiteáil pacáiste',
  'settings.removeLayer': 'Bain sraith',
  'settings.formatBuilt': 'Pacáiste réamhthógtha',
  'settings.formatPrebuild': 'Tóg ón bhfoinse',
  'settings.buildFetching': 'Ag fáil foinse\u2026',
  'settings.buildExtracting': 'Ag baint amach pacáiste\u2026',
  'settings.buildParsing': 'Parsing data\u2026',
  'settings.buildBuilding': 'Building index\u2026',
  'settings.buildWriting': 'Writing files\u2026',
  'settings.dialects': 'Dialects',
  'settings.density': 'Density',
  'settings.densityCompact': 'Compact',
  'settings.densityComfortable': 'Comfortable',
  'settings.densitySpacious': 'Spacious',
  'settings.listStyle': 'List Style',
  'settings.listCard': 'Card',
  'settings.listFlat': 'Flat',
  'settings.appearance': 'Appearance',
  'settings.modeLight': 'Light',
  'settings.modeDark': 'Dark',
  'settings.recentHistory': 'Recent history',
  'settings.recentOff': 'Off',
  'settings.license': 'Ceadúnas \u00b7 Licensing',
  'settings.licenseTitle': 'Dictionary content from Wiktionary',
  'settings.licenseSubtitle': 'Licensed under CC BY-SA 3.0 / 4.0 and GFDL.',
  'settings.licenseEntries': 'Dictionary entries \u2014 Wiktionary, licensed CC BY-SA 3.0/4.0 + GFDL. Extracted via Kaikki.org using Wiktextract (Ylonen 2022, LREC). Each entry links to its Wiktionary source page; contributors credited via page edit history.',
  'settings.licenseExamples': 'Example sentences \u2014 Tatoeba (CC BY 2.0 FR); Gaois Parallel Corpus of Legislation (Fiontar & Scoil na Gaeilge, DCU, CC BY 4.0).',
  'settings.licenseFonts': 'Fonts \u2014 Kumbh Sans and League Gothic, both SIL Open Font License.',
  'settings.licenseShareAlike': 'This derived corpus inherits the Share-Alike obligation. Redistribution must preserve attribution and license terms.',
  'settings.licenseProvenance': 'Dump provenance, file hashes, and extract dates are recorded in the bundle manifest.',
  'settings.licenseShowDetails': 'Show full details',
  'settings.showToastOnLaunch': 'Show licensing notice on launch',

  // Diagnostics
  'settings.diagnostics': 'Diagnóisic \u00b7 Diagnostics',
  'settings.diagEmpty': 'Gan sonraí diagnóiseacha fós \u2014 nascleanúnaigh chun luchtú a thosú.',
  'settings.diagStage': 'Céim',
  'settings.diagDuration': 'Fad',
  'settings.diagSize': 'Méid',
  'settings.diagTotal': 'Iomlán',
  'settings.diagReset': 'Athshocraigh',

  // License toast
  'toast.title': 'Open Data',
  'toast.body': 'Dictionary content from Wiktionary (CC BY-SA), examples from Tatoeba (CC BY 2.0) & Gaois.',
  'toast.details': 'Details',
  'toast.ok': 'OK',
  'toast.aria': 'Licensing information',

  // App
  'app.loading': 'Loading WASM modules\u2026',

  // FAQ
  'faq.title': 'Eolas',
  'faq.whatIsThis': 'Cad é seo?',
  'faq.whatIsThisBody': 'Taispeántas teicniúil is ea Gréasán de chuardach graf séimeantach \u2014 ní foclóir gairmiúil é. Úsáideann sé graif eolais chun naisc idir focail, canúintí, agus teaghlaigh fhocal a léiriú.',
  'faq.howItWorks': 'Conas a oibríonn sé',
  'faq.howItWorksBody': 'Cuardaíonn sé trasna teangacha, canúintí agus teaghlaigh fhocal trí ghraif ghaolmhaireachta. Tá athrú idir Gaeilge agus Gàidhlig gan uaim toisc go roinneann iontrálacha onteolaíocht choiteann.',
  'faq.features': 'Gnéithe',
  'faq.featureStars': 'Réaltaí \u2014 sábháil iontrálacha le rochtain thapa ón gcluaisín Réaltaí.',
  'faq.featureRecent': 'Stair le déanaí \u2014 taispeántar na hiontrálacha deireanacha ar an leathanach cuardaigh; is féidir é a chumrú nó a mhúchadh i Socruithe.',
  'faq.featureLayers': 'Sraitheanna dinimiciúla \u2014 gné amach anseo a ligfidh foinsí sonraí breise a luchtú ag am rite.',
  'faq.licensing': 'Ceadúnú',
  'faq.licensingBody': 'Tá sonraí ceadúnaithe ábhair i Socruithe \u2192 Ceadúnas. Go hachomair: Wiktionary CC BY-SA, Tatoeba CC BY 2.0, Gaois CC BY 4.0. Is féidir an fógra ag am tosaithe a mhúchadh i Socruithe.',
  'faq.openSource': 'Foinse oscailte',
  'faq.openSourceBody': 'Tógtha le Svelte, Tauri, alizarin-wasm, ros-madair, Pagefind, agus Oxigraph.',
};

export default ga;
