<script lang="ts">
  import { App } from 'konsta/svelte';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { currentEntry, currentExample, wasmReady, activeTab, darkMode, density, listStyle, restoreLayers, pushRecent, overlayView } from './lib/store';
  import { t } from './lib/i18n';
  import Search from './views/Search.svelte';
  import EntryDetail from './views/EntryDetail.svelte';
  import ExampleDetailView from './views/ExampleDetail.svelte';
  import Settings from './views/Settings.svelte';
  import Starred from './views/Starred.svelte';
  import TabBar from './views/TabBar.svelte';
  import LicenseToast from './views/LicenseToast.svelte';
  import Faq from './views/Faq.svelte';

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

    restoreLayers();

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

    // Pop history → navigate back through views
    function onPopState() {
      navigatingBack = true;
      if (get(currentExample)) {
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
      window.removeEventListener('popstate', onPopState);
    };
  });
</script>

<App theme="ios" darkMode={$darkMode === 'dark'}>
  <div class="ge-app" data-mode={$darkMode} data-density={$density} data-list={$listStyle}>
    {#if $overlayView === 'faq'}
      <Faq />
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

    {#if !$currentEntry && !$currentExample && !$overlayView}
      <TabBar />
    {/if}

    {#if !$wasmReady}
      <div style="position:fixed;bottom:60px;left:16px;right:16px;text-align:center;font-size:var(--fs-small);color:var(--fg-soft);">
        {$t('app.loading')}
      </div>
    {/if}

    <LicenseToast onShowFull={openLicenseSettings} />
  </div>
</App>
