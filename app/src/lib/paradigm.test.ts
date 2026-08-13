import { describe, it, expect } from 'vitest';
import { buildParadigm, type NounParadigm, type VerbParadigm, type AdjParadigm } from './paradigm';

describe('buildParadigm - noun', () => {
  // fear m1: sgNom fear, sgGen fir, sgDat fear, plNom fir, plGen fear (BuNaMo-tagged).
  const fear = [
    { writtenRep: 'fear', tags: ['masculine', 'nominative', 'singular'] },
    { writtenRep: 'fir', tags: ['genitive', 'masculine', 'singular'] },
    { writtenRep: 'fear', tags: ['dative', 'masculine', 'singular'] },
    { writtenRep: 'fir', tags: ['masculine', 'nominative', 'plural'] },
    { writtenRep: 'fear', tags: ['genitive', 'masculine', 'plural'] },
  ];

  it('pivots into a number × case grid', () => {
    const p = buildParadigm(fear, 'noun') as NounParadigm;
    expect(p.kind).toBe('noun');
    expect(p.hasPlural).toBe(true);
    const nom = p.rows.find((r) => r.case === 'nominative')!;
    expect(nom.sg.map((c) => c.text)).toEqual(['fear']);
    expect(nom.pl.map((c) => c.text)).toEqual(['fir']);
    const gen = p.rows.find((r) => r.case === 'genitive')!;
    expect(gen.sg.map((c) => c.text)).toEqual(['fir']);
    expect(gen.pl.map((c) => c.text)).toEqual(['fear']);
  });

  it('keeps cases in canonical order', () => {
    const p = buildParadigm(fear, 'noun') as NounParadigm;
    expect(p.rows.map((r) => r.case)).toEqual(['nominative', 'genitive', 'dative']);
  });

  it('does not leak gender/case into cell extras', () => {
    const p = buildParadigm(fear, 'noun') as NounParadigm;
    for (const row of p.rows) for (const c of [...row.sg, ...row.pl]) expect(c.extra).toEqual([]);
  });

  it('renders single-column when no plural present', () => {
    const p = buildParadigm(
      [{ writtenRep: 'bó', tags: ['nominative', 'singular', 'feminine'] }],
      'noun',
    ) as NounParadigm;
    expect(p.hasPlural).toBe(false);
  });
});

describe('buildParadigm - verb', () => {
  const mol = [
    { writtenRep: 'moladh', tags: ['verbal-noun'] },
    { writtenRep: 'molta', tags: ['verbal-adjective'] },
    { writtenRep: 'mhol', tags: ['past'] }, // base (analytic)
    { writtenRep: 'mholamar', tags: ['past', 'plural', 'first-person'] },
    { writtenRep: 'moladh', tags: ['past', 'autonomous'] },
    { writtenRep: 'molaim', tags: ['present', 'singular', 'first-person'] },
    // Dependent SHAPES (gramadan-generated): interrogative (dep-a) + negative (dep-n).
    { writtenRep: 'ar mhol', tags: ['past', 'dep-a'] },
    { writtenRep: 'níor mhol', tags: ['past', 'dep-n'] },
    // Radical `dependent` is superseded by dep-a/dep-n and must NOT show as base.
    { writtenRep: 'mhol', tags: ['past', 'dependent'] },
  ];

  it('pins verbal noun/adjective as principal parts', () => {
    const p = buildParadigm(mol, 'verb') as VerbParadigm;
    expect(p.kind).toBe('verb');
    expect(p.principalParts).toEqual([
      { key: 'verbal-noun', text: 'moladh' },
      { key: 'verbal-adjective', text: 'molta' },
    ]);
  });

  it('groups by tense in canonical order, persons ordered', () => {
    const p = buildParadigm(mol, 'verb') as VerbParadigm;
    expect(p.tenses.map((t) => t.tense)).toEqual(['past', 'present']);
    const past = p.tenses.find((t) => t.tense === 'past')!;
    expect(past.rows.map((r) => r.person)).toEqual(['base', '1pl', 'autonomous']);
    expect(past.rows.find((r) => r.person === '1pl')!.base[0].text).toBe('mholamar');
    expect(past.rows.find((r) => r.person === 'autonomous')!.base[0].text).toBe('moladh');
  });

  it('slots dep-a/dep-n into the interrogative/negative shape columns', () => {
    const p = buildParadigm(mol, 'verb') as VerbParadigm;
    expect(p.hasShapes).toBe(true);
    const base = p.tenses.find((t) => t.tense === 'past')!.rows.find((r) => r.person === 'base')!;
    expect(base.a.map((c) => c.text)).toEqual(['ar mhol']);
    expect(base.n.map((c) => c.text)).toEqual(['níor mhol']);
    // radical `dependent` (also "mhol") is dropped, not duplicated into base.
    expect(base.base.map((c) => c.text)).toEqual(['mhol']);
  });
});

describe('buildParadigm - adjective', () => {
  it('separates graded (comparative/superlative) forms', () => {
    const p = buildParadigm(
      [
        { writtenRep: 'gorm', tags: ['nominative', 'singular', 'masculine'] },
        { writtenRep: 'goirm', tags: ['genitive', 'singular', 'feminine'] },
        { writtenRep: 'goirme', tags: ['comparative'] },
      ],
      'adjective',
    ) as AdjParadigm;
    expect(p.kind).toBe('adjective');
    expect(p.comparison.map((c) => c.text)).toEqual(['goirme']);
    expect(p.rows.length).toBeGreaterThan(0);
  });
});

describe('buildParadigm - fallback', () => {
  it('flat-groups an unhandled POS', () => {
    const p = buildParadigm([{ writtenRep: 'x', tags: ['whatever'] }], 'preposition');
    expect(p.kind).toBe('flat');
  });

  it('routes Wiktionary lenited/eclipsed leftovers to Other', () => {
    const p = buildParadigm(
      [
        { writtenRep: 'fear', tags: ['nominative', 'singular'] },
        { writtenRep: 'fhear', tags: ['lenited'] },
      ],
      'noun',
    ) as NounParadigm;
    const other = p.other.find((g) => g.key === 'lenited');
    expect(other?.items[0].writtenRep).toBe('fhear');
  });
});
