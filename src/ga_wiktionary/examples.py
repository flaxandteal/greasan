"""Fetch external example sentences (Tatoeba + Gaois) and match against headwords."""

from __future__ import annotations

import csv
import io
import re
import sys
import tarfile
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import httpx
import orjson

from ga_wiktionary.normalise import normalise_for_search

# Alizarin UUID namespace — must match alizarin-core's NAMESPACE constant
ALIZARIN_NS = uuid.UUID("1a79f1c8-9505-4bea-a18e-28a053f725ca")

# --- Constants ---

TATOEBA_SENTENCES_URL = "https://downloads.tatoeba.org/exports/sentences.tar.bz2"
TATOEBA_LINKS_URL = "https://downloads.tatoeba.org/exports/links.tar.bz2"

GAOIS_TMX_URLS = [
    "https://www.gaois.ie/assets/tmx/18.10.25-gaois.ie-crp-tmx-irish-legislation-constitution.zip",
    "https://www.gaois.ie/assets/tmx/18.10.25-gaois.ie-crp-tmx-irish-legislation-primary-1922-1949.zip",
    "https://www.gaois.ie/assets/tmx/18.10.25-gaois.ie-crp-tmx-irish-legislation-primary-1950-1979.zip",
    "https://www.gaois.ie/assets/tmx/18.10.25-gaois.ie-crp-tmx-irish-legislation-primary-1980-2014.zip",
    "https://www.gaois.ie/assets/tmx/18.10.25-gaois.ie-crp-tmx-irish-legislation-secondary.zip",
    "https://www.gaois.ie/assets/tmx/18.10.25-gaois.ie-crp-tmx-irish-legislation-secondary-court-rules.zip",
]

MAX_EXAMPLES_PER_SOURCE = 3
MAX_SENTENCE_WORDS = 15  # prefer shorter sentences

# Lenition: consonants that take séimhiú
LENITABLE = {"b", "c", "d", "f", "g", "m", "p", "s", "t"}

# Eclipsis: consonant → eclipsed prefix
ECLIPSIS_MAP = {
    "b": "mb",
    "c": "gc",
    "d": "nd",
    "f": "bhf",
    "g": "ng",
    "p": "bp",
    "t": "dt",
}

# Vowels that can take prothesis
VOWELS = set("aeiouáéíóú")


# --- Surface form generation ---


def surface_forms(headword: str) -> set[str]:
    """Generate possible surface forms of a headword including mutations.

    Covers lenition, eclipsis, and vowel prothesis (h-, n-, t-).
    """
    forms = {headword, headword.capitalize()}
    if not headword:
        return forms

    first = headword[0].lower()
    rest = headword[1:]

    # Lenition: b→bh, c→ch, d→dh, f→fh, g→gh, m→mh, p→ph, s→sh, t→th
    if first in LENITABLE:
        lenited = first + "h" + rest
        forms.add(lenited)
        forms.add(lenited.capitalize())

    # Eclipsis: b→mb, c→gc, d→nd, f→bhf, g→ng, p→bp, t→dt
    if first in ECLIPSIS_MAP:
        eclipsed = ECLIPSIS_MAP[first] + rest
        forms.add(eclipsed)
        forms.add(eclipsed.capitalize())

    # Vowel prothesis: h-V, n-V, t-V (uppercase and lowercase)
    if first in VOWELS:
        for prefix in ["h", "n-", "t-"]:
            prefixed = prefix + headword
            forms.add(prefixed)
            forms.add(prefixed.capitalize())

    return forms


# --- Matching ---

# Token boundary pattern for splitting sentences into words
_TOKEN_RE = re.compile(r"[\w'-]+", re.UNICODE)


def find_highlights(text: str, target_forms: set[str]) -> list[tuple[int, int]]:
    """Find character offset spans where any target form appears as a token."""
    highlights = []
    for m in _TOKEN_RE.finditer(text):
        token = m.group()
        if token in target_forms or token.lower() in {f.lower() for f in target_forms}:
            highlights.append((m.start(), m.end()))
    return highlights


def build_inverted_index(headwords: list[str]) -> dict[str, str]:
    """Build surface_form → headword mapping for all headwords."""
    index: dict[str, str] = {}
    for hw in headwords:
        for form in surface_forms(hw):
            # First headword wins for ambiguous forms
            if form not in index:
                index[form] = hw
            # Also index lowercased for case-insensitive matching
            lower = form.lower()
            if lower not in index:
                index[lower] = hw
    return index


