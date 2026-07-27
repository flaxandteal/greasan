// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer catalogue loader — reads the `layer-v2` META head (one Layer resource
// per data layer in the stack) for the layer UI. Queried standalone via
// layerCatalogueHeadDir(); never composed into the lexical/place stack.
import { queryV2, hydrateV2 } from './v2';
import { layerCatalogueHeadDir } from './dictionary';

export interface LayerLink { title: string; url: string; type: string }
export interface LayerDownload { format: string; url: string; notes: string }
export interface LayerEntry {
  resourceId: string;
  name: string;
  slug: string;
  icon: string;
  types: string[];
  formats: string[];
  licence: string;
  attribution: string;
  descriptionType: string;
  description: string;
  links: LayerLink[];
  resourceCount: string;
  statistics: Record<string, unknown> | null;
  integrationSlug: string;
  defaultOn: boolean;
  swatch: string;
  config: Record<string, unknown> | null;
  downloads: LayerDownload[];
}

/** A localized/plain string value from a hydrated tree (mirrors exLocalStr). */
function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, any>;
    for (const c of [o.en, o.ga, ...Object.values(o)]) {
      if (c && typeof c === 'object' && typeof c.value === 'string') return c.value;
    }
    if (typeof o.value === 'string') return o.value;
    if (typeof o.label === 'string') return o.label;
  }
  return '';
}

/** A single reference (ex-concept) label. ros-madair now renders references to
 * labels during hydrate (alizarin datatype handlers + the head's vocab), so the
 * value arrives as a plain label string — no frontend closure needed. */
function refLabel(v: unknown): string {
  return str(v);
}

/** A reference-list field → its labels. The engine renders a list either as an
 * array of labels or a `", "`-joined display string; handle both. */
function refList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  if (!s) return [];
  return s.includes(', ') ? s.split(', ').filter(Boolean) : [s];
}

function asArray(v: unknown): any[] { return Array.isArray(v) ? v : v == null ? [] : [v]; }
function parseJson(v: unknown): Record<string, unknown> | null {
  const s = str(v);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function toEntry(id: string, tree: any): LayerEntry {
  const t = tree || {};
  const lic = t.licensing || {};
  const desc = t.description || {};
  const st = t.statistics || {};
  const integ = t.integration || {};
  const links = asArray(t.links)
    .map((l: any) => ({ title: str(l?.link_title), url: str(l?.link_url), type: refLabel(l?.link_type) }))
    .filter((l) => l.title || l.url);
  const downloads = asArray(integ.download)
    .map((d: any) => ({ format: refLabel(d?.download_format), url: str(d?.download_url), notes: str(d?.download_notes) }))
    .filter((d) => d.format || d.notes);
  return {
    resourceId: id,
    name: str(t.name), slug: str(t.slug), icon: str(t.icon),
    types: refList(t.layer_type), formats: refList(t.layer_format),
    licence: refLabel(lic.licence), attribution: str(lic.attribution),
    descriptionType: refLabel(desc.description_type), description: str(desc.description_text),
    links,
    resourceCount: str(st.resource_count),
    statistics: parseJson(st.statistics_block),
    integrationSlug: str(integ.integration_slug),
    defaultOn: str(integ.default_on).toLowerCase() === 'true',
    swatch: str(integ.swatch),
    config: parseJson(integ.config_block),
    downloads,
  };
}

/** All Layer resources in the catalogue, by display name. Empty if not installed. */
export async function loadLayerCatalogue(): Promise<LayerEntry[]> {
  const head = layerCatalogueHeadDir();
  if (!head) return [];
  let ids: string[] = [];
  try {
    const results = await queryV2(head, { model: 'Layer', measures: ['select_ids'], limit: 200 });
    const r = results.find((x) => x.measure === 'select_ids');
    ids = (r?.rows || []).map((row) => String(row[0])).filter(Boolean);
  } catch (e) { console.warn('[layers] catalogue query failed:', e); return []; }
  const entries = await Promise.all(ids.map(async (id) => {
    try { return toEntry(id, await hydrateV2(head, id)); }
    catch (e) { console.warn('[layers] hydrate failed:', id, e); return null; }
  }));
  return entries.filter((e): e is LayerEntry => !!e).sort((a, b) => a.name.localeCompare(b.name));
}

/** One Layer by its slug (or by its layer-registry name — they match). */
export async function loadLayerBySlug(slug: string): Promise<LayerEntry | null> {
  const all = await loadLayerCatalogue();
  return all.find((l) => l.slug === slug || l.integrationSlug === slug || l.integrationSlug === `${slug}-v2`) || null;
}
