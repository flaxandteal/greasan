/**
 * Rich re-pull of Logainm places for the ontologically-correct `place` model.
 *
 *   node scripts/pull-logainm-places.mjs
 *
 * Supersedes pull-logainm-names.mjs (which grabbed ONLY foaf:name). Per place it
 * captures the feature category, the geometry centroid (lat/long - Logainm stores
 * these as decimal wgs84 literals on a linked geometry resource, so NO WKT parse
 * is needed), the logainm.ie page URL, and the containment parents (spatial#P).
 *
 * Outputs (data/raw/):
 *   logainm-names.jsonl       {"place":N,"name":"…","lang":"ga|en"}   (reused if present)
 *   logainm-places.jsonl      {"place":N,"cat":"BF","topic":"http://logainm.ie/N.aspx","lat":"…","long":"…"}
 *   logainm-parents.jsonl     {"place":N,"parent":M}
 *   logainm-categories.json   {"BF":{"ga":"baile fearainn","en":"townland"}, …}
 *
 * Virtuoso caps a SORTED result at offset+limit <= 10000, so we adaptively bisect
 * the numeric place-ID space (COUNT a window; fetch whole if small enough, else
 * split). Deterministic and complete regardless of ID distribution.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const ENDPOINT = 'https://data.logainm.ie/sparql';
const RAW = resolve(root, 'data/raw');
const MAX_ID = 1_500_000;

// --- Good-citizen throttle: identify ourselves + a contact so Logainm can reach
// out instead of blocking, and pace requests sequentially (never fan out). Every
// request waits at least THROTTLE_MS since the previous one started; combined with
// the exponential backoff below this stays gentle on a shared public endpoint.
const USER_AGENT = 'Greasan-dictionary/0.1 (+mailto:phil.weir@flaxandteal.co.uk; research/educational use)';
const THROTTLE_MS = 350;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _lastRequestAt = 0;

async function sparql(query, attempt = 0) {
  // Serialise + space out requests (this driver is single-threaded/sequential).
  const since = Date.now() - _lastRequestAt;
  if (since < THROTTLE_MS) await sleep(THROTTLE_MS - since);
  _lastRequestAt = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({ query }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.results.bindings;
  } catch (e) {
    if (attempt < 5) {
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`[pull] retry ${attempt + 1} after ${wait}ms (${e.message})`);
      await new Promise(r => setTimeout(r, wait));
      return sparql(query, attempt + 1);
    }
    throw e;
  }
}

const pid = (uri) => parseInt(uri.replace('http://data.logainm.ie/place/', ''), 10);

/**
 * Adaptive-bisection driver. `countQ(lo,hi)` -> SELECT (COUNT(...) AS ?n);
 * `fetchQ(lo,hi)` -> the windowed SELECT (must ORDER BY ?p LIMIT 10000). `onRows`
 * consumes each window's bindings. `cap` is the row-count threshold under which a
 * window is fetched whole.
 */
