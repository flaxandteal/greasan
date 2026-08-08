"""Parse Téarma.ie TBX XML into normalised JSONL (same shape as normalise.py output)."""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import orjson

from goidelic.normalise import normalise_text, normalise_for_search

# --- POS mapping ---

# Téarma uses both English abbreviations and Irish grammatical labels.
# Irish labels encode gender + declension class (fir1 = masculine 1st declension).
TEARMA_POS_MAP: dict[str, str] = {
    # English-style
    "s": "noun",
    "v": "verb",
    "a": "adjective",
    "properNoun": "proper noun",
    "abbr": "noun",
    "phr.": "phrase",
    "pref": "prefix",
    # Irish masculine nouns (fir = firinscneach)
    "fir": "noun",
    "fir1": "noun",
    "fir2": "noun",
    "fir3": "noun",
    "fir4": "noun",
    "fir5": "noun",
    # Irish feminine nouns (bain = baininscneach)
    "bain": "noun",
    "bain2": "noun",
    "bain3": "noun",
    "bain4": "noun",
    "bain5": "noun",
    # Plural-only nouns
    "iol": "noun",
    "pl": "noun",
    "s pl": "noun",
    # Irish verb
    "br": "verb",
    # Irish adjectives by declension
    "a1": "adjective",
    "a2": "adjective",
    "a3": "adjective",
    "gu mar a": "adjective",
    # Abbreviations
    "gior": "noun",
    "abr": "noun",
    # Irish-language labels
    "frása": "phrase",
    "réimír": "prefix",
}

# Gender extraction from Irish POS tags
TEARMA_GENDER_MAP: dict[str, list[str]] = {
    "fir": ["masculine"],
    "fir1": ["masculine"],
    "fir2": ["masculine"],
    "fir3": ["masculine"],
    "fir4": ["masculine"],
    "fir5": ["masculine"],
    "bain": ["feminine"],
    "bain2": ["feminine"],
    "bain3": ["feminine"],
    "bain4": ["feminine"],
    "bain5": ["feminine"],
    "iol": ["plural"],
    "pl": ["plural"],
    "s pl": ["plural"],
}

# Téarma top-level domain → UNESCO Thesaurus concept group label.
# Keyed on the actual top-level strings found in the 25.10.01 TBX export.
# The real file uses hierarchical domains ("Law » Property Law"); map_domains()
# strips to the top-level before looking up here.
TEARMA_DOMAIN_TO_UNESCO: dict[str, str] = {
    # Exact top-level labels from the real TBX
    "Agriculture, Fishing": "Agriculture",
    "Archaeology": "History",
    "Architecture": "Architecture",
    "Art": "Art",
    "Arts, Crafts": "Art",
    "Biology": "Biology",
    "Business": "Trade",
    "Chemistry": "Chemistry",
    "Computers, Computer Science": "Information technology",
    "Dancing": "Performing arts",
    "Economics": "Economics",
    "Education": "Education",
    "Electricity, Electronics": "Energy",
    "Engineering": "Engineering",
    "Environment & Ecology": "Environment",
    "Environment &amp; Ecology": "Environment",
    "Fashion": "Textile industry",
    "Finance": "Financial management",
    "Geography": "Geography",
    "Government": "Government",
    "Health": "Health",
    "History": "History",
    "Industry": "Industry",
    "Law": "Legal systems",
    "Leisure": "Leisure",
    "Librarianship": "Library science",
    "Literature": "Linguistics",
    "Mathematics": "Mathematics",
    "Media": "Communication",
    "Medicine, Medical": "Medical sciences",
    "Military": "Defence",
    "Music": "Performing arts",
    "Natural Sciences & Mathematics": "Mathematics",
    "Natural Sciences &amp; Mathematics": "Mathematics",
    "Nautical": "Transport",
    "Organisation": "Public administration",
    "Physics": "Physics",
    "Policing": "Legal systems",
    "Politics": "Political science",
    "Publishing": "Printing",
    "Religion": "Religion",
    "Safety": "Health",
    "Social Science": "Social sciences",
    "Sports": "Leisure",
    "Technical Drawing": "Engineering",
    "Tourism": "Tourism",
    "Trades, Crafts": "Industry",
    "Transport": "Transport",
    "Veterinary science": "Veterinary medicine",
    "Zoology": "Zoology",
    # Local extensions (no clean UNESCO match)
    "Calendar": "Calendar",
    "Colours": "Colours",
    "Culinary": "Culinary arts",
    "Home Economics": "Home economics",
    "Names": "Names",
    "Nationalities and Peoples": "Names",
    "Placenames": "Names",
    "Signage": "Signage",
}

