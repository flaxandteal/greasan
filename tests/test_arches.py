"""Tests for goidelic.arches — per-tile dialect emission (dialect-on-tiles)."""

import csv

import orjson

from goidelic.arches import emit_csv, entry_to_rows


def _shaped_fear() -> dict:
    return {
        "resource_id": "goi-fear-noun",
        "headword": "fear",
        "part_of_speech": "noun",
        "dialect": "Irish|Scottish Gaelic",  # rollup of the tile dialects
        "pronunciations": [{"ipa_value": "/fʲaɾˠ/", "dialect": "Ulster Irish"}],
        "senses": [
            {"gloss": "man", "example": "", "source_label": "WK", "dialect": "Irish"},
            {"gloss": "man", "example": "", "source_label": "WK", "dialect": "Scottish Gaelic"},
        ],
        "forms": [{"written_rep": "fir", "gram_features": ["genitive", "singular"], "dialect": "Irish"}],
        "domains": [],
    }


def test_entry_to_rows_emits_per_tile_dialect():
    rows = entry_to_rows(_shaped_fear())

    # row 0: card-1 rollup dialect + first pron/sense/form (aligned by index)
    assert rows[0]["dialect"] == "Irish|Scottish Gaelic"
    assert rows[0]["pronunciation_dialect"] == "Ulster Irish"
    assert rows[0]["sense_dialect"] == "Irish"
    assert rows[0]["form_dialect"] == "Irish"

    # the second sense carries its OWN dialect on its own row
    assert rows[1]["gloss"] == "man"
    assert rows[1]["sense_dialect"] == "Scottish Gaelic"
    # no pronunciation/form on row 1
    assert rows[1].get("ipa_value", "") == ""
    assert rows[1].get("form_dialect", "") == ""


def test_emit_csv_round_trip_has_dialect_columns(tmp_path):
    src = tmp_path / "shaped.jsonl"
    out = tmp_path / "business.csv"
    with open(src, "wb") as f:
        f.write(orjson.dumps(_shaped_fear()))
        f.write(b"\n")

    emit_csv(src, out)
    rows = list(csv.DictReader(open(out, encoding="utf-8")))

    assert "sense_dialect" in rows[0]
    assert "form_dialect" in rows[0]
    assert "pronunciation_dialect" in rows[0]
    assert rows[0]["sense_dialect"] == "Irish"
    assert rows[1]["sense_dialect"] == "Scottish Gaelic"
