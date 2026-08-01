<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // Layer Manager — the dedicated home for the data behind the dictionary,
  // replacing the layer controls that used to live in Settings. Reuses the
  // existing layer components (LayerDetail via currentLayer, the layerStack /
  // toggleLayerVisibility visibility model) and adds the two pieces the old
  // Settings form lacked: a per-layer STATE (active / hidden / building /
  // failed) and a SOURCE-FIRST "Add a layer" flow — the user picks what data
  // they want (a catalogue entry, a downloaded file, a URL) and the ingest
  // format is inferred, never chosen from a row of build-pipeline buttons.
  import {
    layerStack, toggleLayerVisibility, layers,
    buildProgress, buildingLayerName, importLayer, installPackage,
    overlayView, familyConfig,
  } from '../lib/store';
  import type { SuggestedLayer } from '../lib/family';
  import { t } from '../lib/i18n';
  import { open } from '@tauri-apps/plugin-dialog';
  import { onMount } from 'svelte';
  import { loadLayerCatalogue, type LayerEntry } from '../lib/layers-catalogue';
  import LayerBlockCard from './LayerBlockCard.svelte';

  let catalogue = $state<LayerEntry[]>([]);
  onMount(() => { loadLayerCatalogue().then(c => (catalogue = c)).catch(() => {}); });
  function catEntry(name: string): LayerEntry | undefined {
    return catalogue.find(e => e.slug === name || e.integrationSlug === name || e.integrationSlug === `${name}-v2`);
  }

  /** A minimal LayerEntry for a layer with no catalogue metadata (e.g. a
   *  device-built Téarma) so it still renders as a full block card. */
  function stubEntry(name: string, label: string, swatch: string): LayerEntry {
    return {
      resourceId: '', name: label, slug: name, icon: '', types: [], formats: [],
      licence: '', attribution: '', descriptionType: '', description: '',
      links: [], resourceCount: '', statistics: null, integrationSlug: name,
      defaultOn: false, swatch, config: null, downloads: [],
    };
  }
  function entryFor(l: { name: string; label: string; swatch: string }): LayerEntry {
    return catEntry(l.name) ?? stubEntry(l.name, l.label, l.swatch);
  }

  // Installed layers split by visibility. The pinned "base" (last one standing)
  // is shown as active but not togglable off.
  let active = $derived($layerStack.filter(l => l.visible));
  let hidden = $derived($layerStack.filter(l => !l.visible));

  // The layer currently building isn't in `layers` yet — surface it as its own
  // card driven by buildProgress. On 'failed' it stays until dismissed/retried.
  let buildingName = $derived($buildingLayerName);
  let building = $derived(
    buildingName && $buildProgress && $buildProgress.state !== 'failed'
      ? { name: buildingName, status: $buildProgress } : null,
  );
  let failed = $derived(
    buildingName && $buildProgress?.state === 'failed'
      ? { name: buildingName, error: $buildProgress.error } : null,
  );
  let isBuilding = $derived(building !== null);

  // Suggested sources not yet installed (family config). These are SOURCES, not
  // formats — each carries the ingest format so the user never picks one.
  let suggestions = $derived(
    $familyConfig.suggestedLayers.filter(s => !$layers.some(l => l.name === s.name)),
  );

  // ── Add a layer: source-first ────────────────────────────────────────────
  let addName = $state('');
  let addUrl = $state('');
  let pickedFile = $state('');       // human filename for display
  let addError = $state('');
  let showAdvanced = $state(false);

  /** Infer the ingest format from the source — the user never selects it. */
  function detectFormat(filenameOrUrl: string): 'tbx-v2' | 'built' | 'prebuild-v2' {
    const s = filenameOrUrl.toLowerCase();
    if (/\.tbx($|\?)/.test(s)) return 'tbx-v2';          // terminology → FTS build
    if (/\.(tar\.gz|tgz|zip)($|\?)/.test(s)) return 'built'; // prebuilt package
    return 'tbx-v2';                                      // BYO files are TBX by default
  }

  async function chooseFile() {
    const selected = await open({ multiple: false, filters: [{ name: 'All files', extensions: ['*'] }] });
    if (!selected) return;
    const picked = selected as string;
    addError = '';
    // The picker's own title carries the real name; show that, not the SAF id.
    pickedFile = decodeURIComponent(picked.split('/').pop() || 'file');
    addUrl = picked;                    // content:// URI — build_layer handles it
    if (!addName.trim()) addName = pickedFile.replace(/\.(tbx|tar\.gz|tgz|zip)$/i, '');
  }

  async function addFromFile() {
    if (!addUrl.trim() || !addName.trim()) return;
    addError = '';
    try {
      await importLayer(addUrl.trim(), addName.trim(), detectFormat(pickedFile || addUrl));
      resetAdd();
    } catch (e) { addError = humanError(String(e)); }
  }

  async function addFromUrl() {
    if (!addUrl.trim() || !addName.trim()) return;
    addError = '';
    try {
      const fmt = detectFormat(addUrl);
      if (fmt === 'built') await installPackage(addUrl.trim(), addName.trim());
      else await importLayer(addUrl.trim(), addName.trim(), fmt);
      resetAdd();
    } catch (e) { addError = humanError(String(e)); }
  }

  /** A suggested source: file-based (empty url) → prefill the file row; a
   *  packaged/remote one → install/build straight away. */
  async function useSuggestion(s: SuggestedLayer) {
    addError = '';
    addName = s.name;
    if (!s.url) { pickedFile = ''; addUrl = ''; return; } // choose-a-file source
    try {
      if (s.format === 'built') await installPackage(s.url, s.name);
      else await importLayer(s.url, s.name, s.format);
      resetAdd();
    } catch (e) { addError = humanError(String(e)); }
  }

  function resetAdd() { addName = ''; addUrl = ''; pickedFile = ''; }

  function close() { overlayView.set(null); }

  /** Turn a raw ingest error into a sentence. The classic: a 404 HTML page fed
   *  to the TBX parser. */
  function humanError(e: string): string {
    if (/expected .<\/meta>|ill-formed|<\/head>/i.test(e))
      return $t('layers.errNotTbx');
    return e.replace(/^Error:\s*/, '');
  }
