import { writable, derived, type Readable, type Writable } from 'svelte/store';
import ga from './locales/ga';
import en from './locales/en';

/** The UI languages that exist, in menu order. */
export type Locale = 'ga' | 'en';
export const SUPPORTED_LOCALES: readonly Locale[] = ['ga', 'en'];

/** Language choice: 'system' follows the device; 'ga'/'en' force one. */
export type LocalePreference = 'system' | Locale;

// `en` is the canonical, complete locale; `ga` is a (currently partial) overlay.
// A key absent from the active locale falls back to `en`, then to the key itself.
const locales: Record<Locale, Record<string, string>> = { ga, en };

/** Minimal localStorage-backed writable (mirrors store.ts's `persisted`, kept
 *  local so i18n has no dependency on the app store). */
function persisted<T>(key: string, initial: T): Writable<T> {
  let value = initial;
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) value = JSON.parse(raw);
    } catch { /* corrupt - use default */ }
  }
  const store = writable<T>(value);
  store.subscribe(v => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(v));
  });
  return store;
}

/** Resolve the device language to a supported UI locale (English default). */
function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const lang = l?.toLowerCase() ?? '';
    if (lang.startsWith('ga')) return 'ga';
    if (lang.startsWith('en')) return 'en';
  }
  return 'en';
}

/** One-time migration of the old bare `ge:locale` ('ga'|'en') to an explicit
 *  preference, so existing installs keep the language they were using. */
function migrateLegacyPreference(): LocalePreference {
  if (typeof localStorage === 'undefined') return 'system';
  try {
    const raw = localStorage.getItem('ge:locale');
    if (raw !== null) {
      const v = JSON.parse(raw);
      if (v === 'ga' || v === 'en') return v;
    }
  } catch { /* ignore */ }
  return 'system';
}

/**
 * The user's language setting. Persisted; bound to the Settings picker.
 * Default 'system' follows the device (via {@link detectSystemLocale}).
 */
export const localePreference = persisted<LocalePreference>('ge:localePref', migrateLegacyPreference());

/** The effective locale that {@link t} renders in. Read-only - set the
 *  preference, not this. */
export const locale: Readable<Locale> = derived(localePreference, ($pref) =>
  $pref === 'system' ? detectSystemLocale() : $pref,
);

// Dev-only: warn once per key that resolves nowhere, so new hardcoded-string
// regressions and typo'd keys surface during development.
const warnedKeys = new Set<string>();

/**
 * Reactive translation function.
 *
 * Usage in Svelte components: `$t('key')` or `$t('key', { count: 5 })`
 *
 * Fallback chain: active locale → en → key itself. `en` is canonical, so a
 * not-yet-translated `ga` key shows English rather than a raw key.
 */
export const t: Readable<(key: string, vars?: Record<string, string | number>) => string> = derived(
  locale,
  ($locale) => {
    return (key: string, vars?: Record<string, string | number>): string => {
      let str = locales[$locale]?.[key] ?? locales.en[key];
      if (str === undefined) {
        if (import.meta.env.DEV && !warnedKeys.has(key)) {
          warnedKeys.add(key);
          console.warn(`[i18n] missing key (no ${$locale} or en translation): ${key}`);
        }
        str = key;
      }
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(`{${k}}`, String(v));
        }
      }
      return str;
    };
  },
);