# TBX namespaces
_NS = {
    "xml": "http://www.w3.org/XML/1998/namespace",
}


def map_pos(raw_pos: str) -> str:
    """Map a Téarma POS tag to a collection label."""
    return TEARMA_POS_MAP.get(raw_pos.strip(), raw_pos.strip())


def extract_gender(raw_pos: str) -> list[str]:
    """Extract gender/number features from an Irish POS tag."""
    return TEARMA_GENDER_MAP.get(raw_pos.strip(), [])


# Declension is STATED in the Téarma gender code: fir1..fir5 / bain2..bain5
# (noun) and a1..a3 (adjective). The trailing digit is the class. Verb
# conjugation is NOT stated (only br/v) - inferring it is deferred to the
# grammar-class-inference session (see the hand-off), so it stays "" here.
_DECLENSION = {
    "fir1": "1", "a1": "1",
    "fir2": "2", "bain2": "2", "a2": "2",
    "fir3": "3", "bain3": "3", "a3": "3",
    "fir4": "4", "bain4": "4",
    "fir5": "5", "bain5": "5",
}


def extract_declension(raw_pos: str) -> str:
    """Noun/adjective declension class from the POS code, or "" if none.

    Mirror of the Rust ``extract_declension`` in ``tbx_parser.rs`` - keep the two
    in step so the build path and the on-device path emit identical grammar_class.
    """
    return _DECLENSION.get(raw_pos.strip(), "")


# --- grammar_class inference (gramadan morphology engine) --------------------
# grammar_class enrichment lives in goidelic.grammar (shared with the Wiktionary
# normalise path so both embed BuNaMo-attested-or-gramadan-inferred classes).
from .grammar import METHOD_CONFIDENCE as _METHOD_CONFIDENCE
from .grammar import guess_grammar_class


def _clean_domain(text: str) -> str:
    """Clean HTML entity leftovers from domain strings.

    The TBX file has inconsistent encoding: some entries use "&amp;" in XML text
    nodes (which ET parses to "&"), others have double-encoded "&amp;amp;"
    (which ET parses to "&amp;"). We repeatedly reduce "&amp;" → "&".
    """
    result = text
    while "&amp;" in result:
        result = result.replace("&amp;", "&")
    return result.strip()


def map_domains(raw_domains: list[str]) -> list[str]:
    """Map Téarma subject fields to UNESCO Thesaurus labels."""
    mapped = []
    for domain in raw_domains:
        domain = _clean_domain(domain)
        # Skip numeric IDs (some TBX entries have bare concept IDs)
        if domain.isdigit():
            continue
        # Try exact match first
        label = TEARMA_DOMAIN_TO_UNESCO.get(domain)
        if label and label not in mapped:
            mapped.append(label)
            continue
        # Try top-level (before first »)
        base = domain.split("»")[0].strip()
        label = TEARMA_DOMAIN_TO_UNESCO.get(base)
        if label and label not in mapped:
            mapped.append(label)
    return mapped


def _text(el: ET.Element | None) -> str:
    """Get text content, empty string if None."""
    if el is None:
        return ""
    return (el.text or "").strip()


def _find_descrips(parent: ET.Element, dtype: str) -> list[str]:
    """Find all <descrip type="dtype"> text values under parent."""
    results = []
    for descrip in parent.findall("descrip"):
        if descrip.get("type") == dtype:
            text = _text(descrip)
            if text:
                results.append(text)
    return results


