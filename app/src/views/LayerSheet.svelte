<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // Layer visibility sheet - a map layer control, minus the map.
  //
  // The stack genuinely behaves like map draw order (ordered composition,
  // topmost-wins per nodegroup, an unhideable basemap), so it borrows the
  // widget grammar: swatch, eye toggle, base pinned at the bottom. It does NOT
  // borrow anything spatial - opacity and blending mean nothing when layers
  // merge into one entry rather than tiling a plane, and the app's genuinely
  // geographic axis is dialect, not source.
  import { layerStack, toggleLayerVisibility, layerSheetOpen, currentEntry, activeTab, currentLayer, layerCatalogue } from '../lib/store';
  import { layerCoverage } from '../lib/dictionary';
  import { loadLayerBySlug } from '../lib/layers-catalogue';
  import { t } from '../lib/i18n';

  // Primary tag per layer (registry name/slug → the layer's first layer_type, its
  // primary classifier) from the shared layer-v2 catalogue store, used to group
  // the tray. Rows fall under "Other" only if the catalogue doesn't cover them.
  let primaryType = $derived.by(() => {
    const m: Record<string, string> = {};
    for (const e of $layerCatalogue) {
      const key = e.slug || e.integrationSlug;
      if (key && e.types.length) m[key] = e.types[0];
    }
    return m;
  });

  /** Tap a layer's label → its full description page (from the catalogue). */
  async function openDetail(name: string) {
    const l = await loadLayerBySlug(name);
    if (l) { layerSheetOpen.set(false); currentLayer.set(l); }
  }

  // Coverage-at-cursor: which layers actually carry the open entry. Null when
  // no entry is open (nothing to be covered) or the lookup failed - in both
  // cases rows render without a coverage claim rather than a wrong one.
  let coverage = $state<Set<string> | null>(null);

  $effect(() => {
    const uri = $currentEntry?.uri;
    if (!$layerSheetOpen || !uri) {
      coverage = null;
      return;
    }
    let stale = false;
    layerCoverage(uri)
      .then(c => { if (!stale) coverage = c; })
      .catch(() => { if (!stale) coverage = null; });
    return () => { stale = true; };
  });

  function close() {
    layerSheetOpen.set(false);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  // Overlays above, base below - the stack reads bottom-up, as a stack should.
  let rows = $derived([...$layerStack].reverse());

  // Group rows by primary tag, preserving stack order (group order = first
  // appearance). Unmatched layers (e.g. a not-yet-reinstalled TBX) fall under
  // "Other"; the base map keeps its own "Basemap" group at the bottom.
  let groups = $derived.by(() => {
    const order: string[] = [];
    const byType = new Map<string, typeof rows>();
    for (const l of rows) {
      const type = primaryType[l.name] || (l.base ? 'Basemap' : 'Other');
      if (!byType.has(type)) { byType.set(type, []); order.push(type); }
      byType.get(type)!.push(l);
    }
    return order.map((type) => ({ type, layers: byType.get(type)! }));
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if $layerSheetOpen}
  <!-- Backdrop closes only on a direct hit, so the sheet needs no click
       handler of its own (and thus no non-interactive click a11y hole). -->
  <div
    class="sheet-backdrop"
    onclick={(e) => { if (e.target === e.currentTarget) close(); }}
    role="presentation"
  >
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={$t('layers.aria')}
      tabindex="-1"
      {@attach (el) => { el.focus(); }}
    >
      <div class="grabber"></div>
      <div class="sheet-title">{$t('layers.title')}</div>

      {#each groups as g (g.type)}
      <div class="group-title">{g.type}</div>
      {#each g.layers as l (l.name)}
        {@const absent = coverage !== null && !coverage.has(l.name)}
        <div class="row" class:off={!l.visible}>
          <button class="row-open" onclick={() => openDetail(l.name)}>
            <span class="swatch" style="background:{l.swatch}"></span>
            <span class="row-body">
              <span class="row-label">{l.label}</span>
              {#if l.base}
                <span class="row-sub">{$t('layers.base')}</span>
              {:else if absent}
                <span class="row-sub absent">{$t('layers.noEntry')}</span>
              {/if}
            </span>
          </button>
          <button
            class="eye-btn"
            disabled={l.base}
            aria-pressed={l.visible}
            aria-label={$t('layers.aria')}
            onclick={() => toggleLayerVisibility(l.name)}
          >
            <span class="eye" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
                <circle cx="12" cy="12" r="3"/>
                {#if !l.visible}<path d="M3 3l18 18"/>{/if}
              </svg>
            </span>
          </button>
        </div>
      {/each}
      {/each}

      <div class="sheet-foot">
        <span class="foot-note">{$t('layers.hint')}</span>
        <button
          class="foot-link"
          onclick={() => { close(); currentEntry.set(null); activeTab.set('settings'); }}
        >{$t('layers.manage')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9998;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(12, 9, 16, 0.28);
    animation: fadeIn var(--t-base) var(--ease);
  }

  .sheet {
    width: 100%;
    max-width: 480px;
    background: var(--srf-card);
    color: var(--fg-default);
    border-radius: 16px 16px 0 0;
    padding: 8px 8px calc(12px + env(safe-area-inset-bottom, 0px));
    box-shadow: var(--shadow-pop);
    animation: slideUp 0.32s cubic-bezier(0.22, 1, 0.36, 1);
  }

  /* Focused on open so Escape and screen readers land here - but it is a
     container, not a control, so it should not draw a ring. */
  .sheet:focus { outline: none; }

  .grabber {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--srf-rule);
    margin: 4px auto 10px;
  }

  .sheet-title {
    font-size: var(--fs-eyebrow);
    font-weight: 700;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--fg-muted);
    padding: 0 12px 6px;
  }

  .group-title {
    font-size: var(--fs-small);
    font-weight: 600;
    color: var(--fg-soft);
    padding: 10px 12px 4px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    background: transparent;
    border: 0;
    border-radius: 10px;
    padding: 10px 12px;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
    transition: opacity var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
  }

  .row:hover:not(:disabled) { background: var(--srf-card-alt); }
  .row:disabled { cursor: default; }
  .row-open {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px;
    background: transparent; border: 0; padding: 0; margin: 0;
    font: inherit; color: inherit; text-align: left; cursor: pointer;
  }
  .eye-btn {
    background: transparent; border: 0; padding: 4px; margin: 0;
    color: inherit; cursor: pointer; display: inline-flex; flex-shrink: 0;
  }
  .eye-btn:disabled { cursor: default; opacity: 0.6; }

  /* Hidden: the whole row recedes and the swatch drains. Distinct from
     `.absent`, which dims nothing - "off" and "nothing here" must not look
     alike, or the coverage readout teaches the wrong thing. */
  .row.off { opacity: 0.45; }
  .row.off .swatch { background: var(--fg-soft) !important; }

  .swatch {
    flex-shrink: 0;
    width: 4px;
    height: 26px;
    border-radius: 2px;
  }

  .row-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .row-label {
    font-size: var(--fs-small);
    font-weight: 600;
    color: var(--fg-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-sub {
    font-size: var(--fs-micro);
    color: var(--fg-soft);
  }

  .row-sub.absent { font-style: italic; }

  .eye {
    flex-shrink: 0;
    display: flex;
    color: var(--fg-muted);
  }

  .row:disabled .eye { opacity: 0.25; }

  .sheet-foot {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px 2px;
    margin-top: 4px;
    border-top: 1px solid var(--srf-divider);
  }

  .foot-note {
    font-size: var(--fs-micro);
    color: var(--fg-soft);
    line-height: 1.35;
  }

  .foot-link {
    flex-shrink: 0;
    background: none;
    border: 0;
    padding: 0;
    font-size: var(--fs-micro);
    font-weight: 600;
    color: var(--link);
    text-decoration: underline;
    cursor: pointer;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes slideUp {
    from { transform: translateY(24px); }
    to { transform: translateY(0); }
  }
</style>
