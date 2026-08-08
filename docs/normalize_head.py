"""
Reference implementation of the Goidelic slug-identity normalization.

See docs/goidelic-slug-identity.md (§2 identity, §3 HEAD normalization). This is
the ONE piece every layer builder must implement identically, so that dialect
variants of a lexeme (Irish `fear`, Scottish `fear`) resolve to the SAME
`resourceid` and compose into one resource - while genuinely different words
(different spelling, or different POS) stay distinct.

Deterministic and side-effect free: given a source slug `<lang>-<HEAD>-<POS>` it
returns the dialect-neutral `goi-<normHEAD>-<POS>` slug; `resourceid()` hashes that
with the pipeline's EXISTING uuid5 namespace. Validated against the real
Wiktionary / MacBain / Téarma corpora (run this file to check).

Pure string work + uuid5 - port to any builder language verbatim.
"""

from __future__ import annotations

import unicodedata
import uuid

# Long-vowel marks - Irish acute AND Scottish grave, from ANY source - fold to a
# MACRON, a dialect-neutral length marker. Accent does NOT track dialect: MacBain
# (1911, pre-reform orthography) writes Scottish `mór` with an acute, and Wiktionary
# lists `gd-mór` as "alternative form of mòr" - so both accents, every source. Length
# is PRESERVED, never stripped: `fear` (man) and `féar`→`fēar` (grass) stay distinct.
# Applied after casefold, so only lowercase forms are listed.
_MACRON = {
    "à": "ā", "á": "ā",
    "è": "ē", "é": "ē",
    "ì": "ī", "í": "ī",
    "ò": "ō", "ó": "ō",
    "ù": "ū", "ú": "ū",
}

# Per-language slug prefixes collapsed into the Goidelic macro-prefix `goi`.
LANG_PREFIXES = ("ga", "gd", "gv")  # Irish, Scottish Gaelic, Manx


def _slug_safe(segment: str) -> str:
    """casefold; NFC; collapse internal whitespace to hyphens (URL/slug-safe)."""
    segment = unicodedata.normalize("NFC", segment.casefold())
    return "-".join(segment.split())


def normalize_head(head: str) -> str:
    """Canonical identity form of a headword (spec §3).

    casefold; NFC; fold grave/acute -> macron (length preserved, NOT ASCII-stripped
    -- stripping would fuse `fear`/`féar`, `cead`/`céad`); collapse whitespace to
    hyphens. The result is intentionally non-ASCII (macron chars) -- it is the uuid5
    input, and macrons are URL-legal (percent-encoded) if ever surfaced.

    Do NOT lemmatize here: headwords already ARE lemmas (spec §6a), and string
    mutation-stripping clashes (`T-léine`->`léine`, `bhfuil`->`fuil`).
    """
    head = _slug_safe(head)
    return "".join(_MACRON.get(ch, ch) for ch in head)


def slug_to_goi(slug: str) -> str | None:
    """`<lang>-<HEAD>-<POS>` -> `goi-<normHEAD>-<POS>`.

    HEAD may contain internal hyphens (multi-word headwords: `fear-an-tí`); POS is
    the final segment. Returns None for anything that is not a recognised lexical
    slug (unknown prefix / too few segments), so callers leave it untouched.

    `-etym` needs no special case: `goi-teach-etym` != `goi-teach-noun`, so MacBain's
    POS-less etymology rows stay their own resource and attach to the lemma via
    `cognate_entry_id` / cited_by (spec §4, §8).
    """
    parts = slug.split("-")
    if len(parts) < 3 or parts[0] not in LANG_PREFIXES:
        return None
    pos = _slug_safe(parts[-1])            # "proper noun" -> "proper-noun"
    head = "-".join(parts[1:-1])
    return f"goi-{normalize_head(head)}-{pos}"


def resourceid(goi_slug: str, namespace: uuid.UUID) -> uuid.UUID:
    """uuid5 of the goi slug under the pipeline's EXISTING resource-id namespace.

    Pass the same `namespace` the current pipeline uses for `<lang>-...` slugs so the
    identity scheme stays continuous. Collisions are namespace-independent, so the
    choice of namespace never affects the merge behaviour.
    """
    return uuid.uuid5(namespace, goi_slug)


if __name__ == "__main__":
    import collections

    # Expected goi slug per source slug - validated against the real corpora.
    cases = {
        # same word + POS across dialects -> MERGE (share a resourceid)
        "ga-fear-noun": "goi-fear-noun",
        "gd-fear-noun": "goi-fear-noun",
        # Irish acute, Scottish grave, AND Scottish-variant/old-orthography acute
        # all fold to the same macron -> one resource
        "ga-mór-adjective": "goi-mōr-adjective",
        "gd-mòr-adjective": "goi-mōr-adjective",
        "gd-mór-adjective": "goi-mōr-adjective",
        # fada preserved -> "grass" stays distinct from "man"
        "ga-féar-noun": "goi-fēar-noun",
        # POS splits -> distinct headwords
        "ga-fear-verb": "goi-fear-verb",
        "gd-fear-pronoun": "goi-fear-pronoun",
        # different spelling -> different headwords (cross-referenced, not merged)
        "gd-taigh-noun": "goi-taigh-noun",
        "ga-teach-noun": "goi-teach-noun",
        # MacBain -etym stays its own resource
        "gd-teach-etym": "goi-teach-etym",
        # alt-form / mutated spelling NOT string-lemmatized (spec §7)
        "ga-bh-fear-noun": "goi-bh-fear-noun",
        # multi-word head + space-in-POS both slug-safe
        "ga-fear-an-tí-noun": "goi-fear-an-tī-noun",
        "gd-mòr-proper noun": "goi-mōr-proper-noun",
    }
    for slug, expected in cases.items():
        got = slug_to_goi(slug)
        assert got == expected, f"{slug!r}: got {got!r}, expected {expected!r}"

    # Show which slugs share a resourceid (== compose into one resource).
    ns = uuid.uuid5(uuid.NAMESPACE_DNS, "greasan.goidelic")  # placeholder NS
    groups = collections.defaultdict(list)
    for slug in cases:
        groups[slug_to_goi(slug)].append(slug)
    for goi, slugs in sorted(groups.items()):
        tag = "MERGE" if len(slugs) > 1 else "solo "
        print(f"[{tag}] {resourceid(goi, ns).hex[:8]}  {goi:22} <- {slugs}")

    print("\nall assertions passed")
