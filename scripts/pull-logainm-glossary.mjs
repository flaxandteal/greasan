#!/usr/bin/env node
/**
 * Pull the Logainm element glossary - the ~212 recurring toponymic elements
 * (baile, cill, mór, cnoc, …) with their forms, meanings and place-frequencies.
 *
 * This is the AUTHORITATIVE element vocabulary: build-logainm-layer.mjs decomposes
 * placenames by matching against these known forms, instead of open-vocabulary
 * string-splitting against the whole dictionary (which mis-linked homographs).
 *
 * Auth: `X-Api-Key` header. Key read from LOGAINM_API_KEY (env, or .env.build) -
 * never hard-code or commit it. Register at https://www.logainm.ie/en/api.
 *
 * Usage:  node scripts/pull-logainm-glossary.mjs
 * Output: data/raw/logainm-glossary.json  [{id, headword, translation, forms[], count}]
 *
 * Licensing: element headword/forms/id are placename data (CC BY 4.0 - usable
 * with attribution). `translation` is a researcher explanatory note (© Government
 * of Ireland) - use it to disambiguate/map, do NOT reproduce it in the app UI.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function apiKey() {
  if (process.env.LOGAINM_API_KEY) return process.env.LOGAINM_API_KEY.trim();
  const envPath = resolve(root, '.env.build');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*LOGAINM_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

/** The API returns `forms` as a Python-style stringified list: "['abhainn', 'abha']". */
function parseForms(f) {
  if (Array.isArray(f)) return f;
  if (typeof f !== 'string' || !f) return [];
  return f.replace(/^\[|\]$/g, '').split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

const KEY = apiKey();
if (!KEY) {
  console.error('[pull-glossary] LOGAINM_API_KEY not set (env or .env.build).');
  process.exit(1);
}

const res = await fetch('https://www.logainm.ie/api/v1.0/glossary', {
  headers: { 'X-Api-Key': KEY, Accept: 'application/json' },
});
if (!res.ok) {
  console.error(`[pull-glossary] glossary fetch failed: ${res.status}`);
  process.exit(1);
}
const data = await res.json();
const results = data.results || [];
if (data.totalPages > 1) {
  console.warn(`[pull-glossary] WARNING: ${data.totalPages} pages but only page 1 pulled (raise perPage).`);
}

const clean = results.map((e) => ({
  id: String(e.id),
  headword: e.headword || '',
  translation: e.translation || '',
  forms: parseForms(e.forms),
  count: Number(e.count) || 0,
})).filter((e) => e.headword);

const out = resolve(root, 'data/raw/logainm-glossary.json');
writeFileSync(out, JSON.stringify(clean));
console.log(`[pull-glossary] ${clean.length} elements → ${out}`);
console.log('[pull-glossary] top:', clean.slice().sort((a, b) => b.count - a.count).slice(0, 6).map((e) => `${e.headword}(${e.count})`).join(', '));
