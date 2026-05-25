# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Goidelic Wiktionary extraction for Rós Madair / Alizarin

## Purpose

Extract a properly-cited Goidelic dictionary (Irish `ga` + Scottish Gaelic `gd`) from Wiktionary — via Kaikki.org's pre-extracted JSONL — and transform it into Arches resource instances backed by a real lexicographic ontology, suitable for stress-testing Rós Madair / Alizarin templating at realistic scale and for delivery as a phone-cached static bundle.

This is a **test corpus**, not a production lexicon. Goals:

1. Exercise Alizarin templates against structurally varied lexicographic data (~50k+ lemmas across two Goidelic languages, mixed sense density, etymology graphs, dialect tagging, uneven IPA coverage).
2. Validate the `arches-data` pipeline against a non-heritage domain.
3. Establish a reusable pattern for ingesting CC BY-SA corpora with attribution and reproducibility intact.
4. Produce a static bundle (via `exportPrebuild` and Pagefind) that an `alizarin-wasm` app can render offline, demonstrating the end-to-end Rós Madair / Alizarin / Pagefind path against a non-trivial corpus.

## Data model: dialect-first

Entries from all Goidelic languages share a single `LexicalEntry` resource model. Dialect is the sole entry point — every entry is tagged with a dialect concept. Language groups dialects but isn't on entries directly.

- **Dialect** is the first-class concept. Every entry must have one. Entries without explicit Wiktionary dialect tags get a "General" dialect for their language (e.g. "Irish (General)", "Scottish Gaelic (General)").
- **Language** is an organizational grouping in the collection hierarchy. The settings UI queries "all dialects grouped by language" via this hierarchy.
- Resource IDs are prefixed by language code (`ga-focal-noun`, `gd-focal-noun`) to avoid collisions.

## Stack: Python (not Rust) — and the reason

Recorded here so we don't relitigate this every time someone fresh joins the project.

- The expensive work (template + Lua expansion of raw Wiktionary wikitext) is done upstream by Wiktextract. We consume pre-baked JSONL from Kaikki.
- Goidelic post-processed JSONL is on the order of 30–100 MB / 50–500k records. With orjson, full ingestion is seconds to low minutes. We are nowhere near the regime where Rust pays back.
- The hard parts are domain logic — initial mutations, dialect tag reconciliation, etymology graph parsing, Caighdeán vs pre-Caighdeán orthography. Iteration speed matters far more than raw throughput.
- Existing `arches-data` and `arches-model` skill pipelines are Python. Consistency reduces friction.
- If a hot loop ever appears, reach for **polars** or **duckdb** (both Rust-backed under the hood), or drop a single function into PyO3. Don't rewrite the project.

Revisit this decision only if scope expands to all Goidelic + Brythonic, or to the full multilingual Wiktextract output (20 GB+).

## Source data

**Primary**: Kaikki.org's post-processed JSONL for each configured language, refreshed against the latest enwiktionary dump every few days.

- Each line is a JSON object for one (word, lang, POS) triple.
- Fields used: `word`, `lang_code`, `pos`, `senses[]` (with `glosses`, `examples`, `categories`, `tags`), `etymology_text`, `etymology_templates`, `sounds[]` (IPA, audio URLs), `forms[]`, `head_templates`, `translations[]`.
- Form-of pages (lenited/eclipsed forms like `bhfear`) are present as separate entries with `form_of` references — strategy below.

**Currently configured languages**:
- `ga` (Irish) — `kaikki.org-dictionary-Irish.jsonl`
- `gd` (Scottish Gaelic) — `kaikki.org-dictionary-Scottish_Gaelic.jsonl`

**Secondary (deferred)**: `ga.wiktionary` for Irish-glossed labels. Smaller, but useful as a label source if/when we want non-English UI text.

## Ontology backbone

Resource models are backed by published ontologies — not invented strings. Arches references real URIs in nodegroup definitions; the resource graph round-trips to OntoLex-Lemon Turtle without information loss.

**Standard imports**:

- **OntoLex-Lemon** (`http://www.w3.org/ns/lemon/ontolex#`) — core lexical structure: `LexicalEntry`, `Form`, `LexicalSense`, `LexicalConcept`, the `canonicalForm` / `otherForm` / `lexicalForm` properties, `writtenRep`, `phoneticRep`, etc.
- **Lexicog** (`http://www.w3.org/ns/lemon/lexicog#`) — dictionary editorial structure: `Entry` (wraps LexicalEntry with editorial metadata), `UsageExample`, headword conventions.
- **OntoLex etymology module** (lemonEty / `ety:` — Khan et al., the published OntoLex extension for etymology) — `Etymology`, `EtyLink`, `Etymon`, link types (`derivation`, `cognate`, `borrowing`, `inheritance`, `calque`).
- **LexInfo** (`http://www.lexinfo.net/ontology/3.0/lexinfo#`) — grammatical features: parts of speech, gender, number, case, mood, tense, person. Use these URIs directly; do not invent local equivalents.

