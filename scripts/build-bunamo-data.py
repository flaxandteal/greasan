#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Emit BuNaMo morphology as lexical_entry business-data (the `forms` nodegroup).

Data source: BuNaMo (github.com/michmech/BuNaMo, ODbL-1.0, (c) Foras na Gaeilge)
read through the tested Gramadan v2 engine (github.com/philtweir/gramadan,
branch python-implementation-v2). Gramadan expands each lemma's full typed
paradigm (weak/strong plural genitive, dative insertion, mutations), so the
enum -> gram_features mapping is 1:1 instead of fragile tag-string parsing.

Each matched lemma -> a resource `goi-<normHead>-<pos>` carrying ONLY `forms`
tiles (written_rep + mapped gram_features + form_dialect="Irish"). The slug is
identical to the wiktionary/tearma goi entry for the same lemma+POS, so the
Layers engine composes them: senses from wiktionary, full paradigm from BuNaMo.

Match-don't-orphan: only lemmas whose goi slug already exists in the base heads
(data/processed/lexical_entry_data.csv) are emitted; the rest are counted and
dropped (they have no dictionary entry to enrich).

Output: data/processed/bunamo_lexical_entry_data.csv (consumed by
scripts/build-bunamo-layer.mjs, which runs the regen-layer-v2 head build).

