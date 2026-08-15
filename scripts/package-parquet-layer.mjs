#!/usr/bin/env node
// Package an emitted Parquet dataset dir into a bundle head zip.
//
// regen-parquet-v2 (emit_parquet) already wrote a real, self-describing
// manifest.json (Slice 2). Here we SEAL + SIGN it via `ros-madair-emit sign`:
// seal_and_sign rebuilds the manifest's content hashes / snapshot_id over EVERY
// file in the dataset (so graph.json, copied in after emit, is covered too) and
// writes a signed attestations.json beside it. Then we zip the dir as
// data/bundle/parquet-heads/<head>.zip. offline.rs extracts this exactly like a
// sqlite head zip - the bundle format is format-agnostic; only the zip's CONTENTS
// change (tiles_*.parquet + concept_catalog.parquet + graph.json + attestations).
//
//   node scripts/package-parquet-layer.mjs <dataset_dir> <head_name>
//
// Signing key: $RM_SIGNING_KEY, else data/keys/publisher-ed25519.key (minted on
// first use, SSH-host-key style; gitignored - a private key must NEVER be
// committed). L0/TOFU: the public key rides in the envelope, so a per-build-machine
// key still verifies self-contained on device. A canonical published key (and key
// pinning) is a later phase.

import { mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

const [datasetDir, headName] = process.argv.slice(2);
if (!datasetDir || !headName) {
  console.error('usage: package-parquet-layer.mjs <dataset_dir> <head_name>');
  process.exit(1);
}

// The ros-madair-emit CLI lives in the sibling substrate repo (crypto stays in
// Rust - never reimplemented in Node). Run from the Greasan repo root.
const EMIT_MANIFEST = resolve('../magic/RosMadair-sandbox-parquet/crates/ros-madair-emit/Cargo.toml');
const keyPath = process.env.RM_SIGNING_KEY || resolve('data/keys/publisher-ed25519.key');
const dataset = resolve(datasetDir);

// Named attribution: bundled layers are DERIVED from public records by Flax &
// Teal - a `derived` role naming the F&T actor (distinct from an upstream
// publisher's `endorsed`). The actor URI will resolve to a schema:Organization
// resource once that model lands; overridable for a different publisher.
const actor = process.env.RM_ACTOR ?? 'https://flaxandteal.co.uk/#organization';
const actorName = process.env.RM_ACTOR_NAME ?? 'Flax & Teal Limited';
const role = process.env.RM_ROLE ?? 'derived';
const attrFlags = actor
  ? ` --role ${role} --actor "${actor}" --actor-name "${actorName}"`
  : '';

// `sign` seals the manifest (real artifacts + snapshot_id) and writes
// attestations.json, printing the snapshot_id on stdout. --quiet keeps cargo's
// chatter off stdout so the id is all we read.
const snapshot_id = execSync(
  `cargo run --release --quiet --bin ros-madair-emit --manifest-path "${EMIT_MANIFEST}" ` +
    `-- sign "${dataset}" "${keyPath}"${attrFlags}`,
  { encoding: 'utf8' },
).trim();

const outDir = resolve('data/bundle/parquet-heads');
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `${headName}.zip`);
execSync(`cd "${dataset}" && rm -f "${out}" && zip -q -r -X "${out}" .`, { stdio: 'inherit' });

console.log(`[parquet-pkg] ${headName}: signed snapshot ${snapshot_id} -> ${out}`);
