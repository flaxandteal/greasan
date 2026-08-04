"""Shape normalised entries into resource skeletons matching the Arches model."""

from __future__ import annotations

import sys
from pathlib import Path

import orjson

from .slug_identity import goi_slug


def slugify(word: str, pos: str, lang_code: str = "") -> str:
    """Create the ResourceID slug from word + POS.

    Now emits the dialect-neutral `goi-HEAD-POS` (see `slug_identity.goi_slug` and
    docs/goidelic-slug-identity.md): "focal" + "noun" → "goi-focal-noun", so a
    lexeme's dialect variants (`ga`/`gd`/`gv`) share one resource. `lang_code` is
    accepted for call-site compatibility but IGNORED — dialect moves onto the tiles,
    not the slug.
    """
    return goi_slug(word, pos)


def shape_entry(entry: dict) -> dict:
    """Shape a normalised entry into a resource skeleton.

    Returns a dict with:
    - resource_id: slugified identifier (prefixed by lang_code)
    - headword: the word
    - part_of_speech: POS label
    - dialect: dialect concept label
    - pronunciations: list of {ipa_value}
    - senses: list of {gloss, example}
    - forms: list of {written_rep, gram_features}
    """
    resource_id = goi_slug(entry["word"], entry["pos"])
    # Dialect now rides the TILES (senses/forms/pronunciations), not the slug — so
    # dialect variants of a lexeme merge into one goi resource yet stay attributable.
    dialect = entry.get("dialect", "Irish")

    pronunciations = []
    for p in entry.get("pronunciations", []):
        pronunciations.append({"ipa_value": p["ipa_value"], "dialect": dialect})

    senses = []
    source_label = entry.get("source_label", "")
    for s in entry.get("senses", []):
        # Take first example only for now (keeps CSV simpler)
        example = s["examples"][0] if s.get("examples") else ""
        sense: dict[str, str] = {"gloss": s["gloss"], "example": example, "dialect": dialect}
        if source_label:
            sense["source_label"] = source_label
        senses.append(sense)

    forms = []
    for f in entry.get("forms", []):
        if f.get("written_rep"):
            forms.append({
                "written_rep": f["written_rep"],
                "gram_features": f.get("gram_features", []),
                "dialect": dialect,
            })

    # Pass through domain categories (Téarma entries have these; Wiktionary entries don't)
    categories = entry.get("categories", [])
    domains: list[str] = []
    if categories:
        # Categories are already mapped to UNESCO labels by tbx.py or are raw Wiktionary categories
        # For domain field, only include string labels (not Wiktionary category dicts)
        for cat in categories:
            if isinstance(cat, str) and cat not in domains:
                domains.append(cat)

    return {
        "resource_id": resource_id,
        "headword": entry["word"],
        # Per-dialect lemma spellings, preserved so a dialect-varying merge
        # (mór/mòr → one goi-mōr-adjective) loses neither. Becomes card-N forms in
        # the next increment; `headword` stays the display fallback for now.
        "headwords": [{"dialect": dialect, "word": entry["word"]}],
        "part_of_speech": entry["pos"],
        "gender": entry.get("gender", ""),
        "grammar_class": entry.get("grammar_class", ""),
        "grammar_class_confidence": entry.get("grammar_class_confidence", ""),
        "dialect": dialect,
        "pronunciations": pronunciations,
        "senses": senses,
        "forms": forms,
        "domains": domains,
    }


def _dialects(value: str) -> list[str]:
    """Split a possibly pipe-separated dialect string into its parts."""
    return [d for d in value.split("|") if d]


def _merge_dialect(existing: str, incoming: str) -> str:
    """Order-preserving union of two (possibly pipe-separated) dialect strings.

    Reuses the pipeline's existing pipe-separated multi-dialect convention
    (PIPELINE_CAVEATS.md), so a merged Irish+Scottish resource reads
    `Irish|Scottish Gaelic` — resolvable by the pagefind filter build as before.
    """
    seen: list[str] = []
    for d in _dialects(existing) + _dialects(incoming):
        if d not in seen:
            seen.append(d)
    return "|".join(seen)


def _merge_resource(acc: dict, new: dict) -> None:
    """Fold `new` (same `goi` resource_id) into `acc` in place.

    Card-n tiles (pronunciations/senses/forms) are unioned and de-duplicated
    INCLUDING their dialect tag — so the same gloss in two dialects stays two tagged
    tiles. Card-1 `dialect` becomes the pipe-separated union; per-dialect lemma
    spellings accumulate in `headwords`.
    """
    def key_pron(p: dict) -> tuple:
        return (p.get("ipa_value", ""), p.get("dialect", ""))

    def key_sense(s: dict) -> tuple:
        return (s.get("gloss", ""), s.get("example", ""), s.get("dialect", ""))

    def key_form(f: dict) -> tuple:
        return (f.get("written_rep", ""), tuple(f.get("gram_features", [])), f.get("dialect", ""))

    for coll, keyfn in (("pronunciations", key_pron), ("senses", key_sense), ("forms", key_form)):
        have = {keyfn(x) for x in acc.get(coll, [])}
        for x in new.get(coll, []):
            k = keyfn(x)
            if k not in have:
                acc.setdefault(coll, []).append(x)
                have.add(k)

    for d in new.get("domains", []):
        if d not in acc.setdefault("domains", []):
            acc["domains"].append(d)

    acc["dialect"] = _merge_dialect(acc.get("dialect", ""), new.get("dialect", ""))

    hw_have = {(h["dialect"], h["word"]) for h in acc.setdefault("headwords", [])}
    for h in new.get("headwords", []):
        if (h["dialect"], h["word"]) not in hw_have:
            acc["headwords"].append(h)
            hw_have.add((h["dialect"], h["word"]))


def shape_file(input_path: Path, output_path: Path) -> dict:
    """Shape all entries, MERGING entries that share a `goi` resource_id.

    Dialect variants of one lexeme (Irish `fear`, Scottish `fear` → `goi-fear-noun`)
    compose into a single resource with dialect-tagged tiles, instead of being
    disambiguated apart with a numeric suffix. See docs/goidelic-slug-identity.md.
    Accumulates in memory keyed by resource_id (order-preserving), then writes once.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    order: list[str] = []
    merged: dict[str, dict] = {}
    merged_rids: set[str] = set()
    total = 0

    with open(input_path, "rb") as fin:
        for line in fin:
            entry = orjson.loads(line)
            shaped = shape_entry(entry)
            rid = shaped["resource_id"]
            if rid in merged:
                _merge_resource(merged[rid], shaped)
                merged_rids.add(rid)
            else:
                merged[rid] = shaped
                order.append(rid)
            total += 1

    with open(output_path, "wb") as fout:
        for rid in order:
            fout.write(orjson.dumps(merged[rid]))
            fout.write(b"\n")

    return {
        "stage": "ontolex",
        "input_path": str(input_path),
        "output_path": str(output_path),
        "total_entries": total,
        "resources": len(order),
        "merged_resources": len(merged_rids),
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Shape entries to OntoLex skeletons")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    manifest = shape_file(args.input, args.output)
    print(orjson.dumps(manifest, option=orjson.OPT_INDENT_2).decode(), file=sys.stderr)


if __name__ == "__main__":
    main()
