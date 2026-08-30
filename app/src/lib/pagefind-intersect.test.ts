import { describe, it, expect } from 'vitest';
import {
  resourceIdsForResults,
  intersectResults,
  resourceIdsFromV2Result,
} from './pagefind-intersect';
import type { V2Result } from './v2';

const cat = new Map([
  ['h1', 'rA'],
  ['h2', 'rB'],
  ['h3', 'rC'],
  ['h4', 'rD'],
]);
const results = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }, { id: 'h4' }];

describe('resourceIdsForResults', () => {
  it('maps hashes to resource ids, dropping unmapped', () => {
    expect(resourceIdsForResults([{ id: 'h1' }, { id: 'h3' }, { id: 'nope' }], cat)).toEqual([
      'rA',
      'rC',
    ]);
  });
});

describe('intersectResults', () => {
  it('keeps only the overlap, in pagefind rank order', () => {
    // structured set {rD, rB} - result preserves pagefind order (h2 before h4)
    expect(intersectResults(results, cat, new Set(['rD', 'rB']))).toEqual(['rB', 'rD']);
  });

  it('accepts any iterable for the other set (array)', () => {
    expect(intersectResults(results, cat, ['rC'])).toEqual(['rC']);
  });

  it('dedups repeated hashes', () => {
    expect(intersectResults([{ id: 'h1' }, { id: 'h1' }], cat, new Set(['rA']))).toEqual(['rA']);
  });

  it('empty catalogue yields [] (caller falls back to hydrate-all)', () => {
    expect(intersectResults(results, new Map(), new Set(['rA']))).toEqual([]);
  });

  it('no overlap yields []', () => {
    expect(intersectResults(results, cat, new Set(['zzz']))).toEqual([]);
  });
});

describe('resourceIdsFromV2Result', () => {
  const mk = (columns: string[], rows: (string | number | null)[][]): V2Result => ({
    measure: 'select_ids',
    coarse: false,
    columns,
    rows,
  });

  it('extracts the resource_id column by default', () => {
    const r = mk(['resource_id'], [['rA'], ['rB'], ['rA']]);
    expect(resourceIdsFromV2Result(r)).toEqual(new Set(['rA', 'rB']));
  });

  it('honours a custom column name and ignores non-strings', () => {
    const r = mk(['count', 'uri'], [[3, 'rX'], [1, null]]);
    expect(resourceIdsFromV2Result(r, 'uri')).toEqual(new Set(['rX']));
  });

  it('missing column yields empty set', () => {
    expect(resourceIdsFromV2Result(mk(['count'], [[1]]))).toEqual(new Set());
  });
});
