<script lang="ts">
  import { starredEntries, currentEntry, loading } from '../lib/store';
  import { loadEntry } from '../lib/dictionary';
  import { t } from '../lib/i18n';

  type SortMode = 'recent' | 'alpha';
  let sortMode: SortMode = $state('recent');

  let sorted = $derived(
    sortMode === 'alpha'
      ? [...$starredEntries].sort((a, b) => a.headword.localeCompare(b.headword, 'ga'))
      : $starredEntries
  );

  async function selectEntry(uri: string, headword: string) {
    loading.set(true);
    try {
      const entry = await loadEntry(uri, headword);
      currentEntry.set(entry);
    } finally {
      loading.set(false);
    }
  }
</script>

<div class="ge-page">
  <div class="ge-navbar">
    <div class="ge-navbar-side"></div>
    <div class="ge-navbar-title">{$t('starred.title')}</div>
    <div class="ge-navbar-side right"></div>
  </div>

  {#if $starredEntries.length > 0}
    <div style="padding:8px 16px 0;display:flex;justify-content:flex-end;">
      <div class="ge-segs" style="width:auto;">
        <button class="ge-seg" class:active={sortMode === 'recent'} onclick={() => sortMode = 'recent'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;">
            <path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>
          </svg>
          {$t('starred.recent')}
        </button>
        <button class="ge-seg" class:active={sortMode === 'alpha'} onclick={() => sortMode = 'alpha'}>
          A–Z
        </button>
      </div>
    </div>

    <div style="padding:8px 16px;overflow-y:auto;flex:1;">
      <div class="ge-list">
        {#each sorted as entry}
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
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4;margin-bottom:8px;">
        <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9z"/>
      </svg>
      <div style="font-size:var(--fs-small);">{$t('starred.empty')}</div>
      <div style="font-size:var(--fs-micro);color:var(--fg-muted);margin-top:4px;">{$t('starred.emptyHint')}</div>
    </div>
  {/if}
</div>
