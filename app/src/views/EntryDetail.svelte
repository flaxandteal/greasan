<script lang="ts">
  import { currentEntry, loading, familyConfig, starredEntries, toggleStar, openMap } from '../lib/store';
  import { loadEntryFlagged, placeHeadDir, type EntryDetail } from '../lib/dictionary';
  import { dialectCode, sourceLabelSwatch } from '../lib/family';
  import { t } from '../lib/i18n';
  import { buildParadigm, posKind, type FlatGroup, type FormItem } from '../lib/paradigm';
  import { generateForms } from '../lib/gramadan';
  import ExampleList from './ExampleList.svelte';
  import LayerPill from './LayerPill.svelte';
  import FlagButton from './FlagButton.svelte';

  let entry = $derived($currentEntry as EntryDetail | null);
  /** True when the headword contains letters whose glyphs descend below the baseline. */
  let hasDescenders = $derived(entry ? /[gjpqyçþðĝĵ]/i.test(entry.headword) : false);
  let starred = $derived(entry ? $starredEntries.some(e => e.uri === entry!.uri) : false);
  // Top-bar dialect code. Derived from the COMPOSED senses (which carry each
  // contributing layer's dialect), so a lexeme with e.g. Irish senses from
  // wiktionary + Scottish senses from macbain shows "G" (both Goidelic branches)
  // rather than whichever single dialect the entry-level tag happened to hold.
  let entryDialectCode = $derived.by(() => {
    if (!entry) return '';
    const branches = new Set<string>();
    for (const s of entry.senses ?? []) {
      if (!s.dialect) continue;
      const c = dialectCode($familyConfig.id, s.dialect) || s.dialect;
      if (c) branches.add(c.split('.')[0]);
    }
    if (branches.size > 1) return 'G';
    return dialectCode($familyConfig.id, entry.dialect || '') || '';
  });

  // Grammar shown as source-tagged tabs:
  //  - BuNaMo (attested): present only when its (opt-in, hidden-by-default) layer
  //    is on, so its forms compose onto the entry (entry.forms populated).
  //  - Gramadan (generated): always available for a classed noun/verb; gramadan-rs
  //    generates from lemma+gender+class offline.
  // One source -> a single grid (no tab chrome); both -> two tabs, BuNaMo first.
  // Nouns: nom/gen only (dat/voc rule-governed but not exception-free, e.g. laimh /
  // a fhir, and unconfirmable). Verbs: learner-core tenses + verbal noun/adjective,
  // with a "ni" toggle swapping independent vs dependent forms (rinne / dearna) -
  // the same idea as the noun article toggle.
  let generated = $state<FormItem[] | null>(null);
  $effect(() => {
    const e = entry;
    generated = null;
    const kind = e ? posKind(e.pos) : 'other';
    if (e && (kind === 'noun' || kind === 'verb') && (e.grammarClass ?? '') !== '') {
      const key = e.uri;
      generateForms(e.headword, kind, e.gender ?? '', e.grammarClass ?? '').then((g) => {
        if (entry?.uri === key && g.supported && g.forms.length) generated = g.forms;
      });
    }
  });

  // Verb independent/dependent toggle. Only tense forms carry the split; verbal
  // noun/adjective and imperative are invariant and always shown.
  let showDependent = $state(false);
  const VERB_TENSES = ['past', 'present', 'future', 'conditional'];
  const isTenseForm = (f: FormItem) => VERB_TENSES.some((t) => f.tags.includes(t));
  const anyDependent = (fs: FormItem[] | null | undefined) => !!fs?.some((f) => f.tags.includes('dependent'));
  // Toggle shows for a verb whose active source carries dependent forms - the
  // generated tab always does; the attested tab does once BuNaMo emits them.
  let hasDependent = $derived(
    !!entry &&
      posKind(entry.pos) === 'verb' &&
      (anyDependent(generated) || anyDependent((entry.forms ?? []) as FormItem[])),
  );

  /** Scope a form set per POS before pivoting: verbs by the indep/dep toggle,
   *  nouns to the confirmable nom/gen. Used for both attested and generated. */
  function scopeForms(forms: FormItem[]): FormItem[] {
    if (entry && posKind(entry.pos) === 'verb') {
      // Keep VN/VA/imperative always; swap tense forms by the ni toggle, then strip
      // the dependency marker so paradigm.ts pivots them uniformly.
      return forms
        .filter((f) =>
          !isTenseForm(f)
            ? true
            : showDependent
              ? f.tags.includes('dependent')
              : !f.tags.includes('dependent'),
        )
        .map((f) => ({ ...f, tags: f.tags.filter((t) => t !== 'dependent') }));
    }
    // Nouns: confirmable nom/gen only; drop definite/articled and voc/dat.
    return forms.filter(
      (f) => !f.tags.includes('definite') && (f.tags.includes('nominative') || f.tags.includes('genitive')),
    );
  }

  // Dependent-clause particle shown as a grey prefix on the dependent forms (like
  // the noun article), with its initial mutation applied to the bare stem - so it
  // works identically for attested (BuNaMo) and generated forms. go (eclipsis) for
  // the non-past and the irregular past; gur (lenition) for the regular past;
  // nothing for the imperative (no dependent).
  function depParticle(tense: string): string {
    if (!showDependent || tense === 'imperative') return '';
    if (tense === 'past') return (entry?.grammarClass ?? '') === 'irr' ? 'go' : 'gur';
    return 'go';
  }
  const ECLIPSE: Record<string, string> = { b: 'mb', c: 'gc', d: 'nd', f: 'bhf', g: 'ng', p: 'bp', t: 'dt' };
  function mutateForParticle(particle: string, w: string): string {
    if (!w) return w;
    const c = w[0].toLowerCase();
    if (particle === 'go') {
      if (ECLIPSE[c]) return ECLIPSE[c] + w.slice(1); // eclipsis
      if ('aeiouáéíóú'.includes(c)) return 'n-' + w; // vowel -> n-
      return w; // s, l, m, n, r, h unchanged
    }
    // gur -> lenition; s before c/m/p/t does not lenite.
    if (c === 's' && 'cmpt'.includes((w[1] ?? '').toLowerCase())) return w;
    if ('bcdfgmpst'.includes(c)) return w[0] + 'h' + w.slice(1);
    return w; // vowels, l, n, r, h unchanged
  }
  /** A verb cell's grey particle + its (mutated) forms, for the dependent view. */
  function depCell(tense: string, forms: { text: string }[]): { particle: string; text: string } {
    const p = depParticle(tense);
    return { particle: p, text: forms.map((f) => (p ? mutateForParticle(p, f.text) : f.text)).join(', ') };
  }

  let attestedParadigm = $derived.by(() => {
    const attested = (entry?.forms ?? []) as FormItem[];
    if (!entry || !attested.length) return null;
    const scoped = scopeForms(attested);
    return scoped.length ? buildParadigm(scoped, entry.pos) : null;
  });
  let generatedParadigm = $derived.by(() => {
    if (!entry || !generated?.length) return null;
    const scoped = scopeForms(generated);
    return scoped.length ? buildParadigm(scoped, entry.pos) : null;
  });

  type GramTab = { label: string; paradigm: ReturnType<typeof buildParadigm>; generated: boolean };
  let gramTabs = $derived.by<GramTab[]>(() => {
    const t: GramTab[] = [];
    if (attestedParadigm) t.push({ label: 'BuNaMo', paradigm: attestedParadigm, generated: false });
    if (generatedParadigm) t.push({ label: 'Gramadán', paradigm: generatedParadigm, generated: true });
    return t;
  });
  let activeGramTab = $state(0);
  $effect(() => {
    entry?.uri;
    activeGramTab = 0;
    showDependent = false;
  });
  let activeTabIndex = $derived(Math.min(activeGramTab, Math.max(0, gramTabs.length - 1)));
  let paradigm = $derived(gramTabs[activeTabIndex]?.paradigm ?? null);
  let activeGenerated = $derived(gramTabs[activeTabIndex]?.generated ?? false);

  // Person-slot → Irish pronoun label (content, so not localised); base/autonomous via i18n.
  const PRONOUN: Record<string, string> = {
    '1sg': 'mé', '2sg': 'tú', '3sg': 'sé/sí', '1pl': 'muid', '2pl': 'sibh', '3pl': 'siad',
  };
  function personLabel(p: string): string {
    return PRONOUN[p] ?? $t('forms.' + p);
  }
  /** A leftover cell qualifier: gender → m/f, otherwise the raw concept label. */
  function tagLabel(tag: string): string {
    return tag === 'masculine' ? 'm' : tag === 'feminine' ? 'f' : tag;
  }
  const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th'];
  /** Compact class badge for the title: 'm1' (noun), 'a1' (adj), '1st conj.' (verb). */
  let classBadge = $derived.by(() => {
    if (!entry) return '';
    const g = entry.gender === 'masculine' ? 'm' : entry.gender === 'feminine' ? 'f' : '';
    const c = entry.grammarClass ?? '';
    const kind = posKind(entry.pos);
    // An inferred/uncertain declension (gramadan guess, not attested) gets a
    // trailing '?' beside the class so the reader knows it is not sourced.
    const conf = (entry.grammarClassConfidence ?? '').toLowerCase();
    const q = c && conf && !conf.startsWith('attest') ? '?' : '';
    if (kind === 'noun') return c ? g + c + q : g;
    if (kind === 'adjective') return c ? 'a' + c + q : '';
    if (kind === 'verb') return c && ORDINAL[+c] ? ORDINAL[+c] + ' conj.' + q : '';
    return g;
  });

  function handleStar() {
    if (!entry) return;
    toggleStar({
      uri: entry.uri,
      headword: entry.headword,
      pos: entry.pos || '',
      gloss: entry.senses?.[0]?.gloss,
    });
  }

  let openGroup: string | null = $state(null);

  function goBack() {
    history.back();
  }

  // The place graph's `name_elements.element_entry` node uuid - the reverse-link
  // node whose sources are Logainm placenames constituted by this headword. Passed
  // to MapView as an opaque UUID (no alias resolution; the node lives in the place
  // graph, not this stack's base graph).
  const ELEMENT_ENTRY_NODE_UUID = '49436367-b92b-5157-8cf5-a81086195ad6';

  /** Open the placenames map for the current entry; `selected` focuses one place. */
  function openPlacenamesMap(selected?: string) {
    if (!entry) return;
    const headDir = placeHeadDir();
    if (!headDir) return; // place layer not active - no map to show
    openMap({
      layer: { headDir, label: 'Logainm' },
      filter: { nodeUri: ELEMENT_ENTRY_NODE_UUID, targetUri: entry.uri, label: entry.headword },
      selected,
    });
  }
  /** True only when the place layer is installed (so the map has a head to query). */
  let hasPlaceLayer = $derived(!!placeHeadDir());

  function toggleGroup(key: string) {
    openGroup = openGroup === key ? null : key;
  }

  async function selectEntry(uri: string, headword: string) {
    loading.set(true);
    try {
      const detail = await loadEntryFlagged(uri, headword);
      currentEntry.set(detail);
    } finally {
      loading.set(false);
    }
  }

  function groupedCognates(cognates: EntryDetail['cognates']): Array<{ language: string; cognates: EntryDetail['cognates'] }> {
    const map = new Map<string, EntryDetail['cognates']>();
    for (const c of cognates) {
      if (!map.has(c.language)) map.set(c.language, []);
      map.get(c.language)!.push(c);
    }
    return [...map.entries()].map(([language, cognates]) => ({ language, cognates }));
  }

