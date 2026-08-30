/**
 * Intersect pagefind (FTS) hits with an arbitrary ros-madair id-set WITHOUT
 * hydrating every pagefind result.
 *
 * Pagefind results carry `.id` (the index hash) before `.data()` is called. The
 * flaxandteal fork's `getIndexCatalogue` mapping - shipped as `catalogue.json`
 * beside each index (see scripts/lib/pagefind-fork.mjs) - turns that hash into a
 * resource id. So page 1 can be `(all FTS hits) ∩ (structured/spatial id-set)`,
 * hydrating only the overlap.
 *
 * Deliberately GENERAL over the id-set source: the "other" set is any resource
 * ids - a bbox spatial query, a concept-hierarchy query, any `queryV2`
 * `select_ids` result, etc. - not just one query shape.
 */
import type { V2Result } from './v2';

const catalogueCache = new Map<string, Promise<Map<string, string>>>();

/** Clear cached catalogues (call when the active layer set changes). */
export function resetCatalogues(): void {
  catalogueCache.clear();
}

/**
 * Load the `{ pagefindHash -> resourceId }` catalogue for a pagefind base
 * (cached per base). A missing catalogue (upstream pagefind, or a pre-catalogue
 * build) yields an EMPTY map - callers must treat that as "no intersection
 * available" and fall back to hydrate-all rather than showing nothing.
 */
export async function getCatalogue(pagefindBase: string): Promise<Map<string, string>> {
  const cached = catalogueCache.get(pagefindBase);
  if (cached) return cached;
  const p = (async () => {
    let resp: Response;
    try {
      resp = await fetch(`${pagefindBase}catalogue.json`);
    } catch (e) {
      console.warn(`[pagefind] catalogue fetch failed for ${pagefindBase}:`, e);
      return new Map<string, string>();
    }
    if (!resp.ok) {
      console.warn(
        `[pagefind] no catalogue.json at ${pagefindBase} (${resp.status}); intersection disabled for this index`,
      );
      return new Map<string, string>();
    }
    const obj = (await resp.json()) as Record<string, string>;
    return new Map(Object.entries(obj));
  })();
  catalogueCache.set(pagefindBase, p);
  return p;
}

/** Map pagefind results to resource ids via the catalogue (no `.data()` fetch). */
export function resourceIdsForResults(
  results: readonly { id: string }[],
  catalogue: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const r of results) {
    const rid = catalogue.get(r.id);
    if (rid) out.push(rid);
  }
  return out;
}

/**
 * Intersect pagefind results with an arbitrary resource-id set. Returns the
 * overlapping resource ids in PAGEFIND RANK ORDER (relevance), deduped - ready
 * to hydrate for page 1. Results whose hash is absent from the catalogue are
 * dropped (so an empty catalogue yields `[]` - detect that and fall back to
 * hydrate-all).
 */
export function intersectResults(
  results: readonly { id: string }[],
  catalogue: Map<string, string>,
  otherIds: Iterable<string>,
): string[] {
  const other = otherIds instanceof Set ? (otherIds as Set<string>) : new Set(otherIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    const rid = catalogue.get(r.id);
    if (rid && other.has(rid) && !seen.has(rid)) {
      seen.add(rid);
      out.push(rid);
    }
  }
  return out;
}

/**
 * Pull the resource-id column out of a `select_ids` V2Result. Convenience for
 * the common "intersect with a ros-madair query" case; the core `intersectResults`
 * takes any id set. `select_ids` returns `columns: ["resource_id"]` (see
 * src-tauri v2.rs), which is the default.
 */
export function resourceIdsFromV2Result(result: V2Result, idColumn = 'resource_id'): Set<string> {
  const out = new Set<string>();
  const idx = result.columns.indexOf(idColumn);
  if (idx < 0) return out;
  for (const row of result.rows) {
    const v = row[idx];
    if (typeof v === 'string') out.add(v);
  }
  return out;
}
