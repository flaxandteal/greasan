// SPDX-License-Identifier: AGPL-3.0-or-later
//
// First-run guided tour. Walks a new user through the app's main screens by
// driving the SAME store-based navigation that greasan:// deep links use — no
// debug nav-server, no parallel router. Overlay routes go through
// `handleDeepLink`; tab screens set `activeTab` directly (there is no deep-link
// route for a bare tab). Persisted "seen" flag in localStorage, versioned so a
// materially changed tour can be re-shown to returning users.
import { writable, get } from 'svelte/store';
import {
  activeTab, overlayView, currentEntry, currentExample, currentLayer,
  layerSheetOpen, mapState,
} from './store';

/** Bump when the tour changes enough that returning users should see it again. */
export const TOUR_VERSION = 1;
const SEEN_KEY = 'ge:tourSeen';

export interface TourStep {
  /** i18n key stem — `tour.<key>.title` and `tour.<key>.body` must exist. */
  key: string;
  /** Emoji shown on the card. */
  icon: string;
  /** Drive the app to the screen this step describes. */
  go: () => void | Promise<void>;
}

/** Drop every transient nav layer so a step lands on a clean base screen. */
function resetNav(): void {
  mapState.set(null);
  currentLayer.set(null);
  currentExample.set(null);
  currentEntry.set(null);
  layerSheetOpen.set(false);
  overlayView.set(null);
}

export const TOUR_STEPS: readonly TourStep[] = [
  { key: 'welcome',  icon: '👋', go: () => { resetNav(); activeTab.set('search'); } },
  { key: 'search',   icon: '🔍', go: () => { resetNav(); activeTab.set('search'); } },
  { key: 'layers',   icon: '📚', go: () => { resetNav(); activeTab.set('search'); overlayView.set('layers'); } },
  { key: 'starred',  icon: '⭐', go: () => { resetNav(); activeTab.set('starred'); } },
  { key: 'settings', icon: '⚙️', go: () => { resetNav(); activeTab.set('settings'); } },
  { key: 'faq',      icon: '❓', go: () => { resetNav(); overlayView.set('faq'); } },
];

export const tourActive = writable(false);
export const tourStep = writable(0);

function hasSeenCurrent(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw !== null && Number(JSON.parse(raw)) >= TOUR_VERSION;
  } catch { return false; }
}

function markSeen(): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(TOUR_VERSION)); } catch { /* ignore */ }
}

async function applyStep(i: number): Promise<void> {
  tourStep.set(i);
  await TOUR_STEPS[i].go();
}

/** Start the tour from the top (used by first-run and the Settings replay row).
 *  First-run is gated on the launch toast flow finishing (see App.svelte), so the
 *  tour never overlaps the no-warranty / Open Data toasts. */
export function startTour(): void {
  tourActive.set(true);
  void applyStep(0);
}

export function nextStep(): void {
  const i = get(tourStep);
  if (i + 1 >= TOUR_STEPS.length) { endTour(); return; }
  void applyStep(i + 1);
}

export function prevStep(): void {
  const i = get(tourStep);
  if (i > 0) void applyStep(i - 1);
}

/** Finish or skip: mark seen, close, and return to a clean search screen. */
export function endTour(): void {
  markSeen();
  tourActive.set(false);
  resetNav();
  activeTab.set('search');
}

let firstRunChecked = false;
/**
 * Start the tour once, on first ever launch, after the app is usable. Safe to
 * call repeatedly (guarded); no-op if the current tour version was already seen.
 */
export function maybeStartFirstRun(): void {
  if (firstRunChecked) return;
  firstRunChecked = true;
  if (hasSeenCurrent()) return;
  startTour();
}
