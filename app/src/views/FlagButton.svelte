<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // Reusable top-bar flag glyph: shows/edits notes on ANY resource (entry,
  // example, place). Red disc when the resource has notes. Tap pops a toast to
  // view / add / edit / delete. Writes go through flags-write → v2_emit_overlay
  // (re-emits the note head); localStorage is the editable source of truth.
  import {
    notesFor, addFlag, editFlag, deleteFlag,
    NOTE_TYPES, DEFAULT_NOTE_TYPE,
    type NoteRec, type SubjectKind, type NoteType,
  } from '../lib/flags-write';
  import { t } from '../lib/i18n';

  /** i18n key for a controlled-list value (display only - the stored value is the concept label). */
  function typeKey(nt: NoteType): string {
    return nt === 'Flag for Review' ? 'flag.type.review' : 'flag.type.personal';
  }

  interface Props {
    /** Resource UUID to show/attach flags for. */
    resourceUri: string;
    /** Icon colour when there are NO flags (matches the surrounding bar). */
    tone?: string;
    /** Subject context, denormalized onto new notes for the all-flags page.
     *  Only the KIND is stored as data - the display label is derived from it at
     *  render time (`flag.subject.*`), so notes re-localise instead of freezing
     *  whatever language was active when they were flagged. */
    subjectName?: string;
    subjectKind?: SubjectKind;
  }
  let { resourceUri, tone = 'currentColor', subjectName, subjectKind }: Props = $props();

  let notes = $state<NoteRec[]>([]);
  let open = $state(false);
  let busy = $state(false);
  let draft = $state('');
  let draftType = $state<NoteType>(DEFAULT_NOTE_TYPE);

  function refresh() {
    notes = resourceUri ? notesFor(resourceUri) : [];
  }
  $effect(() => {
    resourceUri; // re-run when the resource changes
    open = false;
    draft = '';
    refresh();
  });

  let hasFlags = $derived(notes.length > 0);

  async function onAdd() {
    const text = draft.trim();
    if (!text || busy || !resourceUri) return;
    busy = true;
    try {
      await addFlag(resourceUri, text, { name: subjectName, kind: subjectKind }, draftType);
      draft = '';
      draftType = DEFAULT_NOTE_TYPE;
      refresh();
    }
    catch (e) { console.warn('[flags] add failed:', e); }
    finally { busy = false; }
  }
  async function onDelete(rid: string) {
    if (busy) return;
    busy = true;
    try { await deleteFlag(rid); refresh(); }
    catch (e) { console.warn('[flags] delete failed:', e); }
    finally { busy = false; }
  }
  async function onEdit(rid: string, text: string) {
    const t = text.trim();
    if (!t || busy) return;
    busy = true;
    try { await editFlag(rid, t); refresh(); }
    catch (e) { console.warn('[flags] edit failed:', e); }
    finally { busy = false; }
  }
</script>

<button
  class="ge-iconbtn ge-flag-btn"
  class:flagged={hasFlags}
  aria-label={$t('flag.title')}
  style="color:{hasFlags ? 'var(--flag-red, #d64b3f)' : tone};"
  onclick={() => (open = !open)}
