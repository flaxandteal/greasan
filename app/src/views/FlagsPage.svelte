<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // All-flags page: every note as a card (subject name + graph as heading, note
  // text as body). Tap a card → open the flagged resource; pen edits, bin deletes.
  import { overlayView, currentEntry, currentExample, loading } from '../lib/store';
  import { loadNotes, editFlag, deleteFlag, exportBusinessData, type NoteRec } from '../lib/flags-write';
  import { loadEntryFlagged, loadExample } from '../lib/dictionary';
  import { t } from '../lib/i18n';
  import { save } from '@tauri-apps/plugin-dialog';
  import { writeTextFile } from '@tauri-apps/plugin-fs';


  let notes = $state<NoteRec[]>(loadNotes());
  let busy = $state(false);
  let editingRid = $state<string | null>(null);
  let editText = $state('');

  function refresh() { notes = loadNotes(); }
  function goBack() { overlayView.set(null); }

  async function openSubject(n: NoteRec) {
    const uri = n.subject[0];
    if (!uri || busy) return;
    if (n.subjectKind === 'entry') {
      loading.set(true);
      try {
        const e = await loadEntryFlagged(uri, n.subjectName || '');
        if (e) { overlayView.set(null); currentEntry.set(e); }
      } finally { loading.set(false); }
    } else if (n.subjectKind === 'example') {
      loading.set(true);
      try {
        const ex = await loadExample(uri);
        if (ex) { overlayView.set(null); currentExample.set(ex); }
      } finally { loading.set(false); }
    }
    // 'place' has no standalone detail page — no navigation.
  }

  function startEdit(n: NoteRec) { editingRid = n.rid; editText = n.description; }
  async function saveEdit(rid: string) {
    const t = editText.trim();
    if (!t || busy) return;
    busy = true;
    try { await editFlag(rid, t); editingRid = null; refresh(); }
    catch (e) { console.warn('[flags] edit failed:', e); }
    finally { busy = false; }
  }
  async function onDelete(rid: string) {
    if (busy) return;
    busy = true;
    try { await deleteFlag(rid); if (editingRid === rid) editingRid = null; refresh(); }
    catch (e) { console.warn('[flags] delete failed:', e); }
    finally { busy = false; }
  }

  async function onExport() {
    if (busy || notes.length === 0) return;
    try {
      const json = exportBusinessData();
      const path = await save({
        defaultPath: 'greasan-flags.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (path) await writeTextFile(path, json);
    } catch (e) { console.warn('[flags] export failed:', e); }
  }
</script>

<div class="ge-page">
  <div class="ge-navbar">
    <div class="ge-navbar-side">
      <button class="ge-back" onclick={goBack} aria-label={$t('nav.back')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        {$t('nav.search')}
      </button>
    </div>
    <div class="ge-navbar-title">{$t('flag.title')}</div>
    <div class="ge-navbar-side right">
      <button class="ge-iconbtn" aria-label={$t('flag.export')} onclick={onExport} disabled={busy || notes.length === 0}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
      </button>
    </div>
  </div>

  <div class="ge-flags-body">
    {#if notes.length === 0}
      <div class="ge-flags-empty">{$t('flag.empty')}</div>
    {:else}
      {#each notes as n (n.rid)}
        <div class="ge-flag-card" class:busy>
          <button class="ge-flag-card-main" onclick={() => openSubject(n)} disabled={busy || editingRid === n.rid}>
            <div class="ge-flag-card-head">
              <span class="ge-flag-card-name">{n.subjectName || '—'}</span>
              {#if n.subjectKind}<span class="ge-flag-card-graph">{$t(`flag.subject.${n.subjectKind}`)}</span>{:else if n.subjectGraph}<span class="ge-flag-card-graph">{n.subjectGraph}</span>{/if}
            </div>
            {#if editingRid === n.rid}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <input
                class="ge-flag-card-edit"
                bind:value={editText}
                disabled={busy}
                onclick={(e) => e.stopPropagation()}
                onkeydown={(e) => { if (e.key === 'Enter') saveEdit(n.rid); }}
              />
            {:else}
              <div class="ge-flag-card-body">{n.description}</div>
            {/if}
          </button>
          <div class="ge-flag-card-actions">
            {#if editingRid === n.rid}
              <button class="ge-flag-act" onclick={() => saveEdit(n.rid)} disabled={busy} aria-label={$t('flag.save')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
              </button>
            {:else}
              <button class="ge-flag-act" onclick={() => startEdit(n)} disabled={busy} aria-label={$t('flag.edit')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
              </button>
            {/if}
            <button class="ge-flag-act del" onclick={() => onDelete(n.rid)} disabled={busy} aria-label={$t('flag.delete')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .ge-flags-body { padding: 10px 16px 40px; display: flex; flex-direction: column; gap: 10px; }
  .ge-flags-empty { color: var(--fg-soft); font-size: 15px; text-align: center; padding: 40px 0; }
  .ge-flag-card {
    display: flex; align-items: stretch; gap: 4px;
    background: var(--srf-card, #fffefb); border: 1px solid var(--line, #e0ddce);
    border-radius: 12px; overflow: hidden;
  }
  .ge-flag-card.busy { opacity: 0.6; }
  .ge-flag-card-main {
    flex: 1; min-width: 0; text-align: left; border: 0; background: transparent;
    color: inherit; font: inherit; cursor: pointer; padding: 12px 14px;
  }
  .ge-flag-card-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .ge-flag-card-name { font-size: 17px; font-weight: 700; color: var(--fg-strong, var(--fg-default)); }
  .ge-flag-card-graph {
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--teal-deep, #334b4e); background: color-mix(in srgb, var(--teal-deep, #334b4e) 12%, transparent);
    padding: 1px 7px; border-radius: 8px;
  }
  .ge-flag-card-body { font-size: 15px; line-height: 1.4; color: var(--fg-default); }
  .ge-flag-card-edit {
    width: 100%; font: inherit; font-size: 15px; border: 0;
    border-bottom: 1px solid var(--teal-deep, #334b4e); background: transparent;
    color: var(--fg-default); padding: 2px 0;
  }
  .ge-flag-card-actions { display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 6px 8px; }
  .ge-flag-act {
    border: 0; background: transparent; color: var(--fg-soft); cursor: pointer;
    padding: 6px; display: inline-flex; border-radius: 8px;
  }
  .ge-flag-act:active { background: color-mix(in srgb, var(--fg-soft) 14%, transparent); }
  .ge-flag-act.del { color: var(--flag-red, #d64b3f); }
  .ge-flag-act:disabled { opacity: 0.4; }
</style>
