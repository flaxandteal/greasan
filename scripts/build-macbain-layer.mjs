/**
 * Build a MacBain Etymology layer.
 *
 * Parses MacBain's "An Etymological Dictionary of the Gaelic Language" (1911, public domain)
 * from an EPUB (Wikisource export) and builds an installable layer that contributes etymology
 * and cognate data to existing Scottish Gaelic headwords (via cross-layer tile merge) and
 * creates standalone entries for unmatched archaic/historical terms.
 *
 * Usage: node scripts/build-macbain-layer.mjs [--epub <path>]
 *
 * Default EPUB: An_Etymological_Dictionary_of_the_Gaelic_Language.epub (project root)
 *
 * Output: data/macbain-layer.tar.gz
 */

import { createRequire } from 'module';
import { makeRdmCache } from './lib/rdm-cache.mjs';
import {
  initWasm,
  buildGraphFromModelCsvs,
  buildResourcesFromBusinessCsv,
  collectionsToSkosXml,
  createResourceRegistry,
  parseStaticGraph,
  setNapiModule,
} from '../app/node_modules/alizarin/dist/alizarin.js';
import * as pagefind from '../app/node_modules/pagefind/lib/index.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createHash } from 'node:crypto';

// RFC 4122 v5 (SHA-1), matching the `uuid` package's v5(name, namespace). The npm
// `uuid` dep isn't present in this tree; this is deterministic and matches Python's
// uuid.uuid5 / the Rust uuid5 used to derive resource UUIDs across the pipeline - so
// macbain's cognate_entry_id UUIDs equal the goi resource UUIDs (cross-layer links).
function uuidv5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const b = Buffer.from(createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const namespace = 'https://flaxandteal.org/ontology/goidelic#';
// uuid5(ALIZARIN_NS, "layer/macbain")
const LAYER_NAMESPACE = '672c88ea-0f99-5337-b342-445203b486af';
const MACBAIN_TAG = 'MB';

function elapsed(start) { return `${((performance.now() - start) / 1000).toFixed(1)}s`; }

const ALIZARIN_NS = '1a79f1c8-9505-4bea-a18e-28a053f725ca';
const GRAPH_ID = '449c8695-253e-521b-8994-27701ce22305';
const RESOURCE_NS = uuidv5(`resource/${GRAPH_ID}`, ALIZARIN_NS);

/** Convert a ResourceID to the UUID that alizarin assigns to the resource.
 *  Mirrors Rust: uuid5(uuid5(ALIZARIN_NS, "resource/{graphId}"), resourceId). */
function resourceIdToUuid(resourceId) {
  return uuidv5(resourceId, RESOURCE_NS);
}

function stripDiacritics(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

function slugify(text) {
  return stripDiacritics(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Identity normalization for matching against goi resources: fold acute AND grave to
// a macron (length PRESERVED, not stripped), matching docs/goidelic-slug-identity.md
// §3 / the pipeline's normalize_head - so macbain cognate/headword matches align with
// the goi slug identity (fear ≠ fēar; mór = mòr = mōr). Distinct from stripDiacritics,
// which stays for accent-insensitive SEARCH recall.
const _MACRON = { 'à': 'ā', 'á': 'ā', 'è': 'ē', 'é': 'ē', 'ì': 'ī', 'í': 'ī', 'ò': 'ō', 'ó': 'ō', 'ù': 'ū', 'ú': 'ū' };
function normalizeHead(text) {
  const s = text.normalize('NFC').toLowerCase();
  return Array.from(s, (ch) => _MACRON[ch] || ch).join('');
}

function decodeEntities(html) {
  return html
    .replace(/&#0?39;/g, "'")
    .replace(/&#8224;/g, '†')
    .replace(/&#x2020;/g, '†')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function csvEscape(value) {
  if (value == null || value === '') return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Parse CLI args
let epubPath = resolve(root, 'An_Etymological_Dictionary_of_the_Gaelic_Language.epub');
const epubArgIdx = process.argv.indexOf('--epub');
if (epubArgIdx !== -1 && process.argv[epubArgIdx + 1]) {
  epubPath = resolve(process.argv[epubArgIdx + 1]);
}

if (!existsSync(epubPath)) {
  console.error(`[build-macbain] EPUB not found: ${epubPath}`);
  console.error('[build-macbain] Download from Wikisource or provide --epub <path>');
  process.exit(1);
}

// NAPI or WASM backend
let usingNapi = false;
try {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  setNapiModule(napi);
  usingNapi = true;
  console.log('[build-macbain] Using NAPI backend');
} catch (e) {
  console.log('[build-macbain] NAPI not available, falling back to WASM');
  await initWasm();
}

const t0 = performance.now();

// =========================================================================
// STAGE A: Parse EPUB
// =========================================================================

const LANG_ABBRS = {
  'O. Ir.': 'Old Irish', 'E. Ir.': 'Early Irish', 'M. Ir.': 'Middle Irish',
  'Ir.': 'Irish',
  'O. W.': 'Old Welsh', 'W.': 'Welsh',
  'O. Br.': 'Old Breton', 'Br.': 'Breton',
  'Corn.': 'Cornish', 'Cor.': 'Cornish',
  'Lat.': 'Latin', 'Gr.': 'Greek',
  'O. Norse': 'Old Norse', 'Norse': 'Norse',
  'Skr.': 'Sanskrit',
  'O. Eng.': 'Old English', 'Eng.': 'English',
  'O. H. G.': 'Old High German', 'M. H. G.': 'Middle High German',
  'O. Ger.': 'Old German', 'Ger.': 'German',
  'Fr.': 'French', 'O. Fr.': 'Old French',
  'Got.': 'Gothic',
  'Manx': 'Manx',
  'Lit.': 'Lithuanian', 'Sl.': 'Slavonic',
  'Ch. Sl.': 'Church Slavonic',
  'Zend': 'Zend', 'Per.': 'Persian',
  'Arab.': 'Arabic', 'Heb.': 'Hebrew',
};

// Build regex for language abbreviations (longest first to avoid partial matches)
const langKeys = Object.keys(LANG_ABBRS).sort((a, b) => b.length - a.length);
const langPattern = langKeys
  .map(k => k.replace(/\./g, '\\.').replace(/\s+/g, '\\s+'))
  .join('|');

// Cognate pattern: LANG <i>WORD</i>
const cognateRe = new RegExp(
  `(?:^|[;,:\\s])\\s*(${langPattern})\\s+<i>([^<]+)</i>`,
  'gi',
);

// Bare language pattern: LANG abbreviation followed by comma/semicolon (no italic word)
// e.g., "so Ir.," or "belly, Ir., O. Ir. brú" - means "same word in LANG"
const bareLangRe = new RegExp(
  `(?:^|[;,:\\s])\\s*(${langPattern})\\s*(?=[,;.)])`,
  'gi',
);

// Language abbreviation followed by <i> - marks start of etymology region
const etymStartRe = new RegExp(`(${langPattern})\\s+<i>`, 'i');

function parseEntries(html) {
  const entries = [];

  // Strip page break spans before matching entry divs
  const cleaned = html
    .replace(/<span\s+class="pagenum[^"]*"[^>]*\/>/g, '')
    .replace(/<span\s+class="pagenum[^"]*"[^>]*>[^<]*<\/span>/g, '');

  // Match entry divs by the characteristic hanging-indent style
  const divRe = /<div[^>]*style="[^"]*text-indent:\s*-2em[^"]*margin-left:\s*2em[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;

  while ((m = divRe.exec(cleaned)) !== null) {
    const rawContent = m[1].trim();
    if (!rawContent) continue;

    // Obsolete marker (†)
    const obsolete = /^(?:†|&#8224;|&#x2020;)/.test(rawContent);

    // Strip dagger for headword extraction
    const content = rawContent.replace(/^(?:†|&#8224;|&#x2020;)\s*/, '');

    // Extract consecutive <b> headwords at start of content
    const headwords = [];
    let pos = 0;
    while (pos < content.length) {
      // Skip whitespace and commas between headwords
      const skipMatch = content.substring(pos).match(/^[\s,]+/);
      if (skipMatch) pos += skipMatch[0].length;

      const boldMatch = content.substring(pos).match(/^<b>([^<]+)<\/b>/);
      if (boldMatch) {
        headwords.push(decodeEntities(boldMatch[1]).trim());
        pos += boldMatch[0].length;
      } else {
        break;
      }
    }

    if (headwords.length === 0) continue;

    const primaryHeadword = headwords[0];

    // Gloss: text between last </b> and first language abbreviation + <i>
    const lastBoldEnd = content.lastIndexOf('</b>');
    const afterBold = lastBoldEnd >= 0 ? content.substring(lastBoldEnd + 5) : '';

    let gloss = '';
    const etymMatch = etymStartRe.exec(afterBold);
    if (etymMatch) {
      gloss = stripHtml(afterBold.substring(0, etymMatch.index));
    } else {
      gloss = stripHtml(afterBold);
    }
    // Trim leading/trailing punctuation and whitespace
    gloss = gloss.replace(/^[,;:\s]+/, '').replace(/[,;:\s]+$/, '');
    // Cut at colon or semicolon (usually marks etymology start)
    const punctIdx = gloss.search(/[;:]/);
    if (punctIdx > 0 && punctIdx < 150) {
      gloss = gloss.substring(0, punctIdx).trim();
    }
    // Truncate very long glosses
    if (gloss.length > 200) {
      gloss = gloss.substring(0, 197).replace(/\s\S*$/, '') + '\u2026';
    }

    // Full etymology text (all content, HTML stripped)
    const etymologyText = stripHtml(rawContent);

    // Extract cognates: LANG <i>WORD</i>
    const cognates = [];
    const seen = new Set();
    cognateRe.lastIndex = 0;
    let cm;
    while ((cm = cognateRe.exec(content)) !== null) {
      const langAbbr = cm[1].replace(/\s+/g, ' ').trim();
      const word = decodeEntities(cm[2]).trim();

      // Resolve language abbreviation
      let language = '';
      const abbrNorm = langAbbr.replace(/\s+/g, ' ');
      for (const [key, val] of Object.entries(LANG_ABBRS)) {
        if (key.toLowerCase() === abbrNorm.toLowerCase()) {
          language = val;
          break;
        }
      }
      if (language && word) {
        const dedup = `${language}:${word}`;
        if (!seen.has(dedup)) {
          seen.add(dedup);
          cognates.push({ headword: word, language });
        }
      }
    }

    // Bare language pass: detect LANG abbreviations NOT followed by <i>
    // (e.g., "so Ir.," or "belly, Ir., O. Ir. brú") - means "same word in LANG"
    const extractedLangs = new Set(cognates.map(c => c.language));
    bareLangRe.lastIndex = 0;
    while ((cm = bareLangRe.exec(content)) !== null) {
      const langAbbr = cm[1].replace(/\s+/g, ' ').trim();
      let language = '';
      const abbrNorm = langAbbr.replace(/\s+/g, ' ');
      for (const [key, val] of Object.entries(LANG_ABBRS)) {
        if (key.toLowerCase() === abbrNorm.toLowerCase()) {
          language = val;
          break;
        }
      }
      if (!language || extractedLangs.has(language)) continue;
      // Verify this isn't followed by <i> (already captured by cognateRe)
      const after = content.substring(cm.index + cm[0].length);
      if (/^\s*<i>/.test(after)) continue;
      const dedup = `${language}:${primaryHeadword}`;
      if (!seen.has(dedup)) {
        seen.add(dedup);
        cognates.push({ headword: primaryHeadword, language });
        extractedLangs.add(language);
      }
    }

    entries.push({
      headwords,
      primaryHeadword,
      obsolete,
      gloss,
      etymologyText,
      cognates,
    });
  }

  return entries;
}

console.log('[build-macbain] Parsing EPUB...');
const tEpub = performance.now();

// List chapter files in the EPUB
const zipList = execSync(`unzip -l "${epubPath}"`, { encoding: 'utf8' });
const chapterFiles = [];
for (const line of zipList.split('\n')) {
  const match = line.match(/(OPS\/c(\d+)[^\s]+\.xhtml)/);
  if (match) {
    const num = parseInt(match[2], 10);
    // c10-c27: dictionary entries (letters A-U) + supplementary words
    if (num >= 10 && num <= 27) {
      chapterFiles.push({ path: match[1], num });
    }
  }
}
chapterFiles.sort((a, b) => a.num - b.num);
console.log(`[build-macbain] Found ${chapterFiles.length} chapter files (c10-c27)`);

const allEntries = [];
for (const { path, num } of chapterFiles) {
  const html = execSync(`unzip -p "${epubPath}" "${path}"`, { encoding: 'utf8' });
  const entries = parseEntries(html);
  console.log(`[build-macbain]   c${num}: ${entries.length} entries`);
  allEntries.push(...entries);
}

console.log(`[build-macbain] Total entries parsed: ${allEntries.length} (${elapsed(tEpub)})`);

// =========================================================================
// STAGE B: Headword matching + CSV generation
// =========================================================================

console.log('[build-macbain] Building headword match lookup...');

// Load WK business data CSV to build normalised-headword → ResourceID[] lookups
// for BOTH ga-* (Irish) and gd-* (Scottish Gaelic) entries.
const gaLookup = new Map(); // normalised headword → ResourceID[]
const gdLookup = new Map();
const wkCsvPath = resolve(root, 'data/processed/lexical_entry_data.csv');

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuote = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (inQuote) {
      if (ch === '"' && line[j + 1] === '"') { field += '"'; j++; }
      else if (ch === '"') inQuote = false;
      else field += ch;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      fields.push(field); field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

// Also build forms lookups: normalised written_rep → ResourceID (for lemmatization fallback)
const gaFormsLookup = new Map();
const gdFormsLookup = new Map();

if (existsSync(wkCsvPath)) {
  const wkCsv = readFileSync(wkCsvPath, 'utf8');
  const lines = wkCsv.split('\n');
  const header = lines[0].split(',');
  const ridIdx = header.indexOf('ResourceID');
  const hwIdx = header.indexOf('headword');
  const wrIdx = header.indexOf('written_rep');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const fields = parseCsvLine(line);
    const rid = fields[ridIdx] || '';
    const hw = fields[hwIdx] || '';
    const wr = wrIdx >= 0 ? (fields[wrIdx] || '') : '';

    // Headword lookup (first row per entry has headword)
    if (hw) {
      const key = normalizeHead(hw);
      // goi- resources are the merged cross-dialect lexeme (Irish + Scottish in
      // one), so they are candidates for BOTH Irish and Scottish cognate matches.
      // ga-/gd- kept for any pre-goi data.
      const hwTargets = rid.startsWith('goi-') ? [gaLookup, gdLookup]
        : rid.startsWith('ga-') ? [gaLookup]
        : rid.startsWith('gd-') ? [gdLookup] : [];
      for (const lk of hwTargets) {
        if (!lk.has(key)) lk.set(key, []);
        const arr = lk.get(key);
        if (!arr.includes(rid)) arr.push(rid);
      }
    }

    // Forms lookup (written_rep on subsequent rows)
    if (wr && !hw) {
      const key = normalizeHead(wr);
      const fmTargets = rid.startsWith('goi-') ? [gaFormsLookup, gdFormsLookup]
        : rid.startsWith('ga-') ? [gaFormsLookup]
        : rid.startsWith('gd-') ? [gdFormsLookup] : [];
      for (const lk of fmTargets) {
        if (!lk.has(key)) lk.set(key, rid);
      }
    }
  }
  console.log(`[build-macbain] WK lookup: ga=${gaLookup.size}, gd=${gdLookup.size} unique normalised headwords`);
  console.log(`[build-macbain] WK forms: ga=${gaFormsLookup.size}, gd=${gdFormsLookup.size} unique forms`);
} else {
  console.log('[build-macbain] No WK CSV found - all entries will be standalone');
}

// Forms lemmatization now sources from BuNaMo, not Wiktionary: WK no longer ships
// inflected forms (dropped from the layer), so its written_rep column is empty.
// BuNaMo carries the full paradigm keyed by the shared goi- slug, so it restores
// the "match an inflected MacBain spelling to its lemma" fallback.
const bunamoCsvPath = resolve(root, 'data/processed/bunamo_lexical_entry_data.csv');
if (existsSync(bunamoCsvPath)) {
  const lines = readFileSync(bunamoCsvPath, 'utf8').split('\n');
  const header = lines[0].split(',');
  const ridIdx = header.indexOf('ResourceID');
  const wrIdx = header.indexOf('written_rep');
  let added = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = parseCsvLine(lines[i]);
    const rid = fields[ridIdx] || '';
    const wr = wrIdx >= 0 ? (fields[wrIdx] || '') : '';
    if (!wr || !rid) continue;
    const key = normalizeHead(wr);
    // BuNaMo emits goi- slugs → candidates for both Irish and Scottish matches.
    const fmTargets = rid.startsWith('goi-') ? [gaFormsLookup, gdFormsLookup]
      : rid.startsWith('ga-') ? [gaFormsLookup]
      : rid.startsWith('gd-') ? [gdFormsLookup] : [];
    for (const lk of fmTargets) {
      if (!lk.has(key)) { lk.set(key, rid); added++; }
    }
  }
  console.log(`[build-macbain] BuNaMo forms: ga=${gaFormsLookup.size}, gd=${gdFormsLookup.size} unique forms (+${added})`);
} else {
  console.log('[build-macbain] No BuNaMo CSV - forms lemmatization stays empty');
}

// Combined lookup for MacBain headword matching (gd-* only, same as before)
const wkLookup = gdLookup;

// Map cognate language strings to the appropriate headword + forms lookups
const COGNATE_LANG_TO_LOOKUP = {
  'Irish': gaLookup,
  'Old Irish': gaLookup,
  'Early Irish': gaLookup,
  'Middle Irish': gaLookup,
  'Scottish Gaelic': gdLookup,
  'Manx': null, // no gv-* entries yet
};
const COGNATE_LANG_TO_FORMS = {
  'Irish': gaFormsLookup,
  'Old Irish': gaFormsLookup,
  'Early Irish': gaFormsLookup,
  'Middle Irish': gaFormsLookup,
  'Scottish Gaelic': gdFormsLookup,
  'Manx': null,
};

// Generate business data CSV
const CSV_COLUMNS = [
  'ResourceID', 'headword', 'part_of_speech', 'dialect',
  'ipa_value', 'gloss', 'example', 'source_label',
  'written_rep', 'gram_features', 'domain',
  'etymology_text', 'etymology_source',
  'cognate_headword', 'cognate_language', 'cognate_entry_id',
  // NOTE: related_entries (resource-instance-list) deliberately omitted.
  // Including it causes ros-madair to assign referenced ga-* resources to pages
  // in the MacBain layer with no tile data → 404s on tile fetch.
  // Forward cognate linking works via cognate_entry_id alone.
];

// Collect rows per ResourceID so they're contiguous (buildResourcesFromBusinessCsv requirement).
// Multiple MacBain entries can match the same WK ResourceID.
const rowsByRid = new Map(); // ResourceID → row-object[]
let matchedCount = 0;
let standaloneCount = 0;
const usedResourceIds = new Set();

function addRows(rid, rows) {
  if (!rowsByRid.has(rid)) rowsByRid.set(rid, []);
  rowsByRid.get(rid).push(...rows);
}

for (const entry of allEntries) {
  const normHw = normalizeHead(entry.primaryHeadword);
  const wkIds = wkLookup.get(normHw) || [];

  // Resolve cognate entry IDs against ga/gd lookups (headword first, then forms fallback)
  const resolvedCognates = entry.cognates.map(c => {
    const lookup = COGNATE_LANG_TO_LOOKUP[c.language];
    if (!lookup) return { ...c, entryId: null };
    const key = normalizeHead(c.headword);
    const ids = lookup.get(key);
    if (ids?.[0]) return { ...c, entryId: ids[0] };
    // Fallback: check forms lookup (lemmatization)
    const formsLookup = COGNATE_LANG_TO_FORMS[c.language];
    const formRid = formsLookup?.get(key);
    return { ...c, entryId: formRid || null };
  });

  if (wkIds.length > 0) {
    // Matched: emit etymology + cognate rows for each WK ResourceID
    matchedCount++;
    for (const rid of wkIds) {
      const maxRows = Math.max(1, resolvedCognates.length);
      const rows = [];

      for (let i = 0; i < maxRows; i++) {
        const row = { ResourceID: rid };
        if (i === 0) {
          row.etymology_text = entry.etymologyText;
          row.etymology_source = MACBAIN_TAG;
        }
        if (i < resolvedCognates.length) {
          row.cognate_headword = resolvedCognates[i].headword;
          row.cognate_language = resolvedCognates[i].language;
          if (resolvedCognates[i].entryId) {
            row.cognate_entry_id = resourceIdToUuid(resolvedCognates[i].entryId);
          }
        }
        rows.push(row);
      }
      addRows(rid, rows);
    }
  } else {
    // Unmatched: standalone entry
    standaloneCount++;
    // Dialect-neutral slug (goi-, not gd-): language lives on the tile
    // (row.dialect below), not the ID. A Scottish-only MacBain entry has no Irish
    // match to compose with, and "-etym" is a POS bucket no other source emits, so
    // goi-<slug>-etym cannot collide with a real-POS entry. Finishes the v2
    // dialect-neutral migration (the last language-prefixed slugs).
    const slug = slugify(entry.primaryHeadword);
    let rid = `goi-${slug}-etym`;
    let suffix = 2;
    while (usedResourceIds.has(rid)) rid = `goi-${slug}-etym-${suffix++}`;
    usedResourceIds.add(rid);

    const maxRows = Math.max(1, resolvedCognates.length);
    const rows = [];

    for (let i = 0; i < maxRows; i++) {
      const row = { ResourceID: rid };
      if (i === 0) {
        row.headword = entry.primaryHeadword;
        row.dialect = 'Scottish Gaelic (General)';
        row.gloss = entry.gloss;
        row.source_label = MACBAIN_TAG;
        row.etymology_text = entry.etymologyText;
        row.etymology_source = MACBAIN_TAG;
      }
      if (i < resolvedCognates.length) {
        row.cognate_headword = resolvedCognates[i].headword;
        row.cognate_language = resolvedCognates[i].language;
        if (resolvedCognates[i].entryId) {
          row.cognate_entry_id = resourceIdToUuid(resolvedCognates[i].entryId);
        }
      }
      rows.push(row);
    }
    addRows(rid, rows);
  }
}

// Flatten: header + grouped rows
const csvRows = [CSV_COLUMNS.join(',')];
for (const [, rows] of rowsByRid) {
  for (const row of rows) {
    csvRows.push(CSV_COLUMNS.map(c => csvEscape(row[c] || '')).join(','));
  }
}

const csvContent = csvRows.join('\n') + '\n';

const csvOutPath = resolve(root, 'data/processed/macbain_lexical_entry_data.csv');
mkdirSync(resolve(root, 'data/processed'), { recursive: true });
writeFileSync(csvOutPath, csvContent);

// Count cognates with resolved entry IDs
let linkedCognateCount = 0;
let formsMatchCount = 0;
let bareRefCount = 0;
for (const entry of allEntries) {
  for (const c of entry.cognates) {
    const lookup = COGNATE_LANG_TO_LOOKUP[c.language];
    if (!lookup) continue;
    const key = normalizeHead(c.headword);
    if (lookup.has(key)) {
      linkedCognateCount++;
    } else {
      const formsLookup = COGNATE_LANG_TO_FORMS[c.language];
      if (formsLookup?.has(key)) { linkedCognateCount++; formsMatchCount++; }
    }
    // Count bare refs (headword == entry headword, meaning "so Ir." pattern)
    if (c.headword === entry.primaryHeadword) bareRefCount++;
  }
}

console.log(`[build-macbain] Matched: ${matchedCount}, Standalone: ${standaloneCount}`);
console.log(`[build-macbain] Linked cognates: ${linkedCognateCount} (${formsMatchCount} via forms lemmatization, ${bareRefCount} bare "so Ir." refs)`);
console.log(`[build-macbain] CSV: ${csvRows.length - 1} data rows → ${csvOutPath}`);

// =========================================================================
// STAGE C: Build layer (same pipeline as tearma)
// =========================================================================

// --- Build lexical_entry model ---

const modelDir = resolve(root, 'models/lexical_entry');
const graphCsv = readFileSync(resolve(modelDir, 'graph.csv'), 'utf8');
const nodesCsv = readFileSync(resolve(modelDir, 'nodes.csv'), 'utf8');
const collectionsCsvPath = resolve(modelDir, 'collections.csv');
const collectionsCsv = existsSync(collectionsCsvPath)
  ? readFileSync(collectionsCsvPath, 'utf8')
  : null;

console.log('[build-macbain] Building graph from model CSVs...');
const { graph, collections } = buildGraphFromModelCsvs(graphCsv, nodesCsv, namespace, collectionsCsv);
const graphId = graph.graphid;
console.log(`[build-macbain] Graph: ${graphId}, Collections: ${collections.length}`);

// StaticGraph + descriptors
const typedGraph = parseStaticGraph(JSON.stringify({ graph: [graph] }));
typedGraph.setDescriptorTemplate('name', '<Headword>');
typedGraph.setDescriptorTemplate('description', '<Gloss>');

// Build resources from MacBain business data CSV
const tBd = performance.now();
const result = buildResourcesFromBusinessCsv(csvContent, graph, collections, 'en', false, LAYER_NAMESPACE, makeRdmCache(collections, root, usingNapi));
const resources = result?.business_data?.resources || [];
console.log(`[build-macbain] Built ${resources.length} resources (${elapsed(tBd)})`);

// Migrate concept → reference
for (const node of graph.nodes) {
  if (node.datatype === 'concept-list') {
    node.datatype = 'reference';
    node.config = { ...node.config, multiValue: true, controlledList: node.config?.rdmCollection };
  } else if (node.datatype === 'concept') {
    node.datatype = 'reference';
    node.config = { ...node.config, controlledList: node.config?.rdmCollection };
  }
}

// --- Populate caches ---

const registry = createResourceRegistry();
registry.mergeFromResourcesJson(JSON.stringify(resources), true, true);

let rdmCache = null;
if (usingNapi) {
  const require = createRequire(resolve(root, 'app/package.json'));
  const napi = require('@alizarin/napi');
  rdmCache = new napi.NapiRdmCache();
  for (const collection of collections) {
    const cid = collection.collectionid || collection.id;
    if (!cid) continue;
    const allConcepts = collection.__allConcepts || {};
    const concepts = Object.values(allConcepts).map(c => ({
      id: c.id,
      prefLabels: c.prefLabels || {},
      broader: c.broader || [],
      narrower: (c.children || []).map(ch => ch.id || ch),
    }));
    rdmCache.addCollectionFromJson(cid, JSON.stringify(concepts));
  }
}

const cacheResult = registry.populateCachesFromJson(
  JSON.stringify(resources), typedGraph, true, false, true
);
const enrichedResources = cacheResult.resources || resources;
console.log(`[build-macbain] Descriptors computed for ${enrichedResources.length} resources`);

// --- Write prebuild directory ---

const prebuildDir = resolve(root, 'data/prebuild-macbain');
mkdirSync(resolve(prebuildDir, 'graphs/resource_models'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'business_data'), { recursive: true });
mkdirSync(resolve(prebuildDir, 'reference_data/collections'), { recursive: true });

writeFileSync(
  resolve(prebuildDir, `graphs/resource_models/${graphId}.json`),
  JSON.stringify(graph)
);
writeFileSync(
  resolve(prebuildDir, `business_data/${graphId}.json`),
  JSON.stringify({ business_data: { resources: enrichedResources } })
);

for (const collection of collections) {
  const cid = collection.collectionid || collection.id;
  if (cid) {
    writeFileSync(
      resolve(prebuildDir, `reference_data/collections/${cid}.json`),
      JSON.stringify(collection)
    );
    try {
      const xml = collectionsToSkosXml([collection], namespace);
      writeFileSync(
        resolve(prebuildDir, `reference_data/collections/${cid}.xml`),
        xml
      );
    } catch (e) {
      console.warn(`[build-macbain] SKOS XML failed for ${cid}: ${e.message}`);
    }
  }
}

writeFileSync(
  resolve(prebuildDir, 'manifest.json'),
  JSON.stringify({
    base_uri: namespace,
    source: 'macbain-1911',
    built: new Date().toISOString(),
    license: 'public-domain',
  })
);

console.log(`[build-macbain] Prebuild written to ${prebuildDir}`);

// --- Run ros-madair-build ---

const outputDir = resolve(root, 'data/macbain-index');
mkdirSync(outputDir, { recursive: true });

const buildBin = resolve(root, 'scripts/ros-madair-build');
if (!existsSync(buildBin)) {
  console.error('[build-macbain] ros-madair-build binary not found at', buildBin);
  process.exit(1);
}

const pageSize = parseInt(process.env.ROS_MADAIR_PAGE_SIZE || '200', 10);
console.log(`[build-macbain] Running ros-madair-build (page_size=${pageSize})...`);
try {
  execSync(
    `"${buildBin}" "${prebuildDir}" "${outputDir}" ${pageSize} "${namespace}"`,
    { stdio: 'inherit' }
  );
} catch (e) {
  console.error('[build-macbain] ros-madair-build failed:', e.message);
  process.exit(1);
}

// Wrap graph JSON for alizarin
const graphFile = resolve(outputDir, `graphs/${graphId}.json`);
if (existsSync(graphFile)) {
  const rawGraph = JSON.parse(readFileSync(graphFile, 'utf8'));
  if (!rawGraph.graph) {
    writeFileSync(graphFile, JSON.stringify({ graph: [rawGraph] }));
  }
}

// --- Pagefind indices ---
// Only standalone entries have headwords - matched entries are already searchable via WK pagefind.

console.log('[build-macbain] Building Pagefind indices...');
const tPf = performance.now();

const DIALECT_LABEL_TO_CODE = {
  'Irish': 'GA', 'Irish (General)': 'GA',
  'Connacht Irish': 'GA.CON', 'Connemara Irish': 'GA.CON',
  'Ulster Irish': 'GA.ULS', 'Donegal Irish': 'GA.ULS',
  'Munster Irish': 'GA.MUN', 'Kerry Irish': 'GA.MUN', 'Waterford Irish': 'GA.MUN',
  'Scottish Gaelic': 'GD', 'Scottish Gaelic (General)': 'GD',
  'Highland Gaelic': 'GD.HLD', 'Hebridean Gaelic': 'GD.HEB', 'Argyll Gaelic': 'GD.ARG',
  'Manx': 'GV', 'Manx (General)': 'GV',
};

const dialectValueIndex = registry.getValueToResourcesIndex(
  typedGraph, 'dialect', true, rdmCache
);
const resourceDialectCodes = {};
for (const [label, resourceIds] of Object.entries(dialectValueIndex)) {
  const subLabels = label.split('|');
  const codes = subLabels.map(l => DIALECT_LABEL_TO_CODE[l.trim()] || l.trim());
  for (const rid of resourceIds) {
    if (!resourceDialectCodes[rid]) resourceDialectCodes[rid] = new Set();
    for (const code of codes) resourceDialectCodes[rid].add(code);
  }
}

function getDialectCodes(resource) {
  const uuid = resource.resourceinstance?.resourceinstanceid;
  const codes = resourceDialectCodes[uuid];
  return codes ? [...codes] : ['GD'];
}

const { index: gaIndex } = await pagefind.createIndex({ forceLanguage: 'ga' });
const { index: enIndex } = await pagefind.createIndex({ forceLanguage: 'en' });

if (!gaIndex || !enIndex) {
  console.error('[build-macbain] Failed to create pagefind indices');
  process.exit(1);
}

let gaCount = 0, enCount = 0;

for (const resource of enrichedResources) {
  const ri = resource.resourceinstance;
  const uuid = ri?.resourceinstanceid;
  const headword = ri?.name;
  if (!headword || !uuid) continue;

  const gloss = ri?.descriptors?.description || '';
  const dialectCodes = getDialectCodes(resource);
  const dialectDisplay = dialectCodes.reduce((a, b) => a.length >= b.length ? a : b, '');

  const headwordNorm = stripDiacritics(headword);
  await gaIndex.addCustomRecord({
    url: uuid,
    content: headword === headwordNorm ? headword : `${headword} ${headwordNorm}`,
    language: 'ga',
    meta: { title: headword, gloss, dialect: dialectDisplay },
    filters: { dialect: dialectCodes },
  });
  gaCount++;

  if (gloss) {
    await enIndex.addCustomRecord({
      url: uuid,
      content: gloss,
      language: 'en',
      meta: { title: gloss, headword, dialect: dialectDisplay },
      filters: { dialect: dialectCodes },
    });
    enCount++;
  }
}

await gaIndex.writeFiles({ outputPath: resolve(outputDir, 'pagefind-ga') });
await enIndex.writeFiles({ outputPath: resolve(outputDir, 'pagefind-en') });

// Zip pagefind directories
for (const dir of ['pagefind-ga', 'pagefind-en']) {
  const src = resolve(outputDir, dir);
  const dest = resolve(outputDir, `${dir}.zip`);
  if (existsSync(src)) {
    execSync(`cd "${src}" && zip -0 -q -r "${dest}" .`);
  }
}

console.log(`[build-macbain] Pagefind: ga=${gaCount}, en=${enCount} (${elapsed(tPf)})`);

// --- Zip bulk data and remove extracted directories ---

for (const dir of ['tiles', 'pages']) {
  const src = resolve(outputDir, dir);
  const dest = resolve(outputDir, `${dir}.zip`);
  if (existsSync(src)) {
    try {
      execSync(`cd "${src}" && zip -0 -q -r "${dest}" .`);
      console.log(`[build-macbain] Zipped ${dir} → ${dir}.zip`);
    } catch {
      console.log(`[build-macbain] ${dir}/ empty or zip failed, skipping zip`);
    }
    execSync(`rm -rf "${src}"`);
  }
}
for (const dir of ['pagefind-ga', 'pagefind-en']) {
  const src = resolve(outputDir, dir);
  if (existsSync(src)) {
    execSync(`rm -rf "${src}"`);
  }
}

// --- Package as tar.gz ---

const tarFile = resolve(root, 'data/macbain-layer.tar.gz');
console.log(`[build-macbain] Packaging ${tarFile}...`);
execSync(`tar -czf "${tarFile}" -C "${outputDir}" .`);

console.log(`[build-macbain] Done (${elapsed(t0)})`);
console.log(`[build-macbain] Output: ${tarFile}`);
console.log(`[build-macbain] Entries: ${allEntries.length} parsed, ${matchedCount} matched, ${standaloneCount} standalone`);
