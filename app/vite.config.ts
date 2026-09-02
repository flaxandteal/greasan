import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Plugin } from 'vite'

const host = process.env.TAURI_DEV_HOST;

// Vite 8 doesn't serve files with non-standard extensions (.pf_meta, .pf_index,
// .pagefind) from public/ - they fall through to the SPA fallback. This plugin
// intercepts those requests and serves the binary files directly.
function pagefindServe(): Plugin {
  const PAGEFIND_EXT = /\.(pf_meta|pf_index|pf_filter|pf_fragment|pagefind)$/;
  return {
    name: 'pagefind-serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && PAGEFIND_EXT.test(req.url)) {
          const filePath = resolve('public', req.url.slice(1));
          if (existsSync(filePath)) {
            const data = readFileSync(filePath);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', data.length);
            res.end(data);
            return;
          }
        }
        next();
      });
    },
  };
}

// v2 dev pagefind serving. The v2 layers' Pagefind indices live outside the app
// (data/<layer>-index/pagefind-<lang>/, extracted from the built pagefind zips).
// Serving them via public/ symlinks blows the inotify watcher limit (thousands
// of .pf_fragment files); a request-time middleware reads them on demand WITHOUT
// vite watching them, and keeps them same-origin so the Tauri CSP `'self'`
// connect-src allows the fetch (no CORS, no CSP edit). Maps
// `/layer-<name>/...` -> `../data/<name>-index/...`. Production would serve these
// via the pfzip custom protocol like v1 (see dictionary.ts V2_LAYERS note).
function v2LayerServe(): Plugin {
  const CT: Record<string, string> = {
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm',
  };
  const MAP: Record<string, string> = {
    '/layer-wiktionary/': resolve(__dirname, '../data/wiktionary-index'),
    '/layer-macbain/': resolve(__dirname, '../data/macbain-index'),
    '/layer-tearma/': resolve(__dirname, '../data/tearma-index'),
    // BuNaMo keeps its extracted pagefind-<lang>/ dirs in the head dir itself.
    '/layer-bunamo/': resolve(__dirname, '../data/bunamo-v2'),
    // Place (Logainm) - bundled but excluded from search for now (NON_SEARCH_LAYERS).
    '/layer-place/': resolve(__dirname, '../data/place-v2'),
  };
  const extracted = new Set<string>();
  return {
    name: 'v2-layer-serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url && req.url.split('?')[0];
        if (!url) return next();
        for (const [prefix, root] of Object.entries(MAP)) {
          if (!url.startsWith(prefix)) continue;
          const rel = decodeURIComponent(url.slice(prefix.length));
          if (rel.includes('..')) return next();
          // Lazily extract a pagefind-<lang>/ dir from its sibling .zip on first
          // access, so a fresh clone/build needs no manual unzip. bunamo/place ship
          // the dir already; the -index layers ship only the .zip.
          const pf = rel.match(/^(pagefind-[a-z]+)\//);
          if (pf) {
            const dir = resolve(root, pf[1]);
            const zip = `${dir}.zip`;
            if (!extracted.has(dir) && !existsSync(dir) && existsSync(zip)) {
              try {
                execFileSync('unzip', ['-oq', zip, '-d', dir]);
              } catch { /* fall through to next() below */ }
              extracted.add(dir);
            }
          }
          const filePath = resolve(root, rel);
          if (!existsSync(filePath)) return next();
          const ext = (filePath.match(/\.[a-z0-9_]+$/i) || [''])[0].toLowerCase();
          const data = readFileSync(filePath);
          res.setHeader('Content-Type', CT[ext] || 'application/octet-stream');
          res.setHeader('Content-Length', data.length);
          res.end(data);
          return;
        }
        return next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    pagefindServe(),
    v2LayerServe(),
    svelte(),
    tailwindcss(),
    wasm(),
  ],
  define: {
    // alizarin's main.ts expects this at build time (normally injected by alizarin's own vite build)
    __ALIZARIN_VERSION__: JSON.stringify('2.0.0-alpha.95'),
  },
  build: {
    target: 'esnext',
    emptyOutDir: false,
  },
  resolve: {
    // Point alizarin imports at its TypeScript source so Vite compiles it and
    // its own `../pkg/alizarin` wasm-bindgen glue loads alizarin_bg.wasm. (The
    // v1 combined ros-madair-alizarin binary that used to intercept this import
    // is retired; alizarin now loads its own WASM.)
    alias: {
      'alizarin': resolve(__dirname, '../../magic/alizarin/js/main.ts'),
    },
    // Ensure @alizarin/clm's peer dep and direct imports resolve to the same instance.
    dedupe: ['alizarin'],
  },
  optimizeDeps: {
    exclude: ['alizarin'],
  },
  server: {
    port: parseInt(process.env.PORT || '5173'),
    strictPort: true,
    host: '0.0.0.0',
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**', '**/node_modules/**', '**/public/index-*/**', '**/dist/index-*/**'],
    },
    fs: {
      allow: ['..', '../../magic'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
})
