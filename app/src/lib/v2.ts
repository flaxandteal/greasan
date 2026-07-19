// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * v2 static-assets pilot — thin wrappers over the Tauri `v2` feature commands.
 *
 * This is the pilot read path that replaces `SparqlStore` for a *single*
 * layer (macbain): instead of shipping a WASM SPARQL engine + page index to
 * the webview, the Rust side answers structured queries against a SQLite head
 * (`ros-madair-query` IR -> parameterized SQL) and hydrates entries natively
 * from content-addressed msgpack tile chunks. The webview only ever sees JSON.
 *
 * Only available when src-tauri is built with `--features v2`; the invokes
 * reject with "command not found" otherwise.
 */
import { invoke } from '@tauri-apps/api/core';

/** Filter tree (mirrors `ros_madair_query::Expr`; serde snake_case). */
export type V2Expr =
  | { all: V2Expr[] }
  | { any: V2Expr[] }
  | { not: V2Expr }
  /** `value` is the concept id (URI/UUID) as interned in the head's `dict`. */
  | { concept: { path: string; op: 'is' | 'descendant_or_self_of'; value: string } }
  /** Chunk-coarse: results are an over-approximation, marked `coarse`. */
  | { has_link: { path: string; target?: string } };

/** What to compute (mirrors `ros_madair_query::Measure`). */
export type V2Measure = 'count_records' | 'select_ids';

/** Query IR (mirrors `ros_madair_query::Query`). */
export interface V2Query {
  /** Emitted slug (e.g. "lexical-entry"), graph UUID, or display name. */
  model: string;
  where?: V2Expr;
  measures: V2Measure[];
  /** Row cap for `select_ids` (default 1000). */
  limit?: number;
}

export interface V2Result {
  measure: V2Measure;
  /** True when a `has_link` predicate made this chunk-granular: re-verify rows. */
  coarse: boolean;
  columns: string[];
  rows: (string | number | null)[][];
}

/**
 * Hydrate one resource to a schema-aware JSON tree (alias-keyed, nested by
 * nodegroup) from the head at `headDir` (which must contain `graph.json`).
 */
export async function hydrateV2(headDir: string, resourceId: string): Promise<unknown> {
  return await invoke<unknown>('v2_hydrate', { headDir, resourceId });
}

/**
 * Compile + execute a query IR against the head. Rejects with the serialized
 * `QueryError` (a repairable, typed JSON object) when the IR is invalid.
 */
export async function queryV2(headDir: string, ir: V2Query): Promise<V2Result[]> {
  const out = await invoke<{ results: V2Result[] }>('v2_query', { headDir, ir });
  return out.results;
}

// ---------------------------------------------------------------------------
// Multi-layer composition (R1) — the path for the eventual SparqlStore
// replacement.
//
// `queryV2`/`hydrateV2` above read ONE head. These read an ORDERED STACK of
// heads (base first, later layers override earlier) as one composed view: a
// shipped BASE plus overlays Gréasán emits on-device as the user edits. Rust
// (`ros-madair-read::Layers`) owns per-nodegroup precedence; the webview still
// only ever sees JSON. `headDirs[0]` is authoritative for the graph + registry,
// and `Layers::open` refuses layers that are not mutually composable.
// ---------------------------------------------------------------------------

/** The composed answer to a layered query. Shape depends on the measure. */
export type V2LayersResult =
  /** A `count_records` measure: the composed record count. */
  | { measure: 'count_records'; count: number }
  /** Any other measure: the matching resource UUIDs (capped by `ir.limit`). */
  | { measure: 'select_ids'; ids: string[] };

/**
 * Query the composed view of an ordered layer stack (`headDirs`, base first).
 * A `count_records` measure returns a composed count; otherwise the matching
 * UUIDs are resolved (a count cannot be precedence-filtered).
 */
export async function queryLayers(headDirs: string[], ir: V2Query): Promise<V2LayersResult> {
  return await invoke<V2LayersResult>('v2_query_layers', { headDirs, ir });
}

/**
 * Hydrate one resource from the composed view of an ordered layer stack: its
 * tiles are gathered from every layer that carries it and merged with
 * per-nodegroup precedence (topmost wins) before hydration. Graph is `headDirs[0]`.
 */
export async function hydrateLayers(headDirs: string[], resourceId: string): Promise<unknown> {
  return await invoke<unknown>('v2_hydrate_layers', { headDirs, resourceId });
}

/**
 * Reverse-cognate lookup: the resources that LINK TO `uri` through `nodePath`
 * (a link-datatype node alias, e.g. `cognate_entry_id`) in the composed view.
 *
 * The inverse of a forward `has_link` predicate — opening an entry, find the
 * entries that cite it. Restores v1's continuum behaviour: the Irish "fear"
 * surfaces the MacBain "fear" that lists it as a cognate, so the loader can fold
 * MacBain's etymology/cognates into the Irish entry. Base layer (`headDirs[0]`)
 * is authoritative for graph + registry.
 */
export async function citedBy(
  headDirs: string[],
  uri: string,
  nodePath: string,
): Promise<string[]> {
  return await invoke<string[]>('v2_cited_by', { headDirs, uri, nodePath });
}
