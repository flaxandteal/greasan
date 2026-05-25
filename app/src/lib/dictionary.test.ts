import { describe, it, expect, vi, beforeEach } from 'vitest';

// Provide window global for ensureStore's debug exposure
if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = globalThis;
}

// Mock WASM/alizarin modules that dictionary.ts imports at top level
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
vi.mock('ros-madair-alizarin', () => {
  function SparqlStore() { this.addLayer = vi.fn(); this.loadSummary = vi.fn(); }
  return {
    SparqlStore,
    connect_tile_source: vi.fn(),
    prefetch_tiles_for_resource: vi.fn(),
    disconnect_tile_source: vi.fn(),
  };
});
vi.mock('./wasm', () => ({
  ready: Promise.resolve(),
}));
vi.mock('./tauri-builder', () => ({
  checkLocalIndex: vi.fn().mockResolvedValue(null),
  assetUrl: vi.fn((p: string) => p),
}));

const mockSearch = vi.fn();
const mockFilters = vi.fn().mockResolvedValue({});
vi.mock('./pagefind', () => ({
  getPagefind: vi.fn(() => Promise.resolve({ search: mockSearch, filters: mockFilters })),
  resetPagefind: vi.fn(),
}));

import { search, addDynamicLayer } from './dictionary';

describe('search', () => {
  beforeEach(async () => {
    mockSearch.mockReset();
    mockFilters.mockReset().mockResolvedValue({});
    // Register a mock layer so search doesn't bail on empty layers
    await addDynamicLayer('/mock-layer/', 'mock', '/mock-layer/pagefind-ga');
  });

  it('returns empty for blank query', async () => {
    expect(await search('')).toEqual([]);
    expect(await search('   ')).toEqual([]);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('maps pagefind results to EntrySummary', async () => {
    mockSearch.mockResolvedValue({
      results: [
        { data: () => Promise.resolve({ url: 'uuid-cat', meta: { title: 'cat' }, excerpt: '' }) },
        { data: () => Promise.resolve({ url: 'uuid-bean', meta: { title: 'bean' }, excerpt: '' }) },
      ],
    });

    const results = await search('cat');
    expect(results).toEqual([
      { uri: 'uuid-cat', headword: 'cat', pos: '' },
      { uri: 'uuid-bean', headword: 'bean', pos: '' },
    ]);
  });

  it('limits results to 50', async () => {
    const manyResults = Array.from({ length: 80 }, (_, i) => ({
      data: () => Promise.resolve({ url: `uuid-${i}`, meta: { title: `word${i}` }, excerpt: '' }),
    }));
    mockSearch.mockResolvedValue({ results: manyResults });

    const results = await search('word');
    expect(results).toHaveLength(50);
  });

  it('returns empty on pagefind error', async () => {
    mockSearch.mockRejectedValue(new Error('network'));
    const results = await search('test');
    expect(results).toEqual([]);
  });
});
