import { validateModelCsvs, buildGraphFromModelCsvs, initWasm } from '../app/node_modules/alizarin/dist/alizarin.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsDir = resolve(__dirname, '../models/lexical_entry');

await initWasm();

const graphCsv = readFileSync(resolve(modelsDir, 'graph.csv'), 'utf8');
const nodesCsv = readFileSync(resolve(modelsDir, 'nodes.csv'), 'utf8');
const collectionsCsv = readFileSync(resolve(modelsDir, 'collections.csv'), 'utf8');

console.log('Validating model CSVs...');
const diags = validateModelCsvs(graphCsv, nodesCsv, collectionsCsv);
const errors = (diags || []).filter(d => d.level === 'Error');
const warnings = (diags || []).filter(d => d.level === 'Warning');
if (warnings.length > 0) {
  console.log(`${warnings.length} warnings (non-CIDOC URIs expected for OntoLex model)`);
}
if (errors.length > 0) {
  console.log('ERRORS:', JSON.stringify(errors, null, 2));
  process.exit(1);
}

console.log('Validation passed. Building graph...');
const result = buildGraphFromModelCsvs(graphCsv, nodesCsv, 'https://flaxandteal.org/ontology/ga-wiktionary#', collectionsCsv);
console.log('Build succeeded.');
console.log('Result keys:', Object.keys(result));
if (result.graph) {
  const g = typeof result.graph === 'string' ? JSON.parse(result.graph) : result.graph;
  console.log('Graph name:', g.name || g.graph_id || '(unknown)');
}
if (result.collections) {
  const c = typeof result.collections === 'string' ? JSON.parse(result.collections) : result.collections;
  console.log('Collections count:', Array.isArray(c) ? c.length : Object.keys(c).length);
}
