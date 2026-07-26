<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // Trigger for the layer sheet: swatch dots plus an active count. Renders
  // nothing when there is one layer or none — with a single source there is no
  // stack to reason about, and an always-present control would be clutter for
  // the majority case.
  import { layerStack, layerSheetOpen } from '../lib/store';
  import { t } from '../lib/i18n';

  /** Inherit the surrounding text colour (the entry hero is cream on teal). */
  let { tone = 'currentColor' }: { tone?: string } = $props();

  let visible = $derived($layerStack.filter(l => l.visible).length);
  let total = $derived($layerStack.length);
</script>

{#if total > 1}
  <button
    class="pill"
    style="color:{tone};"
    aria-label={$t('layers.aria')}
    title={$t('layers.title')}
    onclick={() => layerSheetOpen.set(true)}
  >
    <span class="dots" aria-hidden="true">
      {#each $layerStack as l (l.name)}
        <span class="dot" class:off={!l.visible} style="background:{l.swatch}"></span>
      {/each}
    </span>
    <span class="count">{visible}/{total}</span>
  </button>
{/if}

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 0;
    border-radius: var(--pill-radius);
    padding: 4px 6px;
    cursor: pointer;
    font: inherit;
  }

  .dots {
    display: inline-flex;
    gap: 2px;
  }

  /* Stacked bars, not bullets — reads as strata rather than a status light. */
  .dot {
    width: 3px;
    height: 12px;
    border-radius: 1.5px;
  }

  .dot.off {
    background: currentColor !important;
    opacity: 0.25;
  }

  .count {
    font-size: var(--fs-micro);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    opacity: 0.72;
  }
</style>
