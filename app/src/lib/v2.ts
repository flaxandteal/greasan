// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * v2 static-assets pilot - thin wrappers over the Tauri `v2` feature commands.
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

/**
 * One resolved offline layer returned by `v2_prepare_offline` (Rust
 * `offline::OfflineLayer`). Emitted after the first-run unpack of bundled heads
 * + Pagefind zips into app-data. `head_dir` is the real fs path the `v2_*`
 * commands open; `pagefind_index` is the `pfzip://` URL segment.
 */
export interface OfflineLayer {
  name: string;
  head_dir: string;
  pagefind_index: string;
}

/**
 * Run first-run offline preparation and return the resolved layer set. On first
 * launch this unpacks the bundled corpus heads + Pagefind zips into app-data
 * (idempotent thereafter). Only meaningful in a built Tauri app; in `tauri dev`
 * the dev machinery (absolute paths + vite middleware) is used instead.
 */
export async function prepareOffline(): Promise<OfflineLayer[]> {
  return await invoke<OfflineLayer[]>('v2_prepare_offline');
}

/** Filter tree (mirrors `ros_madair_query::Expr`; serde snake_case). */
export type V2Expr =
  | { all: V2Expr[] }
  | { any: V2Expr[] }
  | { not: V2Expr }
  /** `value` is the concept id (URI/UUID) as interned in the head's `dict`. */
  | { concept: { path: string; op: 'is' | 'descendant_or_self_of'; value: string } }
  /** Chunk-coarse: results are an over-approximation, marked `coarse`. */
  | { has_link: { path: string; target?: string } }
  /** Spatial bbox-OVERLAP on a `SpatialBbox` (geojson) node - the query box's
   *  corners in the head's lng/lat space. A strict SUPERSET of true intersection
   *  ("headwords/places near here"), so results are recall-tolerant: never claim
   *  exact containment. Compiles `coarse`. */
  | { bbox: { path: string; min_lng: number; min_lat: number; max_lng: number; max_lat: number } };

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

/** A layer's attestation verdict, as a three-state trust status:
 *  - `verified`   green shield  — a valid signature over the current content
 *  - `unverified` yellow shield — unsigned (old/third-party); a soft heads-up
 *  - `tampered`   red shield    — altered since signed, or an invalid signature
 *  `reason` is human-facing copy for the warning; empty when verified. */
export type LayerTrust = 'verified' | 'unverified' | 'tampered';
export type LayerRole = 'derived' | 'endorsed' | 'authored' | '';
export interface LayerVerification {
  status: LayerTrust;
  reason: string;
  /** Named attribution when a verified layer carries one. `author` is the actor
   *  name; `role` = 'derived' (produced from public records by them) or
   *  'endorsed' (the authoritative upstream publisher vouches). Empty = anonymous. */
  author: string;
  role: LayerRole;
  /** True when the attribution is CONFIRMED against a pinned/registered key
   *  (F&T's root) rather than merely self-asserted. */
  confirmed: boolean;
}

/**
 * Verify an installed layer BY NAME against its attestations: the backend
 * resolves its head, recomputes the snapshot_id from the artifacts on disk, and
 * checks the signature over it. `verified` enables silently; `unverified`/
 * `tampered` drive the enable-time warning (Accept/Reject) - it does NOT
 * hard-refuse. `reason` supplies the warning copy.
 */
export async function verifyLayer(name: string): Promise<LayerVerification> {
  return await invoke<LayerVerification>('v2_verify_layer', { name });
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
// Multi-layer composition (R1) - the path for the eventual SparqlStore
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
 * Resolve resource UUIDs → their descriptor (spine `display_name`) across the layer
 * stack - a cheap indexed lookup, no hydration, and no need for the resource's model
 * graph. Used e.g. for external example sentences (whose descriptor IS the sentence).
 * Batch: one call resolves many uris.
 */
export async function descriptors(headDirs: string[], uris: string[]): Promise<Record<string, string>> {
  return await invoke<Record<string, string>>('v2_descriptors', { headDirs, uris });
}

export interface SearchDisplay { headword: string; pos: string; dialects: string[] }

/** Canonical search display (headword + POS + dialect labels) resolved from the
 * COMPOSED head stack - so a result's badges come from the richest layer, not
 * whichever Pagefind record survived the per-layer cap. The POS/dialect node
 * UUIDs are stable properties of the lexical_entry model. */
const POS_NODE = 'a956278b-6815-5cc5-b674-e933e9c84aad';
const DIALECT_NODE = '69fb02e1-6d10-5a11-9bc2-4a02ad7fb8b0';
export async function searchDisplay(headDirs: string[], uris: string[]): Promise<Record<string, SearchDisplay>> {
  return await invoke<Record<string, SearchDisplay>>('v2_search_display', {
    headDirs, uris, posNode: POS_NODE, dialectNode: DIALECT_NODE,
  });
}

export interface FtsHit { uri: string; headword: string; gloss: string; snippet: string; score: number }

/**
 * Full-text search over the FTS5 `search.sqlite` sidecars of the given layer
 * dirs (on-device-built layers like Téarma, where pagefind is impractical).
 * The command probes each dir for `search.sqlite` and skips those without one,
 * so `headDirs` can be the whole active stack - pagefind and FTS layers coexist.
 * `field` is 'headword' (Ceannfhocail) or 'gloss' (Gluais).
 */
export async function searchFts(
  headDirs: string[],
  query: string,
  field: 'headword' | 'gloss',
  limit: number,
): Promise<FtsHit[]> {
  return await invoke<FtsHit[]>('v2_search_fts', { ftsDirs: headDirs, query, field, limit });
}

/**
 * Reverse-cognate lookup: the resources that LINK TO `uri` through `nodePath`
 * (a link-datatype node alias, e.g. `cognate_entry_id`) in the composed view.
 *
 * The inverse of a forward `has_link` predicate - opening an entry, find the
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

/** One geo-point resolved by {@link geoPoints}: a citing resource with a point. */
export interface GeoPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

/**
 * The `map(layer, filter)` primitive: every resource in the head at `headDir`
 * that cites `targetUri` through the reverse-link node `nodePath`, with its
 * display name and point geometry. `nodePath`/`targetUri` are `dict.term` UUIDs
 * already (no alias resolution against a graph), so this works against a head
 * whose spine/geo tables belong to a DIFFERENT graph than the app's base stack -
 * e.g. the Logainm place head, whose `element_entry` node cites lexical entries.
 *
 * Backed by one indexed SQL join (reverse_links → spine_place → geo_bbox), no
 * hydration. Verified: baile → 6,103 points in ~78 ms.
 */
export async function geoPoints(
  headDir: string,
  nodePath: string,
  targetUri: string,
): Promise<GeoPoint[]> {
  return await invoke<GeoPoint[]>('v2_geo_points', { headDir, nodePath, targetUri });
}
