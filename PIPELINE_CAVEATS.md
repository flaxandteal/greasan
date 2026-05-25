# Pipeline Caveats

## Dialect Detection from Wiktionary

### Problem

Wiktionary entries carry dialect information in multiple places with different semantics:

- **Sense tags**: e.g. `(Connacht, Ulster) dog` — indicates where the word/form is *used*
- **Categories**: e.g. `Connacht Irish` category — editorial classification
- **Sound tags**: e.g. `[Munster] /ˈfˠɞkəl̪ˠ/` — indicates pronunciation *in* that dialect, not that the word belongs to it

A word like "focal" (word) has Munster, Connacht, and Ulster pronunciations listed — but no dialect qualifier on any sense. It's a general Irish word with dialect-specific pronunciations. The old pipeline returned on the first matching sound tag, incorrectly tagging it as "Munster Irish".

### Current Logic (`normalise.py :: _detect_dialect`)

Priority order: **sense tags > categories > sounds**

| Detected dialects | Result |
|---|---|
| 1–2 from senses | Those specific dialects (pipe-separated) |
| 3+ from senses | General (default for language) |
| 1–2 from categories (no sense signal) | Those specific dialects |
| 3+ from categories | General |
| Exactly 1 from sounds (no other signal) | That dialect |
| 2+ from sounds (no other signal) | General |
| Nothing found | General |

### Pipe-separated dialect values

When an entry has exactly 2 dialect qualifiers (e.g. "madadh" is Connacht + Ulster), the CSV stores `Connacht Irish|Ulster Irish` in the `dialect` column.

The Arches resource model's `dialect` node is a cardinality-1 concept field. Pipe-separated values won't resolve against the Dialects collection — they're stored as unresolved strings. This is intentional: the only consumer of multi-dialect values is the pagefind index build, which splits on `|` and maps each part to a filter code independently.

Single-dialect entries (e.g. `Munster Irish`) continue to resolve normally against the collection.

### Pagefind filter codes

Dialect codes use ASCII period as separator (e.g. `GA.CON`, `GD.HLD`). The middle dot `·` (U+00B7) was previously used but breaks pagefind's filter matching — pagefind returns 0 results when filter values contain non-ASCII characters.

Display-side (`Search.svelte :: dialectTag()`) replaces `.` back to `·` for visual presentation.

### Examples

| Word | Sense tags | Sound tags | Result |
|---|---|---|---|
| focal (word) | none | Munster, Connacht, Ulster | `Irish` (general — sounds show 3 dialects) |
| madadh (dog) | Connacht, Ulster | Galway, Mayo, Ulster | `Connacht Irish\|Ulster Irish` (2 sense tags) |
| cos (foot) | none | Munster only | `Munster Irish` (1 sound, no other signal) |