def parse_term_entry(entry: ET.Element) -> list[dict]:
    """Parse a single <termEntry> into zero or more normalised records.

    Returns one record per Irish synonym (ntig/tig). Records with the same
    (word, pos) are expected to be merged later by merge_duplicates().
    """
    # Extract subject fields
    raw_domains = _find_descrips(entry, "subjectField")

    records = []

    for lang_set in entry.findall("langSet"):
        lang = lang_set.get("{http://www.w3.org/XML/1998/namespace}lang", "")
        if lang != "ga":
            continue

        # langSet-level definitions and examples
        ls_definitions = _find_descrips(lang_set, "definition")
        ls_examples = _find_descrips(lang_set, "example")

        # Collect English gloss from the en langSet (if present)
        en_gloss = ""
        for en_ls in entry.findall("langSet"):
            en_lang = en_ls.get("{http://www.w3.org/XML/1998/namespace}lang", "")
            if en_lang == "en":
                en_defs = _find_descrips(en_ls, "definition")
                if en_defs:
                    en_gloss = en_defs[0]
                else:
                    # Try explanation
                    en_expl = _find_descrips(en_ls, "explanation")
                    if en_expl:
                        en_gloss = en_expl[0]
                    else:
                        # Fall back to English term text
                        for en_ntig in en_ls.findall(".//ntig"):
                            en_term = en_ntig.find(".//term")
                            if en_term is not None:
                                en_gloss = _text(en_term)
                                break
                        if not en_gloss:
                            for en_tig in en_ls.findall(".//tig"):
                                en_term = en_tig.find("term")
                                if en_term is not None:
                                    en_gloss = _text(en_term)
                                    break
                break

        # Process each synonym (ntig or tig)
        term_groups: list[ET.Element] = list(lang_set.findall("ntig"))
        term_groups.extend(lang_set.findall("tig"))

        for tg in term_groups:
            # Check normative authorization - skip deprecated terms
            norm_auth = None
            for note in tg.findall("termNote"):
                if note.get("type") == "normativeAuthorization":
                    norm_auth = _text(note)
            if norm_auth == "dímholta":
                continue

            # Get term text
            term_el = tg.find(".//term") if tg.tag == "ntig" else tg.find("term")
            if term_el is None:
                continue
            headword = normalise_text(_text(term_el))
            if not headword:
                continue

            # Get POS
            raw_pos = ""
            for note in tg.findall("termNote"):
                if note.get("type") == "partOfSpeech":
                    raw_pos = _text(note)
                    break
            # Also check termGrp inside ntig
            if not raw_pos:
                term_grp = tg.find("termGrp")
                if term_grp is not None:
                    for note in term_grp.findall("termNote"):
                        if note.get("type") == "partOfSpeech":
                            raw_pos = _text(note)
                            break

            pos = map_pos(raw_pos) if raw_pos else "noun"
            gender = extract_gender(raw_pos) if raw_pos else []

            # Build senses - use en_gloss as primary, ls_definitions as secondary
            gloss = en_gloss
            if not gloss and ls_definitions:
                gloss = ls_definitions[0]
            if not gloss:
                gloss = headword  # fallback: headword itself

            senses = [{"gloss": gloss, "examples": ls_examples[:]}]
            # Additional definitions become additional senses
            extra_start = 1 if (ls_definitions and gloss == ls_definitions[0]) else 0
            for extra_def in ls_definitions[extra_start:]:
                if extra_def != gloss:
                    senses.append({"gloss": extra_def, "examples": []})

            # Build forms with gender info
            forms = []
            if gender:
                forms.append({
                    "written_rep": headword,
                    "written_rep_search": normalise_for_search(headword),
                    "gram_features": gender,
                })

            mapped_domains = map_domains(raw_domains)

            # grammar_class: prefer the explicit TBX declension code (attested);
            # otherwise infer it for nouns/verbs via the gramadan morphology
            # engine, tagging the confidence by which strategy resolved it.
            gclass = extract_declension(raw_pos)
            gclass_conf = "attested" if gclass else ""
            if not gclass and pos in ("noun", "verb"):
                gclass, method = guess_grammar_class(headword, pos, gender)
                gclass_conf = _METHOD_CONFIDENCE.get(method, "uncertain") if gclass else ""

            records.append({
                "word": headword,
                "word_search": normalise_for_search(headword),
                "lang_code": "ga",
                "dialect": "Irish (General)",
                "pos": pos,
                "raw_pos": raw_pos,
                # Inherent lexeme gender (lexinfo:gender), entry-level - distinct from
                # the form-tile gram_features tag above.
                "gender": next((g for g in gender if g in ("masculine", "feminine")), ""),
                "grammar_class": gclass,
                "grammar_class_confidence": gclass_conf,
                "pronunciations": [],
                "senses": senses,
                "forms": forms,
                "categories": mapped_domains,
                "etymology_text": "",
            })

    return records


