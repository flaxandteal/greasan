import { writable, readable } from 'svelte/store';
import { ready } from './wasm';

export const searchQuery = writable('');
export const searchResults = writable<Array<{ uri: string; headword: string; pos: string }>>([]);
export const currentEntry = writable<any | null>(null);
export const loading = writable(false);

export const wasmReady = readable(false, (set) => {
  ready.then(() => set(true)).catch(() => set(false));
});
