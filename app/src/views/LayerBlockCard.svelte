<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // Block card for a Layer — the richer, multi-line presentation used where a
  // layer is browsed / installed (Settings), between the single-line toggle row
  // (LayerSheet) and the full description page (LayerDetail). Tapping it opens
  // the description page; an optional trailing action (e.g. remove) is separate.
  import { currentLayer } from '../lib/store';
  import type { LayerEntry } from '../lib/layers-catalogue';

  let { layer, actionLabel, actionText, onAction, toggle, toggled, onToggle, disabled, onRemove, removeLabel }: {
    layer: LayerEntry;
    /** Icon-button (X) action, e.g. remove. */
    actionLabel?: string;
    /** Labelled action instead of the X — e.g. "Install" / "Build". */
    actionText?: string;
    onAction?: () => void;
    /** Render a visibility toggle (installed layers) instead of an action. */
    toggle?: boolean;
    toggled?: boolean;
    onToggle?: () => void;
    disabled?: boolean;
    /** Uninstall (delete from device). Rendered as a trash icon beside the toggle. */
    onRemove?: () => void;
    removeLabel?: string;
  } = $props();

  function openDetail() { currentLayer.set(layer); }
  function num(s: string): string { const n = Number(s); return Number.isFinite(n) && s ? n.toLocaleString() : ''; }
</script>

<div class="ge-layer-block">
  <button class="ge-layer-block-main" onclick={openDetail}>
    <div class="ge-layer-block-head">
      <span class="ge-layer-block-swatch" style="background:{layer.swatch || 'var(--layer-default)'}"></span>
      <span class="ge-layer-block-name">{layer.name}</span>
    </div>
    {#if layer.types.length}
      <div class="ge-layer-block-types">{layer.types.join(' · ')}</div>
    {/if}
    {#if layer.description}
      <div class="ge-layer-block-desc">{layer.description}</div>
    {/if}
    <div class="ge-layer-block-meta">
      {#if layer.licence}<span class="ge-layer-block-lic">{layer.licence}</span>{/if}
      {#if num(layer.resourceCount)}<span class="ge-layer-block-count">{num(layer.resourceCount)}</span>{/if}
    </div>
  </button>
  {#if toggle}
    {#if onRemove}
      <button class="ge-layer-block-remove" onclick={onRemove} aria-label={removeLabel} title={removeLabel}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
    {/if}
    <button class="ge-layer-block-toggle" class:on={toggled} onclick={onToggle} aria-label={actionLabel}><span></span></button>
  {:else if actionText}
    <button class="ge-layer-block-textaction" onclick={onAction} disabled={disabled}>{actionText}</button>
  {:else if onAction}
    <button class="ge-layer-block-action" onclick={onAction} aria-label={actionLabel}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  {/if}
</div>

<style>
  .ge-layer-block {
    display: flex; align-items: stretch; gap: 4px; margin-bottom: 8px;
    background: var(--srf-card, #fffefb); border: 1px solid var(--line, var(--srf-rule));
    border-radius: 12px; overflow: hidden;
  }
  .ge-layer-block-main {
    flex: 1; min-width: 0; text-align: left; border: 0; background: transparent;
    color: inherit; font: inherit; cursor: pointer; padding: 12px 14px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .ge-layer-block-head { display: flex; align-items: center; gap: 9px; }
  .ge-layer-block-swatch { width: 12px; height: 12px; border-radius: 4px; flex-shrink: 0; }
  .ge-layer-block-name { font-size: 17px; font-weight: 700; color: var(--fg-strong, var(--fg-default)); }
  .ge-layer-block-types {
    font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--teal-mid, #4B7A81);
  }
  .ge-layer-block-desc { font-size: 14px; line-height: 1.4; color: var(--fg-muted); }
  .ge-layer-block-meta { display: flex; gap: 8px; align-items: baseline; margin-top: 2px; flex-wrap: wrap; }
  .ge-layer-block-lic {
    font-size: 11px; font-weight: 600; color: var(--teal-deep, #334b4e);
    background: color-mix(in srgb, var(--teal-deep, #334b4e) 12%, transparent);
    padding: 1px 7px; border-radius: 8px;
  }
  .ge-layer-block-count { font-size: 12px; color: var(--fg-soft); }
  .ge-layer-block-count::after { content: ' · resources'; }
  .ge-layer-block-action {
    border: 0; background: transparent; color: var(--fg-soft); cursor: pointer;
    padding: 0 12px; display: inline-flex; align-items: center;
  }
  .ge-layer-block-action:active { background: color-mix(in srgb, var(--fg-soft) 14%, transparent); }
  .ge-layer-block-remove {
    align-self: center; border: 0; background: transparent; color: var(--fg-soft);
    cursor: pointer; padding: 0 8px; display: inline-flex; align-items: center;
  }
  .ge-layer-block-remove:active { color: var(--danger, #b0463c); }
  .ge-layer-block-textaction {
    align-self: center; margin-right: 12px; border: 0; background: transparent;
    color: var(--accent-deep, var(--accent)); font-weight: 700; font-size: 14px;
    cursor: pointer; padding: 6px 4px; white-space: nowrap;
  }
  .ge-layer-block-textaction:disabled { opacity: .45; cursor: default; }
  .ge-layer-block-toggle {
    align-self: center; margin-right: 14px; width: 38px; height: 22px; border: 0;
    border-radius: 999px; background: var(--srf-rule); position: relative; cursor: pointer;
    flex-shrink: 0; transition: background .15s;
  }
  .ge-layer-block-toggle.on { background: var(--ok, #4f8a5f); }
  .ge-layer-block-toggle > span {
    position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
    border-radius: 50%; background: #fff; transition: transform .15s;
  }
  .ge-layer-block-toggle.on > span { transform: translateX(16px); }
</style>
