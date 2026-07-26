/**
 * Pull all Logainm place foaf:name literals (Irish @ga + English @en) from the
 * Linked Logainm SPARQL endpoint, saving a raw JSONL dump.
 *
 *   node scripts/pull-logainm-names.mjs
 *
 * Output: data/raw/logainm-names.jsonl  (one line per name literal)
 *   {"place": 125009, "name": "An Chanáil Mhór", "lang": "ga"}
 *
 * Virtuoso caps a SORTED result at offset+limit <= 10000, so we cannot deep-page
 * the global name query. Instead we bisect the numeric place-ID space adaptively:
 * COUNT rows in [lo,hi); if small enough, fetch the whole window (ORDER BY ?p,
 * which is safe under the cap); otherwise split. This is deterministic and
 * complete regardless of how IDs are distributed.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const ENDPOINT = 'https://data.logainm.ie/sparql';
const OUT = resolve(root, 'data/raw/logainm-names.jsonl');
const WINDOW_CAP = 8000; // fetch whole window when name-row count <= this
const MAX_ID = 1_500_000;

async function sparql(query, attempt = 0) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ query }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.results.bindings;
  } catch (e) {
    if (attempt < 4) {
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`[pull] retry ${attempt + 1} after ${wait}ms (${e.message})`);
      await new Promise(r => setTimeout(r, wait));
      return sparql(query, attempt + 1);
    }
    throw e;
  }
}

async function countRange(lo, hi) {
  const q = `SELECT (COUNT(?name) AS ?n) WHERE {
    ?p <http://xmlns.com/foaf/0.1/name> ?name .
    BIND(xsd:integer(STRAFTER(STR(?p),"place/")) AS ?id)
    FILTER(?id >= ${lo} && ?id < ${hi})
  }`;
  const b = await sparql(q);
  return parseInt(b[0]?.n?.value || '0', 10);
}

async function fetchRange(lo, hi) {
  // Window guaranteed <= WINDOW_CAP rows; ORDER BY keeps it under the sort cap.
  const q = `SELECT ?p ?name (lang(?name) AS ?l) WHERE {
    ?p <http://xmlns.com/foaf/0.1/name> ?name .
    BIND(xsd:integer(STRAFTER(STR(?p),"place/")) AS ?id)
    FILTER(?id >= ${lo} && ?id < ${hi})
  } ORDER BY ?p LIMIT 10000`;
  return sparql(q);
}

const lines = [];
let placeSet = new Set();
let windows = 0;
let countQueries = 0;

async function process(lo, hi) {
  const n = await countRange(lo, hi);
  countQueries++;
  if (n === 0) return;
  if (n <= WINDOW_CAP || hi - lo <= 1) {
    const rows = await fetchRange(lo, hi);
    windows++;
    if (rows.length >= 10000) {
      console.warn(`[pull] WARNING window [${lo},${hi}) hit 10000-row limit (count said ${n}) — possible truncation`);
    }
    for (const r of rows) {
      const place = parseInt(r.p.value.replace('http://data.logainm.ie/place/', ''), 10);
      const name = r.name.value;
      const lang = r.l?.value || r.name['xml:lang'] || '';
      lines.push(JSON.stringify({ place, name, lang }));
      placeSet.add(place);
    }
    if (windows % 10 === 0) console.log(`[pull] ${windows} windows, ${lines.length} names, ${placeSet.size} places...`);
    return;
  }
  const mid = Math.floor((lo + hi) / 2);
  await process(lo, mid);
  await process(mid, hi);
}

const t0 = Date.now();
console.log('[pull] Starting adaptive bisection pull...');
await process(0, MAX_ID);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`[pull] DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`[pull] ${lines.length} name literals, ${placeSet.size} distinct places`);
console.log(`[pull] ${countQueries} count queries, ${windows} fetch windows`);
console.log(`[pull] Written: ${OUT}`);
