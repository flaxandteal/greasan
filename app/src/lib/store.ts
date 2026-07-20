import { writable, derived, readable, get, type Writable } from 'svelte/store';
import { ready } from './wasm';
import { FAMILIES, DEFAULT_FAMILY, type FamilyId } from './family';
import { switchFamily, addDynamicLayer, removeDynamicLayer, getDynamicLayers, registerV2Layers, initOfflineLayers, USE_V2, type DynamicLayerInfo, type ExampleDetail } from './dictionary';
import { buildLayer, waitForBuild, listLayers, assetUrl, removeLayerFiles, type BuildLayerStatus } from './tauri-builder';
import type { SearchLang } from './dictionary';

export type { DynamicLayerInfo } from './dictionary';

/** Writable store backed by localStorage. */
function persisted<T>(key: string, initial: T): Writable<T> {
  let value = initial;
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) value = JSON.parse(raw);
    } catch { /* corrupt data — use default */ }
  }
  const store = writable<T>(value);
  store.subscribe(v => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(v));
    }
  });
  return store;
}

export const searchQuery = writable('');
export const searchLang = persisted<SearchLang>('ge:searchLang', 'ga');
export const searchResults = writable<Array<{ uri: string; headword: string; pos: string; gloss?: string }>>([]);
export const currentEntry = writable<any | null>(null);
export const currentExample = writable<ExampleDetail | null>(null);
export const loading = writable(false);

export const wasmReady = readable(false, (set) => {
  ready.then(() => set(true)).catch(() => set(false));
});

export const activeTab = writable<'search' | 'starred' | 'settings'>('search');
export const overlayView = writable<'faq' | null>(null);
export const showLicenseToast = persisted<boolean>('ge:showLicenseToast', true);
export const darkMode = persisted<'light' | 'dark'>('ge:darkMode', 'light');
export const density = persisted<'compact' | 'comfortable' | 'spacious'>('ge:density', 'comfortable');
export const listStyle = persisted<'card' | 'flat'>('ge:listStyle', 'card');
export const recentLimit = persisted<number>('ge:recentLimit', 10);

export interface RecentEntry {
  uri: string;
  headword: string;
  pos: string;
  gloss?: string;
}

export const recentEntries = persisted<RecentEntry[]>('ge:recentEntries', []);

/** Push an entry to the front of the recent list, deduplicating by URI. */
export function pushRecent(entry: RecentEntry): void {
  const limit = get(recentLimit);
  if (limit <= 0) return;
  recentEntries.update(list => {
    const filtered = list.filter(e => e.uri !== entry.uri);
    return [entry, ...filtered].slice(0, limit);
  });
}

export interface StarredEntry {
  uri: string;
  headword: string;
  pos: string;
  gloss?: string;
}

export const starredEntries = persisted<StarredEntry[]>('ge:starredEntries', []);

export function toggleStar(entry: StarredEntry): boolean {
  const current = get(starredEntries);
  const exists = current.some(e => e.uri === entry.uri);
  if (exists) {
    starredEntries.set(current.filter(e => e.uri !== entry.uri));
    return false;
  } else {
    starredEntries.set([entry, ...current]);
    return true;
  }
}

export function isStarred(uri: string): boolean {
  return get(starredEntries).some(e => e.uri === uri);
}

export const activeFamily = persisted<FamilyId>('ge:activeFamily', DEFAULT_FAMILY);
export const familyConfig = derived(activeFamily, $f => FAMILIES[$f]);

export const visibleDialects = persisted<string[]>('ge:visibleDialects', FAMILIES[DEFAULT_FAMILY].defaultDialects);

// Migrate old label-based dialect values to codes (one-time)
{
  const current = get(visibleDialects);
  if (current.length > 0 && current.some(d => d.includes(' '))) {
    // Old format used labels like "Irish (General)" — reset to code-based defaults
    const family = get(activeFamily);
    visibleDialects.set(FAMILIES[family]?.defaultDialects ?? FAMILIES[DEFAULT_FAMILY].defaultDialects);
  }
}

// Sync dictionary module with persisted family on startup (teardown is a no-op here)
{
  const restored = get(activeFamily);
  if (restored !== DEFAULT_FAMILY && FAMILIES[restored]) {
    switchFamily(restored);
  }
}

// In production Tauri builds (tauri.localhost), serve from zip via custom protocols.
// In dev mode (localhost:5173), custom protocols don't work in WebKitGTK —
// fall back to asset protocol (files extracted to disk by the builder).
const useTauriProtocols = typeof window !== 'undefined' && window.location.hostname === 'tauri.localhost';

function layerBaseUrl(name: string, nativePath: string): string {
  return useTauriProtocols
    ? `http://rmindex.localhost/${encodeURIComponent(name)}/`
    : assetUrl(nativePath) + '/';
}

function layerPfBase(name: string): string | undefined {
  // pfzip only works via Tauri custom protocol; on desktop dev mode, pagefind
  // dirs are extracted by the builder and served via asset protocol (same baseUrl).
  return useTauriProtocols
    ? `http://pfzip.localhost/${encodeURIComponent(name)}/`
    : undefined; // caller uses baseUrl as pagefindBase
}

// Reactive list of dynamic layers — updated after add/remove operations
export const layers = writable<readonly DynamicLayerInfo[]>([]);

