"""Tests for the TBX parser (Téarma.ie → normalised JSONL)."""

from __future__ import annotations

from pathlib import Path

import orjson
import pytest

from goidelic.tbx import (
    TEARMA_POS_MAP,
    _clean_domain,
    extract_gender,
    map_domains,
    map_pos,
    merge_duplicates,
    parse_tbx,
    parse_tbx_to_jsonl,
)
from goidelic.ontolex import slugify

FIXTURE = Path(__file__).parent / "fixtures" / "tearma_sample.xml"


@pytest.fixture
def records() -> list[dict]:
    return parse_tbx(FIXTURE)


def _find(records: list[dict], word: str) -> dict | None:
    for r in records:
        if r["word"] == word:
            return r
    return None


# --- POS mapping ---


class TestPosMapping:
    def test_irish_masculine_nouns(self):
        for tag in ("fir", "fir1", "fir2", "fir3", "fir4", "fir5"):
            assert map_pos(tag) == "noun"

    def test_irish_feminine_nouns(self):
        for tag in ("bain", "bain2", "bain3", "bain4", "bain5"):
            assert map_pos(tag) == "noun"

    def test_irish_verb(self):
        assert map_pos("br") == "verb"

    def test_irish_adjectives(self):
        for tag in ("a1", "a2", "a3"):
            assert map_pos(tag) == "adjective"

    def test_english_style_tags(self):
        assert map_pos("s") == "noun"
        assert map_pos("v") == "verb"
        assert map_pos("a") == "adjective"

    def test_phrase_tags(self):
        assert map_pos("phr.") == "phrase"
        assert map_pos("frása") == "phrase"

    def test_prefix_tags(self):
        assert map_pos("pref") == "prefix"
        assert map_pos("réimír") == "prefix"

    def test_abbreviation_tags(self):
        assert map_pos("gior") == "noun"
        assert map_pos("abr") == "noun"

    def test_proper_noun(self):
        assert map_pos("properNoun") == "proper noun"

    def test_unknown_tag_passes_through(self):
        assert map_pos("xyz") == "xyz"

    def test_all_map_entries_resolve_to_known_pos(self):
        known_pos = {"noun", "verb", "adjective", "phrase", "prefix", "proper noun"}
        for tag, pos in TEARMA_POS_MAP.items():
            assert pos in known_pos, f"Tag '{tag}' maps to unknown POS '{pos}'"


# --- Gender extraction ---


class TestGenderExtraction:
    def test_masculine(self):
        assert extract_gender("fir1") == ["masculine"]
        assert extract_gender("fir3") == ["masculine"]

    def test_feminine(self):
        assert extract_gender("bain2") == ["feminine"]

    def test_plural(self):
        assert extract_gender("iol") == ["plural"]
        assert extract_gender("pl") == ["plural"]

    def test_no_gender(self):
        assert extract_gender("br") == []
        assert extract_gender("a1") == []
        assert extract_gender("xyz") == []


# --- Domain mapping ---


class TestDomainMapping:
    def test_single_domain(self):
        assert map_domains(["Law"]) == ["Legal systems"]

    def test_multiple_domains(self):
        result = map_domains(["Biology", "Medicine, Medical"])
        assert "Biology" in result
        assert "Medical sciences" in result

    def test_multi_level_domain(self):
        # "Law » Property Law" → base "Law" → "Legal systems"
        result = map_domains(["Law » Property Law"])
        assert result == ["Legal systems"]

    def test_unmapped_domain(self):
        result = map_domains(["Calendar"])
        assert result == ["Calendar"]

    def test_deduplication(self):
        result = map_domains(["Law", "Law"])
        assert result == ["Legal systems"]

    def test_numeric_ids_skipped(self):
        result = map_domains(["4627284"])
        assert result == []

    def test_html_entity_cleanup(self):
        assert _clean_domain("Environment &amp; Ecology") == "Environment & Ecology"
        assert _clean_domain("Natural Sciences &amp;amp; Mathematics") == "Natural Sciences & Mathematics"

    def test_real_agriculture_label(self):
        assert map_domains(["Agriculture, Fishing"]) == ["Agriculture"]

    def test_real_environment_label(self):
        assert map_domains(["Environment & Ecology"]) == ["Environment"]

    def test_deep_hierarchy(self):
        result = map_domains(["Agriculture, Fishing » Animal Husbandry » Pigs"])
        assert result == ["Agriculture"]


