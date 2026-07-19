import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const host = process.env.TAURI_DEV_HOST;

// Vite 8 doesn't serve files with non-standard extensions (.pf_meta, .pf_index,
// .pagefind) from public/ — they fall through to the SPA fallback. This plugin
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
  };
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

// Redirect alizarin's internal WASM module import to the combined ros-madair-alizarin
// binary.  This gives us a single WASM instance that contains both the alizarin
// heritage viewer and the ros-madair SPARQL engine, so connect_tile_source can
// bridge them without crossing a JS serialization boundary.
//
// Two transforms:
//  1. resolveId: when alizarin/js/_wasm.ts imports "../pkg/alizarin", serve the
//     combined binary's wasm-bindgen glue instead.
//  2. transform: neutralise alizarin's hardcoded wasmURL so the combined binary's
//     init() uses its own default URL (which points at the correct .wasm file).
function combinedWasmPlugin(): Plugin {
  const combinedPkg = resolve(
    __dirname,
    '../../magic/RosMadair/pkg-alizarin/ros_madair_alizarin.js',
  );
  return {
    name: 'combined-wasm-redirect',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        source === '../pkg/alizarin' &&
        importer &&
        /alizarin[\\/]js[\\/]/.test(importer)
      ) {
        return combinedPkg;
      }
    },
    transform(code, id) {
      // _wasm.ts computes a URL for alizarin_bg.wasm and passes it to init().
      // Since we've redirected the ../pkg/alizarin import to the combined binary,
      // we need init() to use its own default URL (ros_madair_alizarin_bg.wasm).
      // Set wasmURL to a sentinel (bypasses the empty-URL guard) and call init()
      // with no arguments so wasm-bindgen uses its built-in default URL.
      if (/alizarin[\\/]js[\\/]_wasm/.test(id)) {
        // Replace the wasmURL IIFE with a sentinel value
        code = code.replace(
          /let wasmURL: string = \(\(\) => \{[\s\S]*?\}\)\(\);/,
          'let wasmURL: string = "combined-binary";',
        );
        // Call init() with no arguments — combined binary knows its own WASM URL
        code = code.replace(
          /await init\(\{ module_or_path: wasmURL \}\);/,
          'await init();',
        );
        return code;
      }
    },
  };
}

export default defineConfig({
  plugins: [
    pagefindServe(),
    v2LayerServe(),
    combinedWasmPlugin(),
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
    // Point alizarin imports to TypeScript source so Vite compiles it and our
    // combinedWasmPlugin can intercept the internal ../pkg/alizarin import.
    // The pre-built dist/ bundle has the WASM glue baked in and can't be redirected.
    alias: {
      'alizarin': resolve(__dirname, 'node_modules/alizarin/js/main.ts'),
    },
    // Ensure @alizarin/clm's peer dep and direct imports resolve to the same instance.
    dedupe: ['alizarin', 'ros-madair-alizarin'],
  },
  optimizeDeps: {
    exclude: ['alizarin', 'ros-madair-alizarin'],
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
