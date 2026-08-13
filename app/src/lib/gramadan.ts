// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin wrapper over the gramadan-wasm binding. Generates morphological forms for a
// headword (as paradigm.ts FormItem[]) when the entry has a grammatical class but
// no BuNaMo forms (Téarma). Noun and VERB are live - verbs include the realised
// interrogative (dep-a) and negative (dep-n) dependent shapes via gramadan-rs
// (see gramadan-rs/HANDOFF-verb-shape-rules.md); the subordinate (go/gur) is
// derived from dep-a in the view. Adjective still returns `supported:false`.
import init, { paradigm_forms } from './gramadan-pkg/gramadan.js';
import type { FormItem } from './paradigm';

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

export interface GeneratedParadigm {
  /** 1..5, or 0 when unknown/irregular. */
  declension: number;
  /** false ⇒ this POS isn't generated yet (verb/adjective placeholder). */
  supported: boolean;
  forms: FormItem[];
}

/** Generate forms for a headword. `pos` ∈ {noun,verb,adjective}; `cls` is the
 *  stated class ('1'..'5', or '' to let gramadan guess). Never throws. */
export async function generateForms(
  lemma: string,
  pos: string,
  gender: string,
  cls: string,
): Promise<GeneratedParadigm> {
  try {
    await ensure();
    return JSON.parse(paradigm_forms(lemma, pos, gender || '', cls || '')) as GeneratedParadigm;
  } catch (e) {
    console.warn('[gramadan] generate failed:', e);
    return { declension: 0, supported: false, forms: [] };
  }
}
