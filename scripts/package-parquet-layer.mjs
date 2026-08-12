#!/usr/bin/env node
// Package an emitted Parquet dataset dir into a bundle head zip: stamp a
// manifest.json (content-hash snapshot_id, for offline.rs per-layer versioning)
// and zip the dir as data/bundle/parquet-heads/<head>.zip. offline.rs extracts
// this exactly like a sqlite head zip - the bundle format is format-agnostic; only
// the zip's CONTENTS change (tiles_*.parquet + concept_catalog.parquet + graph.json
// instead of head.sqlite + chunks/).
//
//   node scripts/package-parquet-layer.mjs <dataset_dir> <head_name>

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { resolve } from 'path';

const [datasetDir, headName] = process.argv.slice(2);
if (!datasetDir || !headName) {
  console.error('usage: package-parquet-layer.mjs <dataset_dir> <head_name>');
  process.exit(1);
}

// snapshot_id: sha256 over the dataset's sorted content files (parquet + graph),
// first 16 hex — same shape as the sqlite heads. A data change → new hash → the
// device re-extracts just this layer (offline.rs `head_snapshot` comparison).
const files = readdirSync(datasetDir)
  .filter((f) => /\.(parquet|json)$/.test(f) && f !== 'manifest.json')
  .sort();
const h = createHash('sha256');
for (const f of files) h.update(readFileSync(resolve(datasetDir, f)));
const snapshot_id = h.digest('hex').slice(0, 16);

// A COMPLETE manifest is REQUIRED: ros-madair-read's `load_manifest` treats a
// manifest that exists but is missing ANY field as a deliberate hard error (stale-
// format detection), and `check_manifest_format` rejects a `format_version` that is
// not the current FORMAT_VERSION. The duck read path's `registry()` (via run_query /
// v2_query_layers) calls load_manifest, so an incomplete manifest makes those queries
// throw and their callers (layer catalogue, core-vocab filter) silently get zero rows.
// Every field of `Manifest` must be present and valid:
//   - format_version: MUST equal ros_madair_format::FORMAT_VERSION (currently 1).
//   - base_uri: the value regen-parquet-v2 / emit_parquet emit with.
//   - handlers: [] (empty but PRESENT) → read rebuilds default_registry, exactly what
//     these heads were emitted with. (emit's own manifest declares the real registry;
//     [] is equivalent for a default-registry head - see the FIXME below.)
//   - models / artifacts: unused by the duck read path (it reads graph.json + parquet),
//     so [] is fine for reading.
//   - budgets: mirror the emit defaults.
// FIXME(substrate): emit_parquet writes NO manifest, so this hand-crafts one and
// hardcodes format_version. The correct long-term fix is for emit_parquet to write a
// real self-describing manifest (like the sqlite emit does) and have this script MERGE
// snapshot_id into it. Revisit if FORMAT_VERSION bumps or a head needs non-default handlers.
// snapshot_id is hashed over the parquet/graph content only (manifest.json excluded).
writeFileSync(
  resolve(datasetDir, 'manifest.json'),
  JSON.stringify({
    snapshot_id,
    format_version: 1,
    base_uri: 'https://example.org/',
    handlers: [],
    models: [],
    artifacts: [],
    budgets: { max_result_rows: 1000, max_group_count: 500 },
  }),
);

const outDir = resolve('data/bundle/parquet-heads');
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `${headName}.zip`);
execSync(`cd "${datasetDir}" && rm -f "${out}" && zip -q -r -X "${out}" .`, { stdio: 'inherit' });

console.log(
  `[parquet-pkg] ${headName}: snapshot ${snapshot_id}, ${files.length + 1} files -> ${out}`,
);