>
  <svg width="20" height="20" viewBox="0 0 24 24" fill={hasFlags ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 21V4M5 4h11l-2 3.4L16 11H5" />
  </svg>
</button>

{#if open}
  <div class="ge-flag-scrim" onclick={() => (open = false)} role="presentation"></div>
  <div class="ge-flag-pop" role="dialog" aria-label={$t('flag.title')}>
    <div class="ge-flag-pop-head">
      <span>{$t('flag.title')}{#if busy} · …{/if}</span>
      <button class="ge-flag-x" aria-label={$t('flag.close')} onclick={() => (open = false)}>✕</button>
    </div>

    {#each notes as n (n.rid)}
      <div class="ge-flag-item">
        <span
          class="ge-flag-type-chip"
          class:review={(n.noteType ?? DEFAULT_NOTE_TYPE) === 'Flag for Review'}
        >{$t(typeKey(n.noteType ?? DEFAULT_NOTE_TYPE))}</span>
        <input
          class="ge-flag-edit"
          value={n.description}
          disabled={busy}
          onchange={(e) => onEdit(n.rid, (e.currentTarget as HTMLInputElement).value)}
        />
        <button class="ge-flag-del" aria-label={$t('flag.delete')} disabled={busy} onclick={() => onDelete(n.rid)}>✕</button>
      </div>
    {/each}

    <div class="ge-flag-add">
      <select
        class="ge-flag-type-sel"
        bind:value={draftType}
        disabled={busy}
        aria-label={$t('flag.noteType')}
      >
        {#each NOTE_TYPES as nt}
          <option value={nt}>{$t(typeKey(nt))}</option>
        {/each}
      </select>
      <div class="ge-flag-add-row">
        <input
          class="ge-flag-edit"
          bind:value={draft}
          placeholder={$t('flag.addNote')}
          disabled={busy}
          onkeydown={(e) => { if (e.key === 'Enter') onAdd(); }}
        />
        <button class="ge-flag-addbtn" disabled={busy || !draft.trim()} onclick={onAdd} aria-label={$t('flag.add')}>+</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* White disc behind the flag when the resource is flagged - reads as a badge. */
  .ge-flag-btn { position: relative; }
  .ge-flag-btn.flagged::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 26px;
    height: 26px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }
  .ge-flag-btn svg { position: relative; z-index: 1; }

  /* Dimmed, slightly-blurred backdrop so the popup reads clearly over ANY
     scrolled content behind it (the card alone washed out against light bg). */
  .ge-flag-scrim {
    position: fixed; inset: 0; z-index: 60;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(1.5px);
  }
  .ge-flag-pop {
    position: fixed; left: 12px; right: 12px; bottom: 16px; z-index: 61;
    background: var(--srf-card, #fffefb); color: var(--fg-default);
    border: 1px solid var(--line, #e0ddce);
    border-top: 3px solid var(--teal-deep, #334b4e);
    border-radius: 14px; padding: 14px 16px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.38);
    max-height: 55vh; overflow-y: auto;
  }
  .ge-flag-pop-head {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--fg-soft); margin-bottom: 8px;
  }
  .ge-flag-x { border: 0; background: transparent; color: var(--fg-soft); font-size: 15px; cursor: pointer; }
  .ge-flag-item { display: flex; gap: 8px; align-items: center; padding: 5px 0; }
  /* Controlled-list badge per note: teal for a personal note, red for a review flag. */
  .ge-flag-type-chip {
    flex-shrink: 0; font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; white-space: nowrap;
    padding: 2px 7px; border-radius: 999px;
    background: rgba(51, 75, 78, 0.12); color: var(--teal-deep, #334b4e);
  }
  .ge-flag-type-chip.review {
    background: rgba(214, 75, 63, 0.14); color: var(--flag-red, #d64b3f);
  }
  .ge-flag-edit {
    flex: 1; min-width: 0; font: inherit; font-size: 15px;
    border: 0; border-bottom: 1px solid var(--line, #e0ddce); background: transparent;
    color: var(--fg-default); padding: 4px 2px;
  }
  .ge-flag-edit:disabled { opacity: 0.6; }
  .ge-flag-del {
    border: 0; background: transparent; color: var(--fg-soft); cursor: pointer;
    font-size: 13px; padding: 4px; flex-shrink: 0;
  }
  .ge-flag-add { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line, #e0ddce); }
  .ge-flag-add-row { display: flex; gap: 8px; align-items: center; }
  .ge-flag-type-sel {
    font: inherit; font-size: 13px; align-self: flex-start;
    padding: 4px 8px; border-radius: 8px;
    border: 1px solid var(--line, #e0ddce);
    background: var(--srf-card, #fffefb); color: var(--fg-default);
  }
  .ge-flag-type-sel:disabled { opacity: 0.6; }
  .ge-flag-addbtn {
    border: 0; border-radius: 8px; cursor: pointer; flex-shrink: 0;
    width: 30px; height: 30px; font-size: 20px; line-height: 1;
    background: var(--teal-deep, #334b4e); color: var(--cream, #f6f4eb);
  }
  .ge-flag-addbtn:disabled { opacity: 0.4; }
</style>
