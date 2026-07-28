# OntoLex alignment plan

Bring the Arches resource model into line with the OntoLex-Lemon stack and with
`ontology/goidelic.ttl` — which is presently **richer than the model built from
it**. Six ontology constructs are defined in Turtle but have no node in the
model; two node URIs were outright broken (fixed, Phase 0). Each phase below
lists its **Model** (CSV), **Ontology** (mostly already defined), **ETL**
(`src/goidelic/*.py`, the `.mjs` layer builders, the Rust `regen-*-v2` examples),
**UI** (`EntryDetail.svelte` et al.), and **Validation** touchpoints.

Cross-refs: `HANDOFF-lexeme-concept-split.md` (Phase 1 detail),
`HANDOFF-ondevice-tbx-v2.md`, `HANDOFF-grammar-class-inference.md`.

---

## Sequencing rationale

Ordered by *value ÷ blast-radius*, and so that a rebuild is amortised across
related changes (mutation + register + notation all touch the `forms`
nodegroup, so they ship together).

| Phase | Theme | Value | Cost | Rebuild |
|---|---|---|---|---|
| 0 | Broken URIs | correctness | trivial | model only (done) |
| 1 | Sense → resource + Concept layer | placename→meaning payoff | high | full |
| 2 | Provenance (`WiktionarySource`) | licensing "non-negotiable" | med | full |
| 3 | Etymology graph (`EtyLink` + typed links + `isPartOfEtymologyGraph`) | unblocks Oxigraph + cognate typing | high | full |
| 4 | Forms enrichment (mutation / register / notation) | local-ontology headline features | med | full |
| 5 | Leaf-class + `UsageExample` cleanup | consistency / RDF round-trip | low | model only |

Rebuilds are expensive (~20 min APK). Land each phase's **model + ETL + fixture
validation** first, checkpoint, then batch the full-corpus rebuild.

---

## Phase 0 — Broken URIs  ✅ DONE

- `ipa_value`, `written_rep`: node class `ontolex:Representation` (non-existent)
  → `rdfs:Literal`. Edges (`phoneticRep`/`writtenRep`) were already correct.
- `gloss`: node class `skos:Definition` (non-existent) → `rdfs:Literal`.
- `etymology`/`cognates`/`related_entries` edges: `ety:hasEtymology` /
  `ety:hasEtymon` (dangling — not in lemonEty, not local) → `goi:hasEtymology` /
  `goi:hasEtymon`, now **defined** in `goidelic.ttl` as interim flattened
  shortcuts (Phase 3 replaces them with typed `ety:EtyLink`).
