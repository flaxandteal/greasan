#!/usr/bin/env node
// Emit + package EVERY bundled layer as a self-contained Parquet head zip (the
// DuckDB substrate counterpart of build-apk.sh's sqlite head rezip). For each
// layer: BAKE its own layer-<slug> Layer resource into the prebuild, regen
// -parquet-v2 (corpus tiles + tiles_layer + concept_catalog + graph.json), then
// package-parquet-layer.mjs (manifest snapshot_id + zip -> data/bundle/parquet-heads).
//
// The baked layer-<slug> resource carries the head's REAL resource_count and
// mints the SAME ResourceID + tile ids as the shipped skeleton catalogue entry
// (shared LAYER_NAMESPACE), so on install the store's cross-layer tile merge
// (hydrateLayers, topmost wins) overrides the skeleton placeholder. See
// HANDOFF-layer-skeleton.md Phase 2.
//
// Long-running: wiktionary is a ~25-min release DuckDB emit; the rest are minutes.
// Tearma is NOT here - it is imported on-device (slice 7).
//
//   node scripts/build-parquet-layers.mjs [head ...]   (default: all)

import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { LAYERS, readBundleTag } from './lib/layers-data.mjs';
import { initBackend, buildLayerArtifacts, writeLayerPrebuild } from './lib/layer-emit.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// head -> prebuild dir. Mirrors build-apk.sh HEADS (minus tearma; layer-v2 is the
// catalogue meta-head). Dataset dir = data/parquet-<prebuild-suffix>.
const HEADS = [
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

const usingNapi = await initBackend(root);
const bundleTag = readBundleTag(root);
const layerGraphId = buildLayerArtifacts({ root, layers: [LAYERS[0]], countResources: () => '', bundleTag, usingNapi }).graphId;

/** The corpus primary model of a prebuild (its own tiles, not the baked Layer
 * one): the business_data graph with the most resources, excluding the Layer
 * model. Returns { graphId, count } - count is the head's real resource_count. */
function corpusPrimary(prebuildDir) {
  const bdDir = resolve(prebuildDir, 'business_data');
  let best = { graphId: null, count: 0 };
  for (const f of readdirSync(bdDir)) {
    if (!f.endsWith('.json')) continue;
    const gid = f.replace(/\.json$/, '');
    if (gid === layerGraphId) continue; // skip a previously-baked Layer file
    try {
      const n = JSON.parse(readFileSync(resolve(bdDir, f), 'utf8'))?.business_data?.resources?.length || 0;
      if (n >= best.count) best = { graphId: gid, count: n };
    } catch { /* skip unreadable */ }
  }
  return best;
}

let ok = 0;
for (const [head, prebuild] of HEADS) {
  if (only.length && !only.includes(head)) continue;
  const prebuildDir = resolve(root, `data/${prebuild}`);
  if (!existsSync(prebuildDir)) {
    console.warn(`[skip] ${head}: data/${prebuild} missing`);
    continue;
  }
  const dataset = `data/parquet-${prebuild.slice('prebuild-'.length)}`;
  console.log(`\n========== ${head}  (${prebuild} -> ${dataset}) ==========`);

  // Bake the head's own Layer resource (real count), except into the catalogue
  // head itself (which IS the full catalogue). Pass the corpus primary as the
  // explicit regen primary so graph.json stays the corpus model even when the
  // head is small enough that the Layer resource has comparable tile count.
  const { graphId: primary, count } = corpusPrimary(prebuildDir);
  const layer = head === 'layer-v2' ? null : LAYERS.find((l) => l.head === head);
  if (layer) {
    const frag = buildLayerArtifacts({ root, layers: [layer], countResources: () => String(count), bundleTag, usingNapi });
    writeLayerPrebuild(prebuildDir, frag, { merge: true });
    console.log(`[bake] ${head}: layer-${layer.slug} resource (resource_count=${count}) -> ${prebuild}`);
  }

  const primaryArg = layer && primary ? ` ${primary}` : '';
  execSync(
    `cargo run --release --example regen-parquet-v2 ` +
      `--manifest-path app/src-tauri/Cargo.toml -- data/${prebuild} ${dataset}${primaryArg}`,
    { stdio: 'inherit', env },
  );
  execSync(`node scripts/package-parquet-layer.mjs ${dataset} ${head}`, { stdio: 'inherit' });
  ok++;
}
console.log(`\n[build-parquet-layers] packaged ${ok} layer(s) -> data/bundle/parquet-heads/`);
