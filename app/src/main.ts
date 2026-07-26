import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// Tauri Android's tauri.localhost proxy drops concurrent Range requests
// (https://github.com/tauri-apps/tauri/issues/14097). In dev mode only,
// redirect data fetches to the Vite dev server via ADB reverse tunnel.
if (import.meta.env.DEV && window.location.hostname === 'tauri.localhost') {
  const devOrigin = 'http://127.0.0.1:5173';
  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    if (input instanceof Request) {
      const url = new URL(input.url, window.location.origin);

      // Custom protocol requests: strip headers and pass as plain URL string
      // to avoid CORS preflight (Tauri custom protocols may not handle OPTIONS
      // on Android WebView). Range header is encoded as a query param.
      if (url.hostname === 'rmindex.localhost' || url.hostname === 'pfzip.localhost') {
        const range = input.headers.get('Range');
        if (range) {
          url.searchParams.set('_range', range);
        }
        return origFetch(url.toString());
      }

      if (url.origin === window.location.origin) {
        return origFetch(devOrigin + url.pathname + url.search, {
          method: input.method,
          headers: Object.fromEntries(input.headers),
          ...init,
        });
      }
    }
    return origFetch(input, init);
  } as typeof fetch;
}

// Debug: trace unhandled promise rejections to find TILES_NOT_LOADED source
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const msg = typeof reason === 'string' ? reason : reason?.message || String(reason);
  if (msg.includes('TILES_NOT_LOADED')) {
    console.error('[DEBUG] Unhandled TILES_NOT_LOADED rejection:', msg);
    console.error('[DEBUG] Stack:', reason?.stack || new Error().stack);
    console.error('[DEBUG] Promise:', event.promise);
  }
});

const app = mount(App, {
  target: document.getElementById('app')!,
})

// greasan:// deep links (deterministic navigation + shareable links). No-op off Tauri.
import { initDeepLinks } from './lib/deeplink';
void initDeepLinks();

export default app