</script>

{#if entry}
  <div class="ge-page" style="padding-bottom:0;">
    <!-- Teal hero strip -->
    <div style="background:var(--teal-deep);color:var(--cream);padding:0 0 18px;position:relative;">
      <div class="ge-navbar" style="background:transparent;border-bottom:0;color:var(--cream);">
        <div class="ge-navbar-side">
          <button class="ge-back" style="color:var(--cream);" onclick={goBack}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
            {$t('nav.search')}
          </button>
        </div>
        <div class="ge-navbar-title" style="color:rgba(246,244,235,0.65);font-size:13px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;">{$t('entry.title')}</div>
        <div class="ge-navbar-side right">
          <LayerPill tone="var(--cream)" />
          <button class="ge-iconbtn" aria-label={starred ? $t('entry.unstar') : $t('entry.star')} style="color:var(--cream);" onclick={handleStar}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9z"/>
            </svg>
          </button>
          <FlagButton resourceUri={entry.uri} tone="var(--cream)" subjectName={entry.headword} subjectKind="entry" />
        </div>
      </div>

      <div style="padding:4px 18px 0;">
        <div class="ge-headword display" style="color:var(--cream);font-size:84px;">{entry.headword}</div>
        <div style="font-size:14px;color:rgba(246,244,235,0.72);margin-top:{hasDescenders ? '8px' : '-4px'};display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          {#if entry.pos}
            <span style="font-style:italic;">{entry.pos}</span>
          {/if}
          {#if classBadge}
            <span style="font-size:12px;font-weight:700;background:rgba(246,244,235,0.16);padding:2px 8px;border-radius:4px;font-variant:small-caps;letter-spacing:0.02em;">{classBadge}</span>
          {/if}
          {#if entryDialectCode}
            <span style="font-size:11px;letter-spacing:0.08em;font-weight:600;background:rgba(246,244,235,0.12);padding:2px 7px;border-radius:4px;">{entryDialectCode}</span>
          {/if}
        </div>

        {#if entry.ipa.length > 0}
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;">
            {#each entry.ipa as ipa}
              <span class="ge-pill" style="background:rgba(246,244,235,0.12);color:var(--cream);border:0;">{ipa}</span>
            {/each}
          </div>
        {/if}

        <div class="ge-hero-rule"></div>
      </div>
    </div>

    <!-- Senses -->
    {#if entry.senses.length > 0}
      <div class="ge-block-title">{$t('entry.senses')}</div>
      <div style="padding:0 16px;">
        <div class="ge-list">
          {#each entry.senses as sense, i}
            {@const dcode = sense.dialect ? dialectCode($familyConfig.id, sense.dialect) || sense.dialect : ''}
            {@const sw = sense.sourceLabel ? sourceLabelSwatch($familyConfig.id, sense.sourceLabel) : ''}
            <div class="ge-list-row" style="align-items:flex-start;">
              <span class="ge-sense-num">{i + 1}</span>
              <div class="row-main">
                <div class="ge-list-title">{sense.gloss}</div>
                {#if sense.examples.length > 0}
                  <div class="ge-list-subtitle" style="margin-top:4px;">
                    <span style="font-style:italic;">{sense.examples[0]}</span>
                  </div>
                {/if}
              </div>
              <!-- Two fixed-width slots so dialect and source line up as columns
                   down the sense list, even when a sense is missing one. -->
              <div class="ge-sense-tags">
                <span class="ge-sense-tag dialect" class:empty={!dcode} class:gd={dcode.split('.')[0] === 'GD'} title={sense.dialect ?? ''}>{dcode}</span>
                <span class="ge-sense-tag source" class:empty={!sense.sourceLabel} class:tinted={!!sw} style={sw ? `--sw:${sw}` : ''}>{sense.sourceLabel ?? ''}</span>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Leftover forms (Wiktionary lenited/eclipsed/etc. not placed in the grid) -->
    {#snippet otherForms(other: FlatGroup[])}
      {#if other.length > 0}
        <div class="ge-list" style="padding:0;margin-top:8px;">
          {#each other as group}
            <div class="ge-acc" class:open={openGroup === 'other-' + group.key}>
              <button class="ge-acc-head" onclick={() => toggleGroup('other-' + group.key)}>
                <span class="chev">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                </span>
                {$t('forms.' + group.key) === 'forms.' + group.key ? group.title : $t('forms.' + group.key)}
                <span class="count">{group.items.length}</span>
              </button>
              <div class="ge-acc-body">
                {#each group.items as form}
                  <div class="ge-form-line">
                    <span class="gf-word">{form.writtenRep}</span>
                    <span class="gf-tags">{form.tags.map(tagLabel).join(' · ')}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/snippet}

    <!-- Forms / paradigm -->
    {#if gramTabs.length > 0 && paradigm && (paradigm.kind !== 'flat' || paradigm.groups.length > 0)}
      <div class="ge-block-title">
        {$t('entry.forms')}
      </div>
      <div style="padding:0 16px;">
        {#if gramTabs.length > 1}
          <div class="gram-tabs" role="tablist">
            {#each gramTabs as tab, i}
              <button
                type="button"
                class="gram-tab"
                class:on={activeTabIndex === i}
                role="tab"
                aria-selected={activeTabIndex === i}
                onclick={() => (activeGramTab = i)}
              >{tab.label}</button>
            {/each}
          </div>
        {:else if activeGenerated}
          <div class="gram-src">Gramadán<span class="gram-gen"> · generated</span></div>
        {/if}

        {#if hasDependent}
          <!-- Independent/dependent toggle, mirroring the noun article toggle. "ní"
               is the dependent particle; on = dependent forms (dearna), off = the
               independent forms (rinne). Tense rows only; VN/VA/imperative invariant. -->
          <div class="dep-toggle-row">
            <button
              type="button"
              class="dep-toggle"
              class:on={showDependent}
              aria-pressed={showDependent}
              onclick={() => (showDependent = !showDependent)}
              title={showDependent ? 'Dependent forms (after ní, go, an)' : 'Independent forms'}
            >ní</button>
            <span class="dep-hint">{showDependent ? 'spleách' : 'neamhspleách'}</span>
          </div>
        {/if}

        {#if paradigm.kind === 'noun' || paradigm.kind === 'adjective'}
          <!-- number × case grid -->
          <table class="ge-para">
            <thead>
              <tr>
                <th class="ge-para-corner"></th>
                <th>{$t('forms.singular')}</th>
                {#if paradigm.hasPlural}<th>{$t('forms.plural')}</th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each paradigm.rows as row}
                <tr>
                  <th class="ge-para-axis">{$t('forms.' + row.case)}</th>
                  <td>
                    {#each row.sg as c}
                      <span class="ge-para-cell">{c.text}{#if c.extra.length}<small>{c.extra.map(tagLabel).join(' · ')}</small>{/if}</span>
                    {/each}
                  </td>
                  {#if paradigm.hasPlural}
                    <td>
                      {#each row.pl as c}
                        <span class="ge-para-cell">{c.text}{#if c.extra.length}<small>{c.extra.map(tagLabel).join(' · ')}</small>{/if}</span>
                      {/each}
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
          {#if paradigm.kind === 'adjective' && paradigm.comparison.length > 0}
            <div class="ge-para-sub">{$t('forms.comparison')}</div>
            <div class="ge-para-inline">
              {#each paradigm.comparison as c}<span class="ge-para-cell">{c.text}</span>{/each}
            </div>
          {/if}
          {@render otherForms(paradigm.other)}

        {:else if paradigm.kind === 'verb'}
          {#if paradigm.principalParts.length > 0}
            <div class="ge-para-pp">
              {#each paradigm.principalParts as pp}
                <span><em>{$t(pp.key === 'verbal-noun' ? 'forms.verbalNoun' : 'forms.verbalAdjective')}</em> {pp.text}</span>
              {/each}
            </div>
          {/if}
          <div class="ge-list" style="padding:0;">
            {#each paradigm.tenses as tsec}
              <div class="ge-acc" class:open={openGroup === tsec.tense}>
                <button class="ge-acc-head" onclick={() => toggleGroup(tsec.tense)}>
                  <span class="chev">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                  </span>
                  {$t('forms.' + tsec.tense)}
                  <span class="count">{tsec.rows.length}</span>
                </button>
                <div class="ge-acc-body">
                  {#each tsec.rows as r}
                    {@const dc = depCell(tsec.tense, r.forms)}
                    <div class="ge-form-line">
                      <span class="ge-para-person">{personLabel(r.person)}</span>
                      <span class="gf-word">{#if dc.particle}<span class="dep-particle">{dc.particle}</span> {/if}{dc.text}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
          {@render otherForms(paradigm.other)}

        {:else}
          <!-- flat fallback (non-noun/verb/adj, or untagged forms) -->
          <div class="ge-list" style="padding:0;">
            {#each paradigm.groups as group}
              <div class="ge-acc" class:open={openGroup === group.key}>
                <button class="ge-acc-head" onclick={() => toggleGroup(group.key)}>
                  <span class="chev">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                  </span>
                  {$t('forms.' + group.key) === 'forms.' + group.key ? group.title : $t('forms.' + group.key)}
                  <span class="count">{group.items.length}</span>
                </button>
                <div class="ge-acc-body">
                  {#each group.items as form}
                    <div class="ge-form-line">
                      <span class="gf-word">{form.writtenRep}</span>
                      <span class="gf-tags">{form.tags.map(tagLabel).join(' · ')}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}

      </div>
    {/if}

    <!-- Etymology -->
    {#if entry.etymologies.length > 0}
      <div class="ge-block-title">{$t('entry.etymology')}</div>
      <div style="padding:0 16px;">
        <div class="ge-list">
          {#each entry.etymologies as etym}
            <div class="ge-list-row" style="align-items:flex-start;">
              <div class="row-main">
                <div class="ge-etym-prose">{etym.text}</div>
              </div>
              {#if etym.sourceLabel}
                {@const sw = sourceLabelSwatch($familyConfig.id, etym.sourceLabel)}
                <!-- Same chip as the sense source column: fixed width, swatch-tinted. -->
                <div class="ge-sense-tags">
                  <span class="ge-sense-tag source" class:tinted={!!sw} style={sw ? `--sw:${sw}` : ''}>{etym.sourceLabel}</span>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Cognates -->
    {#if entry.cognates.length > 0}
      <div class="ge-block-title">{$t('entry.cognates')}</div>
      <div style="padding:0 16px;">
        <div class="ge-list">
          {#each groupedCognates(entry.cognates) as group}
            <div class="ge-list-row" style="align-items:baseline;">
              <span class="ge-cognate-lang">{group.language}</span>
              <span class="ge-cognate-words">
                {#each group.cognates as cognate, i}
                  {#if i > 0}<span style="font-style:normal;color:var(--fg-soft);"> · </span>{/if}
                  {#if cognate.entryId}
                    <button class="ge-cognate-link" onclick={() => selectEntry(cognate.entryId!, cognate.headword)}>{cognate.headword}</button>
                  {:else}
                    {cognate.headword}
                  {/if}
                {/each}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Placenames (reverse element_entry lookup into the Logainm place layer) -->
    {#if entry.placenames && entry.placenames.count > 0}
      <div class="ge-block-title ge-placenames-head">
        <span>{$t('entry.placenames')}</span>
        {#if hasPlaceLayer}
          <button class="ge-placenames-map" onclick={() => openPlacenamesMap()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg>
            {$t('map.viewOnMap')}
          </button>
        {/if}
      </div>
      <div style="padding:0 16px;">
        <div class="ge-list">
          <div class="ge-placenames-count">{$t('entry.placenamesCount', { count: entry.placenames.count.toLocaleString() })}</div>
          <div class="ge-placenames-chips">
            {#each entry.placenames.sample as pl}
              {#if hasPlaceLayer}
                <button class="ge-placename ge-placename-btn" onclick={() => openPlacenamesMap(pl.resourceId)}>{pl.name}</button>
              {:else}
                <span class="ge-placename">{pl.name}</span>
              {/if}
            {/each}
            {#if entry.placenames.count > entry.placenames.sample.length}
              <span class="ge-placename-more">+{(entry.placenames.count - entry.placenames.sample.length).toLocaleString()}…</span>
            {/if}
          </div>
          <div class="ge-placenames-src">{$t('entry.placenamesSource')}</div>
        </div>
      </div>
    {/if}

    <!-- External examples -->
    {#if entry.externalExamples.length > 0}
      <div class="ge-block-title">{$t('entry.examples')}</div>
      <div style="padding:0 16px;">
        <ExampleList examples={entry.externalExamples} />
      </div>
    {/if}


    <div style="padding-bottom:32px;"></div>
  </div>
{/if}

<style>
  /* Paradigm grid (nouns / adjectives) */
  .ge-para { width: 100%; border-collapse: collapse; margin: 4px 0 2px; }
  .ge-para th, .ge-para td { text-align: left; padding: 7px 10px; vertical-align: top; }
  .ge-para thead th {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--fg-soft); font-weight: 600; border-bottom: 1px solid color-mix(in srgb, var(--fg-soft) 30%, transparent);
  }
  .ge-para tbody tr + tr { border-top: 1px solid color-mix(in srgb, var(--fg-soft) 18%, transparent); }
  .ge-para-axis {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--fg-soft); font-weight: 600; white-space: nowrap;
  }
  .ge-para-cell { display: inline-flex; align-items: baseline; gap: 5px; margin-right: 12px; color: var(--fg-default); }
  .ge-para-cell:last-child { margin-right: 0; }
  .ge-para-corner { padding: 4px 6px !important; }
  .ge-para-cell small { color: var(--fg-soft); font-size: 11px; }
  /* Grammar source tabs (BuNaMo attested / Gramadán generated). */
  .gram-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
  .gram-tab {
    font-size: 12px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--fg-soft) 30%, transparent);
    background: transparent; color: var(--fg-soft); transition: all 0.12s;
  }
  .gram-tab.on {
    color: var(--fg-default);
    background: color-mix(in srgb, var(--accent, #4a7a63) 16%, transparent);
    border-color: color-mix(in srgb, var(--accent, #4a7a63) 40%, transparent);
  }
  .gram-src { font-size: 11px; color: var(--fg-soft); margin-bottom: 8px; }
  .gram-gen { font-style: italic; opacity: 0.85; }
  .dep-toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .dep-toggle {
    font: italic 12px/1 inherit; padding: 3px 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--fg-soft) 35%, transparent);
    background: transparent; color: var(--fg-soft); transition: all 0.12s;
  }
  .dep-toggle.on {
    color: var(--fg-default); background: color-mix(in srgb, var(--accent, #4a7a63) 16%, transparent);
    border-color: color-mix(in srgb, var(--accent, #4a7a63) 45%, transparent);
  }
  .dep-hint { font-size: 11px; color: var(--fg-soft); font-style: italic; }
  .dep-particle { color: var(--fg-soft); opacity: 0.65; margin-right: 0.3em; }

  /* Adjective comparison + section subheads */
  .ge-para-sub {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--fg-soft); font-weight: 600; margin: 12px 0 2px;
  }
  .ge-para-inline { display: flex; flex-wrap: wrap; gap: 12px; padding: 2px 0 4px; }

  /* Verb principal parts */
  .ge-para-pp {
    display: flex; flex-wrap: wrap; gap: 16px;
    padding: 8px 0 10px; color: var(--fg-default);
  }
  .ge-para-pp em { color: var(--fg-soft); font-style: italic; font-size: 12px; margin-right: 4px; }

  /* Verb conjugation person label */
  .ge-para-person { min-width: 54px; color: var(--fg-soft); font-style: italic; }

  /* Placenames (reverse element_entry lookup) */
  .ge-placenames-count { font-size: 13px; color: var(--fg-muted); padding: 8px 0 2px; }
  .ge-placenames-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 4px; }
  .ge-placename {
    font-size: 14px; padding: 3px 10px; border-radius: 13px;
    background: color-mix(in srgb, var(--fg-soft) 14%, transparent); color: var(--fg-default);
  }
  .ge-placename-more { font-size: 13px; color: var(--fg-soft); align-self: center; }
  .ge-placenames-src { font-size: 11px; color: var(--fg-soft); padding: 6px 0 2px; font-style: italic; }

  /* Placenames block header with the "Map" affordance */
  .ge-placenames-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .ge-placenames-map {
    display: inline-flex; align-items: center; gap: 5px;
    border: 0; cursor: pointer; text-transform: none; letter-spacing: 0;
    padding: 4px 10px; border-radius: var(--pill-radius, 500px);
    background: var(--teal-deep); color: var(--cream);
    font-size: 12px; font-weight: 600;
  }
  /* Tappable placename chip (opens the map focused on that place) */
  .ge-placename-btn { border: 0; cursor: pointer; font-family: inherit; }
  .ge-placename-btn:hover { background: color-mix(in srgb, var(--fg-soft) 24%, transparent); }
</style>
