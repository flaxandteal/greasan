import { writable, derived, readable, get, type Writable } from 'svelte/store';
import { listen } from '@tauri-apps/api/event';
import { ready } from './wasm';
import { FAMILIES, DEFAULT_FAMILY, layerSwatch, type FamilyId } from './family';
import { switchFamily, addDynamicLayer, addV2Layer, removeV2Layer, getDynamicLayers, registerV2Layers, initOfflineLayers, setHiddenLayers, search, loadEntryFlagged, currentV2HeadDirs, warmClosure, type DynamicLayerInfo, type ExampleDetail } from './dictionary';
import { buildLayer, waitForBuild, listLayers, listV2Layers, assetUrl, removeLayerFiles, type BuildLayerStatus } from './tauri-builder';
import { verifyLayer, prewarmLayers, type LayerVerification } from './v2';
import type { SearchLang, EntrySummary } from './dictionary';

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
export const searchResults = writable<EntrySummary[]>([]);

// --- Search filter drawer -------------------------------------------------
/** Filter drawer open/closed. */
export const filterOpen = writable(false);
/** Include multi-word phrase entries in Ceannfhocail (headword) results. Off by
 * default: single-word headwords only, phrases behind the toggle. */
export const showPhrases = persisted<boolean>('ge:showPhrases', false);
/** Selected part-of-speech filter (raw POS values, e.g. "noun"). Empty = all. */
export const posFilter = persisted<string[]>('ge:posFilter', []);
/** Restrict headword search to the BuNaMo morphology core (~13k curated content
 * words with attested inflection). */
export const bunamoOnly = persisted<boolean>('ge:bunamoOnly', false);
/** Count of active (non-default) filters, for the drawer button badge. */
export const activeFilterCount = derived(
  [showPhrases, posFilter, bunamoOnly],
  ([$showPhrases, $posFilter, $bunamoOnly]) =>
    ($showPhrases ? 1 : 0) + ($posFilter.length > 0 ? 1 : 0) + ($bunamoOnly ? 1 : 0),
);
export const currentEntry = writable<any | null>(null);
export const currentExample = writable<ExampleDetail | null>(null);
/** The open Layer description page, or null. */
export const currentLayer = writable<import('./layers-catalogue').LayerEntry | null>(null);
export const loading = writable(false);

export const wasmReady = readable(false, (set) => {
  ready.then(() => set(true)).catch(() => set(false));
});

export const activeTab = writable<'search' | 'starred' | 'settings'>('search');
export const overlayView = writable<'faq' | 'flags' | 'layers' | null>(null);

/** Name of the layer currently being installed/built, or null. Lets the Layer
 *  Manager attribute `buildProgress` to a specific card (the layer isn't in
 *  `layers` until the build completes). Set by importLayer/installPackage. */
export const buildingLayerName = writable<string | null>(null);

/**
 * Open placenames-map state — the `map(layer, filter, selected)` argument bag
 * for `MapView`. Domain-agnostic: `layer` names a head that carries geometry,
 * `filter` is the reverse-link node + target UUIDs to plot, `selected` is an
 * optional point id to focus. Non-null ⇒ the map view is shown (see App.svelte).
 */
export interface MapState {
  layer: { headDir: string; label: string };
  filter: { nodeUri: string; targetUri: string; label: string };
  selected?: string;
}
export const mapState = writable<MapState | null>(null);

/** Open the placenames map over `state`; pushes a history entry (see App.svelte). */
export function openMap(state: MapState): void {
  mapState.set(state);
}

/** Close the map, returning to whatever was underneath (usually the entry). */
export function closeMap(): void {
  mapState.set(null);
}
export const showLicenseToast = persisted<boolean>('ge:showLicenseToast', true);
/** Bump to dismiss the launch "Open Data" toast — e.g. a nav/deep-link redirect
 *  shouldn't leave the licence toast overlapping the target view. */
export const dismissLicenseToast = writable(0);

/** True while the launch toast flow (no-warranty disclaimer, then Open Data
 *  licence) still has something to show. Eagerly initialised to match
 *  LicenseToast's own show logic so gating consumers (e.g. the first-run tour)
 *  don't race the toast's mount. LicenseToast flips it false when the flow ends. */