- Files: `models/lexical_entry/nodes.csv`, `ontology/goidelic.ttl`.
- Validation: rdflib parse OK (215 triples). **Propagates on next model build**;
  no runtime app change (app doesn't yet export RDF).

---

## Phase 1 — `LexicalConcept` layer + sense-as-resource

**Scoping finding (Explore, done).** Senses today are a **zero-cost tile-walk**:
`loadEntryV2`→`extractSenses` (`app/src/lib/dictionary-v2.ts:159-180,210`) reads
the already-composed tree; cross-layer merge is raw tile concatenation
(`ros-madair-client/src/lib.rs:687,770` — no tile-level dedup), with dedup
deferred to TS `mergeSenses` (`:189-204`, key = gloss+examples+dialect). Two
child-gather precedents exist, both starting from `citedBy` (`v2.ts:143-149`):
(a) **`external_examples`** — `citedBy`→`descriptors` batch (`dictionary-v2.ts:307-321`),
O(1) per entry, but yields only a spine `display_name` string per child;
(b) **cognate-fold** — `citedBy`→`hydrateLayers` per child (`:273-292`), **N+1
full hydrate**, structured fields preserved. Pagefind indexes at entry
granularity (`build-*-layer.mjs`), so promotion is search-safe *iff* the build
keeps rolling gloss/example text onto the parent entry's record.

**Consequence — the phase splits.** The placename→meaning payoff does **not**
require sense-as-resource; it needs the `LexicalConcept` layer + concept↔headword
links (all entry/concept-level, no sense hydration touched). Sense-promotion is
the separable OntoLex-purity piece that carries the N+1 concern. So:

### Phase 1a — `LexicalConcept` layer (the placename payoff) — IN PROGRESS
Fully additive; **zero hydrate-cost risk**. Keeps this session's
placename→Headword `element_entry` links intact and layers concepts on top
(`HANDOFF-lexeme-concept-split.md` §4, §7).

**Done + validated:**
- `models/lexical_concept/` created (graph + nodes + collections). Loads via
  alizarin; **graph id `c5d452c6-5ab6-53e6-a7e8-b2e9f2495c90`** (deterministic).
  Nodes: `label` (skos:prefLabel), `place_count` (goi:placeCount),
  `concept_headword` (n, goi:isEvokedBy → LexicalEntry), `diminutive_of`
  (goi:diminutiveOf → concept). Forms deliberately NOT shipped — they're
  build-time matching data, they stay in `logainm-glossary.json`.
- Ontology props added + rdflib-validated: `goi:isEvokedBy` (owl:inverseOf
  ontolex:evokes), `goi:diminutiveOf`, `goi:placeCount`, `goi:conceptEntry`.

**Architecture constraint (Explore, done): one head ships one `graph.json`.**
Even though `ros_madair_emit::emit` bundles every graph in a prebuild dir into
one head, only ONE model sits beside it (`v2.rs` hardcodes `graph.json`;
`load_graph` parses a single `StaticGraph`). Which model a resource
full-hydrates against is decided purely by which head is `headDirs[0]` at the
call site — there is no graph-id dispatch. Consequence:
- **Display (label + reverse-links) is graph-agnostic** — `v2_descriptors` /
  `v2_cited_by` / `v2_geo_points` scan by UUID, no graph. So concepts
  **co-located in place-v2** render their `label` and answer reverse-links with
  **zero app/Rust changes**.
- **Full concept detail-hydrate** (its structured tree) would need concepts as
  their **own** `concept-v2` head + a `V2_LAYERS` entry
  (`app/src/lib/dictionary.ts:477`) + a `hydrateLayers([conceptHead], id)` call
  site. Deferred — 1a doesn't need it; 1b's `evokes`-hydration will.

**Decision for 1a: concepts get their OWN `concept-v2` head** (full-hydratable),
not co-located. A placename's `concept_entry` is hydrated concept-authoritative
(head = concept graph), mirroring `placeHeadDir`/`hydratePlace`. Wiring
touchpoints (all 8):
1. `build-place-layer.mjs` — emits `data/concept-v2` via a 2nd `regen-layer-v2`.
2. `models/lexical_concept/` — the model.
3. `models/place/nodes.csv` — `concept_entry` node.
4. `ontology/goidelic.ttl` — the 4 concept props.
5. `app/src/lib/dictionary.ts` — `V2_LAYERS` entry + `conceptHeadDir()`.
6. `app/src-tauri/src/offline.rs` — `CorpusSpec` (langs `&[]`, no pagefind).
7. `app/src-tauri/tauri.conf.json` — head resource entry.
8. `scripts/build-apk.sh` — `concept-v2` in `HEADS`.
UI: `MapView.svelte` renders the canonical concept label on placename elements
(descriptor batch against `conceptHeadDir()`), surface on hover.

**Gotcha logged:** a new head in `tauri.conf.json` `resources` makes tauri's
build script fail any `cargo run --example` until `data/bundle/heads/<head>.zip`
exists — seed an empty zip once; `build-apk` re-zips the real content (its
`-nt` check fires on the fresh `head.sqlite`).

**Builder — DONE + unit-validated:**
- `matchElements` re-keyed by element id (the concept identity), carrying the
  optional resolved headword; now matches headword-less elements too.
- `build-place-layer.mjs` loads the concept model, emits the 211 concepts
  (`label` + `place_count` + `concept_headword`) into `prebuild-place`, and
  stamps `concept_entry` on each matched placename `name_element`.
- `models/place/nodes.csv`: `concept_entry` node added (ontolex:LexicalConcept,
  goi:conceptEntry) beside `element_entry` (which stays).
- Validated: syntax OK; `conceptUuid('lgc-X')` == the builder's
  `resourceinstanceid` (so `concept_entry` refs resolve).

**Next:** UI — placename detail renders the concept label; then rebuild
(place-v2) + push. Then Phase 1b.
- **Model:** id `lgc-<elementId>`. Concepts live in the **place-v2 head**.
- **ETL:** emit the 211 concepts from `data/raw/logainm-glossary.json` in
  `build-place-layer.mjs` (it already loads the glossary + builds `elementResolve`
  = element→`goi-<head>-<pos>`); **add** a `concept_entry` ref on the placename
  `name_element` (placename→concept) *alongside* the existing `element_entry`
  (placename→headword). Diminutives become their own concept + `diminutive_of`.
- **UI:** placename detail shows the concept (our own gloss, **not** Logainm's
  `translation`); entry detail's placename section unchanged (still via
  `element_entry` reverse-link).
