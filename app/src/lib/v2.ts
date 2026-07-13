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
