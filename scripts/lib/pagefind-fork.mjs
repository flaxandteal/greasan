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
      if (!cat || !cat.entries || cat.entries.length === 0) {
        // Empty index - a legitimate case: some build scripts create a per-language
        // index (e.g. ga/en) but add records only to one of them. Write an empty
        // catalogue and carry on rather than failing the whole build. (A missing/
        // wrong fork binary surfaces earlier as `getIndexCatalogue is not a function`,
        // not as an empty result here.)
        await writeFile(join(args.outputPath, 'catalogue.json'), '{}');
        return r;
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