- **Validation:** 211 concepts emitted; every resolved element has a
  concept→headword; fixture placenames gain a concept_entry.

### Phase 1b — sense → `ontolex:LexicalSense` resource (OntoLex purity)
The N+1-vs-descriptors decision lives here. Structured sense cards (gloss +
examples[] + source + dialect + numbering) don't collapse into a single
descriptor string, so the honest options are: full-hydrate per sense
(cognate-fold precedent, N+1 — cost it on a high-sense-count entry) **or** a
hybrid where the sense keeps its inline tile for display but gains a stable URI
for linking. Also **relocates dedup**: `mergeSenses` (runtime, over tiles) →
build-time `_merge_resource` (`ontolex.py:122-128`). Add `ontolex:evokes`
(sense→concept). Detail per `HANDOFF-lexeme-concept-split.md` §2-3.
- **UI:** `EntryDetail.svelte` senses → numbered per-source blocks (`1. … 2. …`).

---

## Phase 2 — Provenance: `WiktionarySource` as a real resource

CLAUDE.md calls per-entry provenance "non-negotiable"; the model has only a bare
`source_label` string typed with the property `dct:source`.

- **Ontology:** already defined — `:WiktionarySource` + `:wiktionaryUrl`,
  `:historyUrl`, `:dumpDate`, `:kaikkiExtractDate`, `:wiktextractCommit`
  (goidelic.ttl:283–318). No ontology work.
- **Model:** replace `source_label` with a `source` nodegroup (or Source
  resource, many-to-one) carrying the five provenance fields + `dct:license`.
  Node class `:WiktionarySource`, edge `dct:source`.
- **ETL:** the manifests already record dump date / kaikki extract date /
  wiktextract commit per run — thread those from `manifests/*.json` into the
  shaper so each entry references its source. Layer builders (`.mjs`) stamp the
  layer's own provenance.
- **UI:** source chips already exist; extend the entry footer to a citation line
  (URL + history link + dump date). **Never** enumerate contributors — link the
  history page (CLAUDE.md).
- **Validation:** every emitted entry has a resolvable source; `LICENSE` +
  `provenance.json` still emitted per bundle.

---

## Phase 3 — Etymology graph: `EtyLink` + typed links

Highest-leverage structural fix. Today `etymology` is a prose blob and cognates
hang off the entry via the flat `goi:hasEtymon` shortcut with **no link type** —
can't say inheritance vs borrowing vs cognate. And `:isPartOfEtymologyGraph`
(goidelic.ttl:330) is defined but unused, so the "separable etymology subgraph →
Oxigraph WASM" architecture constraint has **no hook in the data**.

