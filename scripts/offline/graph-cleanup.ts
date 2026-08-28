#!/usr/bin/env npx tsx
/**
 * Find the damage in a graph built by an earlier, worse extractor. SCRIPT TIER — no model.
 *
 * Matt, 2026-08-28: "Lets clean up this very messy graph. It did not have good extractions
 * throughout." He is right, and the mess is specific rather than general — worth measuring before
 * anybody starts editing.
 *
 * WHAT IT LOOKS FOR, and why each is checkable by a rule:
 *
 *   COLLAPSED     an entity whose slug is a whole proposition — `orange-logic-is-an-enterprise-dam`.
 *                 The relation the sentence stated was never extracted; it became part of a NAME.
 *                 rdf/triple-shape.ts now rejects these at the door, so every one still in a graph
 *                 predates that guard.
 *   MISHEARD      two entities whose names are lexically near-identical — `matthew-roe` against
 *                 `matthew-rowe`. On a dictated graph this is almost always one thing the speech
 *                 model heard two ways, and embeddings cannot catch it: a misspelling has no
 *                 semantics to embed (rdf/vocabulary-repair.ts).
 *   ORPHANED      an entity mentioned exactly once, connecting nothing. Not automatically wrong —
 *                 a graph has leaves — but a pile of them is what a bad extraction run looks like.
 *
 * THE FIX FOR A COLLAPSED ENTITY IS RE-EXTRACTION, NOT REPAIR, and this script will not offer to
 * split one. triple-shape.ts already argued the point: splitting on the verb would be inventing a
 * fact from a parse, and the model's failure would silently become the graph's content. The
 * dictated note is kept VERBATIM precisely so a reading can be redone — and the pipeline is
 * materially better than the one that produced these (shape rejection, entity typing, instruction
 * routing all postdate them). So the proposal is always "re-extract this note", never "rewrite
 * this fact".
 *
 * IT CHANGES NOTHING. Findings print, and with --pending they queue for review like every other
 * proposal. A cleanup tool that edits a personal graph unattended is the last thing this product
 * should ship.
 *
 * Usage:
 *   npx tsx scripts/offline/graph-cleanup.ts <graph.ttl>
 *   npx tsx scripts/offline/graph-cleanup.ts <graph.ttl> --pending    queue findings for review
 */
import { readFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';
import { looksLikeProposition } from '../../src/lib/rdf/triple-shape.js';
import { editDistance, phoneticKey } from '../../src/lib/rdf/vocabulary-repair.js';

const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const files = argv.filter((a) => !a.startsWith('--'));
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const CONCEPT = 'urn:kbase:concept/';
const EXTRACTED_FROM = 'urn:kbase:predicate/extracted-from';
const CAPTURED_NOTE = 'urn:kbase:predicate/captured-note';
const RDF_TYPE = `${RDF}type`;
const DOCUMENT_TYPE = 'urn:kbase:type/Document';

/** Reification and source bookkeeping — the app folds these into fields, so they are not content. */
const isBookkeeping = (p: string, o: string) =>
  p.startsWith('urn:kbase:meta/') ||
  p === `${RDF}subject` || p === `${RDF}predicate` || p === `${RDF}object` ||
  (p === `${RDF}type` && o === `${RDF}Statement`);

const slugOf = (iri: string) => iri.split('/').pop() ?? iri;
const words = (iri: string) => slugOf(iri).replace(/[-_]+/g, ' ');

export type Finding = {
  kind: 'collapsed' | 'misheard' | 'orphaned' | 'untyped-note';
  entity: string;
  detail: string;
  /** The dictated note this entity was read out of, when the graph records one. */
  note?: string;
};

export function analyse(quads: Quad[]): { findings: Finding[]; facts: number; entities: number } {
  const content = quads.filter((q) => !isBookkeeping(q.predicate.value, q.object.value));

  const entities = new Set<string>();
  const degree = new Map<string, number>();
  const noteOf = new Map<string, string>();
  for (const q of content) {
    for (const t of [q.subject, q.object]) {
      if (t.termType !== 'NamedNode') continue;
      entities.add(t.value);
      degree.set(t.value, (degree.get(t.value) ?? 0) + 1);
    }
    if (q.predicate.value === EXTRACTED_FROM) noteOf.set(q.subject.value, q.object.value);
  }

  const concepts = [...entities].filter((e) => e.startsWith(CONCEPT));
  const findings: Finding[] = [];

  for (const e of concepts) {
    if (looksLikeProposition(words(e))) {
      findings.push({
        kind: 'collapsed',
        entity: e,
        detail: 'the whole proposition became the entity NAME, so the relation it states was never extracted',
        note: noteOf.get(e),
      });
    }
  }

  // Near-identical names. Compared on the SLUG, because that is what the extractor minted from
  // the transcript and where a mis-hearing shows up even when no label was produced.
  //
  // CLOCK-DERIVED NAMES ARE EXCLUDED, and leaving them in produced 45 findings of which 45 were
  // noise. `note-2026-08-27T16-56-41-444Z` and `note-2026-08-27T18-31-51-202Z` have the same
  // phonetic key because phoneticKey drops digits — so every note matched every other note. Those
  // IRIs are minted from the clock BY DESIGN (captured-notes.ts: naming a note from a transcript
  // would mint an entity out of a possibly-misheard proper noun), so they cannot be mis-heard and
  // have no business in a mis-hearing check. A detector that floods the queue is worse than none:
  // it moves cost from extraction to triage, which is exactly what the work-tiering rule forbids.
  const nameable = concepts.filter((e) => {
    const slug = slugOf(e);
    if (/^note-\d{4}-\d{2}-\d{2}T/.test(slug)) return false;       // clock-derived
    const letters = slug.replace(/[^a-z]/gi, '');
    return letters.length >= 4;                                      // needs real words to compare
  });

  const seen = new Set<string>();
  for (let i = 0; i < nameable.length; i++) {
    for (let j = i + 1; j < nameable.length; j++) {
      const a = slugOf(nameable[i]);
      const b = slugOf(nameable[j]);
      if (Math.abs(a.length - b.length) > 3) continue;
      const distance = editDistance(a, b);
      // Two independent signals, as vocabulary-repair argues: a small edit distance OR the same
      // phonetic key. A mis-hearing is often further than two characters ("roes" / "rowe") while
      // still sounding identical, and spelling alone would miss it.
      const sounds = phoneticKey(a) === phoneticKey(b);
      if (distance === 0 || (distance > 2 && !sounds)) continue;
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        kind: 'misheard',
        entity: nameable[i],
        detail: sounds && distance > 2
          ? `sounds identical to "${b}" — likely one thing heard two ways`
          : `${distance} character${distance === 1 ? '' : 's'} from "${b}"${sounds ? ', and sounds the same' : ''} — likely one thing heard two ways`,
        note: noteOf.get(nameable[i]) ?? noteOf.get(nameable[j]),
      });
    }
  }

  // UNTYPED NOTES. The capture path minted these before it knew how to type them, and a note is a
  // Document (Matt, 2026-08-28). This is the one type nobody has to infer, so proposing it costs
  // no model call and settles the largest single group of untyped entities in a captured graph.
  const notes = new Set<string>();
  const typed = new Set<string>();
  for (const q of content) {
    if (q.predicate.value === CAPTURED_NOTE) notes.add(q.subject.value);
    if (q.predicate.value === RDF_TYPE) typed.add(q.subject.value);
  }
  for (const note of notes) {
    if (typed.has(note)) continue;
    findings.push({
      kind: 'untyped-note',
      entity: note,
      detail: 'a captured note with no rdf:type — it is a Document, and the pipeline knows it',
    });
  }

  for (const e of concepts) {
    if ((degree.get(e) ?? 0) <= 1) {
      findings.push({ kind: 'orphaned', entity: e, detail: 'mentioned once, connects nothing', note: noteOf.get(e) });
    }
  }

  return { findings, facts: content.length, entities: entities.size };
}

