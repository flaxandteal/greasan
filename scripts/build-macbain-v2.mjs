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
// !!! DO NOT RUN while another session is building/editing the RosMadair or
// !!! alizarin sandboxes: this shells out to `cargo run` inside
// !!! magic/RosMadair-sandbox and will take its target/ lock (and pick up
// !!! whatever half-finished state that tree is in).

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = resolve(repo, '../magic/RosMadair-sandbox');

const dataDir = resolve(repo, 'data/prebuild-macbain');
const outDir = resolve(repo, 'data/macbain-v2');
// The Arches resource-model export for Lexical Entry; the head carries no
// schema, so the Tauri command needs the graph shipped beside it.
const graphSrc = resolve(
  dataDir,
  'graphs/resource_models/449c8695-253e-521b-8994-27701ce22305.json',
);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

execFileSync(
  'cargo',
  [
    'run',
    '--release',
    '-p',
    'ros-madair-emit',
    '--manifest-path',
    resolve(sandbox, 'Cargo.toml'),
    '--',
    dataDir,
    outDir,
  ],
  { stdio: 'inherit' },
);

copyFileSync(graphSrc, resolve(outDir, 'graph.json'));
console.log(`v2 head written to ${outDir} (graph.json copied alongside)`);