function initialLicenseFlowActive(): boolean {
  if (typeof localStorage === 'undefined') return false;
  const disclaimerPending = !localStorage.getItem('ge:disclaimerAcked');
  let showToast = true;
  try {
    const raw = localStorage.getItem('ge:showLicenseToast');
    if (raw !== null) showToast = JSON.parse(raw);
  } catch { /* default true */ }
  const licenseSeen = typeof sessionStorage !== 'undefined' && !!sessionStorage.getItem('ge:licenseSeen');
  const licenseWanted = showToast && !licenseSeen;
  return disclaimerPending || licenseWanted;
}
export const licenseFlowActive = writable<boolean>(initialLicenseFlowActive());
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

// --- Layer visibility ----------------------------------------------------
// Hiding a layer is a view filter, not an uninstall: the head stays on disk
// and the toggle is free. Install/remove stays in Settings, deliberately.

/** Names of layers hidden from composition. Any layer may be hidden; the only
 *  rule (enforced in `setHiddenLayers`) is that the stack can't be emptied. */
// BuNaMo ships hidden by default: it's the heavy attested-morphology layer, opt-in
// per user. It stays a listed, toggleable card (just visible:false); turning it on
// composes its attested paradigms and adds the 'BuNaMo' grammar tab. A `persisted`
// default only applies to fresh installs; existing users keep their saved set.
export const hiddenLayerNames = persisted<string[]>('ge:hiddenLayers', ['bunamo']);
hiddenLayerNames.subscribe(names => setHiddenLayers(names));

/** Whether the layer sheet is showing. */
export const layerSheetOpen = writable(false);

export interface LayerStackItem {
  name: string;
  label: string;
  swatch: string;
  /** The sole remaining visible layer — pinned so the stack can't be emptied.
   *  Not a fixed layer: it's whichever one is last standing. */
  base: boolean;
  visible: boolean;
}

/** The layer-v2 catalogue (Layer records), loaded once at startup. The single
 * source for a layer's display name + swatch; family.ts layerPresentation is only
 * the fallback (for a layer not yet in the catalogue, or before it loads). */
export const layerCatalogue = writable<import('./layers-catalogue').LayerEntry[]>([]);

/** Refresh the catalogue store from the layer-v2 head. Best-effort. */
export async function loadCatalogue(): Promise<void> {
  try {
    const { loadLayerCatalogue } = await import('./layers-catalogue');
    layerCatalogue.set(await loadLayerCatalogue());
  } catch { /* catalogue head absent - fall back to family.ts presentation */ }
}

/** The stack in composition order, as the sheet renders it. */
export const layerStack = derived(
  [layers, hiddenLayerNames, activeFamily, layerCatalogue],
  ([$layers, $hidden, $family, $catalogue]): LayerStackItem[] => {
    // layer-v2 is authoritative for display; family.ts presentation is the
    // fallback. Key the catalogue by slug (= the layer registry name).
    const cat = new Map($catalogue.map((e) => [e.slug || e.integrationSlug, e]));
    // The `layer` catalogue is a META head — never a toggleable stack layer.
    const items: LayerStackItem[] = $layers.filter((l) => l.name !== 'layer').map((l) => {
      const c = cat.get(l.name);
      return {
        name: l.name,
        label: c?.name || FAMILIES[$family]?.layerPresentation?.[l.name]?.label || l.name,
        swatch: c?.swatch || layerSwatch($family, l.name),
        base: false,
        visible: !$hidden.includes(l.name),
      };
    });
    // No layer is permanently the base. Only the LAST visible layer is pinned
    // (un-hideable) so RM always gets a non-empty stack. If a stale set hid them
    // all, force the first back on to match `setHiddenLayers`' fallback.
    const visible = items.filter((it) => it.visible);
    const pin = visible.length <= 1 ? (visible[0] ?? items[0]) : null;
    if (pin) { pin.visible = true; pin.base = true; }
    return items;
  },
);

// Per-layer attestation trust, keyed by layer name, for the shield badges.
// Populated by refreshLayerTrust; also updated at enable-time by the gate.
export const layerTrust = writable<Record<string, LayerVerification>>({});

