"""Normalise filtered JSONL: NFC, séimhiú-dot, LexInfo tag mapping."""

from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

import orjson

# Séimhiú-dot precomposed characters → lenis-h equivalents
_DOT_ABOVE_MAP: dict[str, str] = {
    "\u1e02": "Bh",  # Ḃ
    "\u1e03": "bh",  # ḃ
    "\u010a": "Ch",  # Ċ
    "\u010b": "ch",  # ċ
    "\u1e0a": "Dh",  # Ḋ
    "\u1e0b": "dh",  # ḋ
    "\u1e1e": "Fh",  # Ḟ
    "\u1e1f": "fh",  # ḟ
    "\u0120": "Gh",  # Ġ
    "\u0121": "gh",  # ġ
    "\u1e40": "Mh",  # Ṁ
    "\u1e41": "mh",  # ṁ
    "\u1e56": "Ph",  # Ṗ
    "\u1e57": "ph",  # ṗ
    "\u1e60": "Sh",  # Ṡ
    "\u1e61": "sh",  # ṡ
    "\u1e6a": "Th",  # Ṫ
    "\u1e6b": "th",  # ṫ
}

# Combining dot above (U+0307) after base letters
_BASE_LETTERS_FOR_DOT = set("BbCcDdFfGgMmPpSsTt")

# Kaikki POS → collection label (matching collections.csv)
POS_MAP: dict[str, str] = {
    "noun": "noun",
    "verb": "verb",
    "adj": "adjective",
    "adv": "adverb",
    "pron": "pronoun",
    "prep": "preposition",
    "conj": "conjunction",
    "intj": "interjection",
    "num": "numeral",
    "particle": "particle",
    "det": "determiner",
    "prefix": "prefix",
    "suffix": "suffix",
    "phrase": "phrase",
    "contraction": "contraction",
    "name": "proper noun",
    "article": "article",
    "character": "character",
    # These don't have direct collection entries; map to closest
    "prep_phrase": "phrase",
    "proverb": "phrase",
}

# Kaikki inflection tags → Grammatical Features collection labels
TAG_MAP: dict[str, str] = {
    "nominative": "nominative",
    "genitive": "genitive",
    "dative": "dative",
    "vocative": "vocative",
    "accusative": "accusative",
    "singular": "singular",
    "plural": "plural",
    "masculine": "masculine",
    "feminine": "feminine",
    "present": "present",
    "past": "past",
    "future": "future",
    "conditional": "conditional",
    "imperative": "imperative",
    "subjunctive": "subjunctive",
    "indicative": "indicative",
    "first-person": "first-person",
    "second-person": "second-person",
    "third-person": "third-person",
    "autonomous": "autonomous",
    "verbal noun": "verbal-noun",
    "verbal adjective": "verbal-adjective",
    "definite": "definite",
    "indefinite": "indefinite",
    "mutation-lenition": "lenited",
    "lenition": "lenited",
    "eclipsis": "eclipsed",
    "mutation-eclipsis": "eclipsed",
    "comparative": "comparative",
    "superlative": "superlative",
}


def dot_to_h(text: str) -> str:
    """Convert séimhiú-dot notation to lenis-h form.

    Handles both precomposed characters (Ḃ) and combining dot above (U+0307).
    """
    # Handle precomposed
    result = text
    for dot_char, h_form in _DOT_ABOVE_MAP.items():
        result = result.replace(dot_char, h_form)

    # Handle combining dot above after relevant base letters
    out = []
    i = 0
    while i < len(result):
        if (
            i + 1 < len(result)
            and result[i] in _BASE_LETTERS_FOR_DOT
            and result[i + 1] == "\u0307"
        ):
            if result[i].isupper():
                out.append(result[i] + "h")
            else:
                out.append(result[i] + "h")
            i += 2
        else:
            out.append(result[i])
            i += 1
    return "".join(out)


def normalise_text(text: str) -> str:
    """NFC normalise text."""
    return unicodedata.normalize("NFC", text)


def normalise_for_search(text: str) -> str:
    """NFC + dot-to-h for search indexing."""
    return dot_to_h(normalise_text(text))


def map_tags(tags: list[str]) -> tuple[list[str], list[str]]:
    """Map Kaikki tags to Grammatical Features labels.

    Returns (mapped_tags, unmapped_tags).
    """
    mapped = []
    unmapped = []
    for tag in tags:
        normalised = tag.lower().strip()
        if normalised in TAG_MAP:
            label = TAG_MAP[normalised]
            if label not in mapped:
                mapped.append(label)
        else:
            unmapped.append(tag)
    return mapped, unmapped


def normalise_entry(entry: dict) -> dict:
    """Normalise a single entry. Returns enriched entry with normalised fields."""
    word = normalise_text(entry.get("word", ""))
    word_search = normalise_for_search(word)

    # Map POS
    raw_pos = entry.get("pos", "")
    pos_label = POS_MAP.get(raw_pos, raw_pos)

    # Normalise forms
    forms = []
    all_unmapped_tags: list[str] = []
    for form in entry.get("forms", []):
        form_text = normalise_text(form.get("form", ""))
        # Skip table-tag markers
        if form_text == "no-table-tags":
            continue
        tags = form.get("tags", [])
        mapped, unmapped = map_tags(tags)
        all_unmapped_tags.extend(unmapped)
        forms.append({
            "written_rep": form_text,
            "written_rep_search": normalise_for_search(form_text),
            "gram_features": mapped,
        })

    # Normalise sounds (IPA only)
    pronunciations = []
    for sound in entry.get("sounds", []):
        if "ipa" in sound:
            pronunciations.append({
                "ipa_value": sound["ipa"],
                "tags": sound.get("tags", []),
            })

    # Normalise senses
    senses = []
    for sense in entry.get("senses", []):
        # Skip form-of senses
        if "form_of" in sense:
            continue
        glosses = sense.get("glosses", [])
        if not glosses:
            continue
        gloss = "; ".join(glosses)
        examples = []
        for ex in sense.get("examples", []):
            text = ex.get("text", "")
            translation = ex.get("english") or ex.get("translation", "")
            if text:
                example_str = text
                if translation:
                    example_str += f" - {translation}"
                examples.append(example_str)
        senses.append({"gloss": gloss, "examples": examples})

    return {
        "word": word,
        "word_search": word_search,
        "pos": pos_label,
        "raw_pos": raw_pos,
        "pronunciations": pronunciations,
        "senses": senses,
        "forms": forms,
        "categories": entry.get("categories", []),
        "etymology_text": entry.get("etymology_text", ""),
        "_unmapped_tags": list(set(all_unmapped_tags)),
    }


def normalise_file(input_path: Path, output_path: Path) -> dict:
    """Normalise all entries in a JSONL file.

    Returns manifest dict.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    all_unmapped: set[str] = set()

    with open(input_path, "rb") as fin, open(output_path, "wb") as fout:
        for line in fin:
            entry = orjson.loads(line)
            normalised = normalise_entry(entry)
            all_unmapped.update(normalised.pop("_unmapped_tags", []))
            fout.write(orjson.dumps(normalised))
            fout.write(b"\n")
            total += 1

    return {
        "stage": "normalise",
        "input_path": str(input_path),
        "output_path": str(output_path),
        "total": total,
        "unmapped_tags": sorted(all_unmapped)[:50],  # Cap for manifest readability
        "unmapped_tag_count": len(all_unmapped),
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Normalise filtered JSONL")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    manifest = normalise_file(args.input, args.output)
    print(orjson.dumps(manifest, option=orjson.OPT_INDENT_2).decode(), file=sys.stderr)


if __name__ == "__main__":
    main()
