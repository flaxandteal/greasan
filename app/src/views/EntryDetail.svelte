<script lang="ts">
  import { Navbar, NavbarBackLink, Block, BlockTitle, List, ListItem } from 'konsta/svelte';
  import { currentEntry } from '../lib/store';
  import type { EntryDetail } from '../lib/dictionary';
  import ExampleList from './ExampleList.svelte';

  $: entry = $currentEntry as EntryDetail | null;

  function goBack() {
    currentEntry.set(null);
  }
</script>

<Navbar title={entry?.headword ?? ''}>
  {#snippet left()}
    <NavbarBackLink onClick={goBack} text="Back" />
  {/snippet}
</Navbar>

{#if entry}
  <Block strong inset class="!mb-2">
    <div class="flex items-baseline gap-3">
      <h1 class="text-2xl font-bold">{entry.headword}</h1>
      <span class="text-sm text-gray-500 italic">{entry.pos}</span>
    </div>
    {#if entry.ipa.length > 0}
      <p class="text-sm text-gray-600 mt-1 font-mono">
        {entry.ipa.join(' · ')}
      </p>
    {/if}
  </Block>

  {#if entry.senses.length > 0}
    <BlockTitle>Senses</BlockTitle>
    <List strong inset>
      {#each entry.senses as sense, i}
        <ListItem
          title={`${i + 1}. ${sense.gloss}`}
          subtitle={sense.examples.length > 0 ? sense.examples[0] : undefined}
        />
      {/each}
    </List>
  {/if}

  {#if entry.forms.length > 0}
    <BlockTitle>Forms</BlockTitle>
    <List strong inset>
      {#each entry.forms as form}
        <ListItem
          title={form.writtenRep}
          after={form.tags.join(', ')}
        />
      {/each}
    </List>
  {/if}

  {#if entry.externalExamples.length > 0}
    <BlockTitle>Samplaí / Examples</BlockTitle>
    <Block strong inset>
      <ExampleList examples={entry.externalExamples} />
    </Block>
  {/if}
{/if}
