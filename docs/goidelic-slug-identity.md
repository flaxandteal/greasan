# Goidelic Slug Identity & Dialect Model — data-pipeline spec

*Domain spec for the Gréasán data pipeline (the tooling that produces
`data/processed/*_lexical_entry_data.csv` → Arches business-data → graph).
It defines how a lexical entry's **resource identity** is formed so that the
same word, in the same part of speech, composes into **one resource** across
layers and dialects — with dialect carried as a tag on the content, not as a
separate resource. Nothing here touches Rós Madair / alizarin: the engine keeps
composing by `resourceid` exactly as it already does. This is the consumer-side
of `Emitter-Consolidation-Ask.md` A10.*

---

## 1. Goal

Irish and Scottish Gaelic (and Manx) are a **dialect continuum**. A reader
opening `fear` expects *one* headword — "man" — gathering the Irish and Scottish
senses side by side, dialect-tagged, **not** two walled entries. So dialect is a
**tag, not a resource identity**: dialect variants of one lexeme are one
resource; genuinely different words (different spelling, or different POS) are
different resources, cross-referenced.

## 2. The identity: `resourceid = uuid5(NS, slug)`, `slug = "goi-HEAD-POS"`

Resource ids are already `uuid5` of a slug (verified: e.g. the Irish `fear`
noun is `5b663193-…`, a version-5 UUID). The only change is the **slug string**:

```
slug = "goi" "-" HEAD "-" POS
```

- **`goi`** — a fixed Goidelic macro-prefix, replacing the per-language
  `ga`/`gd`/`gv`. This is what makes Irish `fear` and Scottish `fear` land on the
  **same** resourceid. It is a slug convention, not an ISO code; any agreed token
  works, but use `goi` for all Goidelic layers.
- **`HEAD`** — the headword, **normalized** per §3.
- **`POS`** — the coarse part of speech, taken from the existing slug's final
  segment (see §4).

Because the slug is canonical, **every layer computes the same `resourceid`
independently** — no grouping pass, no cross-layer coordination, no dynamic-layer
problem. A layer added later self-collides. The engine's existing
compose-by-`resourceid` merges the tiles.

> The `resourceid` is **not** the pretty/URL slug and **not** human-facing — it is
> the `uuid5`. A display or URL slug, if wanted, is a separate concern layered on
> top; it must never be the identity input (see §3, the ASCII trap).

## 3. `HEAD` normalization (the one shared spec)

Applied to the headword segment **before** it goes in the slug. This is the only
thing every layer builder must implement identically — spec-level agreement, like
agreeing on the `uuid5` namespace.

Rules, in order:

1. **Length accents → macron** (transliterate, do **not** strip): map both the
   Irish acute and the Scottish grave to a macron — a **dialect-neutral length
   marker**:

   | in (grave / acute) | out (macron) |
   |---|---|
   | à á | ā |
   | è é | ē |
   | ì í | ī |
   | ò ó | ō |
   | ù ú | ū |

   (plus the uppercase forms). So `mòr` and `mór` both → `mōr` (**merge**), while
   `féar` → `fēar` stays distinct from `fear` (**length preserved**). The macron
   is written by neither orthography — that is the point: the identity privileges
   no dialect, and the real spellings live on the form tiles (§5).

2. **Case-fold** to lower case.

3. **Word separators → hyphen.** Multi-word headwords keep internal hyphens
   (`fear an tí` → `fear-an-tí`); spaces and other separators become `-`.

**Do NOT ASCII-strip.** Stripping diacritics removes the fada too and fuses
distinct words — `fear`(man)/`féar`(grass), `cead`(permission)/`céad`(hundred),
`áit`(place)/`ait`(pleasant) — the classic accent-neutral over-merge. It also does
not help URLs (it *collides* `/fear-noun`). Macron characters are URL-legal
(percent-encoded), so the normalized slug is a fine URL if one is ever needed.

*Assumption:* acute/grave in modern Irish/Scottish mark **only** vowel length
(lenition is an `h`, not a diacritic), so collapsing them to a length macron
loses no lexical information. An old-orthography quality distinction, if any, is a
display nuance on a form tile, never an identity concern.

## 4. `POS` and the `-etym` exclusion

- POS comes from the existing slug's final segment, already coarse English across
  all three layers (`noun`, `verb`, `pronoun`, `adjective`, `adverb`,
  `preposition`, `prefix`, `suffix`, `numeral`, `interjection`, `phrase`,
  `character`, …). The messy `part_of_speech` **column** (Téarma's `fir iol`,
  `bain iol`, `dob`, …) is **not** used for identity — the slug POS already is the
  coarse value.
- Different POS on the same spelling ⇒ **different headwords** (`goi-fear-noun` vs
  `goi-fear-verb`). Correct: "man" and "to shed" are different words.
- **`-etym` entries** (MacBain rows whose slug ends `-etym`, e.g. `gd-teach-etym`,
  `gd-abadh-etym` — POS unassigned) are **excluded from the merge**: they do not
  share a `-noun` resourceid. They remain pure etymology and attach to the
  matching headword via the existing `cognate_entry_id` cross-reference
  (`cited_by`), which is what they are. MacBain rows that *do* carry a real POS
  (`gd-fear-noun`, `gd-fear-pronoun`) compose in normally.

## 5. Dialect lives on tiles, not on the resource (the schema change with teeth)

Collapsing dialect variants onto one resource means a single resource can no
longer carry a single, resource-level `dialect` or a single headword spelling.
Two changes:

