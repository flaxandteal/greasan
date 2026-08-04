"""Grammatical-class enrichment via the gramadan-rs engine.

`gramadan_rs.enrich(word, pos, gender, "")` returns `(grammar_class, method)`.
The method says HOW the class was resolved, which maps to a confidence:
`DbLookup` (the bundled BuNaMo lemma db) is attested; the heuristics are
inferred; the last-ditch morphological guesser is uncertain. Consumers embed
`grammar_class` + the mapped `grammar_class_confidence` at bundle time, so nothing
is guessed at render time and every inferred value carries its provenance.
"""

try:
    import gramadan_rs as _gramadan  # PyO3 binding, see ../../Gramadan/gramadan-rs
except ImportError:  # pragma: no cover - engine optional; pipeline still runs
    _gramadan = None

METHOD_CONFIDENCE = {
    "AlreadyStated": "attested",
    "DbLookup": "attested",  # found in the BuNaMo lemma database
    "HeuristicVowel4th": "inferred",
    "HeuristicVnAdh": "inferred",
    "HeuristicVnAil": "inferred",
    "HeuristicProper4th": "inferred",
    "CompoundDecomposition": "inferred",
    "MorphologicalGuesser": "uncertain",
    "VerbHeuristic": "uncertain",
    "Unresolved": "",
}


def guess_grammar_class(word: str, pos: str, gender) -> tuple[str, str]:
    """Infer a `(grammar_class, method)` for a classless noun/verb/adjective.

    `gender` may be the `extract_gender` list (e.g. `["masculine"]`) or a bare
    string; the engine wants "masculine"/"feminine". Returns `("", "Unresolved")`
    when the engine is unavailable or can't resolve. A DB-lookup on an irregular
    NOUN stringifies to "-1"; normalise that to "irr".
    """
    if _gramadan is None:
        return "", "Unresolved"
    if isinstance(gender, (list, tuple)):
        gender = next((g for g in gender if g in ("masculine", "feminine", "masc", "fem")), "")
    gclass, method = _gramadan.enrich(word, pos, gender or "", "")
    if gclass == "-1":
        gclass = "irr"
    return gclass, method


import csv as _csv
from functools import lru_cache
from pathlib import Path

from .slug_identity import goi_slug


@lru_cache(maxsize=1)
def _bunamo_classes() -> dict[str, str]:
    """`goi-slug -> grammar_class` from the built BuNaMo layer CSV — the attested
    source. Empty (all gramadan fallback) if the CSV isn't built yet."""
    repo = Path(__file__).resolve().parents[2]
    path = repo / "data" / "processed" / "bunamo_lexical_entry_data.csv"
    out: dict[str, str] = {}
    if not path.exists():
        return out
    with open(path, newline="", encoding="utf-8") as f:
        for row in _csv.DictReader(f):
            rid = (row.get("ResourceID") or "").strip()
            gc = (row.get("grammar_class") or "").strip()
            if rid and gc and rid not in out:
                out[rid] = gc
    return out


def enrich_grammar_class(word: str, pos: str, gender) -> tuple[str, str]:
    """`(grammar_class, grammar_class_confidence)` — the pair consumers embed.

    BuNaMo (the attested morphology database) wins when it carries the lemma;
    otherwise the gramadan guess, tagged inferred/uncertain by the method that
    resolved it. Empty pair when neither resolves.
    """
    attested = _bunamo_classes().get(goi_slug(word, pos))
    if attested:
        return attested, "attested"
    gclass, method = guess_grammar_class(word, pos, gender)
    return (gclass, METHOD_CONFIDENCE.get(method, "")) if gclass else ("", "")
