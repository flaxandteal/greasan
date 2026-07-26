import { describe, it, expect } from 'vitest';
import { dialectCode, sourceLabelSwatch } from './family';

describe('dialectCode', () => {
  it('maps specific dialect labels to codes', () => {
    expect(dialectCode('goidelic', 'Ulster Irish')).toBe('GA.ULS');
    expect(dialectCode('goidelic', 'Connacht Irish')).toBe('GA.CON');
    expect(dialectCode('goidelic', 'Argyll Gaelic')).toBe('GD.ARG');
  });

  it('maps language-generic labels with or without "(General)"', () => {
    // Entry/settings labels keep the qualifier; sense dialects arrive stripped.
    expect(dialectCode('goidelic', 'Irish (General)')).toBe('GA');
    expect(dialectCode('goidelic', 'Irish')).toBe('GA');
    expect(dialectCode('goidelic', 'Scottish Gaelic (General)')).toBe('GD');
    expect(dialectCode('goidelic', 'Scottish Gaelic')).toBe('GD');
  });

  it('returns empty string for an unknown dialect', () => {
    expect(dialectCode('goidelic', 'Cornish')).toBe('');
  });
});

describe('sourceLabelSwatch', () => {
  it('resolves a layer swatch for a known source code, case-insensitively', () => {
    expect(sourceLabelSwatch('goidelic', 'WK')).toBe('var(--layer-wk)');
    expect(sourceLabelSwatch('goidelic', 'mb')).toBe('var(--layer-mb)');
  });

  it('gives no swatch to a merged (multi-source) chip', () => {
    expect(sourceLabelSwatch('goidelic', 'MB+WK')).toBe('');
  });
});
