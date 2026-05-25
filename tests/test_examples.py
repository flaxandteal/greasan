"""Tests for goidelic.examples — surface forms, matching, highlights, CSV output."""

import csv

from goidelic.examples import (
    augment_entry_csv,
    build_inverted_index,
    example_resource_id,
    find_highlights,
    format_highlights,
    match_sentences,
    resource_uuid,
    surface_forms,
    write_example_csv,
)


class TestSurfaceForms:
    def test_basic_word(self):
        forms = surface_forms("focal")
        assert "focal" in forms
        assert "Focal" in forms
        # f is lenitable
        assert "fhocal" in forms
        assert "Fhocal" in forms
        # f has eclipsis: f→bhf
        assert "bhfocal" in forms
        assert "Bhfocal" in forms

    def test_lenition_consonants(self):
        # b→bh
        forms = surface_forms("bád")
        assert "bhád" in forms
        # c→ch
        forms = surface_forms("cat")
        assert "chat" in forms
        # d→dh
        forms = surface_forms("doras")
        assert "dhoras" in forms
        # g→gh
        forms = surface_forms("gaeilge")
        assert "ghaeilge" in forms
        # m→mh
        forms = surface_forms("maith")
        assert "mhaith" in forms
        # p→ph
        forms = surface_forms("peann")
        assert "pheann" in forms
        # s→sh (simple first-char mutation; doesn't handle cluster exceptions)
        forms = surface_forms("scoil")
        assert "shcoil" in forms
        # t→th
        forms = surface_forms("teach")
        assert "theach" in forms

    def test_eclipsis_consonants(self):
        # b→mb
        forms = surface_forms("bád")
        assert "mbád" in forms
        # c→gc
        forms = surface_forms("cat")
        assert "gcat" in forms
        # d→nd
        forms = surface_forms("doras")
        assert "ndoras" in forms
        # g→ng
        forms = surface_forms("gaeilge")
        assert "ngaeilge" in forms
        # p→bp
        forms = surface_forms("peann")
        assert "bpeann" in forms
        # t→dt
        forms = surface_forms("teach")
        assert "dteach" in forms

    def test_vowel_prothesis(self):
        forms = surface_forms("áit")
        assert "háit" in forms
        assert "n-áit" in forms
        assert "t-áit" in forms
        # Capitalised
        assert "Háit" in forms
        assert "N-áit" in forms
        assert "T-áit" in forms

    def test_vowel_with_accent(self):
        forms = surface_forms("éan")
        assert "héan" in forms
        assert "n-éan" in forms
        assert "t-éan" in forms

    def test_no_mutation_for_non_mutable(self):
        # 'l' is not lenitable or eclipsable
        forms = surface_forms("leabhar")
        assert forms == {"leabhar", "Leabhar"}

    def test_empty_headword(self):
        forms = surface_forms("")
        assert forms == {"", ""}


class TestFindHighlights:
    def test_exact_match(self):
        hl = find_highlights("Ní raibh focal aige.", {"focal"})
        assert hl == [(9, 14)]

    def test_case_insensitive(self):
        hl = find_highlights("Focal mór.", {"focal"})
        assert hl == [(0, 5)]

    def test_multiple_matches(self):
        hl = find_highlights("an focal agus an focal eile", {"focal"})
        assert len(hl) == 2
        assert hl[0] == (3, 8)
        assert hl[1] == (17, 22)

    def test_mutated_form(self):
        hl = find_highlights("gan fhocal", {"fhocal", "focal"})
        assert hl == [(4, 10)]

    def test_no_match(self):
        hl = find_highlights("Tá sé go maith.", {"focal"})
        assert hl == []

    def test_word_boundary(self):
        # Should not match partial words
        hl = find_highlights("unfocal", {"focal"})
        # "unfocal" is a single token, not "focal"
        assert hl == []