async function bisect(label, countQ, fetchQ, onRows, cap) {
  let windows = 0, counts = 0, rows = 0;
  async function go(lo, hi) {
    const b = await sparql(countQ(lo, hi));
    counts++;
    const n = parseInt(b[0]?.n?.value || '0', 10);
    if (n === 0) return;
    if (n <= cap || hi - lo <= 1) {
      const r = await sparql(fetchQ(lo, hi));
      windows++;
      rows += r.length;
      if (r.length >= 10000) {
        console.warn(`[pull:${label}] WARNING window [${lo},${hi}) hit 10000 (count=${n}) - possible truncation`);
      }
      onRows(r);
      if (windows % 20 === 0) console.log(`[pull:${label}] ${windows} windows, ${rows} rows...`);
      return;
    }
    const mid = Math.floor((lo + hi) / 2);
    await go(lo, mid);
    await go(mid, hi);
  }
  const t0 = Date.now();
  await go(0, MAX_ID);
  console.log(`[pull:${label}] DONE ${rows} rows, ${windows} windows, ${counts} counts (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return rows;
}

mkdirSync(RAW, { recursive: true });

// ---------------------------------------------------------------------------
// Pass 0: category label vocabulary (small, one query)
// ---------------------------------------------------------------------------
{
  console.log('[pull] Pass 0: category labels...');
  const q = `SELECT ?c ?name (lang(?name) AS ?l) WHERE {
    ?c a <http://data.logainm.ie/ontology/Category> .
    OPTIONAL { ?c <http://xmlns.com/foaf/0.1/name> ?name }
  }`;
  const rows = await sparql(q);
  const cats = {};
  for (const b of rows) {
    const code = b.c.value.replace('http://data.logainm.ie/category/', '');
    if (!cats[code]) cats[code] = {};
    const lang = b.l?.value || b.name?.['xml:lang'] || '';
    if (b.name && lang) cats[code][lang] = b.name.value;
  }
  writeFileSync(resolve(RAW, 'logainm-categories.json'), JSON.stringify(cats, null, 2));
  console.log(`[pull] ${Object.keys(cats).length} categories -> logainm-categories.json`);
}

// ---------------------------------------------------------------------------
// Pass 1: names (foaf:name ga/en) - reuse existing dump if present
// ---------------------------------------------------------------------------
{
  const out = resolve(RAW, 'logainm-names.jsonl');
  if (existsSync(out) && readFileSync(out, 'utf8').trim().length > 0) {
    console.log('[pull] Pass 1: names - reusing existing logainm-names.jsonl');
  } else {
    console.log('[pull] Pass 1: names (foaf:name)...');
    const lines = [];
    await bisect('names',
      (lo, hi) => `SELECT (COUNT(?name) AS ?n) WHERE {
        ?p <http://xmlns.com/foaf/0.1/name> ?name .
        BIND(xsd:integer(STRAFTER(STR(?p),"place/")) AS ?id)
        FILTER(?id >= ${lo} && ?id < ${hi}) }`,
      (lo, hi) => `SELECT ?p ?name (lang(?name) AS ?l) WHERE {
        ?p <http://xmlns.com/foaf/0.1/name> ?name .
        BIND(xsd:integer(STRAFTER(STR(?p),"place/")) AS ?id)
        FILTER(?id >= ${lo} && ?id < ${hi}) } ORDER BY ?p LIMIT 10000`,
      (rows) => {
        for (const r of rows) {
          const place = pid(r.p.value);
          if (!Number.isFinite(place)) continue;
          const lang = r.l?.value || r.name['xml:lang'] || '';
          lines.push(JSON.stringify({ place, name: r.name.value, lang }));
        }
      }, 8000);
    writeFileSync(out, lines.join('\n') + '\n');
    console.log(`[pull] ${lines.length} names -> logainm-names.jsonl`);
  }
}

// ---------------------------------------------------------------------------
// Pass 2: per-place category + page URL + geometry centroid (1 row/place)
// ---------------------------------------------------------------------------
{
  console.log('[pull] Pass 2: type + topic + lat/long...');
  const lines = [];
  await bisect('places',
    (lo, hi) => `SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE {
      ?p a <http://geovocab.org/spatial#Feature> .
      BIND(xsd:integer(STRAFTER(STR(?p),"place/")) AS ?id)
      FILTER(?id >= ${lo} && ?id < ${hi}) }`,
    (lo, hi) => `SELECT ?p ?cat ?topic ?lat ?long WHERE {
      ?p a <http://geovocab.org/spatial#Feature> .
      BIND(xsd:integer(STRAFTER(STR(?p),"place/")) AS ?id)
      FILTER(?id >= ${lo} && ?id < ${hi})
      OPTIONAL { ?p <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?cat .
                 FILTER(STRSTARTS(STR(?cat),"http://data.logainm.ie/category/")) }
      OPTIONAL { ?p <http://xmlns.com/foaf/0.1/isPrimaryTopicOf> ?topic }
      OPTIONAL { ?p <http://geovocab.org/geometry#geometry> ?g .
                 ?g <http://www.w3.org/2003/01/geo/wgs84_pos#lat> ?lat ;
                    <http://www.w3.org/2003/01/geo/wgs84_pos#long> ?long }
    } ORDER BY ?p LIMIT 10000`,
    (rows) => {
      for (const r of rows) {
        const place = pid(r.p.value);
        if (!Number.isFinite(place)) continue;
        lines.push(JSON.stringify({
          place,
          cat: r.cat ? r.cat.value.replace('http://data.logainm.ie/category/', '') : '',
          topic: r.topic?.value || '',
          lat: r.lat?.value || '',
          long: r.long?.value || '',
        }));
      }
    }, 7000);
  writeFileSync(resolve(RAW, 'logainm-places.jsonl'), lines.join('\n') + '\n');
  console.log(`[pull] ${lines.length} place records -> logainm-places.jsonl`);
}

// ---------------------------------------------------------------------------
// Pass 3: containment parents (spatial#P) - multi-valued, so smaller windows
// ---------------------------------------------------------------------------
{
  console.log('[pull] Pass 3: containment parents (spatial#P)...');
  const lines = [];
  await bisect('parents',
    (lo, hi) => `SELECT (COUNT(?parent) AS ?n) WHERE {
      ?p <http://geovocab.org/spatial#P> ?parent .
      BIND(xsd:integer(STRAFTER(STR(?p),"place/")) AS ?id)
      FILTER(?id >= ${lo} && ?id < ${hi}) }`,
    (lo, hi) => `SELECT ?p ?parent WHERE {
      ?p <http://geovocab.org/spatial#P> ?parent .
      BIND(xsd:integer(STRAFTER(STR(?p),"place/")) AS ?id)
      FILTER(?id >= ${lo} && ?id < ${hi}) } ORDER BY ?p LIMIT 10000`,
    (rows) => {
      for (const r of rows) {
        const place = pid(r.p.value);
        const parent = pid(r.parent.value);
        if (!Number.isFinite(place) || !Number.isFinite(parent)) continue;
        lines.push(JSON.stringify({ place, parent }));
      }
    }, 6000);
  writeFileSync(resolve(RAW, 'logainm-parents.jsonl'), lines.join('\n') + '\n');
  console.log(`[pull] ${lines.length} parent links -> logainm-parents.jsonl`);
}

console.log('[pull] All passes complete.');