/** Verify every layer in the stack and publish per-name trust for the shields.
 *  Best-effort: a failed invoke marks that layer tampered (a red shield is the
 *  safe default when we cannot confirm) rather than dropping it. */
export async function refreshLayerTrust(): Promise<void> {
  const names = get(layerStack).map((l) => l.name);
  const pairs = await Promise.all(
    names.map(async (name): Promise<[string, LayerVerification]> => {
      try {
        return [name, await verifyLayer(name)];
      } catch (e) {
        return [name, { status: 'tampered', reason: String(e), author: '', role: '', confirmed: false }];
      }
    }),
  );
  layerTrust.set(Object.fromEntries(pairs));
}

/**
 * Toggle a layer's visibility, then refresh whatever is on screen. Both the
 * result set and the composed entry change when the stack changes, so a stale
 * view would silently misreport its own provenance.
 */
export async function toggleLayerVisibility(name: string): Promise<void> {
  if (get(layerStack).find(l => l.name === name)?.base) return;

  hiddenLayerNames.update(h =>
    h.includes(name) ? h.filter(n => n !== name) : [...h, name],
  );

  const q = get(searchQuery);
  const entry = get(currentEntry);
  loading.set(true);
  try {
    if (q.trim()) {
      searchResults.set(await search(q, get(searchLang), get(visibleDialects)));
    }
    if (entry?.uri) {
      currentEntry.set(await loadEntryFlagged(entry.uri, entry.headword));
    }
  } catch (err) {
    console.warn('[store] refresh after layer toggle failed:', err);
  } finally {
    loading.set(false);
  }
}

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
  void refreshLayerTrust();
}

/**
 * Live-update `buildProgress` from `build-progress` events for one layer_id, until
 * unlistened. Events are PUSHED from Rust, so they render smoothly even while a
 * CPU-pegged on-device emit starves the `get_layer_status` poll (which stays as the
 * completion detector + a foreground-resync fallback). Returns the unlisten fn.
 */
async function subscribeBuildProgress(layerId: string): Promise<() => void> {
  return listen<{ layer_id: string; state: string; progress: number; error?: string; output_path?: string }>(
    'build-progress',
    (e) => {
      const p = e.payload;
      if (p.layer_id !== layerId) return;
      buildProgress.set({
        state: p.state,
        progress: p.progress,
        error: p.error ?? null,
        output_path: p.output_path ?? null,
      });
    },
  );
}

/**
 * Import a layer via the Tauri builder: fetch source, build index, add to store.
 * Progress is exposed via the buildProgress store.
 */
export async function importLayer(sourceUrl: string, name: string, format = 'prebuild-v2'): Promise<void> {
  buildingLayerName.set(name);
  buildProgress.set({ state: 'pending', progress: 0, error: null, output_path: null });

  const { layer_id } = await buildLayer({ sourceUrl, format, layerName: name });

  const unlisten = await subscribeBuildProgress(layer_id);
  let finalStatus: BuildLayerStatus;
  try {
    finalStatus = await waitForBuild(layer_id, (status) => {
      buildProgress.set(status);
    });
  } finally {
    unlisten();
  }

  if (finalStatus.state === 'failed') {
    buildProgress.set(finalStatus);
    throw new Error(finalStatus.error || 'Build failed');
  }

  const outputPath = finalStatus.output_path!;
  if (format === 'prebuild-v2' || format === 'tbx-v2') {
    // Installed v2 head (prebuild or TBX-built): register its dir into the native
    // v2 head-dir set (hydrate/query), not the v1 SparqlStore. See addV2Layer.
    addV2Layer(outputPath, name);
  } else {
    const baseUrl = layerBaseUrl(name, outputPath);
    await addDynamicLayer(baseUrl, name);
  }
  layers.set(getDynamicLayers());
  void refreshLayerTrust();

  buildProgress.set(null);
  buildingLayerName.set(null);
}

/**
 * Install a pre-built layer package from a URL (format: "built").
 * Downloads tar.gz, extracts directly — no on-device build_to_memory.
 */