**Local extension**: `ontology/goidelic.ttl`, namespace `https://flaxandteal.org/ontology/goidelic#`. Imports the above. Defines what isn't covered upstream:

- **Language**: `Irish`, `ScottishGaelic`, `Manx` — organizational groupings for dialects.
- **Initial mutations**: `Lenition` (séimhiú), `Eclipsis` (urú), `H-prothesis`, `T-prothesis` — modelled as individuals of `MorphophonologicalProcess` so they can attach to Form resources as the process that produced them.
- **Dialect classification**: `GeneralIrish`, `ConnachtIrish`, `UlsterIrish`, `MunsterIrish`, `GeneralScottishGaelic`, `HighlandGaelic`, `HebrideanGaelic`, `ArgyllGaelic`, `GeneralManx` and sub-variants. Each dialect has `:hasLanguage` linking to its Language. Used as the value of `:hasDialect` on entries.
- **Register**: `CaighdeanOifigiuil` and `PreCaighdean` as `Register` instances, distinguished from dialect.
- **Orthographic variants**: dot-above séimhiú as a `NotationalVariant`, distinct from a phonological mutation. Both representations are preserved on the Form.

The local ontology is published as Turtle in the repo, validated as a single deliverable (RDF parse-clean, OWL-consistent). The Arches resource model produced by `arches-model` references the URIs from this combined namespace stack.

## Project status

Pipeline is functional for Irish + Scottish Gaelic. Ontology, resource models, and all pipeline stages (fetch → filter → normalise → ontolex → arches) are implemented with multi-language support.

## Layout

```
.
├── CLAUDE.md              # this file
├── pyproject.toml         # uv-managed
├── config.toml            # multi-language pipeline config
├── ontology/
│   └── goidelic.ttl       # local extensions, imports OntoLex/Lexicog/lemonEty/LexInfo
├── models/
│   ├── lexical_entry/     # Arches resource model (nodes.csv, graph.csv, collections.csv)
│   └── external_example/  # External example sentence model
├── data/
│   ├── raw/               # downloaded kaikki JSONL (gitignored)
│   ├── interim/           # filtered + normalised JSONL (gitignored)
│   ├── processed/         # arches-compatible CSVs (gitignored)
│   ├── prebuild-core/     # prebuild for core metadata (gitignored)
│   ├── prebuild-wiktionary/ # prebuild for Wiktionary layer (gitignored)
│   ├── prebuild-tearma/   # prebuild for Téarma layer (gitignored)
│   ├── wiktionary-index/  # Wiktionary layer output before tar (gitignored)
│   ├── tearma-index/      # Téarma layer output before tar (gitignored)
│   ├── wiktionary-layer.tar.gz  # installable Wiktionary layer package
│   └── tearma-layer.tar.gz      # installable Téarma layer package
├── scripts/
│   ├── build-core.mjs             # builds core metadata bundle → app/public/core-goidelic/
│   ├── build-wiktionary-layer.mjs # builds Wiktionary layer → data/wiktionary-layer.tar.gz
│   ├── build-tearma-layer.mjs     # builds Téarma layer → data/tearma-layer.tar.gz
│   └── ros-madair-build           # compiled binary from RosMadair
├── manifests/             # provenance per run (committed)
├── src/
│   └── goidelic/
│       ├── __init__.py
│       ├── __main__.py    # CLI entry point
│       ├── fetch.py       # download from kaikki.org per language, record provenance
│       ├── filter.py      # lemma vs form-of, multi-language merge
│       ├── normalise.py   # Unicode NFC, séimhiú-dot ↔ lenis-h, LexInfo tag mapping, dialect detection
│       ├── ontolex.py     # shape records to OntoLex-Lemon resource skeletons
│       ├── arches.py      # emit CSVs via the arches-data skill
│       ├── examples.py    # fetch Tatoeba/Gaois, match to headwords
│       └── run.py         # pipeline orchestrator
├── tests/
│   ├── fixtures/          # ~60-lemma slice (50 Irish + 10 Scottish Gaelic)
│   └── test_*.py
└── app/                   # Svelte/alizarin-wasm frontend
    └── public/
        └── core-goidelic/ # schema-only bundle (~200KB): graphs, collections, empty binaries
```

