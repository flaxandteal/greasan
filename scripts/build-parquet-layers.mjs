#!/usr/bin/env node
// Emit + package EVERY bundled layer as a self-contained Parquet head zip (the
// DuckDB substrate counterpart of build-apk.sh's sqlite head rezip). For each
// layer: regen-parquet-v2 (tiles + concept_catalog + graph.json) then
// package-parquet-layer.mjs (manifest snapshot_id + zip -> data/bundle/parquet-heads).
//
// Long-running: wiktionary is a ~25-min release DuckDB emit; the rest are minutes.
// Tearma is NOT here - it is imported on-device (slice 7).
//
//   node scripts/build-parquet-layers.mjs [head ...]   (default: all)

import { execSync } from 'child_process';
import { existsSync } from 'fs';

// head -> prebuild dir. Mirrors build-apk.sh HEADS (minus tearma; layer-v2 is the
// catalogue meta-head). Dataset dir = data/parquet-<prebuild-suffix>.
const LAYERS = [
  ['wiktionary-v2-full', 'prebuild-wiktionary'],
  ['macbain-v2', 'prebuild-macbain'],
  ['bunamo-v2', 'prebuild-bunamo'],
  ['gramadan-forms-v2', 'prebuild-gramadan-forms'],
  ['place-v2', 'prebuild-place'],
  ['concept-v2', 'prebuild-concept'],
  ['example-tatoeba-v2', 'prebuild-example-tatoeba'],
  ['example-gaois-v2', 'prebuild-example-gaois'],
  ['example-udt-v2', 'prebuild-example-udt'],
  ['person-v2', 'prebuild-person'],
  ['note-v2', 'prebuild-note'],
  ['layer-v2', 'prebuild-layer'],
];

const only = process.argv.slice(2);
const NDK = process.env.ANDROID_NDK_HOME || `${process.env.HOME}/Android/Sdk/ndk/27.0.12077973`;
const env = { ...process.env, ANDROID_NDK_HOME: NDK };

let ok = 0;
for (const [head, prebuild] of LAYERS) {
  if (only.length && !only.includes(head)) continue;
  if (!existsSync(`data/${prebuild}`)) {
    console.warn(`[skip] ${head}: data/${prebuild} missing`);
    continue;
  }
  const dataset = `data/parquet-${prebuild.slice('prebuild-'.length)}`;
  console.log(`\n========== ${head}  (${prebuild} -> ${dataset}) ==========`);
  execSync(
    `cargo run --release --example regen-parquet-v2 --features v2-emit ` +
      `--manifest-path app/src-tauri/Cargo.toml -- data/${prebuild} ${dataset}`,
    { stdio: 'inherit', env },
  );
  execSync(`node scripts/package-parquet-layer.mjs ${dataset} ${head}`, { stdio: 'inherit' });
  ok++;
}
console.log(`\n[build-parquet-layers] packaged ${ok} layer(s) -> data/bundle/parquet-heads/`);
