"""Emit business_data.csv from OntoLex-shaped entries."""

from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

import orjson

# Column headers matching nodes.csv aliases (data-bearing only)
COLUMNS = [
    "ResourceID",
    "headword",
    "part_of_speech",
    "grammar_class",
    "grammar_class_confidence",
    "dialect",
    "ipa_value",
    "pronunciation_dialect",
    "gloss",
    "example",
    "source_label",
    "sense_dialect",
    "written_rep",
    "gram_features",
    "form_dialect",
    "domain",
    "etymology_text",
    "etymology_source",
    "cognate_headword",
    "cognate_language",
    "cognate_entry_id",
    "related_entries",
]


def entry_to_rows(entry: dict) -> list[dict[str, str]]:
    """Convert a shaped entry into one or more CSV rows.

    Business data format: multiple rows per ResourceID for cardinality-n groups.
    Each row represents one tile (one pronunciation, one sense, or one form).
    Cardinality-1 fields (headword, part_of_speech) repeat on first row only.
    """
    rid = entry["resource_id"]
    rows: list[dict[str, str]] = []

    # Collect all cardinality-n items
    pronunciations = entry.get("pronunciations", [])
    senses = entry.get("senses", [])
    forms = entry.get("forms", [])
    domains = entry.get("domains", [])

    # Determine how many rows we need (at least 1)
    max_rows = max(len(pronunciations), len(senses), len(forms), 1)

    for i in range(max_rows):
        row: dict[str, str] = {"ResourceID": rid}

        # Cardinality-1 fields on first row only
        if i == 0:
            row["headword"] = entry.get("headword", "")
            row["part_of_speech"] = entry.get("part_of_speech", "")
            gc = entry.get("grammar_class", "")
            row["grammar_class"] = gc
            # Confidence comes from the enrichment stage (tbx.py): "attested" for an
            # explicit TBX code / BuNaMo paradigm, "inferred"/"uncertain" for a
            # gramadan guess. Fall back to the attested-if-present constant for
            # sources (e.g. Wiktionary) that don't run the guesser.
            row["grammar_class_confidence"] = (
                entry.get("grammar_class_confidence") or ("attested" if gc else "")
            )
            row["dialect"] = entry.get("dialect", "")
            # Domain is concept-list (cardinality n), pipe-separated
            if domains:
                row["domain"] = "|".join(domains)

        # Pronunciation (cardinality-n) — dialect rides the tile
        if i < len(pronunciations):
            row["ipa_value"] = pronunciations[i].get("ipa_value", "")
            row["pronunciation_dialect"] = pronunciations[i].get("dialect", "")

        # Sense (cardinality-n) — dialect rides the tile
        if i < len(senses):
            row["gloss"] = senses[i].get("gloss", "")
            row["example"] = senses[i].get("example", "")
            row["source_label"] = senses[i].get("source_label", "")
            row["sense_dialect"] = senses[i].get("dialect", "")

        # Form (cardinality-n) — dialect rides the tile
        if i < len(forms):
            row["written_rep"] = forms[i].get("written_rep", "")
            features = forms[i].get("gram_features", [])
            row["gram_features"] = ", ".join(features) if features else ""
            row["form_dialect"] = forms[i].get("dialect", "")

        rows.append(row)

    return rows


def emit_csv(input_path: Path, output_path: Path) -> dict:
    """Read shaped JSONL, emit business_data.csv.

    Returns manifest dict.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total_entries = 0
    total_rows = 0

    with open(input_path, "rb") as fin, open(output_path, "w", newline="", encoding="utf-8") as fout:
        writer = csv.DictWriter(fout, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()

        for line in fin:
            entry = orjson.loads(line)
            rows = entry_to_rows(entry)
            for row in rows:
                writer.writerow(row)
                total_rows += 1
            total_entries += 1

    return {
        "stage": "arches",
        "input_path": str(input_path),
        "output_path": str(output_path),
        "total_entries": total_entries,
        "total_rows": total_rows,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Emit Arches business data CSV")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    manifest = emit_csv(args.input, args.output)
    print(orjson.dumps(manifest, option=orjson.OPT_INDENT_2).decode(), file=sys.stderr)


if __name__ == "__main__":
    main()