## Target resource model

Generated via the **`arches-model`** skill from the ontology stack above. Every class and property in the resource model carries a real URI — Arches nodegroups reference these directly.

- **LexicalEntry** → `ontolex:LexicalEntry` (and subclasses `Word`, `MultiWordExpression`, `Affix` where applicable). Tagged with a `dialect` concept from the Dialects collection. Bears citation, license, source URL via Lexicog properties.
- **Form** → `ontolex:Form`, related to its lemma via `ontolex:canonicalForm` / `ontolex:otherForm`. Inflected, lenited, and eclipsed forms are first-class. Mutation type attached as a relation to a `Lenition` / `Eclipsis` instance from the local ontology.
- **LexicalSense** → `ontolex:LexicalSense`. Definition + examples + register/dialect. Examples typed as `lexicog:UsageExample`.
- **Etymology** → `ety:Etymology` with `ety:EtyLink` edges between `ety:Etymon` instances. The etymon may itself be a `LexicalEntry` (e.g. an Old Irish entry) or a free-standing reconstructed form. Link types come from lemonEty's class hierarchy: `derivation`, `cognate`, `borrowing`, `inheritance`, `calque`.
- **Source** — `dcterms:source` + Wiktionary URL + revision + `dcterms:license` + Kaikki extract date. Many-to-one from anything carrying provenance.

Use LexInfo for grammatical features. Do **not** invent per-entry tag vocabulary — reconcile to LexInfo at the normalise stage; tags that don't reconcile are flagged in the manifest, not silently dropped.

## Pipeline

1. **fetch** — pull JSONL for each configured language from kaikki.org. Record dump date, wiktextract commit, kaikki extract date, file SHA-256 to `manifests/{timestamp}.json`.
2. **filter** — keep entries whose `lang_code` is in the configured set. Drop `form_of` entries; lemmas only. Merges multiple language inputs into a single output stream.
3. **normalise** — Unicode NFC. Map séimhiú-dot orthography to lenis-`h` form **while preserving the original glyph for display**. Reconcile inflection tags to LexInfo URIs. Detect dialect from Wiktionary tags/categories; assign default dialect per language for untagged entries. Each record carries `lang_code` and `dialect`.
4. **etymology** — (deferred) parse `etymology_templates` where structured; fall back to `etymology_text`.
5. **ontolex** — shape records to OntoLex-Lemon resource skeletons. Each LexicalEntry gets its Forms, Senses, and Etymology references attached. Resource IDs prefixed by `lang_code` (e.g. `ga-focal-noun`, `gd-focal-noun`).
6. **arches** — feed through `arches-data` to emit business-data CSVs with `dialect` column.

Each stage writes a manifest. Reproducibility is mandatory — we're republishing under SA, so anyone receiving the corpus needs to be able to verify what dump it came from.

## Downstream: Tauri app with uniform layers

The pipeline output is not the endpoint. The end-to-end path is:

```
pipeline → Arches business data CSVs
        → build-core.mjs → core metadata bundle (schema only, ~200KB)
        → build-wiktionary-layer.mjs → wiktionary-layer.tar.gz (tiles + pagefind)
        → build-tearma-layer.mjs → tearma-layer.tar.gz (tiles + pagefind)
        → app: Tauri + alizarin-wasm + Pagefind + (optional) Oxigraph WASM
```

The app is a **Tauri desktop/mobile app** — not a PWA. Tauri gives us native Rust for heavy lifting (index building via `ros-madair-core::build_to_memory()`) while the frontend uses alizarin-wasm + ros-madair-client for rendering and queries.

### Layer-based architecture

**There is no special-cased base index.** The app starts with a core metadata bundle (graph models, collections, concept metadata, empty ros-madair binaries) and all data comes from installable layer packages. Wiktionary and Téarma are both `.tar.gz` layers installed the same way via Settings.

On startup:
1. `ensureStore()` loads core metadata from `coreBase` (`/core-goidelic/`)
2. `restoreLayers()` re-adds previously installed layers via `addLayer()`
3. Search and entry loading work against layer tile data
4. With zero layers installed, search returns empty and an empty-state hint directs users to Settings

The Tauri builder plugin (`src-tauri/src/builder_plugin.rs`) handles layer installation:

1. Fetching source data (prebuild archives, pre-built `.tar.gz` packages)
2. Parsing into alizarin's `StaticGraph` + `StaticResource` format (for prebuild sources)
3. Compiling via `ros_madair_core::build_to_memory()` (for prebuild sources)
4. Writing binary index artifacts to `{app_data_dir}/layers/{name}/`

