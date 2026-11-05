// Regression guard for "tapping a layer in the Layer Manager doesn't open its
// detail page". App.svelte resolves the view via resolveMainView (this exercises
// that exact function). The bug: the 'layers' overlay is resolved BEFORE
// currentLayer, so setting currentLayer from inside the manager leaves the list
// shadowing the detail page. The fix: the tap (store.openLayerDetail) clears
// overlayView, which this proves resolves to 'layerDetail'.
//
// A true UI e2e (render + tap) isn't possible in this repo: no DOM test env
// (vitest runs in node, no jsdom/testing-library) and the Tauri WebView can't be
// driven headless. This is the logic-level e2e: tap-state -> resolved view.
import { describe, it, expect } from 'vitest';
import { resolveMainView, type ViewState } from './routing';

const base: ViewState = {
  mapState: null,
  overlayView: null,
  currentLayer: null,
  currentExample: null,
  currentEntry: null,
  activeTab: 'search',
};
const aLayer = { name: 'téarma' };

describe('resolveMainView — layer detail routing', () => {
  it('BUG: the layers overlay shadows a set currentLayer', () => {
    // What tapping used to do: set currentLayer but leave overlayView === 'layers'.
    expect(resolveMainView({ ...base, overlayView: 'layers', currentLayer: aLayer })).toBe('layers');
  });

  it('FIX: with overlayView cleared, a set currentLayer resolves to the detail page', () => {
    // What store.openLayerDetail now produces (overlayView -> null, currentLayer set).
    expect(resolveMainView({ ...base, overlayView: null, currentLayer: aLayer })).toBe('layerDetail');
  });

  it('the Settings path already worked (overlay never set there)', () => {
    expect(resolveMainView({ ...base, activeTab: 'settings', currentLayer: aLayer })).toBe('layerDetail');
  });

  it('precedence is otherwise unchanged', () => {
    expect(resolveMainView({ ...base, mapState: { layer: 'x' } })).toBe('map');
    expect(resolveMainView({ ...base, overlayView: 'flags' })).toBe('flags');
    expect(resolveMainView({ ...base, currentEntry: { uri: 'x' } })).toBe('entry');
    expect(resolveMainView({ ...base, activeTab: 'starred' })).toBe('starred');
    expect(resolveMainView(base)).toBe('search');
  });
});
