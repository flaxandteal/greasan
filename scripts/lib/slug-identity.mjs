/**
 * slug-identity.mjs — the single JS copy of the goi- CONCEPT identity normaliser.
 *
 * A LexicalConcept's ResourceID is `goi-<normhead>-concept`, and the same id must
 * be minted identically by every JS corpus builder AND by the on-device Rust TBX
 * build (builder_plugin.rs `concept_normalize_head`/`concept_resource_id`) - a
 * mismatch silently breaks cross-layer merge. This used to be copy-pasted into
 * concept-emit.mjs, build-macbain-layer.mjs and build-logainm-layer.mjs; it now
 * lives here once, and is asserted against tests/fixtures/slug-golden.json.
 *
 * CONCEPT normalisation is deliberately LIGHTER than the entry-slug one
 * (src/goidelic/slug_identity.py): NFC + lowercase + grave/acute→macron ONLY -
 * NO whitespace→hyphen and NO punctuation strip, so "Bun os cionn" keeps its
 * spaces and "cé'n" keeps its apostrophe. (The entry slug drops both.)
 */

// Irish acute + Scottish grave fold to a macron (dialect-neutral length marker);
// length is preserved, never ASCII-stripped.
/** @type {Record<string, string>} */
const MACRON = { 'à': 'ā', 'á': 'ā', 'è': 'ē', 'é': 'ē', 'ì': 'ī', 'í': 'ī', 'ò': 'ō', 'ó': 'ō', 'ù': 'ū', 'ú': 'ū' };

/** Concept-level headword identity: NFC + lowercase + macron fold.
 * @param {string} text @returns {string} */
export function normalizeHead(text) {
  const s = (text || '').normalize('NFC').toLowerCase();
  return Array.from(s, (ch) => MACRON[ch] || ch).join('');
}

/** The concept ResourceID for a headword (POS-independent).
 * @param {string} headword @returns {string} */
export function conceptResourceId(headword) {
  return `goi-${normalizeHead(headword)}-concept`;
}
