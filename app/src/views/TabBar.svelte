<script lang="ts">
  import { activeTab, overlayView } from '../lib/store';
  import { t } from '../lib/i18n';

  const tabs = [
    { id: 'search' as const, key: 'nav.search' },
    { id: 'starred' as const, key: 'nav.starred' },
    // Layers is an overlay (the Layer Manager), not a main tab — but it lives in
    // the tab row, left of Settings, as a library.
    { id: 'layers' as const, key: 'nav.layers' },
    { id: 'settings' as const, key: 'nav.settings' },
  ];

  function selectTab(id: (typeof tabs)[number]['id']) {
    if (id === 'layers') {
      overlayView.set('layers');
    } else {
      activeTab.set(id);
      overlayView.set(null);
    }
  }
</script>

<nav class="ge-tabbar" style="grid-template-columns:repeat(4,1fr);">
  {#each tabs as tab}
    <button
      class="ge-tab"
      class:active={tab.id === 'layers'
        ? $overlayView === 'layers'
        : $activeTab === tab.id && $overlayView !== 'layers'}
      onclick={() => selectTab(tab.id)}
    >
      {#if tab.id === 'search'}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
        </svg>
      {:else if tab.id === 'starred'}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9z"/>
        </svg>
      {:else if tab.id === 'layers'}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>
        </svg>
      {:else}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06A2 2 0 117.04 4.3l.06.06A1.65 1.65 0 008.92 4.7 1.65 1.65 0 009.92 3.19V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.3 9c.07.32.18.62.33.92h.09a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      {/if}
      {$t(tab.key)}
    </button>
  {/each}
</nav>
