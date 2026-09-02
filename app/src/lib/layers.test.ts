import { describe, it, expect, vi, beforeEach } from 'vitest';

// Provide window global for ensureStore's debug exposure
if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = globalThis;
}

vi.mock('alizarin', () => ({
  client: { ArchesClientRemoteStatic: vi.fn() },
  graphManager: {
    archesClient: null,
    initialize: vi.fn(),
    loadGraph: vi.fn(),
  },
  staticStore: { archesClient: null },
  RDM: { archesClient: null },
}));
vi.mock('./wasm', () => ({ ready: Promise.resolve() }));
vi.mock('./tauri-builder', () => ({
  checkLocalIndex: vi.fn().mockResolvedValue(null),
  assetUrl: vi.fn((p: string) => p),
}));

const mockDescriptors = vi.fn();
vi.mock('./v2', () => ({
  prepareOffline: vi.fn(),
  descriptors: (...args: unknown[]) => mockDescriptors(...args),
}));

const mockSearch = vi.fn().mockResolvedValue({ results: [] });
const mockFilters = vi.fn().mockResolvedValue({});
const mockGetPagefind = vi.fn(() =>
  Promise.resolve({ search: mockSearch, filters: mockFilters }),
);
vi.mock('./pagefind', () => ({
  getPagefind: (base: string) => mockGetPagefind(base),
  resetPagefind: vi.fn(),
}));

import {
  setHiddenLayers,
  currentV2HeadDirs,
  layerCoverage,
  registerV2Layers,
  search,
  V2_LAYERS,
} from './dictionary';

// Index-agnostic: the dev layer set grows as pilots land, so pin only the
// structural roles (headDirs[0] is the basemap; anything after is an overlay).
const BASE = V2_LAYERS[0].name;
const OVERLAY = V2_LAYERS[1].name;
const headDirOf = (name: string) => V2_LAYERS.find(l => l.name === name)!.headDir;
const pfBaseOf = (name: string) => V2_LAYERS.find(l => l.name === name)!.pagefindBase;

// The composed head-dir stack: every layer EXCEPT the `layer` catalogue meta-head
// (queried on its own, never composed) and any hidden ones, in declared order.
const composable = (hidden: string[] = []) =>
  V2_LAYERS.filter(l => l.name !== 'layer' && !hidden.includes(l.name)).map(l => l.headDir);

describe('layer visibility', () => {
  beforeEach(() => {
    setHiddenLayers([]);
    registerV2Layers();
    mockGetPagefind.mockClear();
    mockDescriptors.mockReset();
  });

  it('never composes an empty stack, even if every layer is hidden', () => {
    // RM's Layers::open rejects a zero-dir stack, so setHiddenLayers keeps one
    // layer visible when a (stale/all-hidden) set would blank everything.
    setHiddenLayers(V2_LAYERS.map(l => l.name));
    expect(currentV2HeadDirs().length).toBe(1);
  });

  it('excludes the `layer` catalogue meta-head from the composed stack', () => {
    expect(currentV2HeadDirs()).not.toContain(headDirOf('layer'));
  });

  it('drops hidden overlays from the composed head dirs, preserving order', () => {
    setHiddenLayers([OVERLAY]);
    expect(currentV2HeadDirs()).toEqual(composable([OVERLAY]));
  });

  it('restores the full stack when unhidden', () => {
    setHiddenLayers([OVERLAY]);
    setHiddenLayers([]);
    expect(currentV2HeadDirs()).toEqual(composable());
  });

  it('excludes hidden layers from Pagefind search', async () => {
    setHiddenLayers([OVERLAY]);
    await search('focal');
    const queried = mockGetPagefind.mock.calls.map(c => c[0] as string);
    expect(queried.some(b => b.startsWith(pfBaseOf(BASE)))).toBe(true);
    expect(queried.some(b => b.startsWith(pfBaseOf(OVERLAY)))).toBe(false);
  });
});

describe('layerCoverage', () => {
  beforeEach(() => {
    setHiddenLayers([]);
    mockDescriptors.mockReset();
  });

  it('reports the layers holding the resource, hidden ones included', async () => {
    // The sheet must distinguish "you turned this off" from "nothing here",
    // so coverage is reported for every installed layer regardless of state.
    setHiddenLayers([OVERLAY]);
    const carriers = new Set([headDirOf(BASE), headDirOf(OVERLAY)]);
    mockDescriptors.mockImplementation((heads: string[], uris: string[]) =>
      Promise.resolve(carriers.has(heads[0]) ? { [uris[0]]: 'fear' } : {}),
    );

    const covered = await layerCoverage('uuid-fear');
    expect([...covered].sort()).toEqual([OVERLAY, BASE].sort());
  });

  it('treats an unreadable head as no coverage rather than failing', async () => {
    mockDescriptors.mockRejectedValue(new Error('no such head'));
    await expect(layerCoverage('uuid-fear')).resolves.toEqual(new Set());
  });
});
