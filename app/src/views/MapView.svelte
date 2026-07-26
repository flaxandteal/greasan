<script lang="ts">
  // SPDX-License-Identifier: AGPL-3.0-or-later
  //
  // MapView — the reusable `map(layer, filter, selected)` component.
  //
  // Phase 2 renderer: MapLibre GL JS, with NO basemap tiles. The map draws ONLY
  // our own GeoJSON — a bundled Ireland/Goidelic outline plus the point cloud
  // returned by the generic `geoPoints(headDir, nodeUri, targetUri)` primitive.
  // Nothing external is ever fetched: the style has empty `sources`, no `glyphs`,
  // no `sprite`, no tile source and no text layers (so no glyph PBFs are needed).
  // The offline + CSP-locked webview stays offline.
  //
  // The prop interface is unchanged from phase 1 — `layer` (a head that carries
  // geometry), `filter` (the reverse-link node + target to plot) and `selected`
  // (a point id to focus) — so a future Protomaps basemap or a monuments graph
  // slots in behind this same `map(...)` API with no caller change.
  import { onMount } from 'svelte';
  // MapLibre v6 (ESM-only). v6 dropped the CSP build; its default worker loader
  // assumes an http(s) `import.meta.url` origin and mis-resolves inside the
  // Tauri/Android WebView, so GeoJSON never tiles and the map draws blank with no
  // error. The supported escape hatch is setWorkerUrl pointed at a worker the
  // bundler has already emitted same-origin: Vite's `?worker&url` follows the
  // worker's internal `./maplibre-gl-shared.mjs` import, inlines it, and returns
  // a URL to a self-contained (IIFE/classic) worker — so there is nothing left
  // for v6's fragile auto-resolution to get wrong.
  import * as maplibregl from 'maplibre-gl';
  import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { Protocol, PMTiles } from 'pmtiles';

  // Both must run before any Map is created.
  maplibregl.setWorkerUrl(workerUrl);
  maplibregl.setWorkerCount(1);
  import { invoke } from '@tauri-apps/api/core';
  import { t } from '../lib/i18n';
  import { geoPoints, hydrateLayers, type GeoPoint } from '../lib/v2';
  import { darkMode, closeMap, currentEntry, loading } from '../lib/store';
  import { loadEntryFlagged } from '../lib/dictionary';
  import FlagButton from './FlagButton.svelte';
  // Public-domain outline (Natural Earth, naturalearthdata.com): the Goidelic
  // area (Ireland + Isle of Man + western Scotland). Static asset, not a head.
  import ireland from '../lib/assets/ireland.geo.json';

  // --- Vector basemap: self-rendered OSM PMTiles (ODbL) --------------------
  // Random-access the bundled goidelic.pmtiles through a Tauri byte-range command
  // — no tile server, fully offline. When the tiles aren't bundled (build ran
  // without scripts/build-basemap.sh), `basemapReady` stays false and the map
  // falls back to the hand-drawn Natural Earth outline. Geometry only for now:
  // labels need a bundled glyph set (a follow-up).
  let basemapReady = $state(false);
  let pmProtocol: Protocol | undefined;
  class TauriBasemapSource {
    getKey() { return 'goidelic'; }
    async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
      const data = await invoke<ArrayBuffer>('basemap_range', { offset, length });
      return { data };
    }
  }

  interface Props {
    layer: { headDir: string; label: string };
    filter: { nodeUri: string; targetUri: string; label: string };
    selected?: string;
  }
  let { layer, filter, selected }: Props = $props();

  let points = $state<GeoPoint[]>([]);
  let loadingPoints = $state(true);
  let errored = $state(false);
  let selectedId = $state<string | undefined>(undefined);
  // Seed / re-seed the focused point from the prop. Runs only when `selected`
  // changes (not on internal selection), so user taps are never clobbered.
  $effect(() => { selectedId = selected; });
  /** Bottom-sheet snap state — DEFAULT peek (map dominant, Google/Apple style). */
  let snap = $state<'peek' | 'half' | 'full'>('peek');

  let rootEl = $state<HTMLDivElement>();
  let mapEl = $state<HTMLDivElement>();
  let listEl = $state<HTMLDivElement>();

  let map: MLMap | undefined;
  let mapLoaded = $state(false);

  // --- Geographic extent -----------------------------------------------------
  interface GeoJSON { features: Array<{ geometry: { type: string; coordinates: any } }> }
  interface Bounds { minLng: number; minLat: number; maxLng: number; maxLat: number }

  const outlineBounds = computeBounds(ireland as GeoJSON);

  function computeBounds(g: GeoJSON): Bounds {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const visit = (c: any) => {
      if (typeof c[0] === 'number') {
        minLng = Math.min(minLng, c[0]); maxLng = Math.max(maxLng, c[0]);
        minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
      } else for (const x of c) visit(x);
    };
    for (const f of g.features) visit(f.geometry.coordinates);
    return { minLng, minLat, maxLng, maxLat };
  }

  function pointsBounds(): Bounds | null {
    if (points.length === 0) return null;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const p of points) {
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    }
    return { minLng, minLat, maxLng, maxLat };
  }

  // --- Theme colours (read the live resolved CSS custom properties) ----------
  function token(name: string, fallback: string): string {
    if (!rootEl) return fallback;
    const v = getComputedStyle(rootEl).getPropertyValue(name).trim();
    return v || fallback;
  }
  /** Parse a `#rrggbb` (or `rgb()`) token to `rgba(r,g,b,a)`. */
  function rgba(colour: string, alpha: number): string {
    let r = 0, g = 0, b = 0;
    const c = colour.trim();
    if (c[0] === '#') {
      const h = c.slice(1);
      const hex = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else {
      const m = c.match(/(\d+(?:\.\d+)?)/g);
      if (m && m.length >= 3) { r = +m[0]; g = +m[1]; b = +m[2]; }
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  interface Palette {
    paper: string; land: string; coast: string; water: string;
    teal: string; gold: string; ring: string;
  }
  function palette(): Palette {
    return {
      paper: token('--srf-app', '#F6F4EB'),
      land: token('--map-land', '#FBF9F2'),
      coast: token('--map-coast', '#334B4E'),
      water: token('--map-water', '#DCE6E5'),
      teal: token('--teal-mid', '#4B7A81'),
      gold: token('--gold-deep', '#B39B52'),
      ring: token('--paper', '#FFFFFF'),
    };
  }

  // --- MapLibre style: minimal, ALL-LOCAL, zero external fetches -------------
  function baseStyle(pal: Palette): any {
    return {
      version: 8,
      // No glyphs, no sprite, no tile sources — nothing to fetch. A single
      // background layer paints the theme paper colour; our GeoJSON layers are
      // added on `load` once the sources exist.
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': pal.paper } },
      ],
    };
  }

  function pointsFC(): any {
    return {
      type: 'FeatureCollection',
      features: points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { id: p.id, name: p.name },
      })),
    };
  }
  function selectedFC(): any {
    const p = points.find((q) => q.id === selectedId);
    if (!p) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { id: p.id, name: p.name },
      }],
    };
  }

  // Greyscale OSM vector basemap (OpenMapTiles schema). Fill/line only — the
  // offline style bundles no glyphs, so labels are a follow-up. Themed via the
  // --map-* tokens so it tracks light/dark. Sits at the bottom, under the points.
  function addBasemapLayers(pal: Palette) {
    if (!map) return;
    map.addSource('basemap', { type: 'vector', url: 'pmtiles://goidelic' } as any);
    map.addLayer({ id: 'bm-water', type: 'fill', source: 'basemap', 'source-layer': 'water',
      paint: { 'fill-color': pal.water } } as any);
    map.addLayer({ id: 'bm-landcover', type: 'fill', source: 'basemap', 'source-layer': 'landcover',
      paint: { 'fill-color': pal.coast, 'fill-opacity': 0.05 } } as any);
    map.addLayer({ id: 'bm-waterway', type: 'line', source: 'basemap', 'source-layer': 'waterway',
      minzoom: 8, paint: { 'line-color': pal.water, 'line-width': 0.8, 'line-opacity': 0.7 } } as any);
    map.addLayer({ id: 'bm-boundary', type: 'line', source: 'basemap', 'source-layer': 'boundary',
      filter: ['<=', ['get', 'admin_level'], 6],
      paint: { 'line-color': pal.coast, 'line-width': 0.6, 'line-opacity': 0.28, 'line-dasharray': [2, 2] } } as any);
    map.addLayer({ id: 'bm-road', type: 'line', source: 'basemap', 'source-layer': 'transportation',
      minzoom: 7, paint: { 'line-color': pal.coast,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 11, 1.1], 'line-opacity': 0.3 } } as any);
  }

  function addLayers(pal: Palette) {
    if (!map) return;
    // Basemap at the bottom: the real OSM vector basemap when bundled, else the
    // hand-drawn Natural Earth outline.
    if (basemapReady) {
      addBasemapLayers(pal);
    } else {
      map.addSource('outline', { type: 'geojson', data: ireland as any });
      // Subtle land fill.
      map.addLayer({
        id: 'outline-fill', type: 'fill', source: 'outline',
        paint: { 'fill-color': pal.land, 'fill-opacity': 0.5 },
      });
      // Coastline / admin lines.
      map.addLayer({
        id: 'outline-line', type: 'line', source: 'outline',
        paint: { 'line-color': pal.coast, 'line-width': 1.1, 'line-opacity': 0.55 },
      });
    }
    map.addSource('points', { type: 'geojson', data: pointsFC() });
    map.addSource('sel', { type: 'geojson', data: selectedFC() });

    // Soft density underlay: a faint TEAL-CAPPED heatmap (no gold) that lends a
    // sense of mass beneath the dots without the muddy flat-gold blob. It fades
    // back as you zoom in and the individual dots take over. Gold is reserved for
    // the selected point, so it always pops.
    map.addLayer({
      id: 'points-heat', type: 'heatmap', source: 'points',
      paint: {
        'heatmap-weight': 1,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 9, 1.0],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 7, 14, 10, 22],
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.42, 9, 0.26, 12, 0.08],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)',
          0.2, rgba(pal.teal, 0.14),
          0.5, rgba(pal.teal, 0.26),
          1, rgba(pal.teal, 0.38),
        ],
      },
    });
    // Dot-density: one translucent teal dot per place, drawn at EVERY zoom.
    // Overlapping dots composite up toward solid, so density reads as deepening
    // teal while individual townlands stay visible — the crisp "vector" look.
    // Radius + opacity grow with zoom so points separate into tappable dots.
    map.addLayer({
      id: 'points-circle', type: 'circle', source: 'points',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 7, 2.2, 10, 4, 13, 6],
        'circle-color': pal.teal,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.34, 10, 0.6, 13, 0.85],
        'circle-stroke-width': 0,
      },
    });
    // Selected point: a distinct ringed gold marker, always visible on top.
    map.addLayer({
      id: 'sel-circle', type: 'circle', source: 'sel',
      paint: {
        'circle-radius': 7,
        'circle-color': pal.gold,
        'circle-stroke-width': 2,
        'circle-stroke-color': pal.ring,
      },
    });
  }

  /** Re-tint every layer from the current theme (light/dark toggle). */
  function applyTheme() {
    if (!map || !mapLoaded) return;
    const pal = palette();
    map.setPaintProperty('bg', 'background-color', pal.paper);
    if (basemapReady) {
      map.setPaintProperty('bm-water', 'fill-color', pal.water);
      map.setPaintProperty('bm-landcover', 'fill-color', pal.coast);
      map.setPaintProperty('bm-waterway', 'line-color', pal.water);
      map.setPaintProperty('bm-boundary', 'line-color', pal.coast);
      map.setPaintProperty('bm-road', 'line-color', pal.coast);
    } else {
      map.setPaintProperty('outline-fill', 'fill-color', pal.land);
      map.setPaintProperty('outline-line', 'line-color', pal.coast);
    }
    map.setPaintProperty('points-circle', 'circle-color', pal.teal);
    map.setPaintProperty('sel-circle', 'circle-color', pal.gold);
    map.setPaintProperty('sel-circle', 'circle-stroke-color', pal.ring);
    map.setPaintProperty('points-heat', 'heatmap-color', [
      'interpolate', ['linear'], ['heatmap-density'],
      0, 'rgba(0,0,0,0)',
      0.2, rgba(pal.teal, 0.14),
      0.5, rgba(pal.teal, 0.26),
      1, rgba(pal.teal, 0.38),
    ]);
  }

  /** Fit the view to the points (or the whole outline when there are none). */
  function frame(animate: boolean) {
    if (!map) return;
    const b = pointsBounds() ?? outlineBounds;
    const bottom = Math.max(140, Math.round(window.innerHeight * 0.24));
    map.fitBounds(
      [[b.minLng, b.minLat], [b.maxLng, b.maxLat]],
      { padding: { top: 72, left: 32, right: 32, bottom }, maxZoom: 9, animate, duration: 500 },
    );
  }

  onMount(() => {
    if (!mapEl) return;
    map = new maplibregl.Map({
      container: mapEl,
      style: baseStyle(palette()),
      center: [(outlineBounds.minLng + outlineBounds.maxLng) / 2, (outlineBounds.minLat + outlineBounds.maxLat) / 2],
      zoom: 5,
      attributionControl: false, // we render our own attribution line
      // Web Mercator is the MapLibre default projection.
    });

    map.on('error', (e: any) => {
      console.error('[MapView] maplibre error:', (e && e.error && (e.error.message || e.error)) || e);
    });
    map.on('load', async () => {
      // Is the basemap actually bundled? (Absent when the build ran without
      // scripts/build-basemap.sh — then keep the hand-drawn outline.)
      try { basemapReady = await invoke<boolean>('basemap_available'); }
      catch { basemapReady = false; }
      if (basemapReady) {
        try {
          pmProtocol = new Protocol();
          maplibregl.addProtocol('pmtiles', pmProtocol.tile);
          pmProtocol.add(new PMTiles(new TauriBasemapSource() as any));
        } catch (err) {
          console.warn('[MapView] pmtiles init failed, using outline:', err);
          basemapReady = false;
        }
      }
      try { addLayers(palette()); } catch (err) { console.error('[MapView] addLayers failed:', err); }
      mapLoaded = true;
      frame(false);
      map!.resize();
    });

    // Tap selection: nearest plotted point within a screen radius. Done manually
    // (via map.project) so it works over the heatmap too, at any zoom — the
    // heatmap layer isn't feature-queryable and the circle layer is invisible at
    // low zoom.
    map.on('click', (e) => {
      let best: string | undefined;
      let bestD = 22 * 22;
      for (const p of points) {
        const q = map!.project([p.lng, p.lat]);
        const dx = q.x - e.point.x, dy = q.y - e.point.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p.id; }
      }
      if (best) selectPoint(best, false);
    });

    const ro = new ResizeObserver(() => map?.resize());
    ro.observe(mapEl);
    // Belt-and-braces: force a resize once layout settles, in case the map was
    // created before the container had its final size (0-size init → blank map).
    requestAnimationFrame(() => map?.resize());
    setTimeout(() => map?.resize(), 350);

    return () => {
      ro.disconnect(); map?.remove(); map = undefined;
      if (pmProtocol) { try { maplibregl.removeProtocol('pmtiles'); } catch { /* already gone */ } pmProtocol = undefined; }
    };
  });

  // Load the point set on mount / when the filter changes.
  $effect(() => {
    const { headDir } = layer;
    const { nodeUri, targetUri } = filter;
    loadingPoints = true;
    errored = false;
    geoPoints(headDir, nodeUri, targetUri)
      .then((pts) => { points = pts; })
      .catch((e) => { console.warn('[MapView] geoPoints failed:', e); errored = true; })
      .finally(() => { loadingPoints = false; });
  });

  // Push the loaded points into the map + refit whenever they change.
  $effect(() => {
    void points;
    if (!map || !mapLoaded) return;
    (map.getSource('points') as GeoJSONSource | undefined)?.setData(pointsFC() as any);
    frame(false);
  });

  // Keep the theme in sync with the light/dark toggle while the map is open.
  $effect(() => { void $darkMode; applyTheme(); });

  // Reflect the selected point into the `sel` source + hydrate its detail.
  $effect(() => {
    const id = selectedId;
    if (map && mapLoaded) {
      (map.getSource('sel') as GeoJSONSource | undefined)?.setData(selectedFC() as any);
    }
    // Scroll the matching card into view (and lift the sheet if it was peeking).
    if (id && listEl) {
      if (snap === 'peek') snap = 'half';
      queueMicrotask(() => {
        const card = listEl?.querySelector(`[data-pid="${cssEscape(id)}"]`);
        card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
    if (id) hydratePlace(id);
    else placeDetail = null;
  });

  function cssEscape(s: string): string {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  // --- Interaction ----------------------------------------------------------
  /** Select a point; optionally recentre the map on it. */
  function selectPoint(id: string, recentre: boolean) {
    selectedId = id;
    if (recentre && map) {
      const p = points.find((q) => q.id === id);
      if (p) map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 9), duration: 500 });
    }
  }

  function close() {
    // Mirrors the entry back-button: pop the history entry the map pushed, which
    // the App popstate handler turns into `mapState.set(null)`.
    history.back();
  }

  const selectedPoint = $derived(points.find((p) => p.id === selectedId));

  // --- Hydrate-on-select: place detail --------------------------------------
  // logainm_url / feature_type / name_elements are tile values, NOT SQL-indexed,
  // so they can only be read by hydrating the one selected place.
  interface PlaceDetail {
    id: string;
    name: string;
    featureType: string;
    logainmUrl: string;
    lat?: number;
    lng?: number;
    elements: Array<{ surface: string; entryId: string }>;
  }
  let placeDetail = $state<PlaceDetail | null>(null);
  let placeLoading = $state(false);

  // feature_type is a reference concept → resolve via the place head's closure
  // map (cheap, cached). Best-effort: falls back to the raw value / nothing.
  let closurePromise: Promise<Record<string, string>> | undefined;
  function closure(): Promise<Record<string, string>> {
    if (!closurePromise) {
      closurePromise = invoke<Record<string, string>>('v2_closure', { headDirs: [layer.headDir] })
        .catch(() => ({} as Record<string, string>));
    }
    return closurePromise;
  }

  function localStr(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      const o = v as Record<string, any>;
      for (const c of [o.en, ...Object.values(o)]) {
        if (c && typeof c === 'object' && typeof c.value === 'string') return c.value;
      }
      if (typeof o.value === 'string') return o.value;
    }
    return '';
  }
  function asArray(v: unknown): any[] { return v == null ? [] : Array.isArray(v) ? v : [v]; }
  function refId(v: unknown): string {
    const r = asArray(v)[0];
    if (r && typeof r === 'object') return r.resourceId ?? r.id ?? '';
    return typeof r === 'string' ? r : '';
  }

  async function hydratePlace(id: string) {
    placeLoading = true;
    placeDetail = null;
    const forId = id;
    try {
      const [treeRaw, closureMap] = await Promise.all([hydrateLayers([layer.headDir], id), closure()]);
      if (forId !== selectedId) return; // a newer selection superseded this one
      const tree = treeRaw as Record<string, any> | null;
      if (!tree || typeof tree !== 'object') { placeDetail = null; return; }
      const ftRaw = tree.feature_type;
      const featureType = typeof ftRaw === 'string' ? (closureMap[ftRaw] ?? '') : localStr(ftRaw);
      const elements = asArray(tree.name_elements)
        .map((ne) => ({ surface: localStr(ne?.element_surface), entryId: refId(ne?.element_entry) }))
        .filter((e) => e.surface);
      const pt = points.find((q) => q.id === id);
      placeDetail = {
        id,
        name: localStr(tree.name) || pt?.name || '',
        featureType,
        logainmUrl: localStr(tree.logainm_url),
        lat: pt?.lat,
        lng: pt?.lng,
        elements,
      };
    } catch (err) {
      console.warn('[MapView] place hydrate failed:', err);
      if (forId === selectedId) placeDetail = null;
    } finally {
      if (forId === selectedId) placeLoading = false;
    }
  }

  /** Open the place's Logainm page in the external browser (Tauri opener). */
  async function openLogainm(url: string) {
    if (!url) return;
    try {
      await invoke('plugin:opener|open_url', { url });
    } catch (err) {
      console.warn('[MapView] opener failed:', err);
    }
  }

  /** Constituent-word chip → navigate to that dictionary entry (closes the map). */
  async function openEntry(entryId: string, headword: string) {
    if (!entryId) return;
    loading.set(true);
    try {
      const detail = await loadEntryFlagged(entryId, headword);
      closeMap();
      if (detail) currentEntry.set(detail);
    } catch (err) {
      console.warn('[MapView] openEntry failed:', err);
    } finally {
      loading.set(false);
    }
  }

  // --- Bottom sheet drag ----------------------------------------------------
  let dragStartY = 0;
  let dragging = false;
  function onHandleDown(ev: PointerEvent) {
    dragging = true;
    dragStartY = ev.clientY;
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
  }
  function onHandleMove(ev: PointerEvent) {
    if (!dragging) return;
    const dy = ev.clientY - dragStartY;
    if (Math.abs(dy) < 24) return;
    if (dy < 0) snap = snap === 'peek' ? 'half' : 'full';
    else snap = snap === 'full' ? 'half' : 'peek';
    dragging = false;
  }
  function onHandleUp() { dragging = false; }
  function cycleSnap() {
    snap = snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek';
  }
