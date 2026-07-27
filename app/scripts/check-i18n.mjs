#!/usr/bin/env node
/**
 * i18n guardrail. Two checks, run over src/:
 *
 *  1. Locale coverage — keys in the canonical `en` locale that `ga` has not yet
 *     translated (informational: `ga` is intentionally partial and falls back
 *     to `en`), and keys in `ga` absent from `en` (a failure — orphan/typo).
 *
 *  2. Hardcoded strings — user-facing text in .svelte that bypasses `$t`:
 *     `aria-label`/`placeholder`/`title` literals, and bilingual " · " literals
 *     in markup. Heuristic, deliberately conservative.
 *
 * Exit non-zero on orphan keys or hardcoded strings; coverage gaps only warn.
 * Usage: node scripts/check-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** Extract the top-level string keys from a locale .ts module by regex. */
function localeKeys(file) {
  const text = readFileSync(join(SRC, 'lib/locales', file), 'utf8');
  const keys = new Set();
  // Matches:  'some.key':  or  "some.key":
  for (const m of text.matchAll(/['"]([a-zA-Z0-9_.]+)['"]\s*:/g)) keys.add(m[1]);
  return keys;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

// --- Check 1: locale coverage -------------------------------------------
const en = localeKeys('en.ts');
const ga = localeKeys('ga.ts');
const untranslated = [...en].filter((k) => !ga.has(k)).sort();
const orphans = [...ga].filter((k) => !en.has(k)).sort();

// --- Check 2: hardcoded strings -----------------------------------------
// Attribute literals with actual letters (skip pure-symbol values like "✕").
const ATTR = /\b(aria-label|placeholder|title)="([^"]*[A-Za-zÁÉÍÓÚáéíóú][^"]*)"/g;
const findings = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ATTR)) {
      findings.push(`${rel}:${i + 1}  ${m[1]}="${m[2]}"`);
    }
    // Bilingual heading: a static "Word · Word" text node. Lines containing a
    // `{` are skipped — there the middot is a data separator (e.g. join(' · '),
    // `{a} · {b}`), which is punctuation, not a translatable string.
    if (!line.includes('{') && /[A-Za-zÁÉÍÓÚáéíóú]\s·\s[A-Za-zÁÉÍÓÚáéíóú]/.test(line)) {
      findings.push(`${rel}:${i + 1}  bilingual '·' literal: ${line.trim().slice(0, 80)}`);
    }
  });
}

// --- Report --------------------------------------------------------------
let failed = false;

if (orphans.length) {
  failed = true;
  console.error(`\n✗ ${orphans.length} ga key(s) not in en (orphan/typo):`);
  for (const k of orphans) console.error(`    ${k}`);
}

if (findings.length) {
  failed = true;
  console.error(`\n✗ ${findings.length} hardcoded string(s) — route through $t:`);
  for (const f of findings) console.error(`    ${f}`);
}

if (untranslated.length) {
  console.warn(`\n⚠ ${untranslated.length}/${en.size} keys not yet in ga (fall back to en):`);
  for (const k of untranslated) console.warn(`    ${k}`);
}

if (!failed) {
  console.log(`\n✓ i18n clean — no orphan keys, no hardcoded strings. ` +
    `ga covers ${ga.size}/${en.size} keys.`);
}

process.exit(failed ? 1 : 0);
