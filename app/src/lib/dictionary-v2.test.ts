import { describe, it, expect, vi } from 'vitest';

// dictionary-v2 pulls the Tauri v2 bridge at import; stub it (we only test the
// pure normHead identity function).
vi.mock('./v2', () => ({
  hydrateLayers: vi.fn(),
  citedBy: vi.fn(),
  descriptors: vi.fn(),
}));

import { normHead } from './dictionary-v2';

describe('normHead — same-lexeme identity (cross-layer join key)', () => {
  it('folds accent CONVENTION: acute = grave = macron', () => {
    // Irish acute, Scottish grave, MacBain macron — all the same lexeme.
    expect(normHead('bás')).toBe(normHead('bàs'));
    expect(normHead('mór')).toBe(normHead('mòr'));
    expect(normHead('mór')).toBe(normHead('mōr'));
  });

  it('PRESERVES length: accented ≠ unaccented', () => {
    // This is the bug the gate fixes — MacBain "bàs" must NOT fold into "bas".
    expect(normHead('bás')).not.toBe(normHead('bas'));
    expect(normHead('fear')).not.toBe(normHead('féar'));
  });

  it('casefolds and NFC-normalises', () => {
    expect(normHead('BÁS')).toBe(normHead('bás'));
    // Decomposed a + combining acute → same as precomposed á.
    expect(normHead('bás')).toBe(normHead('bás'));
  });

  it('leaves distinct spellings distinct', () => {
    expect(normHead('ceann')).not.toBe(normHead('ceo'));
  });
});
