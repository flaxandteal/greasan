<script lang="ts">
  import { App, Page } from 'konsta/svelte';
  import { currentEntry, wasmReady } from './lib/store';
  import Search from './views/Search.svelte';
  import EntryDetail from './views/EntryDetail.svelte';
</script>

<App theme="ios">
  <Page>
    {#if $currentEntry}
      <EntryDetail />
    {:else}
      <Search />
    {/if}

    {#if !$wasmReady}
      <div class="fixed bottom-4 left-4 right-4 text-center text-sm text-gray-500">
        Loading WASM modules...
      </div>
    {/if}
  </Page>
</App>
