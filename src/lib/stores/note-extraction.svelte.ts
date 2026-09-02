/**
 * Running dictated notes through the ordinary ingest pipeline.
 *
 * THIS ADDS NO EXTRACTION OF ITS OWN. Everything downstream already exists and is already
 * vocabulary-grounded: `ingest({ kind: 'note' })` extracts, `buildVocabularySection` primes the
 * model with the slugs this graph already uses, `normalizeEntities` remaps near-duplicates by
 * embedding, and every result lands pending. What was missing was only the TRIGGER - nothing ever
 * turned a `kpred:captured-note` blob into a call to that pipeline.
 *
 * WHY THE APP AND NOT n8n. Extraction is core state, and n8n owns web side-effects rather than
 * core state (see the integration-boundaries rule). It also cannot see the graph, and grounding
 * extraction in the vocabulary the graph already holds is the entire mechanism that makes a
 * dictated "Recon's AI" resolve to the entity you already have. Doing it here also keeps every
 * dictated personal note on the machine that owns it.
 */

import { v4 as uuid } from 'uuid';
import { ingest } from './ingest.svelte';
import { statements as allStatements, addStatements, setStatus } from './kb.svelte';
import {
  findUnextractedNotes,
  noteTitle,
  buildExtractionMarker,
  buildNoteType,
  buildProvenanceLinks,
  buildRepairProposals,
  buildTaskProposals,
  rejectionKey,
  type CapturedNote,
} from '../rdf/captured-notes';
import { readNote } from '../rdf/note-intent';
import { buildVocabulary, type VocabularyEntry } from '../rdf/vocabulary-repair';
import { shouldAutoTrust } from '../rdf/auto-trust';
import { SKOS_ALT_LABEL } from '../rdf/merge-aliases';
import type { Statement } from '../rdf/types';

export type NoteExtractionOutcome = {
  note: CapturedNote;
  /** Triples the extractor proposed from this sentence. */
  extracted: number;
  /** Mis-heard names proposed as pending skos:altLabel. */
  repairs: number;
  /** Sentences read as a request for work and proposed as tasks instead of facts. */
  tasks: number;
  /** True when the whole note was an instruction, so no extraction call was made at all. */
  skippedExtraction?: boolean;
  /** Set when this note failed; the note is left UNMARKED so it can be retried. */
  error?: string;
};

export type NoteExtractionResult = {
  processed: number;
  extracted: number;
  repairs: number;
  tasks: number;
  failures: number;
  outcomes: NoteExtractionOutcome[];
};

/** Aliases the user has already turned down, so a settled question is never asked twice. */
function rejectedAliases(statements: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of statements) {
    if (s.p.value !== SKOS_ALT_LABEL || s.status !== 'rejected') continue;
    if (s.s.kind !== 'iri' || s.o.kind !== 'literal') continue;
    out.add(rejectionKey(s.s.value, s.o.value));
  }
  return out;
}

/**
 * Extract every captured note that has not been extracted yet.
 *
 * ONE NOTE AT A TIME, AND A FAILURE IS NOT FATAL. Each note is its own extraction: a model that
 * chokes on one sentence must not strand the others, and the failed note is deliberately left
 * WITHOUT its extraction marker so the next run retries it. Reporting a failure is the point -
 * a capture path that silently drops a note is worse than one that visibly fails.
 */
