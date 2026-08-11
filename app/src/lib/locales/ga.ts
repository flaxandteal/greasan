/**
 * Irish locale — a PARTIAL overlay on the canonical English (`en.ts`).
 *
 * Only genuine Irish belongs here. Any key omitted (or not yet translated)
 * falls back to English via `t` (chain: ga → en → key). So the honest thing to
 * do with an untranslated string is leave it OUT, not paste the English in —
 * that keeps `scripts/check-i18n.mjs` able to report what still needs Irish.
 */
const ga: Record<string, string> = {
  // Navigation
  'nav.search': 'Cuardaigh',
  'nav.starred': 'Réaltaí',
  'nav.settings': 'Socruithe',
  'nav.back': 'Ar ais',

  // Search
  'search.title': 'Gréasán',
  'search.placeholder': 'Cuardaigh focal…',
  'search.clear': 'Glan cuardach',
  'search.noResults': 'Níl toradh ar bith',
  'search.settings': 'Socruithe',
  'search.info': 'Eolas',
  'search.flags': 'Bratacha',
  'search.noLayers': 'Suiteáil sraith foclóra i Socruithe chun tosú.',
  'search.goToSettings': 'Oscail Socruithe',

  // HUMAN SLOT - filter drawer + part-of-speech labels. Deliberately NOT filled
  // (no machine translation): these keys fall back to the English strings in
  // en.ts until a person adds the Irish. Keys awaiting translation:
  //   filter.title, filter.showPhrases, filter.showPhrasesHint,
  //   filter.bunamoOnly, filter.bunamoOnlyHint,
  //   filter.partOfSpeech, filter.clear, filter.noneForExamples,
  //   pos.noun, pos.verb, pos.adjective, pos.adverb, pos.propernoun,
  //   pos.pronoun, pos.preposition, pos.numeral, pos.conjunction,
  //   pos.interjection, pos.particle, pos.phrase

  // Entry detail
  'entry.title': 'Iontráil',
  'entry.senses': 'Bríonna',
  'entry.forms': 'Foirmeacha',
  'entry.examples': 'Samplaí',
  'entry.etymology': 'Sanasaíocht',
  'entry.cognates': 'Focail Ghaolmhara',
  'entry.placenames': 'Logainmneacha',
  'entry.placenamesCount': '{count} logainm bunaithe ar an bhfocal seo',
  'entry.placenamesSource': 'Ó Logainm (CC BY 4.0), athraithe',
  'entry.star': 'Réalta',
  'entry.unstar': 'Bain réalta',

  // Placenames map
  'map.title': 'Léarscáil logainmneacha',
  'map.viewOnMap': 'Léarscáil',
  'map.pointsWithGeo': '{count} le suíomh',
  'map.clearFilter': 'Glan scagaire',
  'map.loading': 'Ag lódáil logainmneacha…',
  'map.empty': 'Níl aon logainm le comhordanáidí don fhocal seo.',
  'map.source': 'Ó Logainm (CC BY 4.0), athraithe · imlíne: Natural Earth',
  'map.goToEntry': 'Go dtí an iontráil',
  'map.viewOnLogainm': 'Féach ar Logainm',
  'map.loadingDetail': 'Ag lódáil sonraí…',
  'map.constituentWords': 'Focail chomhdhéanta',

  // Form groups
  'forms.nominative': 'Ainmneach',
  'forms.genitive': 'Ginideach',
  'forms.dative': 'Tabharthach',
  'forms.vocative': 'Gairmeach',
  'forms.lenited': 'Séimhithe',
  'forms.eclipsed': 'Uraithe',
  'forms.other': 'Eile',
  'forms.singular': 'Uatha',
  'forms.plural': 'Iolra',
  'forms.past': 'Caite',
  'forms.present': 'Láithreach',
  'forms.future': 'Fáistineach',
  'forms.conditional': 'Coinníollach',
  'forms.subjunctive': 'Foshuiteach',
  'forms.imperative': 'Ordaitheach',
  'forms.comparison': 'Céimeanna comparáide',
  'forms.principalParts': 'Príomhpháirteanna',
  'forms.verbalNoun': 'ainm briathartha',
  'forms.verbalAdjective': 'aidiacht bhriathartha',
  'forms.base': 'bun',
  'forms.autonomous': 'saor',

  // Example detail
  'example.title': 'Sampla',
  'example.translation': 'Aistriúchán',
  'example.source': 'Foinse',
  'example.viewSource': 'Féach ar an bhfoinse →',
  'example.headwords': 'Ceannfhocail',

  // Flags (notes on entries / examples / places)
  'flag.title': 'Bratacha',
  'flag.add': 'Cuir leis',
  'flag.addNote': 'Cuir nóta leis…',
  'flag.edit': 'Cuir in eagar',
  'flag.save': 'Sábháil',
  'flag.delete': 'Scrios',
  'flag.close': 'Dún',
  'flag.export': 'Easpórtáil',
  'flag.empty': 'Gan bratacha fós.',
  'flag.subject.entry': 'Ceannfhocal',
  'flag.subject.example': 'Sampla',
  'flag.subject.place': 'Logainm',

  // Layer detail page
  'layerDetail.title': 'Sraith',
  'layerDetail.description': 'Cur síos',
  'layerDetail.licence': 'Ceadúnas',
  'layerDetail.formats': 'Formáidí',
  'layerDetail.statistics': 'Staitisticí',
  'layerDetail.resources': 'acmhainn',
  'layerDetail.links': 'Naisc',
  'layerDetail.downloads': 'Íoslódáil',

  // Layer sheet
  'layers.title': 'Sraitheanna',
  'layers.aria': 'Sraitheanna a thaispeáint nó a cheilt',
  'layers.base': 'Ciseal deireanach',
  'layers.noEntry': 'Faic san iontráil seo',
  'layers.hint': 'Ní bhaintear sraith cheilte den ghléas.',
  'layers.manage': 'Bainistigh',

  // Settings
  'settings.title': 'Socruithe',
  'settings.layers': 'Sraitheanna',
  'settings.suggestedLayers': 'Sraitheanna ar fáil',
  'settings.layerUrlPackage': 'URL pacáiste (.tar.gz)',
  'settings.importLayer': 'Tóg ón bhfoinse',
  'settings.installPackage': 'Suiteáil pacáiste',
  'settings.removeLayer': 'Bain sraith',
  'settings.formatBuilt': 'Pacáiste réamhthógtha',
  'settings.formatPrebuild': 'Tóg ón bhfoinse',
  'settings.formatTbx': 'Téarmaíocht TBX',
  'settings.buildTbx': 'Tóg ó TBX',
  'settings.chooseTbxFile': 'Roghnaigh comhad TBX…',
  'settings.noFileChosen': 'Níl comhad roghnaithe',
  'settings.buildFetching': 'Ag fáil foinse…',
  'settings.buildExtracting': 'Ag baint amach pacáiste…',
  'settings.buildIndexing': 'Ag tógáil innéacs cuardaigh…',
  'settings.language': 'Teanga',
  'settings.langSystem': 'Córas',
  'settings.license': 'Ceadúnas',
  'settings.licenseMacbain': 'Foclóir Sanasaíochta na Gàidhlig le MacBain (1911) — san fhearann poiblí. Aiteantas: Alasdair MacBain, trí Wikisource.',
  'settings.licenseLogainm': 'Logainmneacha — Linked Logainm (logainm.ie), Gaois / Fiontar & Scoil na Gaeilge, DCU; © Rialtas na hÉireann, ceadúnaithe faoi CC BY 4.0. Athraithe: nasctar eilimintí na logainmneacha le hiontrálacha foclóra agus laghdaítear comhordanáidí go lárphointí.',

  // Diagnostics
  'settings.diagnostics': 'Diagnóisic',
  'settings.diagEmpty': 'Gan sonraí diagnóiseacha fós — nascleanúnaigh chun luchtú a thosú.',
  'settings.diagStage': 'Céim',
  'settings.diagDuration': 'Fad',
  'settings.diagSize': 'Méid',
  'settings.diagTotal': 'Iomlán',
  'settings.diagReset': 'Athshocraigh',

  // App
  'app.preparing': 'Ag ullmhú an fhoclóra…',
  'app.preparingHint': 'Ag díphacáil sonraí as líne. Ritheann sé seo uair amháin, ag an gcéad tosú.',

  // FAQ
  'faq.title': 'Eolas',
  'faq.whatIsThis': 'Cad é seo?',
  'faq.whatIsThisBody': 'Taispeántas teicniúil is ea Gréasán de chuardach graf séimeantach — ní foclóir gairmiúil é. Úsáideann sé graif eolais chun naisc idir focail, canúintí, agus teaghlaigh fhocal a léiriú.',
  'faq.howItWorks': 'Conas a oibríonn sé',
  'faq.howItWorksBody': 'Cuardaíonn sé trasna teangacha, canúintí agus teaghlaigh fhocal trí ghraif ghaolmhaireachta. Tá athrú idir Gaeilge agus Gàidhlig gan uaim toisc go roinneann iontrálacha onteolaíocht choiteann.',
  'faq.features': 'Gnéithe',
  'faq.featureStars': 'Réaltaí — sábháil iontrálacha le rochtain thapa ón gcluaisín Réaltaí.',
  'faq.featureRecent': 'Stair le déanaí — taispeántar na hiontrálacha deireanacha ar an leathanach cuardaigh; is féidir é a chumrú nó a mhúchadh i Socruithe.',
  'faq.featureLayers': 'Sraitheanna dinimiciúla — gné amach anseo a ligfidh foinsí sonraí breise a luchtú ag am rite.',
  'faq.licensing': 'Ceadúnú',
  'faq.licensingBody': 'Tá sonraí ceadúnaithe ábhair i Socruithe → Ceadúnas. Go hachomair: Wiktionary CC BY-SA, Tatoeba CC BY 2.0, Gaois CC BY 4.0. Is féidir an fógra ag am tosaithe a mhúchadh i Socruithe.',
  'faq.openSource': 'Foinse oscailte',
  'faq.openSourceBody': 'Tógtha le Svelte, Tauri, alizarin-wasm, ros-madair, Pagefind, agus Oxigraph.',

  // Help + first-run tour (settings.help, settings.showTour, tour.*): awaiting a
  // human Irish translation. Left out deliberately so they fall back to English
  // rather than shipping machine-translated Irish.
};

export default ga;
