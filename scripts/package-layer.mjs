#!/usr/bin/env node
/**
 * Package a built index directory into a distributable .tar.gz layer package.
 *
 * Usage:
 *   node scripts/package-layer.mjs <input-dir> <output.tar.gz> [--name <layer-name>]
 *
 * Example:
 *   node scripts/package-layer.mjs app/public/index-goidelic /tmp/goidelic-layer-v1.tar.gz --name goidelic
 */

import { statSync, readdirSync, readFileSync, mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);

function usage() {
  console.error('Usage: package-layer.mjs <input-dir> <output.tar.gz> [--name <name>]');
  process.exit(1);
}

if (args.length < 2) usage();

const inputDir = resolve(args[0]);
const outputPath = resolve(args[1]);
let layerName = basename(inputDir);

const nameIdx = args.indexOf('--name');
if (nameIdx !== -1 && args[nameIdx + 1]) {
  layerName = args[nameIdx + 1];
}

// Files to include (relative to input dir)
const INCLUDE_FILES = [
  'summary.bin',
  'resource_map.bin',
  'dictionary.bin',
  'concept_tree.bin',
  'concept_intervals.bin',
  'concept_hierarchy.json',
  'page_meta.json',
  'resource_names.json',
  'all.nt',
];

const INCLUDE_DIRS = ['graphs', 'tiles', 'pages'];
const PAGEFIND_PATTERN = /^pagefind-.*\.zip$/;

function main() {
  // Verify input
  try {
    statSync(join(inputDir, 'summary.bin'));
  } catch {
    console.error(`Error: ${inputDir}/summary.bin not found. Is this a built index directory?`);
    process.exit(1);
  }

  // Create a staging directory with just the files we want
  const staging = mkdtempSync(join(tmpdir(), 'layer-pkg-'));

  try {
    // Write manifest
    const manifest = {
      format_version: 1,
      name: layerName,
      built: new Date().toISOString(),
    };
    // Preserve base_uri from existing manifest if present
    try {
      const existing = JSON.parse(readFileSync(join(inputDir, 'manifest.json'), 'utf8'));
      if (existing.base_uri) manifest.base_uri = existing.base_uri;
    } catch { /* no manifest */ }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

    let fileCount = 1; // manifest

    // Copy individual files
    for (const file of INCLUDE_FILES) {
      const src = join(inputDir, file);
      try {
        statSync(src);
        cpSync(src, join(staging, file));
        fileCount++;
      } catch { /* optional */ }
    }

    // Copy directories
    for (const dir of INCLUDE_DIRS) {
      const src = join(inputDir, dir);
      try {
        statSync(src);
        cpSync(src, join(staging, dir), { recursive: true });
        // Count files
        const count = readdirSync(src, { recursive: true }).length;
        fileCount += count;
      } catch { /* optional */ }
    }

    // Copy pagefind zips
    for (const entry of readdirSync(inputDir)) {
      if (PAGEFIND_PATTERN.test(entry)) {
        cpSync(join(inputDir, entry), join(staging, entry));
        fileCount++;
      }
    }

    // Create tar.gz
    execSync(`tar -czf "${outputPath}" -C "${staging}" .`, { stdio: 'pipe' });

    const outStat = statSync(outputPath);
    console.log(`Packaged ${fileCount} files → ${outputPath} (${(outStat.size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main();
