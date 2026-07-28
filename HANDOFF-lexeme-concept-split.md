# Hand-off — Headword / Lexeme / Concept split

For a **separate session.** Promote the lexicographic model from *headword-only*
to the OntoLex three-layer shape: **`LexicalEntry` (Headword) → `LexicalSense`
(Lexeme) → definition (Gloss/Brí)**, plus a **`LexicalConcept`** layer sourced
from Logainm. This is a model + pipeline + frontend pass; it is NOT started.

---

## 0. Why, and what's already true

**The problem it solves.** Today a sense has no identity — nothing can *link to*
a meaning. That's why placenames could only ever point at a headword form (and,
before this session's fix, the wrong POS). A placename wants the *geographic
meaning*; a sense-specific etymology wants *that sense*; neither has a target.

**Current model (unchanged).** `models/lexical_entry/nodes.csv`: senses are a
**cardinality-`n` tile nodegroup on the LexicalEntry** — `senses` (`semantic`,
`ontolex:LexicalSense`) with child `gloss` (`skos:definition`), `example`,
`source_label`, `sense_dialect`. So a sense is a sub-record of the headword, not
a resource. There is **no `LexicalConcept`**.

**Precursor done this session (Entry-level, correct, keep it).**
- Placename → **Headword** linking fixed: `build-place-layer.mjs` decomposes names
  against Logainm's 211-element glossary and resolves to the correct
  `goi-<head>-<POS>` (killed the `[0]`/wrong-POS bug). This is the interim you
  signed off on ("link *Fear* to all its senses, not the wrong one").
- **Logainm glossary pulled** → `data/raw/logainm-glossary.json` (211 elements:
  `{id, headword, translation, forms, count}`) via `pull-logainm-glossary.mjs`.
  This is the **Concept seed**, currently only a build-time lookup.

---

## 1. Decisions already locked (do not relitigate)

1. **Lexeme identity is SOURCE-LOCAL.** A lexeme is "*Wiktionary's* sense 2 of
   *fear*" — `goi-fear-noun/wk/2` — never "*the* second sense". You do NOT align
   Wiktionary sense 2 with Téarma sense 3. That cross-source reconciliation is an
   open-ended lexicographic project and is explicitly **out of scope**. Its
   absence is *why* this is affordable.
2. **Headword stays POS-distinct.** Keep `goi-<head>-<pos>` as the shared
   composition key (Irish/Scottish *fear* still compose). Do NOT demote POS onto
   the lexeme — forms/paradigms are POS-bound and the continuum composition is
   per-POS.
3. **Concept vocabulary comes from Logainm's bounded taxonomy** (the 211
   elements), NOT from reconciling dictionary senses.
4. **Attach levels:** Headword = default (everything today); Lexeme = only
   genuinely sense-specific things; Concept = the meaning target.
5. **MacBain:** etymology is whole-word → **Headword**; its cross-language
   cognates are the one genuine **Headword↔Headword** relation.
6. **Display:** numbered lexemes `1. … 2. …`, grouped **per source** (WK 1,2,3;
   Téarma 1,2), reusing the existing source chips — honest about not merging
   senses across sources.

---

## 2. The three levels

### Headword — `ontolex:LexicalEntry` (mostly as now)
`goi-<head>-<pos>`. Keeps `part_of_speech`, `dialect` rollup, `grammar_class`,
the `forms` nodegroup, IPA, headword-level etymology (MacBain), placename links,
cognates. **Loses** the `senses` nodegroup (moves out to Lexeme resources).

### Lexeme — `ontolex:LexicalSense` (NEW, first-class resource)
- **ID:** `goi-<head>-<pos>/<src>/<n>` — source-local (e.g. `goi-fear-noun/wk/2`).
- **Link to headword:** `ontolex:sense` (headword→lexeme) or its inverse
  `ontolex:isSenseOf` (lexeme→headword) — pick the one the hydrate can gather
  cheaply (see §4).
- **Fields:** `gloss` (Brí, cardinality-n allowed), `example`, `source_label`,
  `sense_dialect`, `sort_order` (the "1./2." number, per-source).
- **Optional:** `ontolex:evokes` → `LexicalConcept`.

### Concept — `ontolex:LexicalConcept` (NEW, from Logainm)
- **ID:** `lgc-<elementId>` (e.g. `lgc-8` = *abhainn*).
- **Fields:** label (element headword), `forms`, `count`. **NOT** the Logainm
  `translation` text — that's a © Government of Ireland explanatory note; use it
  only to disambiguate/map at build time (§5), render our own Brí.
- **Relations:** placename → concept (`element_entry` retargeted); concept →
  Headword (the resolution `build-place-layer.mjs` already computes).

---

## 3. Composition (cross-layer) — the load-bearing constraint

