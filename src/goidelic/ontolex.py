"""Shape normalised entries into resource skeletons matching the Arches model."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import orjson


def slugify(word: str, pos: str, lang_code: str = "") -> str:
    """Create a ResourceID slug from word + POS, prefixed by language code.

    E.g. "focal" + "noun" + "ga" → "ga-focal-noun"
    Prefix avoids collisions when the same word exists in multiple languages.
    """
    # Strip non-alphanumeric (keep hyphens, Goidelic accented vowels)
    slug = word.lower().strip()
    # Replace spaces with hyphens
    slug = re.sub(r"\s+", "-", slug)
    # Remove characters that aren't word chars, hyphens, or accented vowels
    slug = re.sub(r"[^\w\-áéíóúàèìòù]", "", slug)
    base = f"{slug}-{pos}"
    if lang_code:
        return f"{lang_code}-{base}"
    return base


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
    lang_code = entry.get("lang_code", "ga")
    resource_id = slugify(entry["word"], entry["pos"], lang_code=lang_code)

    pronunciations = []
    for p in entry.get("pronunciations", []):
        pronunciations.append({"ipa_value": p["ipa_value"]})

    senses = []
    source_label = entry.get("source_label", "")
    for s in entry.get("senses", []):
        # Take first example only for now (keeps CSV simpler)
        example = s["examples"][0] if s.get("examples") else ""
        sense: dict[str, str] = {"gloss": s["gloss"], "example": example}
        if source_label:
            sense["source_label"] = source_label
        senses.append(sense)

    forms = []
    for f in entry.get("forms", []):
        if f.get("written_rep"):
            forms.append({
                "written_rep": f["written_rep"],
                "gram_features": f.get("gram_features", []),
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
        "part_of_speech": entry["pos"],
        "dialect": entry.get("dialect", "Irish"),
        "pronunciations": pronunciations,
        "senses": senses,
        "forms": forms,
        "domains": domains,
    }


def shape_file(input_path: Path, output_path: Path) -> dict:
    """Shape all entries in a normalised JSONL file.

    Handles ResourceID collisions (same word+pos appears multiple times)
    by appending a numeric suffix.

    Returns manifest dict.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    seen_ids: dict[str, int] = {}

    with open(input_path, "rb") as fin, open(output_path, "wb") as fout:
        for line in fin:
            entry = orjson.loads(line)
            shaped = shape_entry(entry)

            # Handle duplicate ResourceIDs
            rid = shaped["resource_id"]
            if rid in seen_ids:
                seen_ids[rid] += 1
                shaped["resource_id"] = f"{rid}-{seen_ids[rid]}"
            else:
                seen_ids[rid] = 1

            fout.write(orjson.dumps(shaped))
            fout.write(b"\n")
            total += 1

    duplicates = sum(1 for v in seen_ids.values() if v > 1)

    return {
        "stage": "ontolex",
        "input_path": str(input_path),
        "output_path": str(output_path),
        "total": total,
        "duplicate_ids_resolved": duplicates,
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
