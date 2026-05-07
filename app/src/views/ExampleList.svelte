<script lang="ts">
  import type { ExternalExample } from '../lib/dictionary';

  interface Props {
    examples: ExternalExample[];
  }

  let { examples }: Props = $props();

  function highlightText(text: string, highlights: [number, number][]): string {
    if (!highlights.length) return escapeHtml(text);

    // Sort highlights by start position (descending) to insert from end
    const sorted = [...highlights].sort((a, b) => b[0] - a[0]);
    let result = escapeHtml(text);

    // Adjust offsets for HTML escaping: we need to map original offsets to escaped string
    // Simpler approach: build from parts using original offsets on original text
    const parts: string[] = [];
    let lastEnd = 0;
    const ascending = [...highlights].sort((a, b) => a[0] - b[0]);

    for (const [start, end] of ascending) {
      if (start < lastEnd) continue; // skip overlapping
      parts.push(escapeHtml(text.slice(lastEnd, start)));
      parts.push(`<mark class="bg-yellow-200 rounded px-0.5">${escapeHtml(text.slice(start, end))}</mark>`);
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
    return src === 'tatoeba' ? 'T' : 'L';
  }

  function sourceTitle(src: string): string {
    return src === 'tatoeba' ? 'Tatoeba' : 'Gaois (legislation)';
  }
</script>

<ul class="space-y-3 px-4">
  {#each examples as ex}
    <li class="border-l-2 border-gray-200 pl-3">
      <div class="flex items-start gap-2">
        <span
          class="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold text-white flex-shrink-0 mt-0.5"
          class:bg-blue-500={ex.src === 'tatoeba'}
          class:bg-green-600={ex.src === 'gaois'}
          title={sourceTitle(ex.src)}
        >
          {sourceLabel(ex.src)}
        </span>
        <div class="min-w-0">
          <p class="text-sm leading-snug">
            {@html highlightText(ex.ga, ex.hl)}
          </p>
          <p class="text-xs text-gray-500 mt-0.5">{ex.en}</p>
        </div>
      </div>
    </li>
  {/each}
</ul>
