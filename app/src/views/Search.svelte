<script lang="ts">
  import { get } from 'svelte/store';
  import { searchQuery, searchResults, currentEntry, currentExample, loading, activeTab, searchLang, visibleDialects, familyConfig, recentEntries, overlayView, layers } from '../lib/store';
  import { search, loadEntryFlagged, loadExample } from '../lib/dictionary';
  import type { SearchLang } from '../lib/dictionary';
  import { t } from '../lib/i18n';
  import LayerPill from './LayerPill.svelte';

  /** Dialect code tag for display (codes come directly from Pagefind meta). */
  function dialectTag(dialect?: string): string {
    return dialect ? dialect.replace('.', '·') : '';
  }

  let searchInput: HTMLInputElement;
  let debounceTimer: ReturnType<typeof setTimeout>;

  async function doSearch(value: string, lang: SearchLang) {
    if (!value.trim()) {
      searchResults.set([]);
      return;
    }
    loading.set(true);
    try {
      const results = await search(value, lang, $visibleDialects);
      searchResults.set(results);
    } finally {
      loading.set(false);
    }
  }

  function onInput(e: Event) {
    const value = (e.target as HTMLInputElement)?.value ?? '';
    searchQuery.set(value);

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doSearch(value, $searchLang), 200);
  }

  function setLang(lang: string) {
    searchLang.set(lang as SearchLang);
    if ($searchQuery.trim()) doSearch($searchQuery, lang as SearchLang);
  }

  function clearSearch() {
    searchQuery.set('');
    searchResults.set([]);
  }

  // Re-search when dialect filters change (uses get() to avoid extra reactive deps)
  $: $visibleDialects, refreshForDialects();
  function refreshForDialects() {
    const q = get(searchQuery);
    const lang = get(searchLang);
    if (q.trim()) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => doSearch(q, lang), 200);
    }
  }

  async function selectEntry(uri: string, headword: string) {
    loading.set(true);
    try {
      const entry = await loadEntryFlagged(uri, headword);
      currentEntry.set(entry);
    } finally {
      loading.set(false);
    }
  }

  // A tapped result: Samplaí (example-granular) opens the EXAMPLE page; the
  // headword tabs open the entry.
  async function selectResult(result: { uri: string; headword: string }) {
    if ($searchLang === 'sampla') {
      loading.set(true);
      try {
        const ex = await loadExample(result.uri);
        if (ex) currentExample.set(ex);
      } finally {
        loading.set(false);
      }
    } else {
      await selectEntry(result.uri, result.headword);
    }
  }
</script>

<div class="ge-navbar">
  <div class="ge-navbar-side">
    <LayerPill />
  </div>
  <div class="ge-navbar-title">{$t('search.title')}</div>
  <div class="ge-navbar-side right">
    <button class="ge-iconbtn" aria-label="Bratacha · Flags" onclick={() => overlayView.set('flags')}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 21V7M4 7h8l-1.4 2.5L12 12H4"/>
        <path d="M8 16V3M8 3h8l-1.4 2.5L16 8H8"/>
      </svg>
    </button>
    <button class="ge-iconbtn" aria-label={$t('search.info')} onclick={() => overlayView.set('faq')}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
      </svg>
    </button>
    <button class="ge-iconbtn" aria-label={$t('search.settings')} onclick={() => activeTab.set('settings')}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06A2 2 0 117.04 4.3l.06.06A1.65 1.65 0 008.92 4.7 1.65 1.65 0 009.92 3.19V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.3 9c.07.32.18.62.33.92h.09a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>
      </svg>
    </button>
  </div>
</div>

