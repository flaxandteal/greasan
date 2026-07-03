/** English locale. */
const en: Record<string, string> = {
  // Navigation
  'nav.search': 'Search',
  'nav.starred': 'Starred',
  'nav.settings': 'Settings',
  'nav.back': 'Back',

  // Search
  'search.title': 'Gréasán',
  'search.placeholder': 'Search for a word\u2026',
  'search.clear': 'Clear search',
  'search.results': '{count} results',
  'search.noResults': 'No results found',
  'search.recentlyViewed': 'Recently viewed',
  'search.typeToSearch': 'Type to search',
  'search.settings': 'Settings',
  'search.info': 'Info',
  'search.noLayers': 'Install a dictionary layer in Settings to get started.',
  'search.goToSettings': 'Open Settings',

  // Entry detail
  'entry.title': 'Entry',
  'entry.senses': 'Senses',
  'entry.forms': 'Grammar forms',
  'entry.examples': 'Examples',
  'entry.etymology': 'Etymology',
  'entry.cognates': 'Related Words',
  'entry.star': 'Star',
  'entry.unstar': 'Unstar',

  // Form groups
  'forms.nominative': 'Nominative',
  'forms.genitive': 'Genitive',
  'forms.dative': 'Dative',
  'forms.vocative': 'Vocative',
  'forms.lenited': 'Lenited',
  'forms.eclipsed': 'Eclipsed',
  'forms.other': 'Other',

  // Example detail
  'example.title': 'Example',
  'example.translation': 'Translation',
  'example.source': 'Source',
  'example.viewSource': 'View source \u2192',

  // Starred
  'starred.title': 'Starred',
  'starred.recent': 'Recent',
  'starred.empty': 'No starred entries yet',
  'starred.emptyHint': 'Tap the star on any entry to save it here',

  // Settings
  'settings.title': 'Settings',
  'settings.dictionary': 'Dictionary',
  'settings.layers': 'Layers',
  'settings.noLayers': 'No layers added',
  'settings.suggestedLayers': 'Available layers',
  'settings.layerName': 'Layer name',
  'settings.layerUrl': 'Source URL (prebuild archive)',
  'settings.layerUrlPackage': 'Package URL (.tar.gz)',
  'settings.importLayer': 'Build from source',
  'settings.installPackage': 'Install package',
  'settings.removeLayer': 'Remove layer',
  'settings.formatBuilt': 'Pre-built package',
  'settings.formatPrebuild': 'Build from source',
  'settings.buildFetching': 'Fetching source\u2026',
  'settings.buildExtracting': 'Extracting package\u2026',
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
  'settings.license': 'Licensing',
  'settings.licenseTitle': 'Dictionary content from Wiktionary',
  'settings.licenseSubtitle': 'Licensed under CC BY-SA 3.0 / 4.0 and GFDL.',
  'settings.licenseEntries': 'Dictionary entries \u2014 Wiktionary, licensed CC BY-SA 3.0/4.0 + GFDL. Extracted via Kaikki.org using Wiktextract (Ylonen 2022, LREC). Each entry links to its Wiktionary source page; contributors credited via page edit history.',
  'settings.licenseExamples': 'Example sentences \u2014 Tatoeba (CC BY 2.0 FR); Gaois Parallel Corpus of Legislation (Fiontar & Scoil na Gaeilge, DCU, CC BY 4.0).',
  'settings.licenseMacbain': 'MacBain\'s Etymological Dictionary of the Gaelic Language (1911) \u2014 public domain. Attribution: Alexander MacBain, via Wikisource.',
  'settings.licenseFonts': 'Fonts \u2014 Kumbh Sans and League Gothic, both SIL Open Font License.',
  'settings.licenseShareAlike': 'This derived corpus inherits the Share-Alike obligation. Redistribution must preserve attribution and license terms.',
  'settings.licenseProvenance': 'Dump provenance, file hashes, and extract dates are recorded in the bundle manifest.',
  'settings.licenseShowDetails': 'Show full details',
  'settings.showToastOnLaunch': 'Show licensing notice on launch',

  // Diagnostics
  'settings.diagnostics': 'Diagnostics',
  'settings.diagEmpty': 'No diagnostic data yet \u2014 navigate to trigger loading.',
  'settings.diagStage': 'Stage',
  'settings.diagDuration': 'Duration',
  'settings.diagSize': 'Size',
  'settings.diagTotal': 'Total',
  'settings.diagReset': 'Reset',

  // License toast
  'toast.title': 'Open Data',
  'toast.body': 'Dictionary content from Wiktionary (CC BY-SA), examples from Tatoeba (CC BY 2.0) & Gaois.',
  'toast.details': 'Details',
  'toast.ok': 'OK',
  'toast.aria': 'Licensing information',

  // App
  'app.loading': 'Loading WASM modules\u2026',

  // FAQ
  'faq.title': 'Info',
  'faq.whatIsThis': 'What is this?',
  'faq.whatIsThisBody': 'Gréasán is a technical demo of semantic graph search \u2014 not a professional dictionary. It uses knowledge graphs to show connections between words, dialects, and word families.',
  'faq.howItWorks': 'How it works',
  'faq.howItWorksBody': 'It searches across languages, dialects and word families using relationship graphs. Switching between Irish and Scottish Gaelic is fluid because entries share a common ontology.',
  'faq.features': 'Features',
  'faq.featureStars': 'Stars \u2014 save entries for quick access from the Starred tab.',
  'faq.featureRecent': 'Recent views \u2014 last entries shown on the search page; configurable (or disable) in Settings.',
  'faq.featureLayers': 'Dynamic layers \u2014 a future feature allowing additional data sources to be loaded at runtime.',
  'faq.licensing': 'Licensing',
  'faq.licensingBody': 'Content licensing details are in Settings \u2192 Licensing. In brief: Wiktionary CC BY-SA, Tatoeba CC BY 2.0, Gaois CC BY 4.0. The notice on launch can be turned off in Settings.',
  'faq.openSource': 'Open source',
  'faq.openSourceBody': 'Built with Svelte, Tauri, alizarin-wasm, ros-madair, Pagefind, and Oxigraph.',
};

export default en;
