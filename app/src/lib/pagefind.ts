export interface PagefindResult {
  id: string;
  data: () => Promise<PagefindResultData>;
}

export interface PagefindResultData {
  url: string;
  meta: { title: string; gloss?: string; headword?: string };
  excerpt: string;
}

export interface PagefindSearchOptions {
  filters?: Record<string, string | string[] | { any: string[] } | { all: string[] } | { none: string[] } | { not: string[] }>;
}

export interface PagefindInstance {
  search: (query: string, options?: PagefindSearchOptions) => Promise<{ results: PagefindResult[] }>;
  filters: () => Promise<Record<string, Record<string, number>>>;
}

import { diagStart, diagEnd } from './diagnostics';

const instances = new Map<string, PagefindInstance>();
const loadingMap = new Map<string, Promise<PagefindInstance>>();

// Vite 8 blocks both static and dynamic imports of JS from /public.
// Fetch the script as text and import via blob URL to bypass entirely.
async function importPagefind(pagefindBase: string): Promise<any> {
  const resp = await fetch(`${pagefindBase}pagefind.js`);
  if (!resp.ok) throw new Error(`Failed to fetch pagefind.js: ${resp.status}`);
  const text = await resp.text();
  const blob = new Blob([text], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const mod = await import(/* @vite-ignore */ url);
  URL.revokeObjectURL(url);
  return mod;
}

export function resetPagefind(): void {
  instances.clear();
  loadingMap.clear();
}

export async function getPagefind(pagefindBase: string): Promise<PagefindInstance> {
  const cached = instances.get(pagefindBase);
  if (cached) return cached;

  const existing = loadingMap.get(pagefindBase);
  if (existing) return existing;

  const promise = (async () => {
    const dPf = diagStart(`pagefind init (${pagefindBase.split('/').filter(Boolean).pop()})`);

    const mod = await importPagefind(pagefindBase);
    // createInstance gives a dedicated instance (no shared module state).
    // noWorker: true — Workers can't fetch from Tauri's asset:// protocol.
    const inst = mod.createInstance({
      basePath: pagefindBase,
      baseUrl: '/',
      noWorker: true,
    });
    await inst.init();
    diagEnd(dPf);

    instances.set(pagefindBase, inst as PagefindInstance);
    loadingMap.delete(pagefindBase);
    return inst as PagefindInstance;
  })();

  // On failure, clear from loadingMap so subsequent searches can retry
  // rather than permanently returning the rejected promise.
  promise.catch(() => {
    loadingMap.delete(pagefindBase);
  });

  loadingMap.set(pagefindBase, promise);
  return promise;
}
