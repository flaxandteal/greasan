<script lang="ts">
  import { Navbar, Searchbar, List, ListItem, Block } from 'konsta/svelte';
  import { searchQuery, searchResults, currentEntry, loading } from '../lib/store';
  import { search, loadEntry } from '../lib/dictionary';

  let debounceTimer: ReturnType<typeof setTimeout>;

  function onInput(e: CustomEvent | Event) {
    const value = (e.target as HTMLInputElement)?.value ?? '';
    searchQuery.set(value);

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (!value.trim()) {
        searchResults.set([]);
        return;
      }
      loading.set(true);
      try {
        const results = await search(value);
        searchResults.set(results);
      } finally {
        loading.set(false);
      }
    }, 200);
  }

  async function selectEntry(uri: string) {
    loading.set(true);
    try {
      const entry = await loadEntry(uri);
      currentEntry.set(entry);
    } finally {
      loading.set(false);
    }
  }
</script>

<Navbar title="Foclóir" />

<Block class="!mt-0 !pt-2">
  <Searchbar
    value={$searchQuery}
    placeholder="Cuardaigh focal..."
    onInput={onInput}
    onClear={() => { searchQuery.set(''); searchResults.set([]); }}
  />
</Block>

{#if $searchResults.length > 0}
  <List strong inset>
    {#each $searchResults as result}
      <ListItem
        title={result.headword}
        after={result.pos}
        onClick={() => selectEntry(result.uri)}
      />
    {/each}
  </List>
{:else if $searchQuery && !$loading}
  <Block class="text-center text-gray-500">
    <p>Níl toradh ar bith — no results found</p>
  </Block>
{:else if !$searchQuery}
  <Block class="text-center text-gray-400 mt-12">
    <p class="text-lg font-medium mb-2">Foclóir Gaeilge</p>
    <p class="text-sm">Type to search Irish words</p>
  </Block>
{/if}