The frontend adds layers via `SparqlStore.addLayer()` using the asset protocol URL. Tile data from layers merges with the core — same-URI resources interleave senses/forms without duplication. Each layer can optionally include a Pagefind index; the search function queries all active Pagefind instances in parallel and deduplicates results by URI.

### Constraints that flow back into pipeline design

- **Etymology graph must be separable.** The etymology subgraph (Etymons + EtyLinks, no senses/examples) ships as a standalone RDF subset to Oxigraph WASM for SPARQL. Pipeline must be able to emit this subset independently — etymology is the one query shape that doesn't reduce to entry-lookup ("all words derived from PIE \*peh₂-", "all loans from Norse", "cognate clusters across Goidelic"). Flag resources for inclusion via `:isPartOfEtymologyGraph`.
- **Content hashes on all outputs.** The bundle uses manifest-based integrity verification for incremental updates against newer Wiktionary dumps. Every emitted file needs a stable content hash.
- **Headwords + senses must be Pagefind-indexable.** Pagefind handles search + faceted browse (POS, dialect, register). Output structure must support this — entries need structured metadata fields, not just prose blobs.
- **Total bundle budget: ~150 MB.** Entry tiles gzipped ~40–80 MB (both languages), Pagefind index ~10–30 MB (chunked, on-demand), etymology RDF ~2–5 MB compressed.

### App component responsibilities

| Component | Role | Data consumed |
|---|---|---|
| **alizarin-wasm** | Render individual entries by key | Bundle tiles |
| **Pagefind** | Headword search + faceted browse (POS, dialect, register) | Pagefind index chunks (on-demand) |
| **Oxigraph WASM** | Etymology graph queries (SPARQL) | Etymology RDF subset |
| **Tauri builder plugin** | Build layers from prebuild/TBX sources | Source archives → binary index |
| **SparqlStore layers** | Merge layer tiles into unified store | Layer binary index via asset protocol |

## Citation and licensing — non-negotiable

- Source: dual-licensed CC BY-SA (4.0 / 3.0) + GFDL. Our derived corpus inherits SA; license outputs accordingly.
- Per-entry `Source` resource carries:
  - canonical URL: `https://en.wiktionary.org/wiki/{word}#Irish` (or `#Scottish_Gaelic`)
  - dump date and Kaikki extract date
  - link to page history (do **not** enumerate contributor usernames — link to the history page; this is the standard "reasonable to the medium" pattern for Wiktionary reuse)
- Cite Ylonen 2022 LREC ("Wiktextract: Wiktionary as Machine-Readable Structured Data") in any publication or report.
- Retain `categories` from source entries — they're part of attribution context, not noise.
- Output bundle (and the static bundle delivered to the app) must include `LICENSE` and a `provenance.json` with dump dates, commits, file hashes, and ontology version.

## Goidelic gotchas

These will bite anyone unfamiliar with the languages. Read once, internalise.

### Irish (ga)

- **Initial mutations**. en.wiktionary has separate pages for `bhfear`, `fhear`, `mbean` etc., tagged `form_of`. Default first-pass strategy is to drop these and rely on the lemma's own `forms[]` array; revisit once the lemma path is solid. When layered back in, model the mutation as a relation to a `Lenition` / `Eclipsis` instance, not as a string tag.
- **Inflectional density**. Nouns have ~5–10 forms each with mutation variants; verbs have ~50+ finite forms plus verbal noun, verbal adjective, and autonomous forms. Including all forms as Form resources roughly 5–10× the resource count — fine for stress-testing, but plan for it.
- **Dialect tags**. Connacht / Ulster / Munster labels appear inconsistently — sometimes in `tags`, sometimes inside qualifier templates within examples, sometimes only in etymology prose. Partial reconciliation is the realistic target. Entries without explicit tags get "Irish (General)".
- **Orthography**. Handle COMBINING DOT ABOVE (U+0307) and precomposed Latin-letter-with-dot-above forms. Normalise for search, preserve original glyph for display. Don't silently replace.
- **Caighdeán vs pre-Caighdeán**. Standard and pre-standard forms coexist. Don't collapse them — register the difference as a relation to the appropriate `Register` instance.
- **Etymology chains**. Old Irish (`sga`) → Proto-Celtic → PIE, plus Brythonic cognates. Don't try to be exhaustive first pass — edge **types** (lemonEty link classes) matter more than coverage.
- **IPA coverage is uneven**. Some lemmas have three-dialect IPA, many have one, many have none. Don't infer.

