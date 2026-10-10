<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // Layer Manager - the dedicated home for the data behind the dictionary,
  // replacing the layer controls that used to live in Settings. Reuses the
  // existing layer components (LayerDetail via currentLayer, the layerStack /
  // toggleLayerVisibility visibility model) and adds the two pieces the old
  // Settings form lacked: a per-layer STATE (active / hidden / building /
  // failed) and a SOURCE-FIRST "Add a layer" flow - the user picks what data
  // they want (a catalogue entry, a downloaded file, a URL) and the ingest
  // format is inferred, never chosen from a row of build-pipeline buttons.
  import {
    layerStack, toggleLayerVisibility, layers, removeLayer,
    buildProgress, buildingLayerName, importLayer, installPackage,
    overlayView, layerTrust,
  } from '../lib/store';
  import { verifyLayer, type LayerVerification } from '../lib/v2';
  import type { SuggestedLayer } from '../lib/family';
  import { t } from '../lib/i18n';
  import { open } from '@tauri-apps/plugin-dialog';
  import { onMount } from 'svelte';
  import { loadLayerCatalogue, type LayerEntry } from '../lib/layers-catalogue';
  import LayerBlockCard from './LayerBlockCard.svelte';
  import TrustShield from './TrustShield.svelte';

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
      defaultOn: false, swatch, config: null, install: null, downloads: [],
    };
  }
  function entryFor(l: { name: string; label: string; swatch: string }): LayerEntry {
    return catEntry(l.name) ?? stubEntry(l.name, l.label, l.swatch);
  }
  // Uninstall (delete from device). Confirm first - a device-built layer (e.g.
  // Téarma) has to be rebuilt from its TBX to come back.
  async function confirmRemove(l: { name: string; label: string }) {
    const ok = typeof window === 'undefined' || window.confirm($t('layers.removeConfirm', { name: l.label }));
    if (!ok) return;
    try { await removeLayer(l.name); } catch (e) { console.warn('[layers] remove failed:', e); }
  }

  // ── Enable-time trust gate ──────────────────────────────────────────────
  // Enabling a layer verifies it first. A verified (green) layer enables
  // silently; an unverified (yellow) or tampered (red) one raises a warning with
  // Accept/Reject - we WARN, never hard-refuse (this is a dictionary; the strict
  // refuse-to-open policy is Aonach Mor's, on the same verdict). Disabling is
  // always safe, so it never gates.
  let gate = $state<{ name: string; label: string; v: LayerVerification } | null>(null);

  async function enableGuarded(l: { name: string; label: string }) {
    let v: LayerVerification;
    try {
      v = await verifyLayer(l.name); // authoritative fresh check at enable time
    } catch (e) {
      v = { status: 'tampered', reason: String(e), author: '', role: '', confirmed: false };
    }
    layerTrust.update(t => ({ ...t, [l.name]: v }));
    if (v.status === 'verified') { await toggleLayerVisibility(l.name); return; }
    gate = { name: l.name, label: l.label, v }; // warn: open the modal
  }
  async function acceptGate() {
    if (!gate) return;
    const name = gate.name;
    gate = null;
    await toggleLayerVisibility(name);
  }
  function rejectGate() { gate = null; }

  // Installed layers split by visibility. The pinned "base" (last one standing)
  // is shown as active but not togglable off.
  let active = $derived($layerStack.filter(l => l.visible));
  let hidden = $derived($layerStack.filter(l => !l.visible));

  // The layer currently building isn't in `layers` yet - surface it as its own
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

  // When a build STARTS, the progress card renders at the top of the list, but
  // the user usually tapped an install action further down. Scroll the manager
  // back to the top so the loading bar is in view. Rising-edge only (not on every
  // progress tick); scrollIntoView finds whichever ancestor actually scrolls.
  let managerEl: HTMLElement | undefined = $state();
  let wasBuilding = false;
  $effect(() => {
    const now = isBuilding;
    if (now && !wasBuilding) managerEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    wasBuilding = now;
  });

  // Suggested sources not yet installed, derived from the CATALOGUE (the single
  // source): any layer whose definition carries an `install` block is offered,
  // minus the ones already installed. These are SOURCES, not formats - each
  // carries the ingest format so the user never picks one.
  let suggestions = $derived<SuggestedLayer[]>(
    catalogue
      .filter(e => e.install && !$layers.some(l => l.name === e.install!.name))
      .map(e => ({
        name: e.install!.name,
        url: e.install!.url,
        label: e.name,
        format: e.install!.format as SuggestedLayer['format'],
      })),
  );

  // ── Add a layer: source-first ────────────────────────────────────────────
  let addName = $state('');
  let addUrl = $state('');
  let pickedFile = $state('');       // human filename for display
  let addError = $state('');
  let showAdvanced = $state(false);

  /** Infer the ingest format from the source - the user never selects it. */
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
    // Android's dialog returns a content:// URI; desktop returns a bare absolute
    // path (no scheme). build_layer's fetch only handles content:// / file:// /
    // http(s) - a scheme-less path falls through to reqwest and fails - so prefix
    // bare local paths with file://. Leave any real scheme (content://, http://) be.
    addUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(picked) ? picked : `file://${picked}`;
    if (!addName.trim()) {
      // A picked file maps to its catalogue Layer record by ingest format - a .tbx
      // is Téarma - so the installed layer joins that record's name (and thus its
      // label + colour) instead of a filename-derived id like "msf:18375". Fall
      // back to the bare filename only when no catalogue record claims the format.
      const fmt = detectFormat(pickedFile);
      const known = catalogue.find((e) => e.install?.format === fmt);
      addName = known?.install?.name || pickedFile.replace(/\.(tbx|tar\.gz|tgz|zip)$/i, '');
    }
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

