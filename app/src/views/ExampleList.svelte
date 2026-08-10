<script lang="ts">
  import type { ExternalExample } from '../lib/dictionary';
  import { loadExample } from '../lib/dictionary';
  import { currentExample } from '../lib/store';

  interface Props {
    examples: ExternalExample[];
  }

  let { examples }: Props = $props();
  let loadingId: string | null = $state(null);

  async function handleTap(ex: ExternalExample) {
    if (!ex.resourceId || loadingId) return;
    loadingId = ex.resourceId;
    try {
      const detail = await loadExample(ex.resourceId);
      if (detail) {
        currentExample.set(detail);
      }
    } catch (err) {
      console.warn('[ExampleList] loadExample failed:', err);
    } finally {
      loadingId = null;
    }
  }

  function highlightText(text: string, highlights: [number, number][]): string {
    if (!highlights.length) return escapeHtml(text);

    const parts: string[] = [];
    let lastEnd = 0;
    const ascending = [...highlights].sort((a, b) => a[0] - b[0]);

    for (const [start, end] of ascending) {
      if (start < lastEnd) continue;
      parts.push(escapeHtml(text.slice(lastEnd, start)));
      parts.push(`<mark class="ge-mark">${escapeHtml(text.slice(start, end))}</mark>`);
      lastEnd = end;
    }
    parts.push(escapeHtml(text.slice(lastEnd)));
    return parts.join('');
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sourceLabel(src: string): string {
    return src === 'tatoeba' ? 'T' : src === 'udt' ? 'U' : 'G';
  }

  function sourceTitle(src: string): string {
    return src === 'tatoeba' ? 'Tatoeba'
      : src === 'udt' ? 'UD Irish treebank'
        : 'Gaois (legislation)';
  }
</script>

<div class="ge-list">
  {#each examples as ex}
    <button
      class="ge-list-row ge-example-row"
      style="align-items:flex-start;text-align:left;width:100%;background:transparent;border:0;cursor:pointer;font:inherit;color:inherit;"
      onclick={() => handleTap(ex)}
      disabled={!!loadingId}
    >
      <span
        class="ge-srcbadge"
        class:tatoeba={ex.src === 'tatoeba'}
        class:gaois={ex.src === 'gaois'}
        class:udt={ex.src === 'udt'}
        title={sourceTitle(ex.src)}
      >
        {sourceLabel(ex.src)}
      </span>
      <div class="row-main">
        <div class="ge-list-title" style="font-weight:400;line-height:1.45;">
          {@html highlightText(ex.ga, ex.hl)}
        </div>
        <div class="ge-list-subtitle" style="margin-top:2px;">{ex.en}</div>
      </div>
      {#if loadingId === ex.resourceId}
        <span class="row-after" style="font-size:12px;color:var(--fg-soft);">...</span>
      {:else}
        <svg class="row-after" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fg-soft)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
          <path d="M9 18l6-6-6-6"/>
        </svg>
      {/if}
    </button>
  {/each}
</div>