- **Ontology:** `ety:Etymology`, `ety:EtyLink`, `ety:Etymon` classes exist;
  confirm/define the link-type individuals (derivation / borrowing / inheritance
  / cognate / calque) and the `ety:etyLink` / `ety:etymon` predicates we target.
  Retire the interim `goi:hasEtymology` / `goi:hasEtymon` once the structured
  path lands (leave defined but mark deprecated).
- **Model:** `etymology` (`ety:Etymology`) → `ety:etyLink` → `EtyLink`
  nodegroup (carries link type + source) → `ety:etymon` → `Etymon`. Add
  `:isPartOfEtymologyGraph` boolean on the etymon/link nodes.
- **ETL:** parse `etymology_templates` (structured) with `etymology_text`
  fallback — the deferred "etymology stage" in CLAUDE.md's pipeline. MacBain
  cognates get typed links. Emit the flagged subgraph as a standalone RDF subset.
- **UI:** etymology section renders typed edges (cognate list already exists;
  add the relation label). Oxigraph-backed etymology queries become possible.
- **Validation:** etymology subset round-trips to Turtle; SHACL over EtyLink.

---

## Phase 4 — Forms enrichment: mutation / register / notation

Three defined-but-unused constructs that all attach to the `forms` nodegroup, so
they ship in one model+rebuild pass. `normalise.py` already computes most of the
underlying data (mutation detection, séimhiú-dot vs lenis-h, Caighdeán marking).

- **Mutation processes:** `:Lenition` / `:Eclipsis` individuals +
  `:resultOfProcess` / `:hasBaseForm` (goidelic.ttl:44–101). Add a
  `form_mutation` node on `forms` → the process individual; lenited/eclipsed
  forms become distinguishable from ordinary inflection.
- **Register:** `:Register` + `:CaighdeanOifigiuil` / `:PreCaighdean` +
  `:hasRegister` (goidelic.ttl:222–238). Add `form_register` (and possibly
  `sense_register`) — CLAUDE.md: don't collapse standard vs pre-standard.
- **Notation:** `:NotationalVariant` + `:DotAboveSeimhiu` / `:LenisHSeimhiu` +
  `:hasNotationalVariant` (goidelic.ttl:251–273). Tag each `written_rep` with
  its notation so dot-above vs lenis-h is labelled, not just glyph-preserved.
- **ETL:** surface what `normalise.py` already derives into these nodes across
  `ontolex.py` / `arches.py` / the layer builders.
- **UI:** forms table gains mutation/register/notation columns or badges.
- **Validation:** fixture forms show the right mutation/register on known lemmas
  (e.g. `bhfear` eclipsis, a pre-Caighdeán spelling, a dot-above variant).

---

## Phase 5 — Leaf-class + `UsageExample` cleanup (consistency sweep)

Cosmetic-on-export but needed for a clean RDF round-trip.

- **Leaf classes:** the `goi:*` datatype-properties used as node *class*
  (`etymologyText`, `etymologySource`, `cognateHeadword`, `cognateLanguage`,
  `cognateEntryId`, `grammaticalClass`) and `dct:source` on `source_label` →
  `rdfs:Literal` (edge property stays the real predicate). Batch with whichever
  phase last touches each node; anything left over swept here.
- **`UsageExample` modelled twice:** inline string `example` (`lxg:usageExample`)
  on senses vs `external_examples` resource (same class+property). Unify on the
  resource form (`lexicog:UsageExample` with `rdf:value`); senses reference
  examples rather than inlining a string.
- **`grammar_class`:** currently a free string. Consider a controlled
  vocabulary/collection (like POS) for declensions (fir1–5 / bain2–5 / a1–3) —
  optional, low priority.

---

## Global validation (all phases)

- rdflib parse of `goidelic.ttl` stays clean.
- pyshacl over generated resources (shapes from the ontology).
- Round-trip: Arches business data → OntoLex Turtle → diff vs re-extraction.
- Fixture (`--fixture`) green before any full-corpus rebuild.