/** A finding as a pending row. Always a re-extraction proposal — never a rewrite. */
export function toPendingRow(f: Finding, kb: string): Record<string, unknown> {
  if (f.kind === 'untyped-note') {
    return {
      subject: f.entity,
      predicate: RDF_TYPE,
      object: DOCUMENT_TYPE,
      objectKind: 'iri',
      kb,
      type: 'suggestion',
      priority: 'low',
      agent: 'graph-cleanup',
      note: 'Backfill: the capture path now types notes as Document at extraction time. This proposes the same for notes minted before it did.',
    };
  }
  const object = f.note
    ? `Re-extract ${f.note.split('/').pop()} — ${f.detail}`
    : `Review ${slugOf(f.entity)} — ${f.detail}`;
  return {
    subject: f.entity,
    predicate: 'urn:kbase:predicate/known-issue',
    object,
    objectKind: 'literal',
    kb,
    type: f.kind === 'orphaned' ? 'observation' : 'suggestion',
    priority: f.kind === 'collapsed' ? 'high' : 'normal',
    agent: 'graph-cleanup',
    note:
      'The dictated note is kept verbatim, so the fix is to RE-EXTRACT it with the current ' +
      'pipeline — not to rewrite this fact. Splitting a collapsed entity on its verb would ' +
      'invent a fact from a parse.',
  };
}

function main(): void {
  if (files.length === 0) {
    console.error('Usage: graph-cleanup.ts <graph.ttl> [--pending]');
    process.exit(2);
  }
  let queued = 0;

  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`  ! ${file} does not exist`);
      continue;
    }
    const quads = new Parser().parse(readFileSync(file, 'utf8')) as Quad[];
    const { findings, facts, entities } = analyse(quads);
    const kb = path.basename(file, '.ttl');

    console.log(`\n\x1b[1m${file}\x1b[0m  ${facts} content facts · ${entities} entities`);
    const byKind = (k: Finding['kind']) => findings.filter((f) => f.kind === k);

    for (const kind of ['collapsed', 'misheard', 'untyped-note', 'orphaned'] as const) {
      const group = byKind(kind);
      if (group.length === 0) continue;
      console.log(`\n  ${kind.toUpperCase()} (${group.length})`);
      for (const f of group.slice(0, 10)) {
        console.log(`    ${slugOf(f.entity)}`);
        console.log(`      ${f.detail}`);
        if (f.note) console.log(`      from note ${slugOf(f.note)}`);
      }
      if (group.length > 10) console.log(`    … and ${group.length - 10} more`);
    }

    if (findings.length === 0) console.log('  nothing to clean up.');

    if (PENDING_OUT && findings.length > 0) {
      // Orphans are reported but NOT queued: a leaf is not a defect, and filling a review queue
      // with them is how the two real findings get skipped.
      const rows = findings.filter((f) => f.kind !== 'orphaned').map((f) => toPendingRow(f, kb));
      if (rows.length > 0) {
        appendFileSync(PENDING, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        queued += rows.length;
      }
    }
  }

  if (PENDING_OUT) console.log(`\nQueued ${queued} finding(s) for review (orphans reported, not queued).`);
  else console.log('\nReport only. Pass --pending to queue the real findings for review.');
}

if (process.argv[1] && process.argv[1].endsWith('graph-cleanup.ts')) main();
