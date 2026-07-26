// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MapLibre v6 is ESM-only and has no default export; we `import * as maplibregl`
// and hand its `setWorkerUrl` a same-origin worker that Vite has bundled via
// `?worker&url` (imports followed and inlined). Declare that virtual module so
// the URL import stays typed without pulling in vite/client globally.
declare module 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url' {
  const url: string;
  export default url;
}
