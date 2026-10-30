// Golden-vector guard for the goi- CONCEPT slug identity (JS side). The same
// `concept` vectors are asserted by the Rust `concept_id_tests` (builder_plugin.rs),
// so the on-device Téarma concept ids and the JS-built corpus concept ids can't
// silently diverge. The ENTRY family is guarded by tests/test_slug_identity.py +
// the Rust tbx_parser tests.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeHead, conceptResourceId } from '../../../scripts/lib/slug-identity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(resolve(here, '../../../tests/fixtures/slug-golden.json'), 'utf8'),
);

describe('goi concept slug identity (golden)', () => {
  it('normalizeHead matches golden', () => {
    for (const v of golden.concept.normalize_head) {
      expect(normalizeHead(v.in)).toBe(v.out);
    }
  });

  it('conceptResourceId matches golden', () => {
    for (const v of golden.concept.concept_resource_id) {
      expect(conceptResourceId(v.headword)).toBe(v.out);
    }
  });
});