// Build progress for the currently building layer (null when idle)
export const buildProgress = writable<BuildLayerStatus | null>(null);

// True while first-run offline setup (unpacking bundled heads + Pagefind zips
// into app-data) runs. Drives the "preparing dictionary" UI on first launch.
export const preparingDictionary = writable<boolean>(false);

export function setActiveFamily(familyId: FamilyId): void {
  activeFamily.set(familyId);
  visibleDialects.set(FAMILIES[familyId].defaultDialects);
  searchQuery.set('');
  searchResults.set([]);
  currentEntry.set(null);
  searchLang.set(FAMILIES[familyId].searchLangs[0]?.id ?? 'en');
  switchFamily(familyId);
  layers.set(getDynamicLayers());
}

/**
 * Import a layer via the Tauri builder: fetch source, build index, add to store.
 * Progress is exposed via the buildProgress store.
 */
export async function importLayer(sourceUrl: string, name: string, format = 'prebuild'): Promise<void> {
  buildProgress.set({ state: 'pending', progress: 0, error: null, output_path: null });

  const { layer_id } = await buildLayer({ sourceUrl, format, layerName: name });

  const finalStatus = await waitForBuild(layer_id, (status) => {
    buildProgress.set(status);
  });

  if (finalStatus.state === 'failed') {
    buildProgress.set(finalStatus);
    throw new Error(finalStatus.error || 'Build failed');
  }

  const outputPath = finalStatus.output_path!;
  const baseUrl = layerBaseUrl(name, outputPath);
  await addDynamicLayer(baseUrl, name);
  layers.set(getDynamicLayers());

  buildProgress.set(null);
}

/**
 * Install a pre-built layer package from a URL (format: "built").
 * Downloads tar.gz, extracts directly — no on-device build_to_memory.
 */
export async function installPackage(url: string, name: string): Promise<void> {
  buildProgress.set({ state: 'pending', progress: 0, error: null, output_path: null });

  const { layer_id } = await buildLayer({ sourceUrl: url, format: 'built', layerName: name });

  const finalStatus = await waitForBuild(layer_id, (status) => {
    buildProgress.set(status);
  });

  if (finalStatus.state === 'failed') {
    buildProgress.set(finalStatus);
    throw new Error(finalStatus.error || 'Install failed');
  }

  const outputPath = finalStatus.output_path!;
  const baseUrl = layerBaseUrl(name, outputPath);

  // Check if layer has pagefind indices
  let pagefindBase: string | undefined;
  try {
    const existing = await listLayers();
    const info = existing.find(l => l.output_path === outputPath);
    if (info?.has_pagefind) {
      pagefindBase = layerPfBase(name) ?? baseUrl;
    }
  } catch { /* no pagefind */ }

  await addDynamicLayer(baseUrl, name, pagefindBase);
  layers.set(getDynamicLayers());

  buildProgress.set(null);
}

/** Add a layer directly by URL (already-built index served over HTTP). */
export async function addLayerDirect(baseUrl: string, name: string, pagefindBase?: string): Promise<void> {
  await addDynamicLayer(baseUrl, name, pagefindBase);
  layers.set(getDynamicLayers());
}

export async function removeLayer(name: string): Promise<void> {
  await removeDynamicLayer(name);
  // Clean up files from disk
  try {
    await removeLayerFiles(name);
  } catch (err) {
    console.warn(`[store] removeLayerFiles "${name}" failed:`, err);
  }
  layers.set(getDynamicLayers());
}

/**
 * Startup layer bootstrap. In v2 mode, register the v2 heads as installed
 * layers (name + pagefind base) via `registerV2Layers` — no v1 SparqlStore —
 * which clears the "install a layer" empty state and enables Pagefind search;
 * detail hydrate then uses `V2_HEAD_DIRS` natively. In v1 mode, fall back to the
 * disk-restore path. Gated entirely by `USE_V2`; v1 behaviour is unchanged.
 */
export async function bootstrapLayers(): Promise<void> {
  if (USE_V2) {
    // Built app: unpack bundled heads + Pagefind zips into app-data on first
    // launch, then point the active layer set at those real paths. No-op in dev.
    try {
      preparingDictionary.set(true);
      await initOfflineLayers();
    } catch (err) {
      console.error('[store] offline layer prep failed:', err);
    } finally {
      preparingDictionary.set(false);
    }
    registerV2Layers();
    layers.set(getDynamicLayers());
    return;
  }
  await restoreLayers();
}

/** Restore previously-built layers from disk on app startup. */
export async function restoreLayers(): Promise<void> {
  try {
    const existing = await listLayers();
    for (const layer of existing) {
      const baseUrl = layerBaseUrl(layer.layer_id, layer.output_path);
      let pagefindBase: string | undefined;
      if (layer.has_pagefind) {
        pagefindBase = layerPfBase(layer.layer_id) ?? baseUrl;
      }
      try {
        await addDynamicLayer(baseUrl, layer.layer_id, pagefindBase);
      } catch (err) {
        console.warn(`[store] restoreLayer "${layer.layer_id}" failed:`, err);
      }
    }
    layers.set(getDynamicLayers());
  } catch (err) {
    console.warn('[store] restoreLayers failed:', err);
  }
}
