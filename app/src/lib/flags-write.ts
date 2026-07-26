// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The flag/note WRITE path — the app's first on-device write. Mirrors exactly the
// host test (build-flag-layers → note head), minus NAPI: build the note
// `business_data` via alizarin (WASM in the webview), then hand it to the Rust
// `v2_emit_overlay` command, which re-emits the note-v2 head in place. It drops
// straight back into the composed read stack (cited_by('subject')).
//
// localStorage is the editable source of truth (the head only stores un-reversible
// UUIDs, so we can't recover a note's ResourceID from it); the head is derived
// from it on every write.
import { invoke } from '@tauri-apps/api/core';
import {
  buildGraphFromModelCsvs,
  buildResourcesFromBusinessCsv,
  createResourceRegistry,
  parseStaticGraph,
} from 'alizarin';
import { currentV2HeadDirs } from './dictionary';

const NS = 'https://flaxandteal.org/ontology/goidelic#';
const NOTE_GRAPH_ID = '82ac04ef-31d6-5824-97b5-29459c4acc2c';
const NOTE_LAYER_NS = 'ad5d6eb7-6d5b-5c97-abee-417d968f6da7'; // uuidv5('layer/note', ALIZARIN_NS)
/** The single seeded Person the app writes notes as. */
export const USER_UUID = '982346ec-9b51-510b-b4a9-47cee0f5bc2d';
const BAILE_UUID = '6478617d-74c7-5471-aa79-4de8aee53e74';

// The Note model, inlined (must match models/note/*.csv so the graph_id matches
// the bundled head).
const NOTE_GRAPH_CSV = `name,ontology_class,author,description,is_resource
Note,http://www.w3.org/ns/oa#Annotation,,A user note/flag attached to one or more resources,true
`;
const NOTE_NODES_CSV = `parent_alias,alias,name,datatype,cardinality,ontology_class,parent_property,description,collection_name,required,searchable,exportable,sortorder
,description,Description,string,1,http://www.w3.org/ns/oa#bodyValue,http://www.w3.org/ns/oa#bodyValue,The note text (the resource descriptor),,true,true,true,1
,subject,Subject,resource-instance-list,n,http://www.w3.org/ns/oa#hasTarget,http://www.w3.org/ns/oa#hasTarget,The flagged resource(s) this note is about,,false,false,true,2
,author,Author,resource-instance,1,http://purl.org/dc/terms/creator,http://purl.org/dc/terms/creator,The Person who created the note,,false,false,true,3
`;
const NOTE_COLL_CSV = `collection_name,concept_label,parent_label,sort_order
`;

export type SubjectKind = 'entry' | 'example' | 'place';

export interface NoteRec {
  rid: string;
  description: string;
  subject: string[];
  author: string;
  // Denormalized subject context (localStorage only — not emitted to the head),
  // captured at flag-time so the all-flags page can render + navigate without a
  // per-note lookup.
  subjectName?: string;
  subjectGraph?: string;
  subjectKind?: SubjectKind;
}

export interface FlagMeta {
  name?: string;
  graph?: string;
  kind?: SubjectKind;
}

const STORE_KEY = 'ge-flags-v1';

/** All notes (source of truth). Seeded with the sample flag on first run. */
export function loadNotes(): NoteRec[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as NoteRec[];
  } catch { /* fall through to seed */ }
  return [
    {
      rid: 'note-sample-1',
      description: 'Sampla nóta don bhaile · sample flag',
      subject: [BAILE_UUID],
      author: USER_UUID,
      subjectName: 'baile',
      subjectGraph: 'Ceannfhocal · Headword',
      subjectKind: 'entry',
    },
  ];
}

function persist(notes: NoteRec[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(notes));
}

/** Notes attached to one resource (for the flag button). */
export function notesFor(uri: string): NoteRec[] {
  return loadNotes().filter((n) => n.subject.includes(uri));
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** Build the `{business_data:{resources}}` JSON the emit command consumes. */
function buildBusinessData(notes: NoteRec[]): string {
  const { graph, collections } = buildGraphFromModelCsvs(NOTE_GRAPH_CSV, NOTE_NODES_CSV, NS, NOTE_COLL_CSV);
  const rows = notes.map((n) =>
    [n.rid, n.description, n.subject.join(','), n.author].map(csvEscape).join(','),
  );
  const csv = 'ResourceID,description,subject,author\n' + rows.join('\n') + '\n';
  const result: any = buildResourcesFromBusinessCsv(csv, graph, collections, 'en', false, NOTE_LAYER_NS);
  const resources = result?.business_data?.resources || [];
  const typedGraph: any = parseStaticGraph(JSON.stringify({ graph: [graph] }));
  typedGraph.setDescriptorTemplate('name', '<Description>');
  const registry: any = createResourceRegistry();
  registry.mergeFromResourcesJson(JSON.stringify(resources), true, true);
  const enriched = registry.populateCachesFromJson(JSON.stringify(resources), typedGraph, true, false, true).resources || resources;
  return JSON.stringify({ business_data: { resources: enriched } });
}

/** The full note `business_data` JSON (what the head is emitted from) — for export. */
export function exportBusinessData(): string {
  return buildBusinessData(loadNotes());
}

/** Re-emit the note head from the full note list. */
async function rebuild(notes: NoteRec[]): Promise<void> {
  const noteHead = currentV2HeadDirs().find((d) => d.includes('/note-v2'));
  if (!noteHead) throw new Error('note head not found in the layer stack');
  const businessDataJson = buildBusinessData(notes);
  await invoke('v2_emit_overlay', { headDir: noteHead, graphId: NOTE_GRAPH_ID, businessDataJson });
}

/** Flag a resource with a note. */
export async function addFlag(subjectUri: string, text: string, meta: FlagMeta = {}): Promise<void> {
  const notes = loadNotes();
  notes.push({
    rid: 'note-' + crypto.randomUUID(),
    description: text,
    subject: [subjectUri],
    author: USER_UUID,
    subjectName: meta.name,
    subjectGraph: meta.graph,
    subjectKind: meta.kind,
  });
  persist(notes);
  await rebuild(notes);
}

/** Edit a note's text. */
export async function editFlag(rid: string, text: string): Promise<void> {
  const notes = loadNotes().map((n) => (n.rid === rid ? { ...n, description: text } : n));
  persist(notes);
  await rebuild(notes);
}

/** Delete a note. */
export async function deleteFlag(rid: string): Promise<void> {
  const notes = loadNotes().filter((n) => n.rid !== rid);
  persist(notes);
  await rebuild(notes);
}