def match_sentences(
    sentences: list[tuple[str, str, str, str]],  # (ga_text, en_text, source, id)
    inverted: dict[str, str],
    headword_forms: dict[str, set[str]],
) -> dict[str, list[dict]]:
    """Match sentences to headwords via the inverted index.

    Returns {headword: [example_dicts]}.
    """
    results: dict[str, list[dict]] = {}

    for ga_text, en_text, source, sent_id in sentences:
        matched_headwords: set[str] = set()
        for m in _TOKEN_RE.finditer(ga_text):
            token = m.group()
            hw = inverted.get(token) or inverted.get(token.lower())
            if hw and hw not in matched_headwords:
                matched_headwords.add(hw)

        for hw in matched_headwords:
            if hw not in results:
                results[hw] = []
            # Cap per source
            source_count = sum(1 for e in results[hw] if e["src"] == source)
            if source_count >= MAX_EXAMPLES_PER_SOURCE:
                continue
            # Compute highlights
            hl = find_highlights(ga_text, headword_forms[hw])
            if not hl:
                continue
            results[hw].append({
                "ga": ga_text,
                "en": en_text,
                "src": source,
                "id": sent_id,
                "hl": hl,
            })

    return results


# --- Tatoeba fetch + parse ---


def fetch_tatoeba(cache_dir: Path) -> list[tuple[str, str, str, str]]:
    """Download and parse Tatoeba sentences + links for Irish.

    Returns list of (ga_text, en_text, 'tatoeba', sentence_id).
    """
    sentences_path = cache_dir / "sentences.tar.bz2"
    links_path = cache_dir / "links.tar.bz2"

    client = httpx.Client(follow_redirects=True, timeout=120.0)

    # Download if not cached
    if not sentences_path.exists():
        print("[examples] Downloading Tatoeba sentences...", file=sys.stderr)
        resp = client.get(TATOEBA_SENTENCES_URL)
        resp.raise_for_status()
        sentences_path.write_bytes(resp.content)

    if not links_path.exists():
        print("[examples] Downloading Tatoeba links...", file=sys.stderr)
        resp = client.get(TATOEBA_LINKS_URL)
        resp.raise_for_status()
        links_path.write_bytes(resp.content)

    client.close()

    # Parse sentences: id \t lang \t text
    irish_sentences: dict[str, str] = {}  # id → text
    english_sentences: dict[str, str] = {}  # id → text

    print("[examples] Parsing Tatoeba sentences...", file=sys.stderr)
    with tarfile.open(sentences_path, "r:bz2") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            f = tf.extractfile(member)
            if f is None:
                continue
            for line in io.TextIOWrapper(f, encoding="utf-8"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 3:
                    continue
                sent_id, lang, text = parts[0], parts[1], parts[2]
                if lang == "gle":
                    irish_sentences[sent_id] = text
                elif lang == "eng":
                    english_sentences[sent_id] = text

    # Parse links: id \t translation_id
    irish_to_english: dict[str, str] = {}  # irish_id → english_id
    print("[examples] Parsing Tatoeba links...", file=sys.stderr)
    with tarfile.open(links_path, "r:bz2") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            f = tf.extractfile(member)
            if f is None:
                continue
            for line in io.TextIOWrapper(f, encoding="utf-8"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 2:
                    continue
                src_id, tgt_id = parts[0], parts[1]
                if src_id in irish_sentences and tgt_id in english_sentences:
                    irish_to_english[src_id] = tgt_id

    # Build paired results
    results = []
    for irish_id, eng_id in irish_to_english.items():
        ga_text = irish_sentences[irish_id]
        en_text = english_sentences[eng_id]
        results.append((ga_text, en_text, "tatoeba", irish_id))

    print(f"[examples] Tatoeba: {len(results)} Irish-English pairs", file=sys.stderr)
    return results


# --- Gaois TMX fetch + parse ---


def fetch_gaois(cache_dir: Path) -> list[tuple[str, str, str, str]]:
    """Download and parse Gaois legislation TMX files.

    Returns list of (ga_text, en_text, 'gaois', segment_id).
    """
    client = httpx.Client(follow_redirects=True, timeout=120.0)
    results = []

    for url in GAOIS_TMX_URLS:
        filename = url.rsplit("/", 1)[1]
        zip_path = cache_dir / filename

        if not zip_path.exists():
            print(f"[examples] Downloading {filename}...", file=sys.stderr)
            resp = client.get(url)
            resp.raise_for_status()
            zip_path.write_bytes(resp.content)

        # Parse TMX from zip
        with zipfile.ZipFile(zip_path) as zf:
            for name in zf.namelist():
                if not name.endswith(".tmx"):
                    continue
                with zf.open(name) as tmx_file:
                    pairs = _parse_tmx(tmx_file, filename)
                    results.extend(pairs)

    client.close()
    print(f"[examples] Gaois: {len(results)} pairs after filtering", file=sys.stderr)
    return results


def _parse_tmx(
    fileobj: io.BufferedIOBase, source_name: str
) -> list[tuple[str, str, str, str]]:
    """Parse a TMX file, extracting ga/en segment pairs.

    Filters to 4-10 word Irish segments, skipping all-caps and UI cruft.
    """
    results = []
    seg_counter = 0

    try:
        tree = ET.parse(fileobj)
    except ET.ParseError:
        return results

    root = tree.getroot()
    body = root.find("body")
    if body is None:
        return results

    for tu in body.iter("tu"):
        ga_text = ""
        en_text = ""
        for tuv in tu.iter("tuv"):
            lang = tuv.get("{http://www.w3.org/XML/1998/namespace}lang", "") or tuv.get(
                "lang", ""
            )
            seg = tuv.find("seg")
            if seg is None or seg.text is None:
                continue
            text = seg.text.strip()
            if lang.startswith("ga"):
                ga_text = text
            elif lang.startswith("en"):
                en_text = text

        if not ga_text or not en_text:
            continue

        # Filter: 4-10 words in the Irish segment
        word_count = len(ga_text.split())
        if word_count < 4 or word_count > 10:
            continue

        # Skip all-caps (headings)
        if ga_text == ga_text.upper() and len(ga_text) > 3:
            continue

        # Skip entries that look like UI cruft (pure numbers, URLs)
        if ga_text.startswith("http") or ga_text.isdigit():
            continue

        seg_counter += 1
        seg_id = f"{source_name.replace('.tmx.zip', '')}-{seg_counter}"
        results.append((ga_text, en_text, "gaois", seg_id))

    return results


# --- UUID computation (matches alizarin-core) ---


def resource_uuid(graph_id: str, resource_id: str) -> str:
    """Compute deterministic UUID for a resource, matching alizarin's formula."""
    namespace = uuid.uuid5(ALIZARIN_NS, f"resource/{graph_id}")
    return str(uuid.uuid5(namespace, resource_id))


# --- Output: business data CSVs ---

EXAMPLE_COLUMNS = [
    "ResourceID",
    "sentence_ga",
    "sentence_en",
    "source",
    "source_id",
    "highlights",
]


def example_resource_id(source: str, sent_id: str) -> str:
    """Generate a stable ResourceID string for an example."""
    return f"ex-{source}-{sent_id}"


def format_highlights(hl: list[tuple[int, int]]) -> str:
    """Encode highlight spans as semicolon-separated start,end pairs."""
    return ";".join(f"{s},{e}" for s, e in hl)


def write_example_csv(
    examples: dict[str, list[dict]],
    output_path: Path,
) -> int:
    """Write example_data.csv for the ExternalExample resource model.

    Returns total examples written.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Deduplicate: same sentence can match multiple headwords.
    # Keep first occurrence (by ResourceID) — alizarin requires contiguous rows.
    seen: dict[str, dict] = {}
    for ex_list in examples.values():
        for ex in ex_list:
            rid = example_resource_id(ex["src"], ex["id"])
            if rid not in seen:
                seen[rid] = {
                    "ResourceID": rid,
                    "sentence_ga": ex["ga"],
                    "sentence_en": ex["en"],
                    "source": "Tatoeba" if ex["src"] == "tatoeba" else "Gaois",
                    "source_id": ex["id"],
                    "highlights": format_highlights(ex["hl"]),
                }

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=EXAMPLE_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in seen.values():
            writer.writerow(row)

    return len(seen)


def augment_entry_csv(
    examples: dict[str, list[dict]],
    entry_csv_path: Path,
    output_path: Path,
    example_graph_id: str,
) -> int:
    """Read existing entry CSV, add external_examples column with one UUID per row.

    For entries with N examples, emits N extra rows (same ResourceID, one UUID each)
    so that alizarin creates separate tile entries that populateCaches can resolve.

    Returns count of entries augmented. Safe for in-place writes (reads all rows first).
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Pre-compute example UUIDs per headword
    hw_example_uuids: dict[str, list[str]] = {}
    for hw, ex_list in examples.items():
        uuids = []
        for ex in ex_list:
            rid = example_resource_id(ex["src"], ex["id"])
            uuids.append(resource_uuid(example_graph_id, rid))
        hw_example_uuids[hw] = uuids

    # Read all rows into memory first (safe for in-place writes)
    with open(entry_csv_path, "r", encoding="utf-8") as fin:
        reader = csv.DictReader(fin)
        fieldnames = list(reader.fieldnames or [])
        if "external_examples" not in fieldnames:
            fieldnames.append("external_examples")
        rows = list(reader)

    augmented = 0
    with open(output_path, "w", newline="", encoding="utf-8") as fout:
        writer = csv.DictWriter(fout, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()

        for row in rows:
            headword = row.get("headword", "")
            uuids = hw_example_uuids.get(headword, [])
            if uuids:
                # Write the original row with first UUID
                row["external_examples"] = uuids[0]
                writer.writerow(row)
                # Write extra rows for remaining UUIDs (same ResourceID, only this column)
                for u in uuids[1:]:
                    writer.writerow({
                        "ResourceID": row["ResourceID"],
                        "external_examples": u,
                    })
                augmented += 1
            else:
                writer.writerow(row)

    return augmented


# --- Main orchestrator ---


def load_headwords(resource_names_path: Path) -> list[str]:
    """Load headwords from the resource_names.json file."""
    data = orjson.loads(resource_names_path.read_bytes())
    return list(data.values())


def load_headwords_from_csv(entry_csv_path: Path) -> list[str]:
    """Load headwords from the entry business data CSV."""
    headwords = []
    with open(entry_csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            hw = row.get("headword", "")
            if hw and hw not in headwords:
                headwords.append(hw)
    return headwords


def run(
    example_csv_path: Path,
    entry_csv_path: Path,
    example_graph_id: str,
    resource_names_path: Path | None = None,
    cache_dir: Path | None = None,
) -> None:
    """Run the full examples pipeline: fetch, match, emit CSVs."""
    if cache_dir is None:
        cache_dir = Path("data/raw/examples")

    cache_dir.mkdir(parents=True, exist_ok=True)

    # Load headwords from entry CSV (more reliable than resource_names.json)
    print("[examples] Loading headwords...", file=sys.stderr)
    if resource_names_path and resource_names_path.exists():
        headwords = load_headwords(resource_names_path)
    else:
        headwords = load_headwords_from_csv(entry_csv_path)
    print(f"[examples] {len(headwords)} headwords loaded", file=sys.stderr)

    # Build forms for each headword
    headword_forms: dict[str, set[str]] = {}
    for hw in headwords:
        headword_forms[hw] = surface_forms(hw)

    # Build inverted index
    print("[examples] Building inverted index...", file=sys.stderr)
    inverted = build_inverted_index(headwords)
    print(f"[examples] {len(inverted)} surface forms indexed", file=sys.stderr)

    # Fetch corpora
    all_sentences: list[tuple[str, str, str, str]] = []

    tatoeba = fetch_tatoeba(cache_dir)
    all_sentences.extend(tatoeba)

    gaois = fetch_gaois(cache_dir)
    all_sentences.extend(gaois)

    # Sort by length (prefer shorter sentences)
    all_sentences.sort(key=lambda x: len(x[0]))

    # Match
    print(f"[examples] Matching {len(all_sentences)} sentences...", file=sys.stderr)
    examples = match_sentences(all_sentences, inverted, headword_forms)
    total_examples = sum(len(v) for v in examples.values())
    print(
        f"[examples] {total_examples} examples matched across "
        f"{len(examples)} headwords",
        file=sys.stderr,
    )

    # Write example business data CSV
    count = write_example_csv(examples, example_csv_path)
    print(f"[examples] Wrote {count} examples to {example_csv_path}", file=sys.stderr)

    # Augment entry CSV with external_examples column (writes in-place)
    augmented_path = entry_csv_path
    augmented = augment_entry_csv(
        examples, entry_csv_path, augmented_path, example_graph_id
    )
    print(
        f"[examples] Augmented {augmented} entries with example references",
        file=sys.stderr,
    )


# --- CLI ---


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Fetch external examples and match against headwords"
    )
    parser.add_argument(
        "--example-csv",
        type=Path,
        default=Path("data/processed/example_data.csv"),
        help="Output path for example business data CSV",
    )
    parser.add_argument(
        "--entry-csv",
        type=Path,
        default=Path("data/processed/lexical_entry_data.csv"),
        help="Path to entry business data CSV (will be augmented in-place)",
    )
    parser.add_argument(
        "--example-graph-id",
        type=str,
        default="6d502e2e-7fe6-5414-99e4-ac981cebc493",
        help="Graph ID for the ExternalExample model",
    )
    parser.add_argument(
        "--resource-names",
        type=Path,
        default=None,
        help="Path to resource_names.json (optional, falls back to entry CSV)",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help="Cache directory for downloaded corpora",
    )
    args = parser.parse_args()

    run(
        args.example_csv,
        args.entry_csv,
        args.example_graph_id,
        args.resource_names,
        args.cache_dir,
    )


if __name__ == "__main__":
    main()
