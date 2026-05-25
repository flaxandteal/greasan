"""Shape normalised entries into resource skeletons matching the Arches model."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import orjson


def slugify(word: str, pos: str) -> str:
    """Create a ResourceID slug from word + POS.

    E.g. "focal" + "noun" → "focal-noun"
    Handles duplicates downstream (same word, different POS = different resources).
    """
    # Strip non-alphanumeric (keep hyphens, Irish fada)
    slug = word.lower().strip()
    # Replace spaces with hyphens
    slug = re.sub(r"\s+", "-", slug)
    # Remove characters that aren't word chars, hyphens, or fada vowels
    slug = re.sub(r"[^\w\-áéíóú]", "", slug)
    return f"{slug}-{pos}"


def shape_entry(entry: dict) -> dict:
    """Shape a normalised entry into a resource skeleton.

    Returns a dict with:
    - resource_id: slugified identifier
    - headword: the word
    - part_of_speech: POS label
    - pronunciations: list of {ipa_value}
    - senses: list of {gloss, example}
    - forms: list of {written_rep, gram_features}
    """
    resource_id = slugify(entry["word"], entry["pos"])

    pronunciations = []
    for p in entry.get("pronunciations", []):
        pronunciations.append({"ipa_value": p["ipa_value"]})

    senses = []
    for s in entry.get("senses", []):
        # Take first example only for now (keeps CSV simpler)
        example = s["examples"][0] if s.get("examples") else ""
        senses.append({"gloss": s["gloss"], "example": example})

    forms = []
    for f in entry.get("forms", []):
        if f.get("written_rep"):
            forms.append({
                "written_rep": f["written_rep"],
                "gram_features": f.get("gram_features", []),
            })

    return {
        "resource_id": resource_id,
        "headword": entry["word"],
        "part_of_speech": entry["pos"],
        "pronunciations": pronunciations,
        "senses": senses,
        "forms": forms,
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