### Scottish Gaelic (gd)

- **Lenition only**. Scottish Gaelic has lenition but not eclipsis. The `surface_forms()` function handles this by skipping eclipsis for `lang_code == "gd"`.
- **Dialect coverage is sparse**. Wiktionary has far fewer dialect tags for Scottish Gaelic than Irish. Most entries will get "Scottish Gaelic (General)".
- **Orthographic differences**. Scottish Gaelic uses grave accents (`à`, `è`, `ì`, `ò`, `ù`) rather than acute accents. The slugify function accepts both.
- **Example corpora**. Tatoeba has Scottish Gaelic (`gla`). Gaois is Irish-only; skip for `gd` entries.

## Commands

```bash
# install
uv sync

# fetch latest Irish dump
uv run python -m goidelic.fetch --output data/raw/ --language Irish

# fetch latest Scottish Gaelic dump
uv run python -m goidelic.fetch --output data/raw/ --language "Scottish Gaelic"

# run full pipeline against a config
uv run python -m goidelic.run --config config.toml

# run pipeline on the test fixture only
uv run python -m goidelic.run --config config.toml --fixture

# tests
uv run pytest

# build core metadata bundle (schema only, ~200KB)
node scripts/build-core.mjs

# build Wiktionary layer package (tiles + pagefind)
node scripts/build-wiktionary-layer.mjs          # full data
node scripts/build-wiktionary-layer.mjs --fixture # fixture only

# build Téarma layer package
node scripts/build-tearma-layer.mjs

# app dev server
cd app && npm run dev
```

## Dependencies

Keep this list short. Each addition must justify itself.

- **orjson** — JSONL parsing. Use instead of stdlib `json`.
- **httpx** — fetching kaikki dumps.
- **pydantic v2** — record validation between pipeline stages. Forces us to surface schema drift.
- **rdflib** — required, not optional. We're producing real RDF backed by a real ontology; we want round-trip validation through Turtle.
- **pyshacl** — SHACL validation of generated resources against shapes derived from the ontology. Catches inconsistent data before it hits Arches.
- **pytest** + **pytest-snapshot** — tests, with snapshot fixtures for known-tricky lemmas.

**Do not add without discussion**: polars (only if a stage has dataframe ops clearly cleaner than per-record loops), duckdb, or any other heavy dependency.

## Skills

- **`arches-model`** (`~/.claude/skills/arches-model/SKILL.md`) — generates Alizarin graph mutation CSVs from a description of the resource model. Run this **after** the ontology Turtle is stable and **before** writing the `ontolex.py` shaper.
- **`arches-data`** (`~/.claude/skills/arches-data/SKILL.md`) — generates Arches business-data JSON from instance descriptions. Final stage of the pipeline.

Always read the relevant SKILL.md before touching code that calls into these skills.

## Deferred / open

- **Form-of inclusion**. Drop on first pass; layer in once lemma-only is stable. When layered, mutations attach as relations to `Lenition` / `Eclipsis` instances per the local ontology.
- **Etymology pipeline stage**. Parse `etymology_templates` into typed graph edges. Deferred until the core pipeline is stable.
- **Manx data ingestion**. Ontology placeholders exist; data pipeline deferred.
- **App-side dialect filtering UI**. Dialect settings view deferred; RDF_BASE updated to `goidelic#`.
- **ga.wiktionary as secondary source**. Useful for Irish-glossed UI labels. Defer until lemma-only pipeline is end-to-end.
- **Audio files**. Linked from `sounds[]` but the bulk Commons download is multi-GB across all languages. Filter per-entry URLs and pull selectively if/when we need them. For the phone bundle, almost certainly defer audio entirely on first release.
- **Etymology graph as a reduced-order surrogate**. Direct parallel to the EnergyPlus ROM work — "graph too big to query in full, build a surrogate over the cuts that matter". For the phone app, the realistic surrogate is Oxigraph WASM over the etymology RDF subset; for offline desktop / academic use, a richer surrogate may pay off. Worth a serious look once the corpus exists.
- **Round-trip validation**. Once we emit Arches business data, can we round-trip it back to OntoLex Turtle and diff against an independent re-extraction from the same Kaikki dump? Useful regression check before scaling, and the kind of thing rdflib + pyshacl makes cheap.
- **Permanent ontology namespace**. The local ontology currently sits under `flaxandteal.org/ontology/goidelic#`. If this becomes more than a test corpus, a stabler namespace (potentially under a CLARIN / ELG-resolvable URI) is worth establishing before public publication.
