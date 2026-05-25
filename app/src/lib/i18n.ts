import { writable, derived, type Readable } from 'svelte/store';
import ga from './locales/ga';
import en from './locales/en';

const locales: Record<string, Record<string, string>> = { ga, en };

/** Persisted locale store (default 'ga'). */
function createLocaleStore() {
  let initial = 'ga';
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem('ge:locale');
      if (raw !== null) initial = JSON.parse(raw);
    } catch { /* corrupt — use default */ }
  }
  const store = writable<string>(initial);
  store.subscribe(v => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('ge:locale', JSON.stringify(v));
    }
  });
  return store;
}

export const locale = createLocaleStore();

/**
 * Reactive translation function.
 *
 * Usage in Svelte components: `$t('key')` or `$t('key', { count: 5 })`
 *
 * Fallback chain: requested locale → ga → key itself.
 */
export const t: Readable<(key: string, vars?: Record<string, string | number>) => string> = derived(
  locale,
  ($locale) => {
    return (key: string, vars?: Record<string, string | number>): string => {
      let str = locales[$locale]?.[key] ?? locales.ga[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(`{${k}}`, String(v));
        }
      }
      return str;
    };
  },
);
