import { writable, derived } from 'svelte/store';

export interface DiagEntry {
  id: number;
  label: string;
  startMs: number;
  endMs?: number;
  bytes?: number;
}

let nextId = 0;

export const diagEntries = writable<DiagEntry[]>([]);

/** Start timing a labelled stage. Returns an ID to pass to diagEnd. */
export function diagStart(label: string): number {
  const id = nextId++;
  const entry: DiagEntry = { id, label, startMs: performance.now() };
  diagEntries.update(entries => [...entries, entry]);
  return id;
}

/** End timing for a previously started stage. Optionally record byte count. */
export function diagEnd(id: number, bytes?: number): void {
  diagEntries.update(entries =>
    entries.map(e => e.id === id ? { ...e, endMs: performance.now(), bytes } : e),
  );
}

/** Clear all diagnostic entries. */
export function diagReset(): void {
  diagEntries.set([]);
}

/** Total duration of all completed entries. */
export const diagTotalMs = derived(diagEntries, $entries => {
  const completed = $entries.filter(e => e.endMs != null);
  if (completed.length === 0) return 0;
  const earliest = Math.min(...completed.map(e => e.startMs));
  const latest = Math.max(...completed.map(e => e.endMs!));
  return latest - earliest;
});

/** Total bytes across all entries that recorded a size. */
export const diagTotalBytes = derived(diagEntries, $entries =>
  $entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0),
);
