<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // Layer description page — the full human-readable card for one Layer resource
  // from the catalogue. Styled like the example / headword pages (teal hero +
  // ge-block-title sections).
  import { currentLayer, layers, removeLayer } from '../lib/store';
  import { t } from '../lib/i18n';
  import { invoke } from '@tauri-apps/api/core';
  import type { LayerEntry } from '../lib/layers-catalogue';

  let { layer }: { layer: LayerEntry } = $props();

  function goBack() { currentLayer.set(null); }

  // The installed layer this catalogue entry corresponds to (if any) — enables
  // the Remove action. Installed names map to slug / integrationSlug (± the
  // `-v2` head suffix); device-built layers use their name as the slug.
  let installedName = $derived(
    $layers.find(l =>
      l.name === layer.slug || l.name === layer.integrationSlug || `${l.name}-v2` === layer.integrationSlug,
    )?.name,
  );
  async function doRemove() {
    if (!installedName) return;
    try { await removeLayer(installedName); } catch (e) { console.warn('[layer] remove failed:', e); }
    goBack();
  }
  // Match MapView: the opener plugin's command directly (no JS wrapper installed).
  function open(url: string) { if (url) invoke('plugin:opener|open_url', { url }).catch((e) => console.warn('[layer] open failed:', e)); }
  function num(s: string): string { const n = Number(s); return Number.isFinite(n) ? n.toLocaleString() : s; }
</script>

<div class="ge-page" style="padding-bottom:24px;">
  <!-- Teal hero: swatch + name + type chips -->
  <div style="background:var(--teal-deep);color:var(--cream);padding:0 0 18px;">
    <div class="ge-navbar" style="background:transparent;border-bottom:0;color:var(--cream);">
      <div class="ge-navbar-side">
        <button class="ge-back" style="color:var(--cream);" onclick={goBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          {$t('settings.layers')}
        </button>
      </div>
      <div class="ge-navbar-title" style="color:rgba(246,244,235,0.65);font-size:13px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;">{$t('layerDetail.title')}</div>
      <div class="ge-navbar-side right"></div>
    </div>

    <div style="padding:4px 18px 0;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="width:14px;height:14px;border-radius:4px;background:{layer.swatch || 'var(--cream)'};display:inline-block;flex-shrink:0;"></span>
        <div style="font-size:28px;font-weight:700;line-height:1.2;color:var(--cream);">{layer.name}</div>
      </div>
      {#if layer.types.length}
        <div class="ge-ex-chips" style="margin-top:10px;">
          {#each layer.types as ty}
            <span class="ge-ex-chip" style="background:rgba(246,244,235,0.16);color:var(--cream);border:0;">{ty}</span>
          {/each}
        </div>
      {/if}
      <div class="ge-hero-rule"></div>
    </div>
  </div>

  {#if layer.description}
    <div class="ge-block-title">{$t('layerDetail.description')}</div>
    <div style="padding:0 16px;">
      <div class="ge-list"><div class="ge-list-row"><div class="row-main">
        <div class="ge-list-title" style="font-weight:400;line-height:1.5;">{layer.description}</div>
      </div></div></div>
    </div>
  {/if}

  {#if layer.licence || layer.attribution}
    <div class="ge-block-title">{$t('layerDetail.licence')}</div>
    <div style="padding:0 16px;">
      <div class="ge-list">
        {#if layer.licence}
          <div class="ge-list-row"><div class="row-main"><div class="ge-list-title" style="font-weight:700;">{layer.licence}</div></div></div>
        {/if}
        {#if layer.attribution}
          <div class="ge-list-row"><div class="row-main"><div class="ge-list-subtitle" style="line-height:1.45;">{layer.attribution}</div></div></div>
        {/if}
      </div>
    </div>
  {/if}

  {#if layer.formats.length}
    <div class="ge-block-title">{$t('layerDetail.formats')}</div>
    <div style="padding:0 16px 4px;">
      <div class="ge-ex-chips">
        {#each layer.formats as f}<span class="ge-ex-chip">{f}</span>{/each}
      </div>
    </div>
  {/if}

  {#if layer.resourceCount}
    <div class="ge-block-title">{$t('layerDetail.statistics')}</div>
    <div style="padding:0 16px;">
      <div class="ge-list"><div class="ge-list-row"><div class="row-main">
        <div class="ge-list-title"><span style="font-weight:700;font-size:20px;">{num(layer.resourceCount)}</span> <span style="color:var(--fg-soft);">{$t('layerDetail.resources')}</span></div>
      </div></div></div>
    </div>
  {/if}

  {#if layer.links.length}
    <div class="ge-block-title">{$t('layerDetail.links')}</div>
    <div style="padding:0 16px;">
      <div class="ge-list">
        {#each layer.links as lk}
          <button class="ge-list-row" style="width:100%;background:transparent;border:0;text-align:left;cursor:pointer;" onclick={() => open(lk.url)}>
            <div class="row-main">
              <div class="ge-list-title" style="font-weight:600;">{lk.title || lk.url}</div>
              {#if lk.type}<div class="ge-list-subtitle">{lk.type}</div>{/if}
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--fg-soft);flex-shrink:0;"><path d="M7 17L17 7M7 7h10v10"/></svg>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if layer.downloads.length}
    <div class="ge-block-title">{$t('layerDetail.downloads')}</div>
    <div style="padding:0 16px;">
      <div class="ge-list">
        {#each layer.downloads as d}
          <div class="ge-list-row"><div class="row-main">
            <div class="ge-list-title" style="font-weight:600;">{d.format}</div>
            {#if d.notes}<div class="ge-list-subtitle" style="line-height:1.45;">{d.notes}</div>{/if}
          </div></div>
        {/each}
      </div>
    </div>
  {/if}

  {#if installedName}
    <div style="padding:20px 16px 8px;">
      <button
        onclick={doRemove}
        style="width:100%;padding:12px;border:1px solid color-mix(in srgb, var(--danger,#b0463c) 40%, var(--srf-rule));border-radius:10px;background:transparent;color:var(--danger,#b0463c);font-weight:650;font-size:15px;cursor:pointer;"
      >{$t('layers.removeLayer')}</button>
    </div>
  {/if}
</div>
