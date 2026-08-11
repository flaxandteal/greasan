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

writeFileSync(resolve(datasetDir, 'manifest.json'), JSON.stringify({ snapshot_id }));

const outDir = resolve('data/bundle/parquet-heads');
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `${headName}.zip`);
execSync(`cd "${datasetDir}" && rm -f "${out}" && zip -q -r -X "${out}" .`, { stdio: 'inherit' });

console.log(
  `[parquet-pkg] ${headName}: snapshot ${snapshot_id}, ${files.length + 1} files -> ${out}`,
);