</script>

<div class="ge-map" data-snap={snap} bind:this={rootEl}>
  <!-- Full-screen map, behind everything -->
  <div class="ge-map-canvas" bind:this={mapEl}></div>

  <!-- Floating top chrome: back + filter chip -->
  <div class="ge-map-top">
    <button class="ge-map-back" onclick={close} aria-label={$t('nav.back')}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <button class="ge-map-chip" onclick={close} title={$t('map.clearFilter')}>
      <span class="ge-map-chip-label">{filter.label}</span>
      <span class="ge-map-chip-x" aria-label={$t('map.clearFilter')}>✕</span>
    </button>
  </div>

  <!-- Floating status / attribution -->
  {#if loadingPoints}
    <div class="ge-map-status">{$t('map.loading')}</div>
  {:else if errored || points.length === 0}
    <div class="ge-map-status">{$t('map.empty')}</div>
  {/if}
  <div class="ge-map-attr">{$t('map.source')}{#if basemapReady} · © OpenMapTiles © OpenStreetMap contributors{/if}</div>

  <!-- Bottom sheet: overlays the map -->
  <div class="ge-map-sheet">
    <button class="ge-map-handle" onpointerdown={onHandleDown} onpointermove={onHandleMove} onpointerup={onHandleUp} onclick={cycleSnap} aria-label={$t('map.title')}>
      <span class="ge-map-grip"></span>
    </button>
    <div class="ge-map-sheet-head">
      <div class="ge-map-title">{$t('map.title')}</div>
      <div class="ge-map-count">{$t('map.pointsWithGeo', { count: points.length.toLocaleString() })}</div>
    </div>

    <div class="ge-map-list" bind:this={listEl}>
      <!-- Place detail (hydrate-on-select): feature type, coords, Logainm + word chips -->
      {#if selectedPoint}
        <div class="ge-place-detail">
          <div class="ge-place-name" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span>{placeDetail?.name || selectedPoint.name}</span>
            <FlagButton resourceUri={selectedId ?? ''} tone="var(--fg-soft)" subjectName={placeDetail?.name || selectedPoint.name} subjectGraph="Logainm · Place" subjectKind="place" />
          </div>
          <div class="ge-place-meta">
            {#if placeDetail?.featureType}<span class="ge-place-ft">{placeDetail.featureType}</span>{/if}
            <span class="ge-place-coord">{selectedPoint.lat.toFixed(4)}, {selectedPoint.lng.toFixed(4)}</span>
          </div>

          {#if placeDetail?.logainmUrl}
            <button class="ge-logainm-btn" onclick={() => openLogainm(placeDetail!.logainmUrl)}>
              {$t('map.viewOnLogainm')}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>
            </button>
          {:else if placeLoading}
            <div class="ge-place-loading">{$t('map.loadingDetail')}</div>
          {/if}

          {#if placeDetail && placeDetail.elements.length > 0}
            <div class="ge-place-elems-label">{$t('map.constituentWords')}</div>
            <div class="ge-place-elems">
              {#each placeDetail.elements as el}
                {#if el.entryId}
                  <button class="ge-elem-chip is-link" onclick={() => openEntry(el.entryId, el.surface)}>{el.surface}</button>
                {:else}
                  <span class="ge-elem-chip">{el.surface}</span>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#each points as p (p.id)}
        <button
          class="ge-map-card"
          class:selected={p.id === selectedId}
          data-pid={p.id}
          onclick={() => selectPoint(p.id, true)}
        >
          <span class="ge-map-card-name">{p.name}</span>
          <span class="ge-map-card-coord">{p.lat.toFixed(3)}, {p.lng.toFixed(3)}</span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .ge-map {
    position: fixed; inset: 0; z-index: 50;
    background: var(--srf-app, #f6f4eb);
    color: var(--fg-default);
  }

  /* Full-screen map fills the view, behind the chrome + sheet */
  .ge-map-canvas { position: absolute; inset: 0; z-index: 0; }
  /* MapLibre canvas focus outline is distracting on tap */
  .ge-map-canvas :global(.maplibregl-canvas:focus) { outline: none; }

  .ge-map-top {
    position: absolute; top: 0; left: 0; right: 0; z-index: 3;
    display: flex; align-items: center; gap: 10px;
    padding: calc(10px + env(safe-area-inset-top, 0px)) 12px 10px;
    pointer-events: none;
  }
  .ge-map-top > * { pointer-events: auto; }
  .ge-map-back {
    display: inline-flex; align-items: center; justify-content: center;
    width: 38px; height: 38px; border-radius: 50%;
    background: var(--paper); color: var(--teal-deep);
    border: 0; box-shadow: var(--shadow-card); cursor: pointer;
  }
  .ge-map-chip {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 12px; border-radius: var(--pill-radius, 500px);
    background: var(--teal-deep); color: var(--cream);
    border: 0; box-shadow: var(--shadow-card); cursor: pointer;
    font-size: var(--fs-small, 14px); font-weight: 600;
  }
  .ge-map-chip-x { opacity: 0.8; font-size: 12px; }

  .ge-map-status {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 2;
    color: var(--fg-soft); font-size: var(--fs-small, 14px);
    background: color-mix(in srgb, var(--srf-app) 78%, transparent);
    padding: 8px 14px; border-radius: 10px; pointer-events: none; text-align: center;
  }
  .ge-map-attr {
    position: absolute; left: 10px; z-index: 2;
    bottom: calc(22vh + 8px); /* sits just above the peeking sheet */
    font-size: 10px; color: var(--fg-soft); font-style: italic;
    background: color-mix(in srgb, var(--srf-app) 66%, transparent);
    padding: 2px 6px; border-radius: 6px; pointer-events: none;
    max-width: 62%;
  }

  .ge-map-sheet {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 4;
    display: flex; flex-direction: column;
    background: var(--srf-card, #fff);
    border-top-left-radius: 16px; border-top-right-radius: 16px;
    box-shadow: var(--shadow-pop);
    transition: height var(--t-base, 220ms) var(--ease, ease);
    overflow: hidden;
  }
  .ge-map[data-snap="peek"] .ge-map-sheet { height: 22vh; }
  .ge-map[data-snap="half"] .ge-map-sheet { height: 50vh; }
  .ge-map[data-snap="full"] .ge-map-sheet { height: 88vh; }

  .ge-map-handle {
    display: flex; align-items: center; justify-content: center;
    width: 100%; padding: 10px 0 6px; border: 0; background: transparent;
    cursor: grab; touch-action: none;
  }
  .ge-map-grip {
    width: 40px; height: 4px; border-radius: 2px;
    background: color-mix(in srgb, var(--fg-soft) 55%, transparent);
  }
  .ge-map-sheet-head {
    display: flex; align-items: baseline; justify-content: space-between;
    padding: 2px 16px 8px; gap: 12px;
    border-bottom: 1px solid var(--srf-divider, rgba(51,75,78,0.1));
  }
  .ge-map-title { font-size: var(--fs-h3, 19px); font-weight: 700; color: var(--fg-strong); }
  .ge-map-count { font-size: var(--fs-small, 14px); color: var(--fg-muted); white-space: nowrap; }

  .ge-map-list { flex: 1 1 auto; overflow-y: auto; padding: 6px 12px 24px; -webkit-overflow-scrolling: touch; }

  /* Place detail card */
  .ge-place-detail {
    padding: 12px 12px 14px; margin: 4px 0 8px;
    border-radius: var(--card-radius, 10px);
    background: var(--srf-card-alt, #fbf9f2);
    border: 1px solid color-mix(in srgb, var(--gold-deep, #b39b52) 40%, transparent);
  }
  .ge-place-name { font-size: var(--fs-h3, 19px); font-weight: 700; color: var(--fg-strong); }
  .ge-place-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-top: 3px; }
  .ge-place-ft {
    font-size: 12px; font-weight: 600; color: var(--teal-deep);
    background: color-mix(in srgb, var(--teal-mid) 16%, transparent);
    padding: 1px 8px; border-radius: 10px;
  }
  .ge-place-coord { font-size: var(--fs-micro, 12px); color: var(--fg-soft); font-variant-numeric: tabular-nums; }
  .ge-logainm-btn {
    display: inline-flex; align-items: center; gap: 6px; margin-top: 10px;
    padding: 7px 13px; border-radius: var(--pill-radius, 500px);
    background: var(--teal-deep); color: var(--cream); border: 0; cursor: pointer;
    font-size: var(--fs-small, 14px); font-weight: 600;
  }
  .ge-place-loading { font-size: 12px; color: var(--fg-soft); margin-top: 8px; }
  .ge-place-elems-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--fg-soft); font-weight: 600; margin: 12px 0 5px;
  }
  .ge-place-elems { display: flex; flex-wrap: wrap; gap: 6px; }
  .ge-elem-chip {
    font-size: 14px; padding: 3px 10px; border-radius: 13px; font-family: inherit;
    background: color-mix(in srgb, var(--fg-soft) 14%, transparent); color: var(--fg-default);
  }
  .ge-elem-chip.is-link {
    border: 0; cursor: pointer;
    background: color-mix(in srgb, var(--gold-deep, #b39b52) 26%, transparent);
    color: var(--fg-strong);
  }
  .ge-elem-chip.is-link:hover { background: color-mix(in srgb, var(--gold-deep, #b39b52) 40%, transparent); }

  .ge-map-card {
    display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    width: 100%; text-align: left; border: 0; cursor: pointer;
    padding: 10px 12px; margin: 3px 0; border-radius: var(--card-radius, 10px);
    background: transparent; color: var(--fg-default);
  }
  .ge-map-card:hover { background: var(--srf-card-alt, #fbf9f2); }
  .ge-map-card.selected {
    background: color-mix(in srgb, var(--accent, #d9c78e) 30%, transparent);
    outline: 1px solid var(--accent-deep, #b39b52);
  }
  .ge-map-card-name { font-size: var(--fs-body, 16px); font-weight: 500; }
  .ge-map-card-coord { font-size: var(--fs-micro, 12px); color: var(--fg-soft); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
