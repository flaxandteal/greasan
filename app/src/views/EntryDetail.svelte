<script lang="ts">
  import { currentEntry, loading, familyConfig, starredEntries, toggleStar } from '../lib/store';
  import { loadEntryFlagged, type EntryDetail } from '../lib/dictionary';
  import { dialectCode } from '../lib/family';
  import { t } from '../lib/i18n';
  import ExampleList from './ExampleList.svelte';

  let entry = $derived($currentEntry as EntryDetail | null);
  /** True when the headword contains letters whose glyphs descend below the baseline. */
  let hasDescenders = $derived(entry ? /[gjpqyçþðĝĵ]/i.test(entry.headword) : false);
  let starred = $derived(entry ? $starredEntries.some(e => e.uri === entry!.uri) : false);

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

  function toggleGroup(key: string) {
    openGroup = openGroup === key ? null : key;
  }

  interface FormGroup {
    key: string;
    title: string;
    match: (tags: string[]) => boolean;
  }

  const formGroups: FormGroup[] = [
    { key: 'nominative', title: 'Nominative', match: (tags) => tags.some(tg => tg.toLowerCase().includes('nominative')) },
    { key: 'genitive', title: 'Genitive', match: (tags) => tags.some(tg => tg.toLowerCase().includes('genitive')) },
    { key: 'dative', title: 'Dative', match: (tags) => tags.some(tg => tg.toLowerCase().includes('dative')) },
    { key: 'vocative', title: 'Vocative', match: (tags) => tags.some(tg => tg.toLowerCase().includes('vocative')) },
    { key: 'lenited', title: 'Lenited', match: (tags) => tags.some(tg => tg.toLowerCase().includes('lenited') || tg.toLowerCase().includes('lenition')) },
    { key: 'eclipsed', title: 'Eclipsed', match: (tags) => tags.some(tg => tg.toLowerCase().includes('eclipsed') || tg.toLowerCase().includes('eclipsis')) },
  ];

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

  function groupedForms(forms: EntryDetail['forms']) {
    const used = new Set<number>();
    const groups: Array<{ key: string; title: string; items: EntryDetail['forms'] }> = [];

    for (const g of formGroups) {
      const items = forms.filter((f, i) => !used.has(i) && g.match(f.tags));
      if (items.length) {
        items.forEach(item => {
          const idx = forms.indexOf(item);
          if (idx >= 0) used.add(idx);
        });
        groups.push({ key: g.key, title: g.title, items });
      }
    }

    const other = forms.filter((_, i) => !used.has(i));
    if (other.length) {
      groups.push({ key: 'other', title: 'Other', items: other });
    }

    return groups;
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
          <button class="ge-iconbtn" aria-label={starred ? $t('entry.unstar') : $t('entry.star')} style="color:var(--cream);" onclick={handleStar}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9z"/>
            </svg>
          </button>
        </div>
      </div>

      <div style="padding:4px 18px 0;">
        <div class="ge-headword display" style="color:var(--cream);font-size:84px;">{entry.headword}</div>
        <div style="font-size:14px;color:rgba(246,244,235,0.72);margin-top:{hasDescenders ? '8px' : '-4px'};display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          {#if entry.pos}
            <span style="font-style:italic;">{entry.pos}</span>
          {/if}
          {#if entry.dialect && dialectCode($familyConfig.id, entry.dialect)}
            <span style="font-size:11px;letter-spacing:0.08em;font-weight:600;background:rgba(246,244,235,0.12);padding:2px 7px;border-radius:4px;">{dialectCode($familyConfig.id, entry.dialect)}</span>
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
              {#if sense.dialect}
                <span class="ge-layer-tag" style="background:transparent;border:1px solid currentColor;opacity:0.75;" title="Dialect">{sense.dialect}</span>
              {/if}
              {#if sense.sourceLabel}
                <span class="ge-layer-tag">{sense.sourceLabel}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Forms accordion -->
    {#if entry.forms.length > 0}
      <div class="ge-block-title">{$t('entry.forms')}</div>
      <div style="padding:0 16px;">
        <div class="ge-list" style="padding:0;">
          {#each groupedForms(entry.forms) as group}
            <div class="ge-acc" class:open={openGroup === group.key}>
              <button class="ge-acc-head" onclick={() => toggleGroup(group.key)}>
                <span class="chev">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                </span>
                {group.title}
                <span class="count">{group.items.length}</span>
              </button>
              <div class="ge-acc-body">
                {#each group.items as form}
                  <div class="ge-form-line">
                    <span class="gf-word">{form.writtenRep}</span>
                    <span class="gf-tags">{form.tags.filter(t => t.toLowerCase() !== group.title.toLowerCase()).join(' · ')}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
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
                <span class="ge-layer-tag">{etym.sourceLabel}</span>
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