</script>

<div class="ge-page ge-layer-mgr">
  <div class="ge-navbar">
    <div class="ge-navbar-side">
      <button class="ge-back" onclick={close} aria-label={$t('nav.back')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        {$t('nav.settings')}
      </button>
    </div>
    <div class="ge-navbar-title">{$t('layers.managerTitle')}</div>
    <div class="ge-navbar-side right"></div>
  </div>

  <!-- ── Your layers ─────────────────────────────────────────── -->
  <div class="ge-block-title">{$t('layers.yours')} · {$t('layers.managerCount', { active: active.length, total: $layerStack.length })}</div>
  <div class="lm-body">
    {#if building}
      <div class="lm-row building">
        <span class="lm-swatch" style="background:var(--layer-te,#925f3c)"></span>
        <div class="lm-main">
          <div class="lm-name">{building.name}</div>
          <div class="lm-prog"><span style="width:{Math.round(building.status.progress * 100)}%"></span></div>
          <div class="lm-buildline">
            <span>{building.status.state === 'parsing' ? $t('settings.buildParsing')
              : building.status.state === 'building' ? $t('settings.buildBuilding')
              : building.status.state === 'indexing' ? $t('settings.buildIndexing')
              : building.status.state === 'fetching' ? $t('settings.buildFetching')
              : building.status.state}</span>
            <span>{Math.round(building.status.progress * 100)}%</span>
          </div>
        </div>
        <span class="lm-pill building">{$t('layers.stBuilding')}</span>
      </div>
    {/if}

    {#if failed}
      <div class="lm-row failed">
        <span class="lm-swatch" style="background:var(--danger,#b0463c)"></span>
        <div class="lm-main">
          <div class="lm-name">{failed.name}</div>
          <div class="lm-err">{humanError(failed.error || '')}</div>
        </div>
        <button class="lm-ghost" onclick={() => buildingLayerName.set(null)}>{$t('layers.dismiss')}</button>
      </div>
    {/if}

    {#each active as l}
      <LayerBlockCard layer={entryFor(l)} toggle toggled onToggle={() => toggleLayerVisibility(l.name)} actionLabel={$t('layers.aria')} />
    {/each}

    {#if hidden.length > 0}
      <div class="lm-group">{$t('layers.stHidden')}</div>
      {#each hidden as l}
        <LayerBlockCard layer={entryFor(l)} toggle toggled={false} onToggle={() => toggleLayerVisibility(l.name)} actionLabel={$t('layers.aria')} />
      {/each}
    {/if}

    {#if $layerStack.length === 0 && !building}
      <div class="lm-empty">{$t('settings.noLayers')}</div>
    {/if}
  </div>

  <!-- ── Add a layer (source-first) ──────────────────────────── -->
  <div class="ge-block-title">{$t('layers.add')}</div>
  <div class="lm-body">
    {#if suggestions.length > 0}
      <div class="lm-group">{$t('layers.fromCatalogue')}</div>
      {#each suggestions as s}
        <LayerBlockCard
          layer={catEntry(s.name) ?? stubEntry(s.name, s.label, 'var(--layer-default)')}
          actionText={!s.url ? $t('layers.getFile') : s.format === 'built' ? $t('layers.install') : $t('layers.build')}
          onAction={() => useSuggestion(s)}
          disabled={isBuilding}
        />
      {/each}
    {/if}

    <div class="lm-group">{$t('layers.fromFile')}</div>
    <div class="lm-file">
      <input class="lm-input" bind:value={addName} placeholder={$t('settings.layerName')} disabled={isBuilding} />
      <div class="lm-file-row">
        <button class="lm-ghost" onclick={chooseFile} disabled={isBuilding}>{$t('settings.chooseTbxFile')}</button>
        <span class="lm-file-name">{pickedFile || $t('settings.noFileChosen')}</span>
      </div>
      <button class="lm-primary" onclick={addFromFile} disabled={isBuilding || !addUrl.trim() || !addName.trim()}>
        {$t('layers.addLayer')}
      </button>
    </div>

    <button class="lm-adv" onclick={() => (showAdvanced = !showAdvanced)}>{$t('layers.advanced')}</button>
    {#if showAdvanced}
      <div class="lm-file">
        <input class="lm-input" bind:value={addUrl} placeholder={$t('settings.layerUrl')} disabled={isBuilding} />
        <button class="lm-primary" onclick={addFromUrl} disabled={isBuilding || !addUrl.trim() || !addName.trim()}>
          {$t('layers.addLayer')}
        </button>
      </div>
    {/if}

    {#if addError}<div class="lm-error">{addError}</div>{/if}
  </div>
</div>

<style>
  .ge-layer-mgr { color: var(--fg-body); }
  .lm-body { padding: 0 16px 8px; display: flex; flex-direction: column; gap: 8px; }
  .lm-group { font-size: var(--fs-small); color: var(--fg-muted); text-transform: uppercase; letter-spacing: .06em; margin: 6px 0 0; }

  .lm-row {
    display: flex; align-items: center; gap: 10px;
    background: var(--srf-card, var(--srf-base)); border: 1px solid var(--srf-rule); border-radius: 12px;
    padding: 10px 12px;
  }
  .lm-row.building { border-color: color-mix(in oklab, var(--warn, #b9821f) 45%, var(--srf-rule)); }
  .lm-row.failed { border-color: color-mix(in oklab, var(--danger, #b0463c) 45%, var(--srf-rule)); }
  .lm-swatch { width: 6px; align-self: stretch; border-radius: 3px; flex-shrink: 0; min-height: 34px; }
  .lm-main { flex: 1; min-width: 0; }
  .lm-name { font-weight: 650; font-size: var(--fs-body); }

  .lm-pill { font-size: 10px; letter-spacing: .03em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; font-weight: 650; white-space: nowrap; flex-shrink: 0; }
  .lm-pill.building { color: var(--warn, #b9821f); background: color-mix(in oklab, var(--warn, #b9821f) 16%, transparent); }

  .lm-prog { height: 5px; border-radius: 999px; background: var(--srf-rule); overflow: hidden; margin-top: 6px; }
  .lm-prog > span { display: block; height: 100%; background: var(--accent-deep, var(--accent)); border-radius: 999px; transition: width .3s; }
  .lm-buildline { display: flex; justify-content: space-between; font-size: var(--fs-small); color: var(--fg-muted); margin-top: 4px; font-variant-numeric: tabular-nums; }
  .lm-err { font-size: var(--fs-small); color: var(--danger, #b0463c); margin-top: 2px; }

  .lm-empty { font-size: var(--fs-small); color: var(--fg-muted); padding: 4px 0 8px; }

  .lm-file { display: flex; flex-direction: column; gap: 8px; }
  .lm-input { padding: 9px 11px; border: 1px solid var(--srf-rule); border-radius: 8px; font-size: var(--fs-body); background: var(--srf-base); color: var(--fg-body); }
  .lm-file-row { display: flex; align-items: center; gap: 10px; }
  .lm-file-name { font-size: var(--fs-small); color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lm-ghost { padding: 8px 12px; border: 1px solid var(--srf-rule); border-radius: 8px; font-size: var(--fs-small); font-weight: 600; background: var(--srf-card, var(--srf-base)); color: var(--fg-body); cursor: pointer; white-space: nowrap; }
  .lm-primary { padding: 10px 12px; border: none; border-radius: 8px; font-size: var(--fs-body); font-weight: 650; background: var(--accent-deep, var(--accent)); color: #fff; cursor: pointer; }
  .lm-primary:disabled { opacity: .5; cursor: default; }
  .lm-adv { align-self: flex-start; background: none; border: none; color: var(--fg-muted); font-size: var(--fs-small); text-transform: uppercase; letter-spacing: .06em; cursor: pointer; padding: 4px 0; }
  .lm-error { font-size: var(--fs-small); color: var(--danger, #b0463c); padding-top: 2px; }
</style>