class TestBuildInvertedIndex:
    def test_basic(self):
        idx = build_inverted_index(["focal", "bád"])
        assert idx["focal"] == "focal"
        assert idx["fhocal"] == "focal"
        assert idx["bhfocal"] == "focal"
        assert idx["bád"] == "bád"
        assert idx["bhád"] == "bád"
        assert idx["mbád"] == "bád"

    def test_first_headword_wins(self):
        # If two headwords produce the same form, first one wins
        idx = build_inverted_index(["abc", "abc"])
        assert idx["abc"] == "abc"


class TestMatchSentences:
    def test_basic_match(self):
        headwords = ["focal"]
        headword_forms = {hw: surface_forms(hw) for hw in headwords}
        inverted = build_inverted_index(headwords)

        sentences = [
            ("Ní raibh focal aige.", "He had nothing to say.", "tatoeba", "123"),
        ]
        results = match_sentences(sentences, inverted, headword_forms)
        assert "focal" in results
        assert len(results["focal"]) == 1
        ex = results["focal"][0]
        assert ex["ga"] == "Ní raibh focal aige."
        assert ex["en"] == "He had nothing to say."
        assert ex["src"] == "tatoeba"
        assert ex["id"] == "123"
        assert ex["hl"] == [(9, 14)]

    def test_mutated_match(self):
        headwords = ["focal"]
        headword_forms = {hw: surface_forms(hw) for hw in headwords}
        inverted = build_inverted_index(headwords)

        sentences = [
            ("gan fhocal", "without a word", "gaois", "g1"),
        ]
        results = match_sentences(sentences, inverted, headword_forms)
        assert "focal" in results
        assert results["focal"][0]["hl"] == [(4, 10)]

    def test_cap_per_source(self):
        headwords = ["focal"]
        headword_forms = {hw: surface_forms(hw) for hw in headwords}
        inverted = build_inverted_index(headwords)

        sentences = [
            (f"focal {i}", f"word {i}", "tatoeba", str(i))
            for i in range(10)
        ]
        results = match_sentences(sentences, inverted, headword_forms)
        # Should be capped at MAX_EXAMPLES_PER_SOURCE (3)
        assert len(results["focal"]) == 3

    def test_no_highlight_skipped(self):
        # If find_highlights returns nothing (unlikely but possible with
        # index/form mismatch), entry should not be added
        headwords = ["xyz"]
        headword_forms = {hw: surface_forms(hw) for hw in headwords}
        inverted = build_inverted_index(headwords)

        # Manually inject a form that won't match highlight
        inverted["something"] = "xyz"
        sentences = [
            ("something else", "other", "tatoeba", "1"),
        ]
        results = match_sentences(sentences, inverted, headword_forms)
        # "something" maps to "xyz" but highlights look for xyz's surface forms
        # which don't include "something"
        assert results.get("xyz", []) == []


class TestResourceUuid:
    def test_deterministic(self):
        """UUID computation must be deterministic."""
        u1 = resource_uuid("graph-1", "res-1")
        u2 = resource_uuid("graph-1", "res-1")
        assert u1 == u2

    def test_different_graphs(self):
        """Different graph IDs produce different UUIDs."""
        u1 = resource_uuid("graph-1", "res-1")
        u2 = resource_uuid("graph-2", "res-1")
        assert u1 != u2

    def test_matches_alizarin(self):
        """Verify against known alizarin output."""
        # Verified by running buildResourcesFromBusinessCsv in Node.js
        graph_id = "6d502e2e-7fe6-5414-99e4-ac981cebc493"
        result = resource_uuid(graph_id, "ex-tatoeba-123")
        assert result == "6b4a336c-235b-5c63-90c2-f262988bbc5d"


class TestExampleResourceId:
    def test_tatoeba(self):
        assert example_resource_id("tatoeba", "123") == "ex-tatoeba-123"

    def test_gaois(self):
        assert example_resource_id("gaois", "secondary-5981") == "ex-gaois-secondary-5981"