Usage: .venv/bin/python scripts/build-bunamo-data.py [--bunamo <dir>]
"""
from __future__ import annotations

import csv
import logging
import os
import sys
from pathlib import Path

logging.disable(logging.WARNING)  # silence the v2 "not fully tested" banner

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

from goidelic.slug_identity import goi_slug  # noqa: E402
from gramadan.v2.database import Database  # noqa: E402
from gramadan import verb as v1verb  # noqa: E402
from gramadan.v2.verb import VerbConjugationClass  # noqa: E402

BUNAMO_DIR = REPO / "data" / "bunamo-src"
BASE_CSV = REPO / "data" / "processed" / "lexical_entry_data.csv"
OUT_CSV = REPO / "data" / "processed" / "bunamo_lexical_entry_data.csv"
# Sidecar consumed by build-bunamo-layer.mjs's Pagefind stage: the true accented
# lemma per goi slug (the CSV carries only inflected surface forms, not a headword
# node — so the search-record title comes from here). {resourceId: lemma}.
LEMMA_JSON = REPO / "data" / "processed" / "bunamo_lemmas.json"

# POS folders that map cleanly onto dictionary headwords. preposition/possessive/
# nounPhrase are skipped for v1 (see report) — not silent: counted below.
POS_FOLDERS = ("noun", "adjective", "verb")

# --- 1:1 slot / enum -> gram_features label maps -------------------------------

NOUN_SLOT = {
    "sgNom": ["singular", "nominative"],
    "sgGen": ["singular", "genitive"],
    "sgVoc": ["singular", "vocative"],
    "sgDat": ["singular", "dative"],
    "plNom": ["plural", "nominative"],
    "plGen": ["plural", "genitive"],
    "plVoc": ["plural", "vocative"],
    "plDat": ["plural", "dative"],
    "count": [],  # special counting form ("trí bhliana") — no clean concept
}

ADJ_SLOT = {
    "sgNom": ["singular", "nominative"],
    "sgGenMasc": ["singular", "genitive", "masculine"],
    "sgGenFem": ["singular", "genitive", "feminine"],
    "sgVocMasc": ["singular", "vocative", "masculine"],
    "sgVocFem": ["singular", "vocative", "feminine"],
    "plNom": ["plural", "nominative"],
    "graded": ["comparative", "superlative"],  # the single graded degree form
    "abstractNoun": [],  # derived abstract noun — no adjective-form concept
}

TENSE_MAP = {
    "Past": ["past"],
    "PastCont": ["past"],       # habitual/continuous distinction dropped
    "Pres": ["present"],
    "PresCont": ["present"],
    "Fut": ["future"],
    "Cond": ["conditional"],
}
MOOD_MAP = {"Imper": ["imperative"], "Subj": ["subjunctive"]}
PERSON_MAP = {
    "Base": [],
    "Sg1": ["singular", "first-person"],
    "Sg2": ["singular", "second-person"],
    "Sg3": ["singular", "third-person"],
    "Pl1": ["plural", "first-person"],
    "Pl2": ["plural", "second-person"],
    "Pl3": ["plural", "third-person"],
    "Auto": ["autonomous"],
}


def gender_label(word) -> list[str]:
    g = getattr(word, "gender", None)
    if g is None:
        return []
    name = getattr(g, "name", str(g))
    return {"Masc": ["masculine"], "Fem": ["feminine"]}.get(name, [])


def noun_forms(word):
    gl = gender_label(word)  # lexeme's inherent gender, stamped on every form
    for slot, feats in NOUN_SLOT.items():
        for f in word.forms.get(slot, []):
            if not f.value:
                continue
            yield f.value, feats + gl


def adj_forms(word):
    for slot, feats in ADJ_SLOT.items():
        for f in word.forms.get(slot, []):
            if not f.value:
                continue
            yield f.value, list(feats)


def verb_forms(word):
    for f in word.verbalNoun:
        if f.value:
            yield f.value, ["verbal-noun"]
    for f in word.verbalAdjective:
        if f.value:
            yield f.value, ["verbal-adjective"]
    # Indicative tenses (Indep/Dep/RelIndep dependency distinction has no concept
    # -> dropped; dedup collapses the duplicates).
    for tense, deps in word.tenses.items():
        tfeats = TENSE_MAP.get(tense.name)
        if tfeats is None:
            continue
        for person_dict in deps.values():
            for person, forms in person_dict.items():
                pfeats = PERSON_MAP.get(person.name, [])
                for f in forms:
                    if f.value:
                        yield f.value, tfeats + pfeats + ["indicative"]
    # Imperative / subjunctive moods.
    for mood, persons in word.moods.items():
        mfeats = MOOD_MAP.get(mood.name)
        if mfeats is None:
            continue
        for person, forms in persons.items():
            pfeats = PERSON_MAP.get(person.name, [])
            for f in forms:
                if f.value:
                    yield f.value, mfeats + pfeats


EXTRACTORS = {"noun": noun_forms, "adjective": adj_forms, "verb": verb_forms}

# --- entry-level grammatical class -------------------------------------------
# Emitted once per resource (top-level `grammar_class` node, cardinality 1). It
# is the class number as a short string: noun/adjective declension via the v1
# `.declension` int the v2 Entity proxies (BuNaMo's `declension="N"` attribute);
# verb conjugation via the derived Gramadan v2 `Verb.get_conjugation()`.
#   noun:      "1".."5", "irr" for declension 0 (genuinely irregular, e.g. bean)
#   adjective: "1".."3", ""    for declension 0 (indeclinable / unclassified)
#   verb:      "1" (1st conj), "2" (2nd conj), "irr" (irregular)
_VERB_CONJ = {
    VerbConjugationClass.First: "1",
    VerbConjugationClass.Second: "2",
    VerbConjugationClass.Irregular: "irr",
}


def grammar_class(pos: str, word) -> str:
    if pos in ("noun", "adjective"):
        d = getattr(word, "declension", None)
        try:
            d = int(d)
        except (TypeError, ValueError):
            return ""
        if 1 <= d <= 5:
            return str(d)
        # declension 0 = outside the standard declensions
        return "irr" if pos == "noun" else ""
    if pos == "verb":
        try:
            return _VERB_CONJ.get(word.get_conjugation(), "")
        except Exception:  # noqa: BLE001 — never fabricate; leave empty on failure
            return ""
    return ""


def load_base_goi_ids() -> set[str]:
    ids: set[str] = set()
    with BASE_CSV.open(encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        rid_i = header.index("ResourceID")
        for row in reader:
            if not row:
                continue
            rid = row[rid_i]
            if rid.startswith("goi-"):
                ids.add(rid)
    return ids


def main() -> None:
    bunamo = BUNAMO_DIR
    if "--bunamo" in sys.argv:
        bunamo = Path(sys.argv[sys.argv.index("--bunamo") + 1])

    print(f"[bunamo] base goi ids from {BASE_CSV.name} ...", flush=True)
    base = load_base_goi_ids()
    print(f"[bunamo] {len(base)} distinct goi- ResourceIDs in base heads")

    # Database.load iterates ENTITY_TYPE_MAP which includes 'copula'; BuNaMo has
    # no copula dir, so ensure an empty one exists (harmless, ignored otherwise).
    os.makedirs(bunamo / "copula", exist_ok=True)

    print(f"[bunamo] loading Gramadan v2 database from {bunamo} ...", flush=True)
    db = Database(str(bunamo))
    db.load()

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    # grammar_class_confidence appended LAST so the position-based parse in
    # build-bunamo-layer.mjs (id/grammar_class/written_rep = cols 0/1/2) is unchanged.
    columns = ["ResourceID", "grammar_class", "written_rep", "gram_features", "form_dialect", "grammar_class_confidence"]

    stats = {p: {"total": 0, "matched": 0, "tiles": 0} for p in POS_FOLDERS}
    rows_out: list[dict] = []
    lemmas: dict[str, str] = {}  # rid -> accented lemma (for the Pagefind title)

    for pos in POS_FOLDERS:
        extract = EXTRACTORS[pos]
        for lemma, word in db.dictionary[pos].items():
            stats[pos]["total"] += 1
            actual = word.getLemma()
            rid = goi_slug(actual, pos)
            if rid not in base:
                continue
            stats[pos]["matched"] += 1
            lemmas[rid] = actual  # accented lemma for the Pagefind record title
            gclass = grammar_class(pos, word)  # entry-level, stamped on 1st row
            first = True
            seen: set[tuple] = set()
            for written, feats in extract(word):
                key = (written, tuple(sorted(set(feats))))
                if key in seen:
                    continue
                seen.add(key)
                rows_out.append({
                    "ResourceID": rid,
                    # top-level single-cardinality: on the first tile row only,
                    # blank on the rest (matches the base-CSV layout).
                    "grammar_class": gclass if first else "",
                    "written_rep": written,
                    "gram_features": ", ".join(sorted(set(feats))),
                    "form_dialect": "Irish",
                    # From a real BuNaMo paradigm → attested (same tile as the value).
                    "grammar_class_confidence": "attested" if (gclass and first) else "",
                })
                first = False
                stats[pos]["tiles"] += 1

    with OUT_CSV.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=columns)
        w.writeheader()
        w.writerows(rows_out)

    import json
    with LEMMA_JSON.open("w", encoding="utf-8") as fh:
        json.dump(lemmas, fh, ensure_ascii=False)
    print(f"[bunamo] wrote {len(rows_out)} form tiles -> {OUT_CSV}")
    print(f"[bunamo] wrote {len(lemmas)} lemma titles -> {LEMMA_JSON}")
    tot_total = tot_matched = 0
    for pos in POS_FOLDERS:
        s = stats[pos]
        tot_total += s["total"]
        tot_matched += s["matched"]
        pct = 100 * s["matched"] / s["total"] if s["total"] else 0
        print(f"[bunamo]   {pos:10} lemmas={s['total']:6} matched={s['matched']:6} "
              f"({pct:5.1f}%)  form-tiles={s['tiles']}")
    pct = 100 * tot_matched / tot_total if tot_total else 0
    print(f"[bunamo]   {'TOTAL':10} lemmas={tot_total:6} matched={tot_matched:6} ({pct:5.1f}%)")
    print(f"[bunamo] matched resources (distinct): {len({r['ResourceID'] for r in rows_out})}")


if __name__ == "__main__":
    main()