<div style="padding: 12px 16px 8px;">
  <div class="ge-search">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
    </svg>
    <input
      bind:this={searchInput}
      value={$searchQuery}
      placeholder={$t('search.placeholder')}
      oninput={onInput}
    />
    {#if $searchQuery}
      <button aria-label={$t('search.clear')} onclick={clearSearch} style="background:none;border:0;color:var(--fg-soft);cursor:pointer;padding:0;display:flex;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    {/if}
  </div>
  <div class="ge-segs" style="margin-top:8px;">
    {#each $familyConfig.searchLangs as lang}
      <button class="ge-seg" class:active={$searchLang === lang.id} onclick={() => setLang(lang.id)}>{lang.label}</button>
    {/each}
  </div>
</div>

{#if $searchResults.length > 0}
  <div class="ge-block-title" style="padding-top:12px;">{$t('search.results', { count: $searchResults.length })}</div>
  <div style="padding:0 16px;">
    <div class="ge-list">
      {#each $searchResults as result}
        <button
          class="ge-list-row"
          onclick={() => selectResult(result)}
          style="width:100%;background:transparent;border:0;text-align:left;cursor:pointer;"
        >
          <div class="row-main">
            {#if $searchLang === 'en'}
              <div class="ge-list-title">
                <span style="font-weight:600;">
                  {result.gloss || result.headword}
                </span>
              </div>
              <div class="ge-list-subtitle">
                {result.headword}
                {#if dialectTag(result.dialect)}
                  <span class="ge-dialect-tag">{dialectTag(result.dialect)}</span>
                {/if}
              </div>
            {:else if $searchLang === 'sampla'}
              <div class="ge-list-title" style="font-weight:600;line-height:1.4;">
                {result.headword}
              </div>
              <div class="ge-list-subtitle" style="line-height:1.4;">
                {#if result.gloss}{result.gloss}{/if}
                {#if dialectTag(result.dialect)}
                  <span class="ge-dialect-tag">{dialectTag(result.dialect)}</span>
                {/if}
              </div>
            {:else if result.excerpt}
              <div class="ge-list-title" style="font-weight:400;line-height:1.45;">
                {@html result.excerpt}
              </div>
              <div class="ge-list-subtitle">
                <span style="font-weight:600;">{result.headword}</span>
                {#if dialectTag(result.dialect)}
                  <span class="ge-dialect-tag">{dialectTag(result.dialect)}</span>
                {/if}
                {#if result.gloss}
                  <span style="margin-left:4px;">{result.gloss.length > 40 ? result.gloss.slice(0, 40) + '…' : result.gloss}</span>
                {/if}
              </div>
            {:else}
              <div class="ge-list-title">
                <span style="font-weight:600;">
                  {#if $searchQuery && result.headword.toLowerCase().startsWith($searchQuery.toLowerCase())}
                    <span style="color:var(--accent-deep);">{result.headword.slice(0, $searchQuery.length)}</span>{result.headword.slice($searchQuery.length)}
                  {:else}
                    {result.headword}
                  {/if}
                </span>
                {#if result.pos}
                  <span style="color:var(--fg-muted);font-size:13px;margin-left:8px;font-style:italic;font-weight:400;">{result.pos}</span>
                {/if}
                {#if dialectTag(result.dialect)}
                  <span class="ge-dialect-tag">{dialectTag(result.dialect)}</span>
                {/if}
              </div>
              {#if result.gloss}
                <div class="ge-list-subtitle">{result.gloss.length > 60 ? result.gloss.slice(0, 60) + '…' : result.gloss}</div>
              {/if}
            {/if}
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--fg-soft);flex-shrink:0;">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>
      {/each}
    </div>
  </div>
{:else if $searchQuery && !$loading}
  <div class="ge-block" style="text-align:center;color:var(--fg-muted);padding-top:48px;">
    <p>{$t('search.noResults')}</p>
  </div>
{:else if !$searchQuery}
  {#if $layers.length === 0}
    <div style="padding:48px 16px;text-align:center;color:var(--fg-soft);">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4;margin-bottom:8px;">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
      </svg>
      <div style="font-size:var(--fs-body);margin-bottom:4px;">{$t('search.noLayers')}</div>
      <button
        style="font-size:var(--fs-small);color:var(--link);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;"
        onclick={() => activeTab.set('settings')}
      >{$t('search.goToSettings')}</button>
    </div>
  {:else if $recentEntries.length > 0}
    <div class="ge-block-title" style="padding-top:24px;">{$t('search.recentlyViewed')}</div>
    <div style="padding:0 16px;">
      <div class="ge-list">
        {#each $recentEntries as entry}
          <button
            class="ge-list-row"
            onclick={() => selectEntry(entry.uri, entry.headword)}
            style="width:100%;background:transparent;border:0;text-align:left;cursor:pointer;"
          >
            <div class="row-main">
              <div class="ge-list-title">
                <span style="font-weight:600;">{entry.headword}</span>
                {#if entry.pos}
                  <span style="color:var(--fg-muted);font-size:13px;margin-left:8px;font-style:italic;font-weight:400;">{entry.pos}</span>
                {/if}
              </div>
              {#if entry.gloss}
                <div class="ge-list-subtitle">{entry.gloss.length > 60 ? entry.gloss.slice(0, 60) + '…' : entry.gloss}</div>
              {/if}
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--fg-soft);flex-shrink:0;">
              <path d="M9 18l6-6-6-6"/>
            </svg>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <div style="padding:48px 16px;text-align:center;color:var(--fg-soft);">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5;margin-bottom:8px;">
        <path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>
      </svg>
      <div style="font-size:var(--fs-small);">{$t('search.typeToSearch')}</div>
    </div>
  {/if}
{/if}