def merge_duplicates(records: list[dict]) -> list[dict]:
    """Merge records with the same (word, pos, lang_code).

    Combines senses and deduplicates categories. The first record's metadata
    wins for other fields.
    """
    grouped: dict[tuple[str, str, str], dict] = {}
    order: list[tuple[str, str, str]] = []

    for rec in records:
        key = (rec["word"], rec["pos"], rec["lang_code"])
        if key not in grouped:
            grouped[key] = {**rec, "senses": list(rec["senses"]), "categories": list(rec["categories"])}
            order.append(key)
        else:
            existing = grouped[key]
            # Merge senses - deduplicate by gloss text
            existing_glosses = {s["gloss"] for s in existing["senses"]}
            for sense in rec["senses"]:
                if sense["gloss"] not in existing_glosses:
                    existing["senses"].append(sense)
                    existing_glosses.add(sense["gloss"])
            # Merge categories
            for cat in rec["categories"]:
                if cat not in existing["categories"]:
                    existing["categories"].append(cat)

    return [grouped[k] for k in order]


def parse_tbx(input_path: Path, source_label: str = "") -> list[dict]:
    """Parse a TBX file and return merged normalised records.

    If *source_label* is given (e.g. ``"TE"``), it is stamped on every record
    so that downstream stages can propagate it into sense tiles.
    """
    tree = ET.parse(input_path)
    root = tree.getroot()

    # Find all termEntry elements (handle both namespaced and plain)
    term_entries = root.findall(".//termEntry")
    if not term_entries:
        # Try with body wrapper
        term_entries = root.findall("body/termEntry")
    if not term_entries:
        # Try text/body
        term_entries = root.findall("text/body/termEntry")

    all_records: list[dict] = []
    for entry in term_entries:
        records = parse_term_entry(entry)
        all_records.extend(records)

    merged = merge_duplicates(all_records)

    if source_label:
        for rec in merged:
            rec["source_label"] = source_label

    return merged


def parse_tbx_to_jsonl(input_path: Path, output_path: Path, source_label: str = "") -> dict:
    """Parse TBX and write normalised JSONL. Returns manifest."""
    records = parse_tbx(input_path, source_label=source_label)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        for rec in records:
            f.write(orjson.dumps(rec))
            f.write(b"\n")

    # Collect stats
    domains_seen: set[str] = set()
    for rec in records:
        domains_seen.update(rec.get("categories", []))

    return {
        "stage": "tbx",
        "input_path": str(input_path),
        "output_path": str(output_path),
        "total_entries": len(records),
        "domains_seen": sorted(domains_seen),
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Parse Téarma TBX to normalised JSONL")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    manifest = parse_tbx_to_jsonl(args.input, args.output)
    print(orjson.dumps(manifest, option=orjson.OPT_INDENT_2).decode(), file=sys.stderr)


if __name__ == "__main__":
    main()
