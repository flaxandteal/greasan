import { describe, it, expect, vi, beforeAll } from 'vitest';

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
vi.mock('ros-madair', () => ({
  SparqlStore: vi.fn(),
}));
vi.mock('./wasm', () => ({
  ready: Promise.resolve(),
}));

import { search } from './dictionary';

describe('search', () => {
  // search uses loadResourceIndex which fetches resource_names.json
  // We mock fetch to provide test data
  const mockNames: Record<string, string> = {
    'uuid-cat': 'cat',
    'uuid-cait': 'cait',
    'uuid-cathal': 'Cathal',
    'uuid-bean': 'bean',
    'uuid-scat': 'scat',
  };

  beforeAll(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockNames),
    }) as any;
  });

  it('returns empty for blank query', async () => {
    expect(await search('')).toEqual([]);
    expect(await search('   ')).toEqual([]);
  });

  it('finds prefix matches', async () => {
    const results = await search('cat');
    const headwords = results.map(r => r.headword);
    expect(headwords[0]).toBe('cat');
  });

  it('prefix matches come before substring matches', async () => {
    const results = await search('cat');
    const headwords = results.map(r => r.headword);
    // "cat" and "Cathal" are prefix matches; "scat" is substring
    const catIdx = headwords.indexOf('cat');
    const scatIdx = headwords.indexOf('scat');
    expect(catIdx).toBeLessThan(scatIdx);
  });

  it('is case insensitive', async () => {
    const results = await search('CAT');
    const headwords = results.map(r => r.headword);
    expect(headwords).toContain('cat');
    expect(headwords).toContain('Cathal');
  });

  it('returns no results for unmatched query', async () => {
    const results = await search('zzzzz');
    expect(results).toEqual([]);
  });
});
