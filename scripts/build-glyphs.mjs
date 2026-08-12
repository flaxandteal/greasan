/**
 * build-glyphs.mjs
 *
 * Generate offline SDF glyph PBFs from the app's bundled font (Kumbh Sans) for
 * the basemap's text labels. MapLibre renders text from `{fontstack}/{range}.pbf`
 * SDF glyphs; we're fully offline + CSP-locked, so we pre-generate the Latin
 * ranges we need and bundle them (served by a custom URI-scheme handler).
 *
 * Irish fadas (á é í ó ú / Á É Í Ó Ú) and Scottish-Gaelic graves (à è ì ò ù)
 * all live in Basic Latin + Latin-1 Supplement (0–255); Latin Extended-A
 * (256–511) is included for wider coverage. Kumbh Sans is a variable font -
 * node-fontnik/freetype renders its default instance, which is what we want.
 *
 * Output: app/public/glyphs/<fontstack>/<start>-<end>.pbf - under public/ so Vite
 * bundles it into the frontend and the webview serves it same-origin (no custom
 * protocol, no CSP change), exactly like the MapLibre worker/CSS.
 */
import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fontnik = require(resolve(root, 'app/node_modules/fontnik'));

const FONT = resolve(root, 'app/public/fonts/KumbhSans.ttf');
const FONTSTACK = 'KumbhSans';                  // matches the style's text-font (no space → clean URLs)
const RANGES = [[0, 255], [256, 511]];          // Latin + Latin-1 + Latin Ext-A
const OUT = resolve(root, 'app/public/glyphs', FONTSTACK);

const font = readFileSync(FONT);
mkdirSync(OUT, { recursive: true });

const range = (opts) => new Promise((res, rej) =>
  fontnik.range(opts, (err, buf) => (err ? rej(err) : res(buf))));

let bytes = 0;
for (const [start, end] of RANGES) {
  const buf = await range({ font, start, end });
  const path = resolve(OUT, `${start}-${end}.pbf`);
  writeFileSync(path, buf);
  bytes += buf.length;
  console.log(`[glyphs] ${FONTSTACK}/${start}-${end}.pbf  ${buf.length} bytes`);
}
console.log(`[glyphs] done: ${RANGES.length} ranges, ${(bytes / 1024).toFixed(1)} KB → ${OUT}`);
