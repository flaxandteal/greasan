"""Filter raw Kaikki JSONL: keep lemmas, drop form-of entries."""

from __future__ import annotations

import sys
from pathlib import Path

import orjson


def is_form_of(entry: dict) -> bool:
    """Check if all senses of an entry are form-of references."""
    senses = entry.get("senses", [])
    if not senses:
        return False
    return all("form_of" in s for s in senses)


def filter_entries(input_path: Path, output_path: Path) -> dict:
    """Filter raw JSONL to lemmas-only.

    Keeps entries where:
    - lang_code == "ga"
    - Not purely a form-of entry (at least one sense without form_of)

    Returns manifest dict with counts.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    kept = 0
    dropped_form_of = 0
    dropped_lang = 0

    with open(input_path, "rb") as fin, open(output_path, "wb") as fout:
        for line in fin:
            entry = orjson.loads(line)
            total += 1

            if entry.get("lang_code") != "ga":
                dropped_lang += 1
                continue

            if is_form_of(entry):
                dropped_form_of += 1
                continue

            fout.write(orjson.dumps(entry))
            fout.write(b"\n")
            kept += 1

    return {
        "stage": "filter",
        "input_path": str(input_path),
        "output_path": str(output_path),
        "total": total,
        "kept": kept,
        "dropped_form_of": dropped_form_of,
        "dropped_lang": dropped_lang,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Filter Kaikki JSONL to Irish lemmas")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    manifest = filter_entries(args.input, args.output)
    print(orjson.dumps(manifest, option=orjson.OPT_INDENT_2).decode(), file=sys.stderr)


if __name__ == "__main__":
    main()