export async function installPackage(url: string, name: string): Promise<void> {
  buildingLayerName.set(name);
  buildProgress.set({ state: 'pending', progress: 0, error: null, output_path: null });

  const { layer_id } = await buildLayer({ sourceUrl: url, format: 'built', layerName: name });

  const unlisten = await subscribeBuildProgress(layer_id);
  let finalStatus: BuildLayerStatus;
  try {
    finalStatus = await waitForBuild(layer_id, (status) => {
      buildProgress.set(status);
    });
  } finally {
    unlisten();
  }

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
  void refreshLayerTrust();

  buildProgress.set(null);
  buildingLayerName.set(null);
}

/** Add a layer directly by URL (already-built index served over HTTP). */
export async function addLayerDirect(baseUrl: string, name: string, pagefindBase?: string): Promise<void> {
  await addDynamicLayer(baseUrl, name, pagefindBase);
  layers.set(getDynamicLayers());
  void refreshLayerTrust();
}

export async function removeLayer(name: string): Promise<void> {
  // Drop ONLY this layer from the active v2 head set (no store teardown, which
  // previously wiped every layer). Head dirs are read live via currentV2HeadDirs.
  removeV2Layer(name);
  // Clean up files from disk (no-op for bundled heads, which aren't in layers_dir).
  try {
    await removeLayerFiles(name);
  } catch (err) {
    console.warn(`[store] removeLayerFiles "${name}" failed:`, err);
  }
  // Don't leave the name in the hidden set: a later reinstall would come back
  // invisible, looking like a failed install.
  hiddenLayerNames.update(h => h.filter(n => n !== name));
  // Refresh the reactive store so the Layer Manager live-updates.
  layers.set(getDynamicLayers());
  void refreshLayerTrust();
}

/**
 * Startup layer bootstrap. Registers the v2 heads as installed layers (name +
 * pagefind base) via `registerV2Layers` — no v1 SparqlStore — which clears the
 * "install a layer" empty state and enables Pagefind search; detail hydrate then
 * uses the active head dirs natively.
 */
export async function bootstrapLayers(): Promise<void> {
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
  // Re-add any user-installed v2 heads (built on-device via `prebuild-v2`),
  // persisted on disk under layers/<name>/head.sqlite, into the active head-dir
  // set. This is the v2 counterpart of restoreLayers (which is v1-only).
  await restoreV2Layers();
  // Re-apply persisted visibility now that the real layer set is known:
  // `setHiddenLayers` strips the base layer, and until initOfflineLayers has
  // run that base is the dev constant, not the installed one.
  setHiddenLayers(get(hiddenLayerNames));
  layers.set(getDynamicLayers());
  // Warm the DuckDB reader pool for the active head dirs in the background, so the
  // first entry open hits cached readers. Otherwise gather (opening ~11 parquet
  // readers) dominates the first hydrate at ~600ms; RM_HYDRATE_PERF confirmed it
  // is 96% of the cost. Fire-and-forget - v2_prewarm is idempotent.
  void prewarmLayers(currentV2HeadDirs());
  // Warm the concept-label closure cache too. `v2_closure` opens a fresh cold
  // DuckReader per layer + reads each catalog (~2s across the full stack), and the
  // entry loader awaits it alongside the hydrate - so without this the FIRST entry
  // open blocks ~2s on it (cmdperf: v2_closure 2098ms). Cached after, keyed on the
  // same currentV2HeadDirs() the loader uses. Fire-and-forget; getClosure de-dupes.
  void warmClosure(currentV2HeadDirs());
  void refreshLayerTrust();
  // Populate the catalogue so the tray shows layer-v2 names/swatches from the
  // first render (not the family.ts fallback). Best-effort; head must be unpacked.
  await loadCatalogue();
}

/**
 * Restore user-installed v2 heads from disk on startup. Scans layers/<name>/ for
 * a `tiles_*.parquet` head (`list_v2_layers`) and re-registers each via `addV2Layer`
 * so it rejoins `currentV2HeadDirs()`. The v2 sibling of `restoreLayers` (v1 summary.bin).
 */
export async function restoreV2Layers(): Promise<void> {
  try {
    const existing = await listV2Layers();
    for (const layer of existing) {
      addV2Layer(layer.output_path, layer.layer_id);
    }
  } catch (err) {
    console.warn('[store] restoreV2Layers failed:', err);
  }
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
  void refreshLayerTrust();
  } catch (err) {
    console.warn('[store] restoreLayers failed:', err);
  }
}