<div class="ge-page ge-layer-mgr" bind:this={managerEl}>
  <div class="ge-navbar">
    <div class="ge-navbar-side"></div>
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
      <LayerBlockCard layer={entryFor(l)} trust={$layerTrust[l.name]} toggle toggled onToggle={() => toggleLayerVisibility(l.name)} actionLabel={$t('layers.aria')} onRemove={() => confirmRemove(l)} removeLabel={$t('layers.removeLayer')} />
    {/each}

    {#if hidden.length > 0}
      <div class="lm-group">{$t('layers.stHidden')}</div>
      {#each hidden as l}
        <LayerBlockCard layer={entryFor(l)} trust={$layerTrust[l.name]} toggle toggled={false} onToggle={() => enableGuarded(l)} actionLabel={$t('layers.aria')} onRemove={() => confirmRemove(l)} removeLabel={$t('layers.removeLayer')} />
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

  <!-- ── Enable-time trust warning (Accept / Reject) ─────────────── -->
  {#if gate}
    <div class="lm-gate-backdrop" role="dialog" aria-modal="true">
      <div class="lm-gate">
        <div class="lm-gate-icon"><TrustShield status={gate.v.status} reason="" /></div>
        <div class="lm-gate-title">
          {gate.v.status === 'tampered' ? $t('trust.tamperedTitle') : $t('trust.unsignedTitle')}
        </div>
        <div class="lm-gate-name">{gate.label}</div>
        <div class="lm-gate-body">
          {gate.v.reason
            || (gate.v.status === 'tampered' ? $t('trust.tamperedBody') : $t('trust.unsignedBody'))}
        </div>
        <div class="lm-gate-actions">
          <button class="lm-ghost" onclick={rejectGate}>{$t('trust.reject')}</button>
          <button class="lm-primary" onclick={acceptGate}>{$t('trust.accept')}</button>
        </div>
      </div>
    </div>
  {/if}
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

  /* Enable-time trust warning */
  .lm-gate-backdrop {
    position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
    background: color-mix(in oklab, #000 45%, transparent); padding: 24px;
  }
  .lm-gate {
    width: 100%; max-width: 340px; background: var(--srf-card, var(--srf-base));
    border: 1px solid var(--srf-rule); border-radius: 16px; padding: 20px;
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px;
  }
  .lm-gate-icon :global(svg) { width: 34px; height: 36px; }
  .lm-gate-title { font-weight: 700; font-size: var(--fs-body); }
  .lm-gate-name { font-size: var(--fs-small); color: var(--fg-muted); }
  .lm-gate-body { font-size: var(--fs-small); color: var(--fg-body); line-height: 1.45; }
  .lm-gate-actions { display: flex; gap: 10px; margin-top: 8px; width: 100%; }
  .lm-gate-actions > button { flex: 1; }
</style>