# --- Parsing integration (fixture) ---


class TestParseFixture:
    def test_basic_noun(self, records):
        rec = _find(records, "áititheoir")
        assert rec is not None
        assert rec["pos"] == "noun"
        assert rec["raw_pos"] == "fir3"
        assert rec["lang_code"] == "ga"
        assert rec["dialect"] == "Irish (General)"
        assert "Legal systems" in rec["categories"]

    def test_synonyms_produce_separate_records(self, records):
        bogearrai = _find(records, "bogearraí")
        earrai = _find(records, "earraí boga")
        riomhchlar = _find(records, "ríomhchlár")
        assert bogearrai is not None
        assert earrai is not None
        assert riomhchlar is not None
        # All share the same gloss from English definition
        assert bogearrai["senses"][0]["gloss"] == "Computer programs and related data"
        assert earrai["senses"][0]["gloss"] == "Computer programs and related data"

    def test_deprecated_entry_filtered(self, records):
        # "staitúid" is marked dímholta → should be absent
        assert _find(records, "staitúid") is None
        # But "reacht" from the same termEntry should be present
        assert _find(records, "reacht") is not None

    def test_verb(self, records):
        rec = _find(records, "oideachasaigh")
        assert rec is not None
        assert rec["pos"] == "verb"

    def test_adjective(self, records):
        rec = _find(records, "cliniciúil")
        assert rec is not None
        assert rec["pos"] == "adjective"

    def test_phrase(self, records):
        rec = _find(records, "smacht an dlí")
        assert rec is not None
        assert rec["pos"] == "phrase"

    def test_multiple_domains(self, records):
        rec = _find(records, "cill")
        assert rec is not None
        assert "Biology" in rec["categories"]
        assert "Medical sciences" in rec["categories"]

    def test_duplicate_merging(self, records):
        # "dlí" appears in t8 (Economics) and t9 (Law) → should be merged
        dli = _find(records, "dlí")
        assert dli is not None
        # Should have 2 senses (one from each termEntry)
        assert len(dli["senses"]) == 2
        # Should have both domains
        assert "Economics" in dli["categories"]
        assert "Legal systems" in dli["categories"]

    def test_abbreviation(self, records):
        rec = _find(records, "URL")
        assert rec is not None
        assert rec["pos"] == "noun"  # gior maps to noun

    def test_proper_noun(self, records):
        rec = _find(records, "Éire")
        assert rec is not None
        assert rec["pos"] == "proper noun"

    def test_prefix(self, records):
        rec = _find(records, "ath-")
        assert rec is not None
        assert rec["pos"] == "prefix"

    def test_example_preserved(self, records):
        rec = _find(records, "scoil")
        assert rec is not None
        assert any("Tá an scoil dúnta inniu" in ex for s in rec["senses"] for ex in s.get("examples", []))

    def test_english_style_pos(self, records):
        rec = _find(records, "péintéireacht")
        assert rec is not None
        assert rec["pos"] == "noun"  # "s" → noun

    def test_tig_element(self, records):
        rec = _find(records, "séis")
        assert rec is not None
        assert rec["pos"] == "noun"

    def test_no_pos_defaults_to_noun(self, records):
        rec = _find(records, "bradán")
        assert rec is not None
        assert rec["pos"] == "noun"

    def test_multi_level_domain(self, records):
        rec = _find(records, "gníomhas")
        assert rec is not None
        assert "Legal systems" in rec["categories"]

    def test_no_english_langset_fallback(self, records):
        rec = _find(records, "Lá Fhéile Pádraig")
        assert rec is not None
        # Gloss should fall back to headword
        assert rec["senses"][0]["gloss"] == "Lá Fhéile Pádraig"

    def test_no_pronunciations(self, records):
        for rec in records:
            assert rec["pronunciations"] == []

    def test_no_etymology(self, records):
        for rec in records:
            assert rec["etymology_text"] == ""

    def test_all_records_have_required_fields(self, records):
        required = {"word", "word_search", "lang_code", "dialect", "pos", "raw_pos",
                     "pronunciations", "senses", "forms", "categories", "etymology_text"}
        for rec in records:
            assert required.issubset(rec.keys()), f"Missing fields in {rec['word']}: {required - rec.keys()}"


# --- URI determinism ---


