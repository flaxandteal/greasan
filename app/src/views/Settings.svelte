<script lang="ts">
  import { darkMode, density, listStyle, visibleDialects, activeFamily, familyConfig, setActiveFamily, layers, importLayer, installPackage, removeLayer, buildProgress, recentLimit, recentEntries, showLicenseToast } from '../lib/store';
  import { FAMILIES, type FamilyId, type SuggestedLayer } from '../lib/family';
  import { t, localePreference } from '../lib/i18n';
  import { diagEntries, diagTotalMs, diagTotalBytes, diagReset } from '../lib/diagnostics';
  import { open } from '@tauri-apps/plugin-dialog';
  import { onMount } from 'svelte';
  import LayerBlockCard from './LayerBlockCard.svelte';
  import { loadLayerCatalogue, type LayerEntry } from '../lib/layers-catalogue';

  const familyIds = Object.keys(FAMILIES) as FamilyId[];

  // Layer catalogue — rich metadata for installed/available layers (block cards).
  let catalogue = $state<LayerEntry[]>([]);
  onMount(() => { loadLayerCatalogue().then((c) => (catalogue = c)).catch(() => {}); });
  function catEntry(name: string): LayerEntry | undefined {
    return catalogue.find((e) => e.slug === name || e.integrationSlug === name || e.integrationSlug === `${name}-v2`);
  }

  function toggleDialect(value: string) {
    visibleDialects.update(current => {
      if (current.includes(value)) {
        return current.filter(d => d !== value);
      } else {
        return [...current, value];
      }
    });
  }

  // Derive dialect groups from the active family config
  let dialectGroups = $derived([...new Set($familyConfig.dialectOptions.map(d => d.group))]);

  // Layer import form
  let layerUrl = $state('');
  let layerName = $state('');
  let layerError = $state('');
  let layerFormat = $state<'built' | 'prebuild' | 'tbx'>('built');
  let tbxFilePath = $state('');

  let isBuilding = $derived($buildProgress !== null && $buildProgress.state !== 'failed');

  // Suggested layers not yet installed
  let availableSuggestions = $derived(
    $familyConfig.suggestedLayers.filter(
      s => !$layers.some(l => l.name === s.name)
    )
  );

  function prefillSuggested(s: SuggestedLayer) {
    layerName = s.name;
    layerUrl = s.url;
    layerFormat = s.format;
  }

  async function handleChooseTbxFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'All files', extensions: ['*/*'] }],
    });
    if (selected) {
      const picked = selected as string;
      layerError = '';
      tbxFilePath = decodeURIComponent(picked.split('/').pop() || 'file.tbx');
      // Pass content:// URI directly — Rust builder handles it via JNI
      layerUrl = picked;
    }
  }

  async function handleImportLayer() {
    if (!layerUrl.trim() || !layerName.trim()) return;
    layerError = '';
    try {
      if (layerFormat === 'built') {
        await installPackage(layerUrl.trim(), layerName.trim());
      } else {
        await importLayer(layerUrl.trim(), layerName.trim(), layerFormat);
      }
      layerUrl = '';
      layerName = '';
      tbxFilePath = '';
    } catch (err) {
      layerError = String(err);
    }
  }

  async function handleRemoveLayer(name: string) {
    try {
      await removeLayer(name);
    } catch (err) {
      console.warn('[settings] removeLayer failed:', err);
    }
  }

  const densityOptions = [
    { value: 'compact' as const, key: 'settings.densityCompact' },
    { value: 'comfortable' as const, key: 'settings.densityComfortable' },
    { value: 'spacious' as const, key: 'settings.densitySpacious' },
  ];

  const listOptions = [
    { value: 'card' as const, key: 'settings.listCard' },
    { value: 'flat' as const, key: 'settings.listFlat' },
  ];

  const modeOptions = [
    { value: 'light' as const, key: 'settings.modeLight' },
    { value: 'dark' as const, key: 'settings.modeDark' },
  ];

  const languageOptions = [
    { value: 'system' as const, key: 'settings.langSystem' },
    { value: 'ga' as const, key: 'settings.langIrish' },
    { value: 'en' as const, key: 'settings.langEnglish' },
  ];

  interface Props {
    showLicenseSection?: boolean;
  }

  let { showLicenseSection = false }: Props = $props();
  let licenseExpanded = $state(showLicenseSection);
  let diagExpanded = $state(false);

  function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  $effect(() => {
    if (showLicenseSection) licenseExpanded = true;
  });
