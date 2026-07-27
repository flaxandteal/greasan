// SPDX-License-Identifier: AGPL-3.0-or-later
//
// greasan:// route handling — deterministic navigation for testing + screencasts.
// Real Android deep links are blocked by an upstream tao panic on typeless VIEW
// intents, so for now routes arrive via the debug nav channel (Rust `nav-server`
// feature → `nav` event). Drive from the host:
//   adb forward tcp:8787 tcp:8787 && curl -s localhost:8787/nav/map/baile
//
// Routes:
//   greasan://word/<headword>    open the top-matching entry
//   greasan://map/<headword>     open that entry's placenames map
//   greasan://example/<uuid>     open an example (sampla) detail
//   greasan://layers             open the layer sheet
//   greasan://flags              open the flags page
//   greasan://faq                open the FAQ overlay
import { listen } from '@tauri-apps/api/event';
import { currentEntry, currentExample, currentLayer, overlayView, layerSheetOpen, openMap, loading } from './store';
import { search, loadEntryFlagged, loadExample, placeHeadDir } from './dictionary';
import { loadLayerBySlug } from './layers-catalogue';

// The place graph's `name_elements.element_entry` reverse-link node — the same
// UUID EntryDetail uses to plot the placenames constituted by a headword.
const ELEMENT_ENTRY_NODE_UUID = '49436367-b92b-5157-8cf5-a81086195ad6';

/** Top exact-or-first match for a headword (ga search). */
async function topMatch(headword: string) {
  const results = await search(headword, 'ga');
  return results.find((r) => r.headword.toLowerCase() === headword.toLowerCase()) ?? results[0];
}

async function openWord(headword: string): Promise<void> {
  const hit = await topMatch(headword);
  if (!hit) return;
  loading.set(true);
  try { currentEntry.set(await loadEntryFlagged(hit.uri, hit.headword)); }
  finally { loading.set(false); }
}

async function openWordMap(headword: string): Promise<void> {
  const headDir = placeHeadDir();
  if (!headDir) return; // place layer not installed — nothing to map
  const hit = await topMatch(headword);
  if (!hit) return;
  openMap({
    layer: { headDir, label: 'Logainm' },
    filter: { nodeUri: ELEMENT_ENTRY_NODE_UUID, targetUri: hit.uri, label: hit.headword },
  });
}

async function openExample(id: string): Promise<void> {
  loading.set(true);
  try { const ex = await loadExample(id); if (ex) currentExample.set(ex); }
  finally { loading.set(false); }
}

async function openLayer(slug: string): Promise<void> {
  loading.set(true);
  try { const l = await loadLayerBySlug(slug); if (l) currentLayer.set(l); }
  finally { loading.set(false); }
}

/** Route one greasan:// URL. Unknown/unparseable URLs are ignored (logged). */
export async function handleDeepLink(url: string): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { return; }
  if (u.protocol !== 'greasan:') return;
  const route = u.host;
  const arg = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  switch (route) {
    case 'word': case 'entry': await openWord(arg); break;
    case 'map': await openWordMap(arg); break;
    case 'example': await openExample(arg); break;
    case 'layer': await openLayer(arg); break;
    case 'layers': layerSheetOpen.set(true); break;
    case 'flags': overlayView.set('flags'); break;
    case 'faq': overlayView.set('faq'); break;
    default: console.warn('[deeplink] unknown route:', route, '(', url, ')');
  }
}

/**
 * Wire up the debug nav channel. The Rust `nav-server` feature (dev builds only)
 * emits a `nav` event carrying a route like "map/baile", which we route as
 * greasan://map/baile. No-op off Tauri / when the feature is absent.
 */
export async function initDeepLinks(): Promise<void> {
  try {
    await listen<string>('nav', (e) => { void handleDeepLink('greasan://' + e.payload); });
  } catch (e) { console.warn('[deeplink] nav channel unavailable:', e); }
}
