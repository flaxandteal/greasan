"""Tests for the fetch stage."""

from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from goidelic.fetch import (
    FetchManifest,
    KaikkiMetadata,
    scrape_metadata,
    sha256_file,
    write_manifest,
)

# --- Metadata scraping ---

SAMPLE_HTML = """
<p>The data has been extracted on 2026-05-03 from the enwiktionary dump
dated 2026-04-01 using
<a href="https://github.com/tatuylonen/wiktextract">Wiktextract</a>
(<a href="https://github.com/tatuylonen/wiktextract/commit/4d423fda57174d69bf2c03426b253890be55dc15">4d423fd</a>)
and
<a href="https://github.com/tatuylonen/wikitextprocessor/commit/9452535b95088345ce2ce7ae86a5f48bf693041c">9452535</a>)
</p>
"""


def test_scrape_metadata_parses_sample_html():
    meta = scrape_metadata(SAMPLE_HTML)
    assert meta.dump_date == "2026-04-01"
    assert meta.extract_date == "2026-05-03"
    assert meta.wiktextract_commit.startswith("4d423fd")
    assert meta.wikitextprocessor_commit.startswith("9452535")


def test_scrape_metadata_raises_on_missing_fields():
    with pytest.raises(ValueError, match="missing"):
        scrape_metadata("<html>nothing useful here</html>")


def test_scrape_metadata_partial_missing():
    html_only_dump = '<p>dump dated 2026-04-01</p>'
    with pytest.raises(ValueError, match="extract_date"):
        scrape_metadata(html_only_dump)


# --- SHA-256 ---


def test_sha256_file(tmp_path: Path):
    test_file = tmp_path / "test.txt"
    content = b"fear\n"  # Irish for 'man'
    test_file.write_bytes(content)
    expected = hashlib.sha256(content).hexdigest()
    assert sha256_file(test_file) == expected


def test_sha256_file_empty(tmp_path: Path):
    test_file = tmp_path / "empty.txt"
    test_file.write_bytes(b"")
    expected = hashlib.sha256(b"").hexdigest()
    assert sha256_file(test_file) == expected


# --- Manifest ---


def test_manifest_model_roundtrip():
    manifest = FetchManifest(
        source_url="https://kaikki.org/dictionary/Irish/kaikki.org-dictionary-Irish.jsonl",
        dump_date="2026-04-01",
        extract_date="2026-05-03",
        wiktextract_commit="4d423fda57174d69bf2c03426b253890be55dc15",
        wikitextprocessor_commit="9452535b95088345ce2ce7ae86a5f48bf693041c",
        file_sha256="abc123",
        output_path="data/raw/kaikki.org-dictionary-Irish.jsonl",
        file_size_bytes=111_300_000,
        fetch_timestamp="2026-05-04T12:00:00+00:00",
    )
    d = manifest.model_dump()
    rebuilt = FetchManifest(**d)
    assert rebuilt == manifest


def test_write_manifest_creates_file(tmp_path: Path):
    manifest = FetchManifest(
        source_url="https://example.com/test.jsonl",
        dump_date="2026-04-01",
        extract_date="2026-05-03",
        wiktextract_commit="abc",
        wikitextprocessor_commit="def",
        file_sha256="deadbeef",
        output_path="data/raw/test.jsonl",
        file_size_bytes=42,
        fetch_timestamp="2026-05-04T12-00-00+00-00",
    )
    manifests_dir = tmp_path / "manifests"
    path = write_manifest(manifest, manifests_dir)
    assert path.exists()
    assert path.suffix == ".json"
    assert manifests_dir.exists()


# --- Metadata model ---


def test_kaikki_metadata_model():
    meta = KaikkiMetadata(
        dump_date="2026-04-01",
        extract_date="2026-05-03",
        wiktextract_commit="4d423fd",
        wikitextprocessor_commit="9452535",
    )
    assert meta.dump_date == "2026-04-01"