1. **Dialect → per-tile tag.** Move `dialect` from a resource-level (card-1) node
   onto the **sense and form** tiles. Use the **fine** dialect value
   (`Ulster Irish`, `Munster Irish`, `Connacht Irish`, `Connemara Irish`,
   `Scottish Gaelic (General)`, `Manx`, …), **not** the coarse `ga`/`gd`. Sub-
   dialects are complementary points on one continuum; the existing dialect code
   hierarchy (`GD.ARG → GD` sub-dialect→parent, already used by search) applies.
   *(The Gréasán consumer already renders a per-sense dialect chip; this is its
   data source.)*

2. **Dialect-varying spellings → card-N forms.** `mór` (Irish) and `mòr`
   (Scottish) are the same lexeme (`goi-mōr-adjective`) but different written
   forms. Represent each as a **card-N, dialect-tagged form**, carrying the real
   spelling. The resource's **display headword** is derived from the normalized
   form (rendered in a chosen convention, or per active dialect).

Senses, forms, IPA, etymology, cognates are already card-N — they simply gain a
per-tile dialect tag.

This is *more* lexicographically faithful, not a compromise: dialect belongs on
senses and forms ("this sense is Ulster, this form Scottish"), not on the
headword's identity — dialect-as-a-resource-attribute is exactly what forced the
one-headword-per-dialect split this model removes.

## 6. Worked examples

| source entries | `goi` slug → resourceid | result |
|---|---|---|
| `ga-fear-noun` (Irish, "man"), `gd-fear-noun` (Scottish, "man") | both `goi-fear-noun` | **one** resource; senses tagged Irish / Scottish |
| `ga-fear-verb` ("to shed") | `goi-fear-verb` | separate resource (different POS) |
| `gd-fear-pronoun` ("one/somebody") | `goi-fear-pronoun` | separate resource (different POS) |
| `ga-féar-noun` (Irish, "grass") | `goi-fēar-noun` | separate resource — macron preserves length, `fēar` ≠ `fear` |
| Irish `mór` + Scottish `mòr` (adjective) | both `goi-mōr-adjective` | one resource; `mór`/`mòr` as card-N dialect-tagged forms |
| `taigh` (GD, "house") vs `teach` (GA, "house") | `goi-taigh-noun` vs `goi-teach-noun` | **two** resources (different spelling) — cross-referenced, like kirk/church |
| MacBain `gd-teach-etym` | excluded (`-etym`) | attaches to `goi-teach-noun` as etymology via `cited_by` |

## 6a. Headwords are lemmas — do not re-lemmatize

A dictionary headword **is** the citation form. Confirmed in the data: **97–99.6%
of headwords are already lemmas** — mutation-initial headwords are only 2.6%/1.7%
(Wiktionary eclipsis/lenition), 0.4% (MacBain), 0.2% (Téarma), and those are
mostly (a) explicit alt-form/redirect entries (`ga-bh-fear-noun` is glossed
*"obsolete spelling of bhfear"*; others are *"eclipsed form of…"*) carrying a
pointer to their lemma, or (b) genuine lemmas that merely start with those letters
— loanwords (`dharma`, `chic`), symbols (`pH`), compounds (`T-léine`). So the
pipeline **expects** lemmatized headwords and must **not** re-derive them by string
surgery. Non-lemma forms are folded via their explicit relation to the lemma, or
surfaced as data-quality anomalies — never silently normalized away.

## 7. Edge cases

- **Do NOT string-strip initial mutation to "lemmatize" (clash-prone).** Blindly
  removing `bh`/`mb`/`gc`/`nd`/`bhf`/… causes **real clashes and wrong lemmas**,
  verified in-corpus: `T-léine` (T-shirt) → strip `t-` → `léine`, colliding with
  `léine` (shirt); `bhfuil` (a form of *bí*) → strip `bhf` → `fuil`, colliding with
  `fuil` (blood) *and* yielding the wrong lemma; and it corrupts genuine
  mutation-initial lemmas (`dharma`, `chic`, `pH`). Headwords are already lemmas
  (§6a); an alt-form entry keeps its own `goi-<altform>-<pos>` resource and is
  linked/redirected to its lemma via the source's explicit *"form of"* relation —
  never via string surgery.
- **Multi-word / phrase slugs** (`ga-cuireann-an-fear-…-phrase`) merge only on the
  exact normalized multi-word form — fine.
- **Apostrophes / punctuation** in headwords: decide once (drop, or `-`) and apply
  uniformly; document the choice here when made.
- **Dialectal false friends** (same normalized spelling + POS, unrelated meaning
  across dialects) become dialect-senses of one resource. Accepted under the
  continuum: the model asserts headword-**form** identity, not etymological
  identity.

## 8. What the pipeline changes (checklist)

1. Slug construction: emit `goi-HEAD-POS`; `HEAD` normalized per §3; keep the
   coarse POS; keep `-etym` as-is (excluded from merge).
2. `resourceid = uuid5(NS, slug)` — unchanged mechanism, new slug input. Same
   `NS` as today.
3. Move `dialect` onto sense/form tiles (fine value); drop it as a resource-level
   node.
4. Represent dialect-varying spellings as card-N dialect-tagged forms.
5. Do **NOT** string-strip initial mutation (§6a, §7) — it clashes
   (`T-léine`→`léine`, `bhfuil`→`fuil`) and corrupts loanword lemmas. Headwords
   are already lemmas; fold alt-form entries via their explicit *"form of"* link.

**No Rós Madair / alizarin change.** The engine composes by `resourceid`; it never
sees a headword.
