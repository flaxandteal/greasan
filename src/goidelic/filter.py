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


def filter_entries(
    input_paths: list[Path],
    output_path: Path,
    lang_codes: set[str] | None = None,
) -> dict:
    """Filter raw JSONL to lemmas-only, merging multiple input files.

    Keeps entries where:
    - lang_code is in lang_codes (if specified)
    - Not purely a form-of entry (at least one sense without form_of)

    Each output record carries its lang_code through.

    Returns manifest dict with counts.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    kept = 0
    dropped_form_of = 0
    dropped_lang = 0

    with open(output_path, "wb") as fout:
        for input_path in input_paths:
            if not input_path.exists():
                print(f"[filter] Skipping missing input: {input_path}", file=sys.stderr)
                continue
            with open(input_path, "rb") as fin:
                for line in fin:
                    entry = orjson.loads(line)
                    total += 1

                    entry_lang = entry.get("lang_code", "")
                    if lang_codes and entry_lang not in lang_codes:
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
        "input_paths": [str(p) for p in input_paths],
        "output_path": str(output_path),
        "total": total,
        "kept": kept,
        "dropped_form_of": dropped_form_of,
        "dropped_lang": dropped_lang,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Filter Kaikki JSONL to Goidelic lemmas")
    parser.add_argument("--input", required=True, type=Path, action="append")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    manifest = filter_entries(args.input, args.output)
    print(orjson.dumps(manifest, option=orjson.OPT_INDENT_2).decode(), file=sys.stderr)


if __name__ == "__main__":
    main()