export async function extractCapturedNotes(
  options: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<NoteExtractionResult> {
  const existing = allStatements();
  const pending = findUnextractedNotes(existing);
  const notes = options.limit ? pending.slice(0, options.limit) : pending;

  const result: NoteExtractionResult = {
    processed: 0,
    extracted: 0,
    repairs: 0,
    tasks: 0,
    failures: 0,
    outcomes: [],
  };
  if (notes.length === 0) return result;

  // Built ONCE from the graph as it stands before this batch. Rebuilding per note would let one
  // note's unreviewed proposals become the vocabulary the next note is matched against, which is
  // how a single mis-hearing propagates into a convention.
  const vocabulary: VocabularyEntry[] = buildVocabulary(existing);
  const rejected = rejectedAliases(existing);

  for (const note of notes) {
    const outcome: NoteExtractionOutcome = { note, extracted: 0, repairs: 0, tasks: 0 };
    try {
      // ROUTE BEFORE EXTRACTING. A sentence that asks for work asserts nothing, so sending it to a
      // machine whose only output is assertions produces invented facts and loses the request.
      // The split is deterministic and free (rdf/note-intent.ts), and it runs first so a note that
      // is wholly an instruction costs no model call at all.
      const reading = readNote(note.text);

      // The extractor sees only the prose. When ambiguous sentences exist they appear on BOTH
      // sides on purpose - two pending proposals for a human to choose between, rather than one
      // silent decision by a regex.
      let extracted: Statement[] = [];
      let tmpl = { g: note.statement.g, sourceId: note.statement.sourceId };

      if (reading.factText) {
        const run = await ingest({ kind: 'note', title: noteTitle(note), body: reading.factText });
        if (run.phase !== 'done') {
          outcome.error = `ingest ${run.phase}`;
          result.failures++;
          result.outcomes.push(outcome);
          continue;
        }
        extracted = run.statements;
        // ingest() has already persisted the extracted statements and their source. What remains
        // is the bookkeeping that ties them to the sentence, and the vocabulary questions they
        // raise.
        //
        // The bookkeeping rides in the SAME named graph as the extraction, falling back to the
        // note's own graph when nothing was extracted - a marker in a different graph than the
        // facts it describes would be invisible to the next `findUnextractedNotes`.
        tmpl = { g: run.statements[0]?.g ?? note.statement.g, sourceId: run.source.id };
      } else {
        outcome.skippedExtraction = true;
      }

      const marker = buildExtractionMarker(note, tmpl, uuid);
      // The note is a Document, and the pipeline knows it — no model is asked.
      const noteType = buildNoteType(note, tmpl, uuid);
      const links = buildProvenanceLinks(note, extracted, tmpl, uuid);
      const tasks = buildTaskProposals(note, reading.tasks, tmpl, uuid);
      // Repair reads only the EXTRACTED statements. A task's goal is a whole verbatim sentence
      // rather than a name, and running the lexical matcher over one would propose an alias for a
      // paragraph - noise, in the queue that can least afford it.
      const proposals = buildRepairProposals(extracted, vocabulary, tmpl, uuid, {
        alreadyRejected: rejected,
      });

      // Keep this batch from re-proposing the same alias on the next note in the loop.
      for (const p of proposals) rejected.add(rejectionKey(p.candidate.iri, p.statement.o.value));

      await addStatements(
        [
          marker,
          noteType,
          ...links,
          ...tasks.flatMap((t) => t.statements),
          ...proposals.map((p) => p.statement),
        ],
        tmpl.sourceId,
      );

      // The note itself is a LOG once it has been read: it asserts only that a sentence was said
      // at a time, and the person who would be asked to confirm it is the person who said it.
      // Leaving it pending would put an unanswerable question at the top of the queue, above the
      // extracted facts that actually need a human. Settled only AFTER extraction succeeded, so a
      // note that failed to extract stays visible as outstanding work.
      if (shouldAutoTrust(note.statement) && note.statement.status === 'pending') {
        await setStatus(note.statement.id, 'confirmed');
      }

      outcome.extracted = extracted.length;
      outcome.repairs = proposals.length;
      outcome.tasks = tasks.length;
      result.extracted += outcome.extracted;
      result.repairs += outcome.repairs;
      result.tasks += outcome.tasks;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
      result.failures++;
    }
    result.processed++;
    result.outcomes.push(outcome);
    options.onProgress?.(result.processed, notes.length);
  }

  return result;
}

/** How many dictated notes are waiting to be extracted right now. */
export function unextractedNoteCount(): number {
  return findUnextractedNotes(allStatements()).length;
}
