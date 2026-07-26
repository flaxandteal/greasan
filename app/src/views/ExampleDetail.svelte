<script lang="ts">
  import { currentEntry, currentExample, loading } from '../lib/store';
  import { loadEntryFlagged } from '../lib/dictionary';
  import FlagButton from './FlagButton.svelte';
  import type { ExampleDetail } from '../lib/dictionary';
  import type { EntryDetail } from '../lib/dictionary';
  import { t } from '../lib/i18n';

  let example = $derived($currentExample as ExampleDetail | null);
  let parentEntry = $derived($currentEntry as EntryDetail | null);

  function goBack() {
    history.back();
  }

  // Tap a headword chip → open that entry. Mirrors the map word-chip pattern:
  // leave the example view, then load and show the entry.
  async function selectHeadword(uri: string, headword: string) {
    if ($loading) return;
    loading.set(true);
    try {
      const entry = await loadEntryFlagged(uri, headword);
      if (entry) {
        currentExample.set(null);
        currentEntry.set(entry);
      }
    } catch (err) {
      console.warn('[ExampleDetail] selectHeadword failed:', err);
    } finally {
      loading.set(false);
    }
  }

  function sourceLabel(src: string): string {
    if (!src) return '';
    return src.charAt(0).toUpperCase() + src.slice(1);
  }

  // The pipeline encodes highlight spans as ";"-separated "start,end" pairs
  // (see format_highlights). Parse back to [start,end] tuples.
  function parseHighlights(s: string): [number, number][] {
    if (!s) return [];
    const out: [number, number][] = [];
    for (const part of s.split(';')) {
      const [a, b] = part.split(',').map((n) => parseInt(n, 10));
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push([a, b]);
    }
    return out;
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Render the sentence with the matched headword span(s) wrapped in <mark>.
  function highlightText(text: string, highlights: [number, number][]): string {
    if (!highlights.length) return escapeHtml(text);
    const parts: string[] = [];
    let lastEnd = 0;
    for (const [start, end] of [...highlights].sort((a, b) => a[0] - b[0])) {
      if (start < lastEnd) continue;
      parts.push(escapeHtml(text.slice(lastEnd, start)));
      parts.push(`<mark class="ge-hero-mark">${escapeHtml(text.slice(start, end))}</mark>`);
      lastEnd = end;
    }
    parts.push(escapeHtml(text.slice(lastEnd)));
    return parts.join('');
  }

  // Highlight every cited headword's surface form (computed in the loader from the
  // same mutation rules the pipeline matched on). Fall back to the single stored
  // span if the reverse lookup came back empty. highlightText() sorts + drops
  // overlaps, so a union with duplicates is fine.
  let hl = $derived(
    example
      ? example.headwords?.length
        ? example.headwords.flatMap((h) => h.spans)
        : parseHighlights(example.highlights)
      : [],
  );
  let isGaois = $derived((example?.source || '').toLowerCase() === 'gaois');
  // Only Tatoeba carries a real per-sentence permalink. The Gaois source_id is a
  // positional counter (see the pipeline), so its computed URL cannot resolve —
  // never surface it. A real Gaois link needs the re-ingested tuid.
  let showSourceLink = $derived(
    !!example?.sourceUrl && (example?.source || '').toLowerCase() === 'tatoeba',
  );
  let licenceLine = $derived(
    isGaois
      ? 'Gaois Parallel Corpus of Legislation — Fiontar & Scoil na Gaeilge, DCU. Legislation © Government of Ireland. CC BY 4.0. A language resource, not an authoritative legal resource.'
      : 'Tatoeba — CC BY 2.0.',
  );
</script>

{#if example}
  <div class="ge-page" style="padding-bottom:0;">
    <!-- Teal hero strip: the sentence, with the matched word highlighted -->
    <div style="background:var(--teal-deep);color:var(--cream);padding:0 0 18px;position:relative;">
      <div class="ge-navbar" style="background:transparent;border-bottom:0;color:var(--cream);">
        <div class="ge-navbar-side">
          <button class="ge-back" style="color:var(--cream);" onclick={goBack}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
            {parentEntry?.headword || $t('nav.back')}
          </button>
        </div>
        <div class="ge-navbar-title" style="color:rgba(246,244,235,0.65);font-size:13px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;">{$t('example.title')}</div>
        <div class="ge-navbar-side right">
          <FlagButton resourceUri={example.resourceId} tone="var(--cream)" subjectName={example.sentence} subjectGraph="Sampla · Example" subjectKind="example" />
        </div>
      </div>

      <div style="padding:4px 18px 0;">
        <div style="font-size:24px;font-weight:600;line-height:1.4;color:var(--cream);">{@html highlightText(example.sentence, hl)}</div>
        <div class="ge-hero-rule"></div>
      </div>
    </div>

    <!-- Translation -->
    {#if example.translation}
      <div class="ge-block-title">{$t('example.translation')}</div>
      <div style="padding:0 16px;">
        <div class="ge-list">
          <div class="ge-list-row">
            <div class="row-main">
              <div class="ge-list-title" style="font-weight:400;font-style:italic;">{example.translation}</div>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Headwords this sentence illustrates. These come from cited_by (the reverse
         of the entry graph's external_examples link), NOT from string-matching the
         sentence — so mutations (lenition/eclipsis/inflection) can't break them. -->
    {#if example.headwords && example.headwords.length}
      <div class="ge-block-title">Ceannfhocail · Headwords</div>
      <div style="padding:0 16px 4px;">
        <div class="ge-ex-chips">
          {#each example.headwords as hw}
            <button class="ge-ex-chip" onclick={() => selectHeadword(hw.resourceId, hw.headword)}>{hw.headword}</button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Source / citation -->
    {#if example.source || example.sourceId}
      <div class="ge-block-title">{$t('example.source')}</div>
      <div style="padding:0 16px 8px;">
        <div class="ge-list">
          <div class="ge-list-row" style="align-items:flex-start;">
            <div class="row-main">
              {#if example.source}
                <div class="ge-list-title">
                  {sourceLabel(example.source)}{#if isGaois}<span style="font-weight:400;color:var(--fg-soft);"> · Parallel Corpus of Legislation</span>{/if}
                </div>
              {/if}
              {#if example.collection}
                <div class="ge-list-subtitle">{example.collection}</div>
              {/if}
              {#if example.citation}
                <div class="ge-list-subtitle" style="font-variant-numeric:tabular-nums;">{example.citation}</div>
              {/if}
              {#if example.sourceId && !isGaois}
                <div class="ge-list-subtitle">ID: {example.sourceId}</div>
              {/if}
              {#if showSourceLink}
                <div style="margin-top:8px;">
                  <a
                    href={example.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style="color:var(--link);font-size:var(--fs-small);text-decoration:underline;"
                  >
                    {$t('example.viewSource')}
                  </a>
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Licence / provenance footnote -->
    <div style="padding:2px 18px 32px;">
      <div style="font-size:12px;line-height:1.5;color:var(--fg-soft);">{licenceLine}</div>
    </div>
  </div>
{/if}

<style>
  /* Hero highlight: a gold underline reads clearly on the teal ground, unlike
     the light-background mark used in list rows. */
  :global(.ge-hero-mark) {
    background: transparent;
    color: var(--cream);
    box-shadow: inset 0 -2px 0 0 var(--gold, #d9c78e);
    border-radius: 1px;
    padding: 0 1px;
  }

  /* Headword chips — same theme-aware tokens as the placename chips, sized up as
     primary tap targets. */
  .ge-ex-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ge-ex-chip {
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    padding: 5px 13px;
    border: 0;
    border-radius: var(--pill-radius, 500px);
    cursor: pointer;
    background: color-mix(in srgb, var(--teal-deep) 12%, transparent);
    color: var(--fg-default);
  }
  .ge-ex-chip:active {
    background: color-mix(in srgb, var(--teal-deep) 22%, transparent);
  }
</style>