class TestFormatHighlights:
    def test_single(self):
        assert format_highlights([(6, 11)]) == "6,11"

    def test_multiple(self):
        assert format_highlights([(6, 11), (17, 23)]) == "6,11;17,23"

    def test_empty(self):
        assert format_highlights([]) == ""


class TestWriteExampleCsv:
    def test_writes_csv(self, tmp_path):
        examples = {
            "focal": [
                {"ga": "Seo focal.", "en": "This is a word.", "src": "tatoeba", "id": "123", "hl": [(4, 9)]},
            ],
            "bád": [
                {"ga": "An bád.", "en": "The boat.", "src": "gaois", "id": "g1", "hl": [(3, 6)]},
            ],
        }
        out = tmp_path / "example_data.csv"
        count = write_example_csv(examples, out)
        assert count == 2

        with open(out, "r") as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        assert len(rows) == 2
        # Check one row
        tatoeba_rows = [r for r in rows if r["source"] == "Tatoeba"]
        assert len(tatoeba_rows) == 1
        assert tatoeba_rows[0]["ResourceID"] == "ex-tatoeba-123"
        assert tatoeba_rows[0]["sentence"] == "Seo focal."
        assert tatoeba_rows[0]["sentence_en"] == "This is a word."
        assert tatoeba_rows[0]["highlights"] == "4,9"


class TestAugmentEntryCsv:
    def test_augments_with_uuids(self, tmp_path):
        # Write a minimal entry CSV
        entry_csv = tmp_path / "entries.csv"
        with open(entry_csv, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["ResourceID", "headword", "part_of_speech"])
            writer.writeheader()
            writer.writerow({"ResourceID": "focal-noun", "headword": "focal", "part_of_speech": "noun"})
            writer.writerow({"ResourceID": "bád-noun", "headword": "bád", "part_of_speech": "noun"})

        examples = {
            "focal": [
                {"ga": "focal 1", "en": "word 1", "src": "tatoeba", "id": "1", "hl": [(0, 5)]},
                {"ga": "focal 2", "en": "word 2", "src": "gaois", "id": "g1", "hl": [(0, 5)]},
            ],
        }

        graph_id = "test-graph-id"
        out = tmp_path / "augmented.csv"
        augmented = augment_entry_csv(examples, entry_csv, out, graph_id)
        assert augmented == 1  # only "focal" has examples

        with open(out, "r") as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        # 2 original rows + 1 extra row for focal's second example UUID
        assert len(rows) == 3
        assert "external_examples" in rows[0]

        # "focal" rows: first has all original data + first UUID, second has only ResourceID + second UUID
        focal_rows = [r for r in rows if r["ResourceID"] == "focal-noun"]
        assert len(focal_rows) == 2
        # Each row has exactly one UUID
        for r in focal_rows:
            u = r["external_examples"]
            assert len(u) == 36  # UUID format
            assert u.count("-") == 4
        # Two different UUIDs
        assert focal_rows[0]["external_examples"] != focal_rows[1]["external_examples"]

        # "bád" row should have empty external_examples
        bad_row = [r for r in rows if r["headword"] == "bád"][0]
        assert bad_row["external_examples"] == ""

    def test_in_place_write(self, tmp_path):
        """Writing to the same file as input works (reads all first)."""
        csv_path = tmp_path / "entries.csv"
        with open(csv_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["ResourceID", "headword"])
            writer.writeheader()
            writer.writerow({"ResourceID": "a-1", "headword": "focal"})

        examples = {
            "focal": [{"ga": "f", "en": "w", "src": "tatoeba", "id": "1", "hl": [(0, 1)]}],
        }

        augment_entry_csv(examples, csv_path, csv_path, "graph-1")

        with open(csv_path, "r") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        assert len(rows) == 1
        assert rows[0]["external_examples"] != ""
