#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regenerate the v2 pilot head at data/macbain-v2/ from data/prebuild-macbain/.
//
// The output (head.sqlite + chunks/ + closure.json + manifest.json, plus the
// resource-model graph.json copied alongside) is what app/src-tauri's `v2`
// feature reads — including its tests. The artefacts are committed, so this
// script is documentation-of-provenance first, regeneration second.
//
//   node scripts/build-macbain-v2.mjs
//
// The emit itself lives in app/src-tauri/examples/regen-macbain-v2.rs, behind
// the `v2-emit` feature: ros-madair-emit is a path dependency of src-tauri, so
// building it from *our* workspace keeps the emitter's artifacts in our target/
// and leaves the RosMadair sandbox's target/ lock and Cargo.lock untouched.
// (This script used to `cargo run --manifest-path <sandbox>`, which took both,
// and so could not be run while that tree was being worked on.)

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = resolve(repo, 'app/src-tauri');

execFileSync(
  'cargo',
  [
    'run',
    '--release',
    '--example',
    'regen-macbain-v2',
    '--features',
    'v2-emit',
    '--manifest-path',
    resolve(srcTauri, 'Cargo.toml'),
  ],
  { stdio: 'inherit' },
);
