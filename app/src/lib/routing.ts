// SPDX-License-Identifier: AGPL-3.0-or-later
// The single source of truth for which top-level view App.svelte shows, extracted
// from the template's if/else chain so the precedence is testable (and one place
// can't silently diverge from another). Pure - no store imports - so a routing test
// needn't pull in the store module.

export type MainView =
  | 'map'
  | 'faq'
  | 'flags'
  | 'layers'
  | 'layerDetail'
  | 'example'
  | 'entry'
  | 'search'
  | 'starred'
  | 'settings'
  | null;

export interface ViewState {
  mapState: unknown;
  overlayView: 'faq' | 'flags' | 'layers' | null;
  currentLayer: unknown;
  currentExample: unknown;
  currentEntry: unknown;
  activeTab: string;
}

/** Resolve the top-level view. Order mirrors App.svelte EXACTLY - the first match
 *  wins, so a set overlayView shadows currentLayer (hence a layer tap must CLEAR
 *  overlayView, not merely set currentLayer - see store.openLayerDetail). */
export function resolveMainView(s: ViewState): MainView {
  if (s.mapState) return 'map';
  if (s.overlayView === 'faq') return 'faq';
  if (s.overlayView === 'flags') return 'flags';
  if (s.overlayView === 'layers') return 'layers';
  if (s.currentLayer) return 'layerDetail';
  if (s.currentExample) return 'example';
  if (s.currentEntry) return 'entry';
  if (s.activeTab === 'search') return 'search';
  if (s.activeTab === 'starred') return 'starred';
  if (s.activeTab === 'settings') return 'settings';
  return null;
}
