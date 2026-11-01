import { describe, it, expect } from 'vitest';
import { posKind } from './paradigm';

describe('posKind', () => {
  it('treats proper nouns as non-inflecting (not "noun")', () => {
    // "proper noun" contains the token "noun"; it must NOT be declined.
    expect(posKind('proper noun')).toBe('other');
    expect(posKind('Proper Noun')).toBe('other');
  });

  it('still classifies common nouns / verbs / adjectives', () => {
    expect(posKind('noun')).toBe('noun');
    expect(posKind('verb')).toBe('verb');
    expect(posKind('adjective')).toBe('adjective');
    expect(posKind('phrase')).toBe('other');
  });
});
