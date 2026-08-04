// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Build a NapiRdmCache from a collections array (the SKOS reference data), to pass
// into buildResourcesFromBusinessCsv. Serialization then resolves concept/reference
// labels through the SAME identity the read side (v2_closure / hydrate vocab)
// resolves back — one concept identity, no parallel minting. See the
// reference-rdmcache-architecture note.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export function makeRdmCache(collections, root, usingNapi) {
  if (!usingNapi) return null;
  const napi = createRequire(resolve(root, 'app/package.json'))('@alizarin/napi');
  const cache = new napi.NapiRdmCache();
  for (const collection of collections) {
    const cid = collection.collectionid || collection.id;
    if (!cid) continue;
    const concepts = Object.values(collection.__allConcepts || {}).map((c) => ({
      id: c.id,
      prefLabels: c.prefLabels || {},
      broader: c.broader || [],
      narrower: (c.children || []).map((ch) => ch.id || ch),
    }));
    cache.addCollectionFromJson(cid, JSON.stringify(concepts));
  }
  return cache;
}