</script>

<div class="ge-page">
  <div class="ge-navbar">
    <div class="ge-navbar-side"></div>
    <div class="ge-navbar-title">{$t('settings.title')}</div>
    <div class="ge-navbar-side right"></div>
  </div>

  <div class="ge-block-title">{$t('settings.dictionary')}</div>
  <div style="padding:0 16px;">
    <div class="ge-segs">
      {#each familyIds as fid}
        <button
          class="ge-seg"
          class:active={$activeFamily === fid}
          onclick={() => setActiveFamily(fid)}
        >
          {FAMILIES[fid].label}
        </button>
      {/each}
    </div>
  </div>

  <div class="ge-block-title">{$t('settings.layers')}</div>
  <div style="padding:0 16px;">
    {#if $layers.length > 0}
      <div style="margin-bottom:8px;">
        {#each $layers as layer}
          {@const ce = catEntry(layer.name)}
          {#if ce}
            <LayerBlockCard layer={ce} actionLabel={$t('settings.removeLayer')} onAction={() => handleRemoveLayer(layer.name)} />
          {:else}
            <div class="ge-layer-row">
              <span class="ge-layer-label">{layer.name}</span>
              <button
                class="ge-layer-action"
                onclick={() => handleRemoveLayer(layer.name)}
                aria-label={$t('settings.removeLayer')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      <div style="font-size:var(--fs-small);color:var(--fg-muted);padding:4px 0 8px;">{$t('settings.noLayers')}</div>
    {/if}

    {#if availableSuggestions.length > 0}
      <div style="margin-bottom:8px;">
        <div style="font-size:var(--fs-small);color:var(--fg-muted);margin-bottom:4px;">{$t('settings.suggestedLayers')}</div>
        {#each availableSuggestions as s}
          <button
            class="ge-suggested-layer"
            onclick={() => prefillSuggested(s)}
            disabled={isBuilding}
          >
            <span class="ge-suggested-label">{s.label}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
        {/each}
      </div>
    {/if}

    {#if isBuilding && $buildProgress}
      <div style="padding:6px 0;">
        <div style="font-size:var(--fs-small);color:var(--fg-muted);margin-bottom:4px;">
          {$buildProgress.state === 'fetching' ? $t('settings.buildFetching') :
           $buildProgress.state === 'extracting' ? $t('settings.buildExtracting') :
           $buildProgress.state === 'parsing' ? $t('settings.buildParsing') :
           $buildProgress.state === 'building' ? $t('settings.buildBuilding') :
           $buildProgress.state === 'indexing' ? $t('settings.buildIndexing') :
           $buildProgress.state === 'writing' ? $t('settings.buildWriting') :
           $buildProgress.state}
        </div>
        <div style="height:4px;background:var(--srf-rule);border-radius:2px;overflow:hidden;">
          <div style="height:100%;background:var(--accent-deep);border-radius:2px;transition:width 0.3s;width:{$buildProgress.progress * 100}%;"></div>
        </div>
      </div>
    {:else}
      <div style="display:flex;flex-direction:column;gap:6px;">
        <input
          bind:value={layerName}
          placeholder={$t('settings.layerName')}
          style="padding:6px 10px;border:1px solid var(--srf-rule);border-radius:6px;font-size:var(--fs-body);background:var(--srf-base);color:var(--fg-body);"
        />
        {#if layerFormat === 'tbx'}
          <div style="display:flex;align-items:center;gap:8px;">
            <button
              onclick={handleChooseTbxFile}
              style="padding:6px 12px;border:1px solid var(--srf-rule);border-radius:6px;font-size:var(--fs-body);background:var(--srf-card);color:var(--fg-body);cursor:pointer;white-space:nowrap;"
            >
              {$t('settings.chooseTbxFile')}
            </button>
            <span style="font-size:var(--fs-small);color:var(--fg-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              {tbxFilePath ? tbxFilePath.split('/').pop() : $t('settings.noFileChosen')}
            </span>
          </div>
        {:else}
          <input
            bind:value={layerUrl}
            placeholder={layerFormat === 'built' ? $t('settings.layerUrlPackage') : $t('settings.layerUrl')}
            style="padding:6px 10px;border:1px solid var(--srf-rule);border-radius:6px;font-size:var(--fs-body);background:var(--srf-base);color:var(--fg-body);"
          />
        {/if}
        <div class="ge-segs" style="margin:2px 0;">
          <button
            class="ge-seg"
            class:active={layerFormat === 'built'}
            onclick={() => { layerFormat = 'built'; tbxFilePath = ''; layerUrl = ''; }}
          >
            {$t('settings.formatBuilt')}
          </button>
          <button
            class="ge-seg"
            class:active={layerFormat === 'prebuild'}
            onclick={() => { layerFormat = 'prebuild'; tbxFilePath = ''; layerUrl = ''; }}
          >
            {$t('settings.formatPrebuild')}
          </button>
          <button
            class="ge-seg"
            class:active={layerFormat === 'tbx'}
            onclick={() => { layerFormat = 'tbx'; layerUrl = ''; }}
          >
            {$t('settings.formatTbx')}
          </button>
        </div>
        <button
          onclick={handleImportLayer}
          disabled={!layerUrl.trim() || !layerName.trim()}
          style="padding:6px 12px;border:1px solid var(--srf-rule);border-radius:6px;font-size:var(--fs-body);background:var(--accent-deep);color:white;cursor:pointer;opacity:{!layerUrl.trim() || !layerName.trim() ? '0.5' : '1'};"
        >
          {layerFormat === 'built' ? $t('settings.installPackage') : layerFormat === 'tbx' ? $t('settings.buildTbx') : $t('settings.importLayer')}
        </button>
      </div>
    {/if}

    {#if layerError}
      <div style="font-size:var(--fs-small);color:var(--danger,#c00);padding-top:4px;">{layerError}</div>
    {/if}
    {#if $buildProgress?.state === 'failed'}
      <div style="font-size:var(--fs-small);color:var(--danger,#c00);padding-top:4px;">{$buildProgress.error}</div>
    {/if}
  </div>

  <div class="ge-block-title">{$t('settings.dialects')}</div>
  <div class="ge-dialect-section">
    {#each dialectGroups as group}
      <div class="ge-dialect-group-label">{group}</div>
      {#each $familyConfig.dialectOptions.filter(d => d.group === group) as opt}
        <label class="ge-dialect-row">
          <input
            type="checkbox"
            class="ge-checkbox"
            checked={$visibleDialects.includes(opt.code)}
            onchange={() => toggleDialect(opt.code)}
          />
          <span class="ge-dialect-label">{opt.label}</span>
          {#if opt.code}
            <span class="ge-dialect-code">{opt.code}</span>
          {/if}
        </label>
      {/each}
    {/each}
  </div>

  <div class="ge-block-title">{$t('settings.density')}</div>
  <div style="padding:0 16px;">
    <div class="ge-segs">
      {#each densityOptions as opt}
        <button
          class="ge-seg"
          class:active={$density === opt.value}
          onclick={() => density.set(opt.value)}
        >
          {$t(opt.key)}
        </button>
      {/each}
    </div>
  </div>

  <div class="ge-block-title">{$t('settings.listStyle')}</div>
  <div style="padding:0 16px;">
    <div class="ge-segs">
      {#each listOptions as opt}
        <button
          class="ge-seg"
          class:active={$listStyle === opt.value}
          onclick={() => listStyle.set(opt.value)}
        >
          {$t(opt.key)}
        </button>
      {/each}
    </div>
  </div>

  <div class="ge-block-title">{$t('settings.language')}</div>
  <div style="padding:0 16px;">
    <div class="ge-segs">
      {#each languageOptions as opt}
        <button
          class="ge-seg"
          class:active={$localePreference === opt.value}
          onclick={() => localePreference.set(opt.value)}
        >
          {$t(opt.key)}
        </button>
      {/each}
    </div>
  </div>

  <div class="ge-block-title">{$t('settings.appearance')}</div>
  <div style="padding:0 16px;">
    <div class="ge-segs">
      {#each modeOptions as opt}
        <button
          class="ge-seg"
          class:active={$darkMode === opt.value}
          onclick={() => darkMode.set(opt.value)}
        >
          {$t(opt.key)}
        </button>
      {/each}
    </div>
  </div>

  <div class="ge-block-title">{$t('settings.recentHistory')}</div>
  <div style="padding:0 16px;">
    <div style="display:flex;align-items:center;gap:12px;">
      <input
        type="range"
        min="0"
        max="25"
        value={$recentLimit}
        oninput={(e) => {
          const val = Number((e.target as HTMLInputElement).value);
          recentLimit.set(val);
          if (val === 0) recentEntries.set([]);
          else recentEntries.update(list => list.slice(0, val));
        }}
        style="flex:1;accent-color:var(--accent-deep);"
      />
      <span style="font-size:var(--fs-small);color:var(--fg-muted);min-width:20px;text-align:right;">
        {$recentLimit === 0 ? $t('settings.recentOff') : $recentLimit}
      </span>
    </div>
  </div>

  <div class="ge-block-title">
    <button
      class="diag-toggle"
      onclick={() => { diagExpanded = !diagExpanded; }}
    >
      {$t('settings.diagnostics')}
      <span class="diag-chevron" class:open={diagExpanded}>&#x25B8;</span>
    </button>
  </div>
  {#if diagExpanded}
    <div class="diag-section">
      {#if $diagEntries.length === 0}
        <div class="diag-empty">{$t('settings.diagEmpty')}</div>
      {:else}
        <table class="diag-table">
          <thead>
            <tr>
              <th>{$t('settings.diagStage')}</th>
              <th class="diag-num">{$t('settings.diagDuration')}</th>
              <th class="diag-num">{$t('settings.diagSize')}</th>
            </tr>
          </thead>
          <tbody>
            {#each $diagEntries as entry}
              <tr>
                <td>{entry.label}</td>
                <td class="diag-num">
                  {entry.endMs != null ? `${(entry.endMs - entry.startMs).toFixed(1)} ms` : '\u2026'}
                </td>
                <td class="diag-num">
                  {entry.bytes != null ? fmtBytes(entry.bytes) : '\u2014'}
                </td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>{$t('settings.diagTotal')}</strong></td>
              <td class="diag-num"><strong>{$diagTotalMs.toFixed(1)} ms</strong></td>
              <td class="diag-num"><strong>{$diagTotalBytes > 0 ? fmtBytes($diagTotalBytes) : '\u2014'}</strong></td>
            </tr>
          </tfoot>
        </table>
      {/if}
      <button class="diag-reset" onclick={() => diagReset()}>
        {$t('settings.diagReset')}
      </button>
    </div>
  {/if}

  <div class="ge-block-title" id="license-section">{$t('settings.license')}</div>
  <div style="padding:0 16px 32px;">
    <div class="ge-list">
      <div class="ge-list-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
        <div class="row-main">
          <div class="ge-list-title" style="font-weight:500;">{$t('settings.licenseTitle')}</div>
          <div class="ge-list-subtitle" style="margin-top:4px;">
            {$t('settings.licenseSubtitle')}
          </div>
        </div>
        {#if licenseExpanded}
          <div class="license-detail">
            <p>{$t('settings.licenseEntries')}</p>
            <p>{$t('settings.licenseExamples')}</p>
            <p>{$t('settings.licenseMacbain')}</p>
            <p>{$t('settings.licenseLogainm')}</p>
            <p>{$t('settings.licenseFonts')}</p>
            <p>{$t('settings.licenseShareAlike')}</p>
            <p style="margin-top:8px;font-size:var(--fs-micro);color:var(--fg-soft);">
              {$t('settings.licenseProvenance')}
            </p>
          </div>
        {:else}
          <button
            class="toast-link"
            onclick={() => { licenseExpanded = true; }}
            style="font-size:var(--fs-small);color:var(--link);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;"
          >
            {$t('settings.licenseShowDetails')}
          </button>
        {/if}
      </div>
    </div>

    <label class="ge-dialect-row" style="margin-top:12px;">
      <input
        type="checkbox"
        class="ge-checkbox"
        checked={$showLicenseToast}
        onchange={() => showLicenseToast.update(v => !v)}
      />
      <span class="ge-dialect-label">{$t('settings.showToastOnLaunch')}</span>
    </label>
  </div>
</div>

<style>
  .ge-dialect-section {
    padding: 0 16px;
  }

  .ge-dialect-group-label {
    font-size: var(--fs-small);
    color: var(--fg-muted);
    margin: 12px 0 4px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .ge-dialect-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 0;
    cursor: pointer;
  }

  .ge-dialect-label {
    font-size: var(--fs-body);
    color: var(--fg-default);
  }

  .ge-dialect-code {
    font-size: 10px;
    color: var(--fg-soft);
    letter-spacing: 0.04em;
    margin-left: auto;
  }

  .ge-checkbox {
    appearance: none;
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    border: 1.5px solid var(--srf-rule);
    border-radius: 5px;
    background: var(--srf-card);
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
    transition: background var(--t-fast, 0.15s) ease, border-color var(--t-fast, 0.15s) ease;
  }

  .ge-checkbox:checked {
    background: var(--accent-deep);
    border-color: var(--accent-deep);
  }

  .ge-checkbox:checked::after {
    content: '';
    position: absolute;
    left: 5px;
    top: 2px;
    width: 5px;
    height: 9px;
    border: solid var(--fg-on-brand, #fff);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  .ge-checkbox:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .diag-toggle {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .diag-chevron {
    display: inline-block;
    transition: transform 0.15s ease;
    font-size: 0.8em;
  }

  .diag-chevron.open {
    transform: rotate(90deg);
  }

  .diag-section {
    padding: 0 16px 8px;
  }

  .diag-empty {
    font-size: var(--fs-small);
    color: var(--fg-muted);
    padding: 4px 0;
  }

  .diag-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-small);
    margin-bottom: 8px;
  }

  .diag-table th,
  .diag-table td {
    padding: 3px 6px;
    text-align: left;
    border-bottom: 1px solid var(--srf-rule);
  }

  .diag-table th {
    font-weight: 600;
    color: var(--fg-muted);
  }

  .diag-num {
    text-align: right !important;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .diag-table tfoot td {
    border-top: 2px solid var(--srf-rule);
    border-bottom: none;
  }

  .diag-reset {
    font-size: var(--fs-small);
    padding: 4px 10px;
    border: 1px solid var(--srf-rule);
    border-radius: 4px;
    background: var(--srf-card);
    color: var(--fg-body);
    cursor: pointer;
  }

  .ge-layer-row,
  .ge-suggested-layer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 10px;
    margin-bottom: 4px;
    border-radius: 6px;
    background: var(--srf-card);
    color: var(--fg-body);
    font-size: var(--fs-body);
    transition: border-color 0.15s ease;
  }

  .ge-layer-row {
    border: 1px solid var(--srf-rule);
  }

  .ge-suggested-layer {
    border: 1px dashed var(--srf-rule);
    cursor: pointer;
  }

  .ge-suggested-layer:hover:not(:disabled) {
    border-color: var(--accent-deep);
  }

  .ge-suggested-layer:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .ge-layer-label,
  .ge-suggested-label {
    font-size: var(--fs-small);
  }

  .ge-layer-action {
    background: none;
    border: 0;
    color: var(--fg-soft);
    cursor: pointer;
    padding: 4px;
    display: flex;
  }

  .license-detail {
    font-size: var(--fs-small);
    line-height: 1.5;
    color: var(--fg-default);
    padding: 4px 0;
  }

  .license-detail p {
    margin: 0 0 6px;
  }

  .license-detail strong {
    font-weight: 600;
  }
</style>