- **Headword composition unchanged** — `goi-<head>-<pos>` is one shared UUID
  across layers.
- **Lexemes are per-source children → they LIST, not merge.** A composed entry's
  senses = the *union* of each layer's lexemes, grouped by source. **No
  cross-source sense dedup** (that's the alignment we're avoiding). Within a
  single source, dedup as today.
- **Hydrate implication:** sense hydration stops being a tile-walk on the entry
  and becomes a *gather of child lexeme resources across the layer stack*. That's
  the main `ros-madair`/`loadEntryV2` change — either a headword→lexeme link the
  hydrate expands, or an indexed reverse-link (like `cited_by` on
  `element_entry`) from lexemes to their headword.

---

## 4. Placename → Concept re-point (the payoff)

- **Now:** placename `element_entry` → Headword (`goi-<head>-<pos>`).
- **Split:** placename `element_entry` → **Concept** (`lgc-<elementId>`); the
  Concept relates to the Headword.
- The **211 glossary elements become the `LexicalConcept` resources**; the
  `elementResolve` map in `build-place-layer.mjs` (element → `goi-<head>-<POS>`)
  becomes the concept→headword relation.
- Bonus: **diminutives get a home.** `coillín` becomes its own concept
  (`lgc-<coillín>`) with a `diminutive-of` relation to `coill`'s concept —
  instead of the unsafe strip-to-base we rejected. Recovers the ~6 diminutives +
  the 18 remaining no-dict elements *as concepts* even without a headword.

---

## 5. Build pipeline changes

- **`models/lexical_entry/`:** move the `senses` nodegroup out into a
  `LexicalSense` resource (own model, or a promoted sub-resource on the shared
  graph). Add a `LexicalConcept` model.
- **`src/goidelic/ontolex.py`:** `shape_entry` currently returns nested
  `senses[]`; instead emit each sense as a separate `LexicalSense` resource id
  (`goi-<head>-<pos>/<src>/<n>`) with a headword link.
- **`src/goidelic/arches.py`:** emit the lexeme resources + the headword↔lexeme
  link (and the same for `tearma`/`bunamo`/`macbain` builders — they all shape
  senses the same way).
- **New concept builder:** materialise `data/raw/logainm-glossary.json` → 211
  `LexicalConcept` resources; retarget `build-place-layer.mjs`'s `element_entry`
  from the headword to the concept.
- **v2 emit + hydrate:** lexemes as child resources; `loadEntryV2` gathers them
  (§3) and flattens to the `EntryDetail.senses` shape it already uses.

---

## 6. Display (`app/src/views/EntryDetail.svelte`)
The Senses section becomes **numbered lexemes** (`1. … 2. …`) in **per-source
blocks** (using `sort_order` + the existing `source_label` chips). Headword-level
sections (etymology, forms, placenames, IPA) are untouched. `loadEntryV2` keeps
returning a flat `senses[]` — just now sourced from lexeme resources with a
source+order — so the view change is mostly grouping/numbering.

---

## 7. Scope guardrails
- Source-local lexemes only; **no** cross-source sense alignment.
- Headword stays POS-distinct and remains the composition key.
- Concepts = Logainm's 211 (bounded); do not reconcile dictionary senses into concepts.
- Never render Logainm's `translation` (© Gov explanatory note) — map with it, show our own gloss.
- **Migration is additive:** the placename→Headword links shipped this session keep working through the transition; the concept re-point layers on top.

## 8. Open questions / risks
- **Hydrate cost** — gathering child lexeme resources per entry vs the current
  tile-walk. Measure before committing (this is the real ros-madair change).
- **Own graph vs promoted nodegroup** for `LexicalSense` — which composes/hydrates cleaner.
- **Numbering** — per-source (recommended) vs a global "1..N".
- **Search** — Pagefind still indexes at the headword level (as now); lexeme
  glosses stay indexed content, not separate search records.

## 9. Key files / pointers
| Thing | Location |
|---|---|
| senses-as-tiles (to split) | `models/lexical_entry/nodes.csv` (`senses` nodegroup, lines ~8–12) |
| sense shaping | `src/goidelic/ontolex.py` (`shape_entry`), `arches.py` (emit) |
| other builders (same sense shape) | `build-macbain-layer.mjs`, `build-bunamo-*`, `tbx.py` |
| Concept seed | `data/raw/logainm-glossary.json` (211), `pull-logainm-glossary.mjs` |
| element→headword map (→ concept→headword) | `build-place-layer.mjs` (`elementResolve`, `element_entry`) |
| entry hydrate / sense flatten | `app/src/lib/dictionary-v2.ts` (`loadEntryV2`, `extractSenses`) |
| senses display → numbered lexemes | `app/src/views/EntryDetail.svelte` |
