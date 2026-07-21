"""Tests for goidelic.ontolex — goi-HEAD-POS slugs + dialect-merge shaping.

Covers the identity/merge core of docs/goidelic-slug-identity.md at the shape
stage: dialect variants of a lexeme share a slug and merge into one resource with
dialect-tagged tiles; length (fada) and POS keep distinct lexemes apart.
"""

import orjson

from goidelic.ontolex import shape_entry, shape_file, slugify
from goidelic.slug_identity import goi_slug, normalize_head


# ── slug identity ────────────────────────────────────────────────────────────

def test_dialect_variants_share_a_slug():
    # Irish + Scottish "man" -> same goi slug -> will merge into one resource
    assert slugify("fear", "noun") == "goi-fear-noun"
    assert slugify("fear", "noun") == goi_slug("fear", "noun")


def test_macron_folds_grave_and_acute():
    # acute (Irish), grave (Scottish), and Scottish-variant acute all fold to ō
    assert goi_slug("mór", "adjective") == "goi-mōr-adjective"
    assert goi_slug("mòr", "adjective") == "goi-mōr-adjective"


def test_fada_preserved_keeps_lexemes_distinct():
    # length is lexical: "grass" must NOT collapse onto "man"
    assert goi_slug("féar", "noun") == "goi-fēar-noun"
    assert goi_slug("féar", "noun") != goi_slug("fear", "noun")


def test_different_spelling_is_a_different_headword():
    assert goi_slug("taigh", "noun") != goi_slug("teach", "noun")


def test_pos_splits_and_is_slug_safe():
    assert goi_slug("fear", "verb") != goi_slug("fear", "noun")
    assert goi_slug("Mòr", "proper noun") == "goi-mōr-proper-noun"  # space -> hyphen


def test_normalize_head_strips_punctuation_not_fada():
    assert normalize_head("Fáilte!") == "fāilte"
    assert normalize_head("d'ol") == "dol"


# ── dialect-merge shaping ────────────────────────────────────────────────────

def _write_jsonl(path, entries):
    with open(path, "wb") as f:
        for e in entries:
            f.write(orjson.dumps(e))
            f.write(b"\n")


def test_shape_entry_tags_tiles_with_dialect():
    shaped = shape_entry({
        "word": "fear", "pos": "noun", "dialect": "Ulster Irish", "source_label": "WK",
        "senses": [{"gloss": "man", "examples": ["Tá an fear."]}],
        "forms": [{"written_rep": "fir", "gram_features": ["genitive", "singular"]}],
        "pronunciations": [{"ipa_value": "/fʲaɾˠ/"}],
    })
    assert shaped["resource_id"] == "goi-fear-noun"
    assert shaped["senses"][0]["dialect"] == "Ulster Irish"
    assert shaped["forms"][0]["dialect"] == "Ulster Irish"
    assert shaped["pronunciations"][0]["dialect"] == "Ulster Irish"
    assert shaped["headwords"] == [{"dialect": "Ulster Irish", "word": "fear"}]


def test_shape_file_merges_dialect_variants(tmp_path):
    src = tmp_path / "shaped_in.jsonl"
    out = tmp_path / "shaped_out.jsonl"
    _write_jsonl(src, [
        {"word": "fear", "pos": "noun", "dialect": "Irish", "source_label": "WK",
         "senses": [{"gloss": "man", "examples": ["Tá an fear."]}]},
        {"word": "fear", "pos": "noun", "dialect": "Scottish Gaelic", "source_label": "WK",
         "senses": [{"gloss": "man", "examples": []}]},
        {"word": "féar", "pos": "noun", "dialect": "Irish",
         "senses": [{"gloss": "grass", "examples": []}]},
        {"word": "mór", "pos": "adjective", "dialect": "Irish",
         "senses": [{"gloss": "big", "examples": []}]},
        {"word": "mòr", "pos": "adjective", "dialect": "Scottish Gaelic",
         "senses": [{"gloss": "big", "examples": []}]},
    ])

    manifest = shape_file(src, out)
    resources = {r["resource_id"]: r for r in (orjson.loads(l) for l in open(out, "rb"))}

    # 5 source entries -> 3 resources (fear, féar, mōr); 2 of them merged
    assert manifest["total_entries"] == 5
    assert manifest["resources"] == 3
    assert manifest["merged_resources"] == 2
    assert set(resources) == {"goi-fear-noun", "goi-fēar-noun", "goi-mōr-adjective"}

    # fear: Irish + Scottish composed, dialect is the pipe-union, both senses tagged
    fear = resources["goi-fear-noun"]
    assert fear["dialect"] == "Irish|Scottish Gaelic"
    assert {s["dialect"] for s in fear["senses"]} == {"Irish", "Scottish Gaelic"}
    assert {h["word"] for h in fear["headwords"]} == {"fear"}

    # mór/mòr: one lexeme, BOTH spellings preserved for the card-N forms move
    mor = resources["goi-mōr-adjective"]
    assert mor["dialect"] == "Irish|Scottish Gaelic"
    assert {(h["dialect"], h["word"]) for h in mor["headwords"]} == {
        ("Irish", "mór"), ("Scottish Gaelic", "mòr"),
    }

    # féar stays its own resource (fada preserved)
    assert resources["goi-fēar-noun"]["dialect"] == "Irish"
