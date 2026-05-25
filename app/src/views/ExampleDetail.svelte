<script lang="ts">
  import { currentEntry, currentExample } from '../lib/store';
  import type { ExampleDetail } from '../lib/dictionary';
  import type { EntryDetail } from '../lib/dictionary';
  import { t } from '../lib/i18n';

  let example = $derived($currentExample as ExampleDetail | null);
  let parentEntry = $derived($currentEntry as EntryDetail | null);

  function goBack() {
    history.back();
  }

  function sourceLabel(src: string): string {
    if (!src) return '';
    return src.charAt(0).toUpperCase() + src.slice(1);
  }
</script>

{#if example}
  <div class="ge-page" style="padding-bottom:0;">
    <!-- Teal hero strip -->
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
        <div class="ge-navbar-side right"></div>
      </div>

      <div style="padding:4px 18px 0;">
        <div style="font-size:24px;font-weight:600;line-height:1.35;color:var(--cream);">{example.sentence}</div>
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

    <!-- Citation -->
    {#if example.source || example.sourceId}
      <div class="ge-block-title">{$t('example.source')}</div>
      <div style="padding:0 16px 32px;">
        <div class="ge-list">
          <div class="ge-list-row" style="align-items:flex-start;">
            <div class="row-main">
              {#if example.source}
                <div class="ge-list-title">{sourceLabel(example.source)}</div>
              {/if}
              {#if example.sourceId}
                <div class="ge-list-subtitle">ID: {example.sourceId}</div>
              {/if}
              {#if example.sourceUrl}
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
  </div>
{/if}
