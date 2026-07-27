<script lang="ts">
  import { App } from 'konsta/svelte';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { currentEntry, currentExample, currentLayer, wasmReady, activeTab, darkMode, density, listStyle, bootstrapLayers, pushRecent, overlayView, preparingDictionary, mapState } from './lib/store';
  import { t } from './lib/i18n';
  import Search from './views/Search.svelte';
  import EntryDetail from './views/EntryDetail.svelte';
  import ExampleDetailView from './views/ExampleDetail.svelte';
  import LayerDetail from './views/LayerDetail.svelte';
  import MapView from './views/MapView.svelte';
  import Settings from './views/Settings.svelte';
  import Starred from './views/Starred.svelte';
  import TabBar from './views/TabBar.svelte';
  import LicenseToast from './views/LicenseToast.svelte';
  import LayerSheet from './views/LayerSheet.svelte';
  import Faq from './views/Faq.svelte';
  import FlagsPage from './views/FlagsPage.svelte';

  let navigatingBack = false;
  let showLicenseInSettings = $state(false);

  function openLicenseSettings() {
    activeTab.set('settings');
    showLicenseInSettings = true;
  }

  onMount(() => {
    // Only apply system preference if no explicit user choice is persisted
    if (typeof localStorage === 'undefined' || localStorage.getItem('ge:darkMode') === null) {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      darkMode.set(mq.matches ? 'dark' : 'light');
    }

    bootstrapLayers();

    // Push history state when navigating forward into entry/example views
    const unsubEntry = currentEntry.subscribe((val) => {
      if (val && !navigatingBack) {
        history.pushState({ view: 'entry' }, '');
        pushRecent({
          uri: val.uri,
          headword: val.headword,
          pos: val.pos || '',
          gloss: val.senses?.[0]?.gloss,
        });
      }
    });

    const unsubExample = currentExample.subscribe((val) => {
      if (val && !navigatingBack) {
        history.pushState({ view: 'example' }, '');
      }
    });

    const unsubMap = mapState.subscribe((val) => {
      if (val && !navigatingBack) {
        history.pushState({ view: 'map' }, '');
      }
    });

    // Pop history → navigate back through views. Map sits on top of the entry,
    // so it unwinds first.
    function onPopState() {
      navigatingBack = true;
      if (get(mapState)) {
        mapState.set(null);
      } else if (get(currentLayer)) {
        currentLayer.set(null);
      } else if (get(currentExample)) {
        currentExample.set(null);
      } else if (get(currentEntry)) {
        currentEntry.set(null);
      }
      navigatingBack = false;
    }

    window.addEventListener('popstate', onPopState);

    return () => {
      unsubEntry();
      unsubExample();
      unsubMap();
      window.removeEventListener('popstate', onPopState);
    };
  });
</script>

<App theme="ios" darkMode={$darkMode === 'dark'}>
  <div class="ge-app" data-mode={$darkMode} data-density={$density} data-list={$listStyle}>
    {#if $mapState}
      <MapView layer={$mapState.layer} filter={$mapState.filter} selected={$mapState.selected} />
    {:else if $overlayView === 'faq'}
      <Faq />
    {:else if $overlayView === 'flags'}
      <FlagsPage />
    {:else if $currentLayer}
      <LayerDetail layer={$currentLayer} />
    {:else if $currentExample}
      <ExampleDetailView />
    {:else if $currentEntry}
      <EntryDetail />
    {:else if $activeTab === 'search'}
      <div class="ge-page">
        <Search />
      </div>
    {:else if $activeTab === 'starred'}
      <Starred />
    {:else if $activeTab === 'settings'}
      <Settings showLicenseSection={showLicenseInSettings} />
    {/if}

    {#if !$currentEntry && !$currentExample && !$currentLayer && !$overlayView && !$mapState}
      <TabBar />
    {/if}

    {#if !$wasmReady}
      <div style="position:fixed;bottom:60px;left:16px;right:16px;text-align:center;font-size:var(--fs-small);color:var(--fg-soft);">
        {$t('app.loading')}
      </div>
    {/if}

    {#if $preparingDictionary}
      <div style="position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--bg,#fff);color:var(--fg,#111);text-align:center;padding:24px;">
        <div class="ge-spinner" style="width:32px;height:32px;border:3px solid var(--fg-soft,#ccc);border-top-color:var(--accent,#3b6);border-radius:50%;animation:ge-spin 0.9s linear infinite;"></div>
        <div style="font-size:var(--fs-body,15px);font-weight:600;">{$t('app.preparing')}</div>
        <div style="font-size:var(--fs-small,13px);color:var(--fg-soft,#888);max-width:280px;">{$t('app.preparingHint')}</div>
      </div>
    {/if}

    <LayerSheet />

    <LicenseToast onShowFull={openLicenseSettings} />
  </div>
</App>

<style>
  @keyframes -global-ge-spin {
    to { transform: rotate(360deg); }
  }
</style>
