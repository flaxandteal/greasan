// Drop-in replacement for `import * as pagefind from '.../pagefind/lib/index.js'`
// that (a) points the fork node-wrapper at the vendored pagefind_extended binary
// and (b) auto-exports the getIndexCatalogue mapping beside every written index.
//
// The mapping is `{ pagefindHash: resourceUuid }` (records are added with
// `url: <resource uuid>`), i.e. pagefind-id -> resource-id. It ships as
// `<index-dir>/catalogue.json` so the search consumer can intersect FTS hits
// with structured/spatial id-sets WITHOUT hydrating every pagefind result.
// Mirrors flaxandteal/starches-builder. Requires the flaxandteal pagefind fork
// (upstream has no getIndexCatalogue) - see app/scripts/install-pagefind.js.

// Side effect: sets PAGEFIND_EXTENDED_BINARY_PATH before pagefind spawns the service.
import '../../app/scripts/setup-pagefind-env.js';
import * as real from '../../app/node_modules/pagefind/lib/index.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';

/** Wraps createIndex so the returned index also writes catalogue.json on writeFiles. */
export async function createIndex(options) {
  const result = await real.createIndex(options);
  const index = result?.index;
  if (index && typeof index.writeFiles === 'function') {
    const origWriteFiles = index.writeFiles.bind(index);
    index.writeFiles = async (args) => {
      const r = await origWriteFiles(args);
      const cat = await index.getIndexCatalogue();
      if (!cat || !cat.entries) {
        throw new Error(
          'getIndexCatalogue returned no entries - is the flaxandteal fork binary in use? ' +
            '(run `npm install` in app/ so scripts/install-pagefind.js fetches pagefind_extended)'
        );
      }
      // Each entry is [pagefindHash, recordJson]; the resource id is record.url
      // (build scripts add records with `url: <resource uuid>`). Store the lean
      // pagefind-id -> resource-id map, not the whole record.
      const mapping = {};
      for (const [hash, rec] of cat.entries) {
        try {
          const url = JSON.parse(rec)?.url;
          if (url) mapping[hash] = url;
        } catch {
          /* skip unparseable entry */
        }
      }
      const out = join(args.outputPath, 'catalogue.json');
      await writeFile(out, JSON.stringify(mapping));
      console.log(`[catalogue] ${cat.entries.length} pagefind-id -> resource-id entries -> ${out}`);
      return r;
    };
  }
  return result;
}

// Pass-through for the rest of the API the build scripts use.
export const close = real.close;
