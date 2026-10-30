"""Golden-vector guard for the goi- ENTRY slug identity.

The same vectors are asserted by the Rust `slug_identity_tests` (app/src-tauri/
src/tbx_parser.rs) - so a change to the scheme fails in BOTH languages at once,
rather than silently diverging and breaking cross-layer merge (the Téarma-POS
incident). The CONCEPT family (lighter normalisation) is guarded separately by
the Rust `concept_id_tests` + scripts/lib/slug-identity.test.ts.
"""

import json
import pathlib

import pytest

from goidelic.slug_identity import goi_slug, normalize_head

GOLDEN = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "slug-golden.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", GOLDEN["entry"]["normalize_head"])
def test_entry_normalize_head(case):
    assert normalize_head(case["in"]) == case["out"]


@pytest.mark.parametrize("case", GOLDEN["entry"]["goi_slug"])
def test_entry_goi_slug(case):
    assert goi_slug(case["word"], case["pos"]) == case["out"]
