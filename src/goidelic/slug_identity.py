"""Goidelic slug identity — `goi-HEAD-POS` resource slugs.

Pipeline implementation of the identity scheme in `docs/goidelic-slug-identity.md`
(and mirrored by the runnable reference `docs/normalize_head.py`). The point: a
lexeme's dialect variants (Irish `fear`, Scottish `fear`) produce the SAME slug —
hence the same `resource_uuid` under the single `lexical_entry` graph — so they
compose into one resource, while different spellings or POS stay distinct.

`goi_slug("mór", "adjective")` and `goi_slug("mòr", "adjective")` both →
`goi-mōr-adjective`; `goi_slug("féar", "noun")` → `goi-fēar-noun` stays distinct
from `goi-fear-noun` (length preserved, never ASCII-stripped).
"""

from __future__ import annotations

import re
import unicodedata

# Irish acute + Scottish grave (from ANY source — accent does not track dialect:
# MacBain 1911 writes Scottish `mór` with an acute) fold to a MACRON, a
# dialect-neutral length marker. Length is PRESERVED, never stripped, so
# `fear`(man) and `féar`→`fēar`(grass) stay distinct. Applied after casefold.
MACRON: dict[str, str] = {
    "à": "ā", "á": "ā",
    "è": "ē", "é": "ē",
    "ì": "ī", "í": "ī",
    "ò": "ō", "ó": "ō",
    "ù": "ū", "ú": "ū",
}

# Strip anything that is not a word char (letters incl. macron vowels, digits, _)
# or hyphen. Punctuation/apostrophes go; the fada survives as a macron (a letter).
_STRIP = re.compile(r"[^\w\-]", re.UNICODE)


def normalize_head(text: str) -> str:
    """Canonical identity form of a headword or POS segment (spec §3).

    casefold; NFC; fold grave/acute → macron (length preserved, NOT ASCII-stripped);
    whitespace → hyphen; drop remaining punctuation. Deliberately non-ASCII (macron
    chars) — it is the slug/uuid input, and macrons are URL-legal. Does NOT
    lemmatize: headwords already are lemmas (spec §6a).
    """
    text = unicodedata.normalize("NFC", text.casefold().strip())
    text = "".join(MACRON.get(ch, ch) for ch in text)
    text = re.sub(r"\s+", "-", text)
    text = _STRIP.sub("", text)
    return text


def goi_slug(word: str, pos: str) -> str:
    """`goi-<normHEAD>-<normPOS>` — the dialect-neutral resource slug.

    The `goi` (Goidelic) macro-prefix replaces the per-language `ga`/`gd`/`gv`;
    dialect moves onto the tiles. POS is normalized too (`proper noun` →
    `proper-noun`) so slugs stay clean.
    """
    return f"goi-{normalize_head(word)}-{normalize_head(pos)}"
