# Hand-off — grammar-class inference + on-demand decliner/conjugator

For a **separate session**. Scope is deliberately bounded: *implement only what the
parser can't already state.* This session did the cheap, correct half (extract the
declension Téarma states); the two hard halves below are yours.

---

## 0. What is already done (do NOT redo)

**Parse-time extraction of the STATED class** — Téarma encodes noun/adjective
declension in the POS code (`fir1..fir5`, `bain2..bain5`, `a1..a3`); the digit is
the class. Both parsers now keep it as `grammar_class` (model node
`goidelic#grammaticalClass`, the same node BuNaMo emits):

- `app/src-tauri/src/tbx_parser.rs` — `extract_declension()` + `grammar_class` CSV column (on-device path). Compiles (`cargo check --features v2`).
- `src/goidelic/tbx.py` → `ontolex.py` → `arches.py` — same, for the build path. Verified on the fixture: nouns/adjectives get `"1".."5"`, **verbs stay `""`** (intentionally deferred to you).

**BuNaMo already emits grammar_class for all three POS** — `scripts/build-bunamo-data.py:grammar_class()`:
noun/adjective from the `declension` attribute; **verb from `Verb.get_conjugation()`** (reads the future `-f-`). So wherever a lemma exists in BuNaMo, the exact class already composes over Téarma. **BuNaMo composition is the source of truth; inference only fills what BuNaMo lacks.**

---

## 1. Build: grammar-class inference (the guesser)

Fill the gaps the parser leaves. Precedence: **BuNaMo (exact) > inference > empty.**

### 1a. Noun declension — the bare `fir`/`bain` gap
Téarma nouns: **83.7% carry a declension; 16.3% (32,017) don't.** But that 16.3% is not one gap — measured breakdown (ga terms only, from `data/raw/25.10.01-tearma.ie-concepts.tbx`):

| bucket | count | action |
|---|---|---|
| bare `fir` / `bain` | 19,636 | **guess** (gender known, class omitted) |
| plural-only (`iol`/`pl`/`fir iol`/…) | 5,440 | **leave empty** — *plurale tantum*, no singular declension |
| abbreviations (`gior`/`abr`/`abbr`) | 2,700 | **leave empty** — don't decline |
| `s` (generic, no gender) | 4,123 | hardest residue; empty unless gender recoverable |
| `cnuas` (collective) | 118 | leave empty |

So the *real* recoverable gap is ~10% of nouns (bare `fir`/`bain`). Use the
Gramadán **`NualeargaisNounDeclensionGuesser`** (`data/gramadan-src/Python/gramadan/v2/noun_nualeargais.py`), which classifies from lemma+gender. **Measured accuracy vs BuNaMo ground truth (12,321 nouns):**

- **class-level (non-full guesser): 89.05%**
- **full-paradigm (Full guesser): 79.82%** — extra ~9% is right-class/wrong-generated-form
- empirical (genitive-inclusive): **99.94%** — *irrelevant for Téarma*, which has no genitive

Confusions cluster where the nominative looks alike but the genitive differs:
`decl2→3` (477), `decl3→1` (244), `decl4→3` (233), `decl4→1` (142), `decl3→2` (128); **declension 3 is the attractor**, errors skew **feminine** (853 vs 496). Nothing separates these without the genitive — so ~80–89% is a ceiling for lemma-only, not a bug to chase.

### 1b. Verb conjugation — nothing stated, so infer
Téarma tags verbs only `br`/`v` (no class); ~9,400 ga verbs. Irish conjugation is
strongly surface-cued, so a small heuristic is enough. **Ship this exact rule set — measured 94.6% vs BuNaMo `get_conjugation()` (3,359 verbs, classes near-balanced 1,660/1,687/12):**

```
lower(lemma); strip
if lemma in IRREGULAR_11 → "irr"
elif ≤1 vowel-group (a e i o u á é í ó ú)   → "1"   # monosyllabic
elif ends -igh / -aigh                       → "2"
elif ends -áil/-eáil/-óil/-úil/-áin/-eáin    → "1"   # -áil family, BEFORE the -il rule
elif ends -il/-in/-ir/-is/-e                 → "2"   # syncopating
else                                         → "1"
IRREGULAR_11 = bí abair beir clois cluin déan faigh feic ith tabhair tar téigh
```

⚠️ **Do NOT refine the long-vowel `-igh` cases.** I tried (fada/digraph → 1st); it *dropped* accuracy to **84.1%** because standard 2nd-conj `-aigh` verbs carry fadas too (`díchorónaigh`, `díláraigh`). The simple rule's residual errors are `1→2` long-vowel `-igh` (~162) and `2→1` syncopated `-ing/-aim` (~18) — accept them. Ground truth is Gramadán's `Verb.get_conjugation()` (`verb.py`: strips root off the future, checks for `-f-`).

The implementation removed from this session (a working Rust `guess_verb_conjugation` + Python mirror) is in git history if you want a starting point — but it belongs in the inference layer, not the parser.

---

## 2. Build: on-demand decliner/conjugator (BuNaMo → Rust/WASM)

Given `lemma + class`, generate the full paradigm **on demand, per word view** — do
NOT ship every form. Adapt BuNaMo's generation:

- Gramadán Python port to mirror: `gramadan/v2/{noun,adjective,verb}.py`, `noun_declensions.py`, `singular_info.py`, `plural_info.py`, `opers.py` (mutation/slenderise/broaden ops).
- BuNaMo source data: `data/bunamo-src/{noun,adjective,verb}/*.xml` (30,708 nouns, 8,737 adjectives, 3,359 verbs — full attested paradigms; use as the composition layer AND as the guesser's ground-truth oracle).
- Output shape: the `forms` nodegroup on the goi entry (`written_rep` + `gram_features` concepts), same as `build-bunamo-layer.mjs` composes today.

---

## 3. Scope guardrails (so we don't build more than we need)

- **BuNaMo first.** Guess only where the lemma is absent from BuNaMo. Where present, its class/paradigm is exact — compose, don't guess.
- **Don't force a class on non-declining entries** (plural-only, abbreviations, collectives, gender-less `s`). Empty is correct.
- **Skip the empirical noun guesser for Téarma** — it needs the genitive Téarma doesn't have. Only `nualeargais` (lemma+gender) applies.
- **Decliner is on-demand**, scoped to the open entry — not a bulk pre-generation.
- **Verb heuristic: ship the simple version.** No refinement.

---

## 4. Key files / APIs

| Thing | Path |
|---|---|
| Stated-class extraction (done) | `app/src-tauri/src/tbx_parser.rs` `extract_declension`; `src/goidelic/tbx.py` |
| grammar_class node | `models/lexical_entry/nodes.csv` (`goidelic#grammaticalClass`) |
| Noun guesser | `data/gramadan-src/Python/gramadan/v2/noun_nualeargais.py` |
| Verb ground truth | `data/gramadan-src/Python/gramadan/v2/verb.py` `get_conjugation()` |
| BuNaMo grammar_class emit | `scripts/build-bunamo-data.py` `grammar_class()` |
| BuNaMo data | `data/bunamo-src/{noun,adjective,verb}/` |
| Raw Téarma TBX | `data/raw/25.10.01-tearma.ie-concepts.tbx` (18 MB) |
| Composition builder | `scripts/build-bunamo-layer.mjs` |

## 5. Follow-ups from this session (not blocking)
- Regenerate `tearma-v2` so the new `grammar_class` column actually populates the shipped head (current head predates this change).