class TestUriDeterminism:
    def test_focal_produces_wiktionary_compatible_uri(self, records):
        rec = _find(records, "focal")
        assert rec is not None
        slug = slugify(rec["word"], rec["pos"], rec["lang_code"])
        assert slug == "ga-focal-noun"

    def test_dli_produces_wiktionary_compatible_uri(self, records):
        rec = _find(records, "dlí")
        assert rec is not None
        slug = slugify(rec["word"], rec["pos"], rec["lang_code"])
        assert slug == "ga-dlí-noun"

    def test_phrase_slug(self, records):
        rec = _find(records, "smacht an dlí")
        assert rec is not None
        slug = slugify(rec["word"], rec["pos"], rec["lang_code"])
        assert slug == "ga-smacht-an-dlí-phrase"


# --- Merge logic ---


class TestMergeDuplicates:
    def test_no_duplicates(self):
        records = [
            {"word": "a", "pos": "noun", "lang_code": "ga",
             "senses": [{"gloss": "x"}], "categories": ["Law"]},
            {"word": "b", "pos": "noun", "lang_code": "ga",
             "senses": [{"gloss": "y"}], "categories": ["Art"]},
        ]
        merged = merge_duplicates(records)
        assert len(merged) == 2

    def test_merges_same_key(self):
        records = [
            {"word": "a", "pos": "noun", "lang_code": "ga",
             "senses": [{"gloss": "x"}], "categories": ["Law"]},
            {"word": "a", "pos": "noun", "lang_code": "ga",
             "senses": [{"gloss": "y"}], "categories": ["Art"]},
        ]
        merged = merge_duplicates(records)
        assert len(merged) == 1
        assert len(merged[0]["senses"]) == 2
        assert "Law" in merged[0]["categories"]
        assert "Art" in merged[0]["categories"]

    def test_different_pos_not_merged(self):
        records = [
            {"word": "a", "pos": "noun", "lang_code": "ga",
             "senses": [{"gloss": "x"}], "categories": []},
            {"word": "a", "pos": "verb", "lang_code": "ga",
             "senses": [{"gloss": "y"}], "categories": []},
        ]
        merged = merge_duplicates(records)
        assert len(merged) == 2

    def test_deduplicates_glosses(self):
        records = [
            {"word": "a", "pos": "noun", "lang_code": "ga",
             "senses": [{"gloss": "same"}], "categories": []},
            {"word": "a", "pos": "noun", "lang_code": "ga",
             "senses": [{"gloss": "same"}], "categories": []},
        ]
        merged = merge_duplicates(records)
        assert len(merged[0]["senses"]) == 1

    def test_preserves_order(self):
        records = [
            {"word": "b", "pos": "noun", "lang_code": "ga",
             "senses": [], "categories": []},
            {"word": "a", "pos": "noun", "lang_code": "ga",
             "senses": [], "categories": []},
        ]
        merged = merge_duplicates(records)
        assert merged[0]["word"] == "b"
        assert merged[1]["word"] == "a"


# --- JSONL output ---


class TestJsonlOutput:
    def test_output_round_trips(self, tmp_path):
        output = tmp_path / "out.jsonl"
        manifest = parse_tbx_to_jsonl(FIXTURE, output)

        assert output.exists()
        assert manifest["total_entries"] > 0

        # Verify JSONL round-trips
        with open(output, "rb") as f:
            for line in f:
                rec = orjson.loads(line)
                assert "word" in rec
                assert "senses" in rec

    def test_manifest_has_domains(self, tmp_path):
        output = tmp_path / "out.jsonl"
        manifest = parse_tbx_to_jsonl(FIXTURE, output)
        assert len(manifest["domains_seen"]) > 0
        assert "Legal systems" in manifest["domains_seen"]


# --- Source label ---


class TestSourceLabel:
    def test_source_label_applied(self):
        records = parse_tbx(FIXTURE, source_label="TE")
        assert len(records) > 0
        for rec in records:
            assert rec["source_label"] == "TE"

    def test_source_label_omitted_by_default(self):
        records = parse_tbx(FIXTURE)
        for rec in records:
            assert "source_label" not in rec

    def test_source_label_in_jsonl(self, tmp_path):
        output = tmp_path / "out.jsonl"
        parse_tbx_to_jsonl(FIXTURE, output, source_label="TE")
        with open(output, "rb") as f:
            for line in f:
                rec = orjson.loads(line)
                assert rec["source_label"] == "TE"
