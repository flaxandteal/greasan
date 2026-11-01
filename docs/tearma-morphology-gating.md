# Téarma morphology gating — when NOT to inflect

_2026-11-01. Why gramadán was misconjugating/misdeclining Téarma entries, what the
source tells us, and the BuNaMo-free gates now in place._

## The problem

Téarma (`data/raw/25.10.01-tearma.ie-concepts.tbx`, 153 MB) is a terminology base,
not a lexicon. Many entries tagged as verbs or nouns are **not single lemmas** —
phrasal/light-verb constructions, foreign/scientific terms, proper nouns. gramadán
(live via `lib/gramadan.ts` → gramadan-wasm; class pre-filled at build by
`tbx_parser::enrich_records`) was fed every one of them and fabricated a paradigm.

**Constraint: BuNaMo is NOT available to check against** — not on-device (the TBX
build runs with an empty `LemmaDb`) and not as a shipped dataset. So every gate
below uses only signals present in Téarma itself (POS code, the term string) + the
existing `grammar_class_confidence` stamp. BuNaMo was used **offline, as ground
truth**, only to size the buckets and prove the gates are good proxies.

## What the source carries

`partOfSpeech` termNote values (the only grammatical signal, besides the term
string): `s`/`fir[1-5]`/`bain[2-5]`/`iol`/`pl` (nouns, digit = declension class),
`br`/`v` (verbs), `a[1-3]` (adjectives), `properNoun`, `frása`/`phr.` (phrases,
already routed to POS "phrase"), `abbr`/`gior` (abbreviations), `réimír`/`pref`/
`suff` (affixes). Crucially: **the declension digit is only present on nouns the
terminologists judged to be declinable Irish lemmas** — the foreign/uncertain ones
were left classless. That digit IS our "real lemma" signal; no BuNaMo needed.

## Quantification (deduped unique `ga` terms; BuNaMo offline as ground truth)

### Verbs — 6,324 unique
| Bucket | Count | Verdict |
|---|---|---|
| Phrasal (multi-word `br`/`v`) | 3,343 (53%) | **misconjugated → gate off** |
| Single-word, BuNaMo root | 1,998 | correct |
| Single-word **middle** (not in BuNaMo) | 983 | **conjugated correctly** |
| vn-as-headword non-root | 3 | negligible |

**Spot-check finding (examples/verb-probe.rs):** the single-word middle conjugates
**correctly**. Regular `-igh`/`-áil` endings are predictable (`acmhainnigh` →
`acmhainneoidh`/`acmhainniú`), and prefixed verbs are vowel-initial (`ais-`, `ró-`,
`aer-`, `uath-`) so no initial-mutation hazard. `guess_conjugation` is itself
lexicon-free. → **Do not gate single verbs.** The only verb problem is phrasal.

### Nouns — 173,586 unique (incl. properNoun)
| Bucket | Count | Decline? |
|---|---|---|
| `properNoun` | 17,820 | **skip** |
| multi-word common | 109,828 | skip |
| single-word, declension stated (`fir1`/`bain2`…) | 38,634 | ✅ attested |
| single-word classless, BuNaMo root | 1,145 | (valid, but see below) |
| single-word classless **middle** | 4,579 | skip (foreign/scientific) |

The classless middle is mostly lowercase, Irish-orthography-legal **Latin taxonomy /
loanwords / proper-ish terms** (`glossopteris`, `hemiptera`, `gesamtkunstwerk`,
`hokusai`) — declining them is nonsense.

### Why no surface heuristic rescues the classless-valid without BuNaMo
Testing BuNaMo-free gates on the 5,724 classless single nouns (1,145 valid / 4,579 middle):

| Gate | valid kept | valid lost | **garbage still declined** |
|---|---|---|---|
| skip all classless | 0 | 1,145 | 0 |
| skip if capitalised | 1,139 | 6 | **4,086** |
| skip if capitalised or non-Irish letter | 1,134 | 11 | **3,659** |

Capitalisation/orthography fail — the foreign residue is lowercase and uses only
Irish-legal letters. You cannot reconstruct the BuNaMo split from the string. So the
gate falls back to Téarma's own signal: **decline only when a declension class was
stated** (= `grammar_class_confidence == "attested"`). Cost, measured: ~1,145 valid
classless nouns lose a (correct) declension — acceptable, since Téarma left them
unclassed and lemma-only beats a fabricated genitive — while ~4,579 garbage
paradigms are suppressed.

## The asymmetry (and why it's self-explaining)
- **Verbs:** unknown single words are *productive Irish derivations* → gramadán's
  guesser is reliable. Téarma states no verb class, so all are "inferred"; a
  confidence gate would wrongly suppress every verb. → gate on **multi-word only**.
- **Nouns:** unknown single words are *foreign/scientific borrowings* → the guesser
  fabricates. Téarma's class-assignment is the trustworthy signal. → gate on
  **attested class** (plus properNoun + multi-word).

## Gates implemented (all BuNaMo-free)
1. **`lib/paradigm.ts` `posKind`** — `proper noun` → `'other'` (was matching
   `\bnoun\b` and declining proper nouns). App-wide: proper nouns get no paradigm.
2. **`views/EntryDetail.svelte`** (live generation choke point):
   - skip if the headword is **multi-word** (both POS);
   - for **nouns**, generate only when `grammarClassConfidence === 'attested'`.
3. **`tbx_parser.rs enrich_records`** — don't guess a class for a **multi-word**
   term (so no bogus `inferred` class is baked). Attested single words unaffected.

Tests: `tbx_parser::enrich_tests::enrich_skips_multiword_terms`,
`lib/paradigm.test.ts` (posKind proper-noun). Analysis harness:
`examples/verb-probe.rs` (conjugation spot-check), `examples/hydrate-probe.rs`.

## Not done / deferred
- The ~1,145 valid-but-classless nouns could be shown with an *inferred-flagged*
  declension rather than lemma-only, if we decide a guessed paradigm is better than
  none. The confidence stamp is already there to drive that UI choice.
- Adjectives (`a`/`a1-3`) use the same generation path; multi-word gate applies, but
  they are not attested-gated (not flagged as a problem, far fewer entries).
- Reproduce the numbers: the bucket/BuNaMo-ground-truth counts came from ad-hoc
  Python over the TBX + `data/bunamo-src/{verb,noun}/*.xml` (`<verb|noun default>`),
  normalised with `goidelic.slug_identity.normalize_head`.
