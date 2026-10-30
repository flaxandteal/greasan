# Handoff → Rós Madair: a non-spatial render row (so `render_fields` / descriptors work for a dictionary)

_Raised 2026-10-30 from Gréasán, while trying to land opportunities 1.1 + 1.3 of `docs/rm-alignment-opportunities.md`. Verified cold against alpha.32 (`crates/ros-madair-emit/src/parquet.rs`) + the real wiktionary/macbain heads via `app/src-tauri/examples/hydrate-probe.rs`._

---

## ✅ RESOLVED in alpha.33 — with one follow-up (a34)

alpha.33 (`0.1.0-alpha.33`, FORMAT_VERSION 5→6) implemented the ask: the render row
(`descriptor`/`geo_descriptor`/`render_summary`/`render_fields`) now rides the
`resources` entry table per-resource, ungated by geo, and `descriptor_description`
(gloss) is promoted there too. Re-verified on rebuilt v6 heads:
- `render_summaries` returns **5/5** for a non-geo dictionary head (was 0/5); 1.1's row now exists. ✓
- `resource_entries` 4th tuple carries the gloss **text** ("great-grandfather", "how are you?"); **1.3 is landed** (FTS `build_for_head` now reads it). ✓

**Remaining a34 ask — resolve `render_fields` concept values to their LABEL at emit.**
`render_fields` currently bakes the raw concept **value-id**, not the label:
```
render_fields = {"dialect":"a0805fe2-…uuid…","part_of_speech":"0caceaea-…uuid…"}
```
`descriptor` (same row) IS a label ("garathair") because it goes through the
descriptor template; `build_render_fields` instead reads the raw tile value through
`render_display_value`, and these tiles store a bare value-id (no inline `{labels}`
wrapper), so the UUID passes through. The emit already has `concept_catalog`
(`concept_labels()` resolves exactly these at hydrate), so `build_render_fields`
could resolve too. Until it does, a consumer still needs a UUID→label pass for
DISPLAY, so Gréasán keeps `v2_concept_values` for the facet labels and does NOT yet
read `render_fields`. One line of resolution at emit makes 1.1 a clean win (drop the
per-query facet SQL entirely). Repro: `hydrate-probe` on any v6 lexical head.

## The ask in one line

Emit a **per-resource render row for NON-geo resources too** — carrying `descriptor`, `render_summary`, and the domain `render_fields` with a null `geo_descriptor` — so `render_summaries()` (and thus a hydrate-free list/facet read) works for a corpus that has no geometry. Today all of that is gated behind the resource having a `geo_bbox`.

## What we hit

Gréasán is a dictionary. We wanted to stop re-hydrating POS/dialect per search result (the hand-rolled `v2_concept_values` SQL) and read them from `render_summaries`' alpha.32 `render_fields` instead. RM's own field doc even names the case:

```rust
// a dictionary `["part_of_speech","dialect"]`.
pub render_fields: Vec<String>,
```

But in `parquet.rs`, the grid-stage row — the ONLY thing `render_summaries` reads — is appended exclusively inside the geo branch:

```rust
if let Some((mnx, mny, mxx, mxy)) = geo_bbox {       // ~line 773
    ...
    let fields = r.tiles.as_ref()
        .and_then(|t| build_render_fields(t, graph, &cfg.render_fields));   // ~786
    ...
    for cell in cells {
        ga.append_row(params![model_slug, cell, rid, &name,
            &geo_descriptor, &summary, &fields])?;   // the grid row
    }
}
// no else — a resource with no geo_bbox gets NO grid row at all
```

Proof (both heads rebuilt with `render_fields=["part_of_speech","dialect"]`, then probed):

```
[render_summaries] map has 0 / 5 ids
    000035f8-…: <no grid row>       # a wiktionary noun that hydrates as
                                    #   part_of_speech:"noun", dialect:"Irish"
```

`render_summaries` returns an **empty map** for every non-geo resource — the field value is present on the tile, `build_render_fields` would resolve it (`render_display_value` already handles the `{labels:[{value}]}` concept wrapper), but the row is never written because there's no bbox.

Same root cause blocks our 1.3 (gloss in the install-time FTS): the tile `stage` table promotes **only** `descriptor_name` (parquet.rs ~1092), not `descriptor_description`, so an installed layer's English/gloss search is dead. `resource_entries()` gives us the name descriptor non-geo, but nothing gives us description or domain fields without geometry.

## Why it matters

`render_fields` is advertised as domain-generic ("a dictionary sets its own"), but is currently only reachable for spatial corpora. A dictionary, a bibliography, any non-geo Arches model can't use it. The whole point — "the fields a card needs WITHOUT a per-resource hydrate" — doesn't reach the majority of resource types.

## Suggested shape (non-prescriptive)

1. Write the grid/entry row for every resource, not just geo ones: when `geo_bbox` is `None`, still append one row with `geo_descriptor = NULL`, a null/absent `cell`, and the computed `descriptor` + `render_summary` + `render_fields`. `render_summaries()` already tolerates `None` geo; it just needs the row to exist. (A `GridBox` query still only matches real cells, so this doesn't pollute spatial results.)
2. Promote `descriptors.description` to a `descriptor_description` column on the tile `stage` row alongside `descriptor_name`, so install-time readers (our FTS `build_for_head`) get the gloss without re-deriving it.

Either (1) alone unblocks 1.1; (1)+(2) unblock 1.3 too. Both are additive (null for existing/geo-only consumers) and shouldn't move `snapshot_id` for spatial heads that already emit the row.

## Gréasán side, meanwhile

- `v2_concept_values` (the hand-rolled POS/dialect facet SQL) and the empty-gloss FTS install path **stay** until this lands — they are the working fallback, not cruft to delete yet.
- `app/src-tauri/examples/hydrate-probe.rs` is the repro harness (`cargo run --release --example hydrate-probe -- <head_dir>`); re-point it at a rebuilt head to confirm a fix.
