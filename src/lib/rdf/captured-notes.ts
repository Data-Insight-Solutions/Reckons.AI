/**
 * Turning a dictated note into a graph.
 *
 * WHAT ARRIVES AND WHY IT IS NOT ENOUGH. The capture path (ring to MCP to n8n to pending.jsonl)
 * deposits exactly ONE fact per note:
 *
 *   <urn:kbase:concept/note-2026-08-27T16-56-41-444Z>  kpred:captured-note  "I have a new idea..."
 *
 * That is a note ABOUT having taken a note - a blob with a timestamp for a name, no entities and
 * no relations. The subject is derived from the clock rather than the words on purpose: naming it
 * from a transcript would mint an entity out of a possibly-misheard proper noun before any human
 * saw it. Extraction is what makes it safe to name things, because everything it proposes lands
 * as PENDING and a person settles it.
 *
 * THE VERBATIM NOTE IS NEVER REPLACED. Extraction ADDS triples beside the original statement and
 * links them back to it. What was said is the record; what it meant is a reading, and a reading
 * can be wrong and re-run. Deleting the source sentence to keep only the interpretation would
 * throw away the only thing we know for certain.
 *
 * REPAIR PROPOSES VOCABULARY, IT DOES NOT REWRITE FACTS. When a transcript says "Recon's AI" and
 * the graph already holds "Reckons.AI", this module proposes a pending skos:altLabel - it does not
 * silently rewrite the triple. Remapping an entity by MEANING is normalizeEntities' job and runs
 * on embeddings; this is the lexical tier, and its output is a vocabulary suggestion a human
 * accepts once. Accepting it makes every future mis-hearing an exact match rather than a guess,
 * so the thesaurus builds itself out of what the user actually says.
 */

import type { Statement, Term } from './types';
import { SKOS_ALT_LABEL } from './merge-aliases';
import { repairCandidates, type RepairCandidate, type VocabularyEntry } from './vocabulary-repair';
import { statusForNewFact } from './auto-trust';
import { AGENT_TASK_TYPE } from './agent-task';
import type { IntentReading } from './note-intent';

/** Predicate the n8n capture workflow writes. Must match `Build pending row` in that workflow. */
export const CAPTURED_NOTE = 'urn:kbase:predicate/captured-note';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** The task vocabulary this path writes into — defined by F87, not invented here. */
export const TASK_GOAL = 'urn:kbase:predicate/goal';
export const TASK_STATE = 'urn:kbase:predicate/task-state';

/**
 * Tasks live under `urn:reckons:task/`, matching `reckons-workspace/tasks.ttl`. They are
 * deliberately NOT `urn:kbase:concept/`: a task is a thing to do, not a thing that is known, and
 * keeping the namespaces apart is what stops a queue of intentions being read as knowledge.
 */
export const TASK_IRI_PREFIX = 'urn:reckons:task/';

export type TaskProposal = {
  iri: string;
  reading: IntentReading;
  statements: Statement[];
};

/**
 * Marker recording that a note has been through extraction, so a re-drain or a second poll does
 * not extract it again. Idempotency has to live IN THE GRAPH rather than in memory: the capture
 * path is deliberately at-least-once, so duplicates are normal and must be cheap.
 */
export const EXTRACTED_AT = 'urn:kbase:predicate/extracted-at';

/** Links an extracted triple back to the dictated sentence it came from. */
export const EXTRACTED_FROM = 'urn:kbase:predicate/extracted-from';

export type CapturedNote = {
  /** The note entity, e.g. urn:kbase:concept/note-2026-08-27T16-56-41-444Z */
  iri: string;
  /** The dictated text, verbatim. */
  text: string;
  /** The statement that carries it, so callers can reuse its graph and source. */
  statement: Statement;
};

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/**
 * Captured notes that have not yet been extracted.
 *
 * A note whose text is blank is skipped rather than sent to a model: an empty extraction burns a
 * call and returns nothing, and the capture webhook already rejects empty dictations, so a blank
 * one here means something went wrong upstream and is worth leaving visible.
 */
export function findUnextractedNotes(statements: Statement[]): CapturedNote[] {
  const extracted = new Set(
    statements
      .filter((s) => s.p.value === EXTRACTED_AT && s.s.kind === 'iri' && isActive(s))
      .map((s) => (s.s as { value: string }).value),
  );

  const notes: CapturedNote[] = [];
  const seen = new Set<string>();
  for (const s of statements) {
    if (s.p.value !== CAPTURED_NOTE || s.s.kind !== 'iri' || s.o.kind !== 'literal') continue;
    if (!isActive(s)) continue;
    const iri = s.s.value;
    // At-least-once delivery means the same note can appear twice; extract it once.
    if (extracted.has(iri) || seen.has(iri)) continue;
    if (!s.o.value.trim()) continue;
    seen.add(iri);
    notes.push({ iri, text: s.o.value, statement: s });
  }
  return notes;
}

/** A short, human-readable title for the ingest source, without inventing an entity name. */
export function noteTitle(note: CapturedNote, maxLength = 60): string {
  const firstSentence = note.text.trim().split(/(?<=[.!?])\s/)[0] ?? note.text.trim();
  const trimmed =
    firstSentence.length > maxLength
      ? `${firstSentence.slice(0, maxLength - 1).trimEnd()}...`
      : firstSentence;
  return `Dictated note - ${trimmed}`;
}

type Template = Pick<Statement, 'g' | 'sourceId'>;

/** Records that this note has been extracted, so it is never extracted twice. */
export function buildExtractionMarker(
  note: CapturedNote,
  template: Template,
  makeId: () => string,
  now = Date.now(),
): Statement {
  const marker: Statement = {
    id: makeId(),
    s: { kind: 'iri', value: note.iri },
    p: { kind: 'iri', value: EXTRACTED_AT },
    o: { kind: 'literal', value: new Date(now).toISOString() },
    g: template.g,
    sourceId: template.sourceId,
    confidence: 1,
    // Status is DERIVED, never hand-written: `kpred:extracted-at` classifies as `log`, so the
    // trust rule confirms it. A reviewer asked "did extraction run?" could only answer by
    // trusting the app anyway.
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  return { ...marker, status: statusForNewFact(marker) };
}

/** The built-in type a captured note is. Matt, 2026-08-28: "notes are documents". */
export const DOCUMENT_TYPE = 'urn:kbase:type/Document';

/**
 * Type the note itself.
 *
 * WHY THIS WAS MISSING AND WHY IT MATTERED. The capture path mints a note entity per dictation and
 * never said what one IS, so ~100 of them sat untyped — invisible to the entity-type system, grey
 * on the canvas, and unreachable by the hub type gate, which is why that gate needed a
 * substantive-degree rule to catch them by another route. Measured 2026-08-28 on personal-notes:
 * of 183 untyped entities, the deterministic typer could settle ONE, because most of the rest were
 * notes and there was no type for a note to have.
 *
 * IT IS THE ONE TYPE NOBODY HAS TO INFER. Every other entity's type is read out of a transcript by
 * a model and is a claim about the world; this one is known by the pipeline that created the
 * entity. Asking a language model to decide whether a thing the capture path just minted as a note
 * is a note would be paying for an answer we already have.
 */
export function buildNoteType(
  note: CapturedNote,
  template: Template,
  makeId: () => string,
  now = Date.now(),
): Statement {
  const fact: Statement = {
    id: makeId(),
    s: { kind: 'iri', value: note.iri },
    p: { kind: 'iri', value: RDF_TYPE },
    o: { kind: 'iri', value: DOCUMENT_TYPE },
    g: template.g,
    sourceId: template.sourceId,
    confidence: 1,
    gloss: 'A dictated note is a document — set by the capture pipeline, not inferred',
    // Derived like every other fact this module builds. `rdf:type` is a record, so this lands
    // PENDING: typing is a claim in the general case, and the allowlist that skips review is
    // deliberately keyed by predicate rather than by subject. Widening it so this one case
    // auto-confirms is a decision to take on purpose, not a side effect of adding a type.
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  return { ...fact, status: statusForNewFact(fact) };
}

/** Links each extracted statement's subject back to the sentence it was read from. */
export function buildProvenanceLinks(
  note: CapturedNote,
  extracted: Statement[],
  template: Template,
  makeId: () => string,
  now = Date.now(),
): Statement[] {
  const subjects = new Set<string>();
  for (const s of extracted) {
    if (s.s.kind === 'iri' && s.s.value !== note.iri) subjects.add(s.s.value);
  }
  return [...subjects].map((iri) => ({
    id: makeId(),
    s: { kind: 'iri' as const, value: iri },
    p: { kind: 'iri' as const, value: EXTRACTED_FROM },
    o: { kind: 'iri' as const, value: note.iri },
    g: template.g,
    sourceId: template.sourceId,
    confidence: 1,
    // `kpred:extracted-from` is a RECORD the extractor derived and can re-derive. That a triple
    // came from a note dictated at 16:56 is not a claim anybody needs to adjudicate.
    status: 'pending' as const,
    createdAt: now,
    updatedAt: now,
  })).map((link) => ({ ...link, status: statusForNewFact(link) }));
}

export type RepairProposal = {
  candidate: RepairCandidate;
  statement: Statement;
};

/** The key `alreadyRejected` is keyed by - exported so callers build it the same way. */
export function rejectionKey(iri: string, heard: string): string {
  return `${iri} ${heard.trim().toLowerCase()}`;
}

/** Every human-readable name appearing in a batch of freshly extracted statements. */
function labelsIn(statements: Statement[]): string[] {
  const out = new Set<string>();
  const add = (t: Term) => {
    if (t.kind === 'literal' && t.value.trim()) out.add(t.value);
  };
  for (const s of statements) {
    add(s.o);
    // Subject IRIs carry a name in their slug; the extractor mints them from the transcript,
    // so a mis-heard proper noun shows up here even when no rdfs:label was produced.
    if (s.s.kind === 'iri') {
      const slug = s.s.value.split('/').pop() ?? '';
      if (slug) out.add(slug.replace(/[-_]+/g, ' '));
    }
  }
  return [...out];
}

/**
 * Propose a pending skos:altLabel for each entity name that looks like a mis-hearing of a name the
 * graph already holds.
 *
 * `alreadyRejected` carries the aliases a human has already turned down. Without it the same
 * question returns on every note containing the same word, and a queue that asks a settled
 * question repeatedly teaches the user to stop reading it.
 */
export function buildRepairProposals(
  extracted: Statement[],
  vocabulary: VocabularyEntry[],
  template: Template,
  makeId: () => string,
  options: { alreadyRejected?: ReadonlySet<string>; minConfidence?: number; now?: number } = {},
): RepairProposal[] {
  const { alreadyRejected, minConfidence = 0.5, now = Date.now() } = options;
  const proposals: RepairProposal[] = [];
  const seen = new Set<string>();

  for (const heard of labelsIn(extracted)) {
    for (const candidate of repairCandidates(heard, vocabulary, 1)) {
      // An exact or alias hit is already understood; there is nothing to propose.
      if (candidate.reason === 'exact' || candidate.reason === 'alias') continue;
      if (candidate.confidence < minConfidence) continue;

      const key = rejectionKey(candidate.iri, heard);
      if (seen.has(key) || alreadyRejected?.has(key)) continue;
      seen.add(key);

      proposals.push({
        candidate,
        statement: {
          id: makeId(),
          s: { kind: 'iri', value: candidate.iri },
          p: { kind: 'iri', value: SKOS_ALT_LABEL },
          o: { kind: 'literal', value: heard },
          g: template.g,
          sourceId: template.sourceId,
          confidence: candidate.confidence,
          // A claim about what somebody MEANT is exactly the kind of claim review exists for.
          status: 'pending',
          gloss: `"${heard}" sounds like "${candidate.match}"`,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }
  return proposals;
}

/**
 * A dictated instruction, proposed as a task rather than extracted as a fact.
 *
 * WHAT IS DELIBERATELY MISSING FROM WHAT THIS BUILDS. A task the runner would accept needs
 * `kpred:effect` (the authority boundary it is allowed to cross) and `kpred:done-when` (how a
 * machine will know it worked). Neither is written here, because neither was said. "Run research
 * on grants" declares no authority and defines no success, and inventing either would be the
 * exact failure the task vocabulary exists to prevent — an agent deciding for itself what it is
 * allowed to do and when it is finished. The task therefore lands in state `proposed`, which
 * `blockedReason` refuses outright, and stays unrunnable until a person supplies both.
 *
 * THE GOAL IS THE SENTENCE, VERBATIM. Tidying "run research on grants for kids sports like
 * swimming for city park and rec" into "Research youth swimming grants for the Parks and
 * Recreation department" would put words in the speaker's mouth and quietly resolve two guesses
 * (that "city park and rec" is a department, that "kids sports" narrows to swimming). The
 * transcript is the record; interpretation is a separate, reviewable act.
 *
 * The IRI is derived from the note and the sentence's position in it, so re-extracting the same
 * note proposes the same task rather than a second copy of it. Capture is at-least-once.
 */
export function buildTaskProposals(
  note: CapturedNote,
  readings: IntentReading[],
  template: Template,
  makeId: () => string,
  now = Date.now(),
): TaskProposal[] {
  const noteSlug = note.iri.split('/').pop() ?? 'note';
  return readings.map((reading, index) => {
    const iri = `${TASK_IRI_PREFIX}${noteSlug}-${index + 1}`;
    const base = {
      g: template.g,
      sourceId: template.sourceId,
      confidence: reading.score,
      // The whole sentence, so a reviewer seeing two tasks can tell they came from one breath.
      excerpt: reading.fullSentence ?? reading.sentence,
      grounded: true,
      createdAt: now,
      updatedAt: now,
    };
    const why =
      reading.intent === 'ambiguous'
        ? `Might be a request for work rather than a fact (${reading.signals.join('; ')}) — ` +
          'it was also sent to the extractor, so keep whichever reading is right'
        : `Read as a request for work, not a fact (${reading.signals.join('; ')})`;

    const statements: Statement[] = [
      {
        ...base,
        id: makeId(),
        s: { kind: 'iri', value: iri },
        p: { kind: 'iri', value: RDF_TYPE },
        o: { kind: 'iri', value: AGENT_TASK_TYPE },
        // The classification IS the claim under review here, and only the person who said the
        // sentence knows whether they were asking for work. Nothing checks this but them.
        verifiableBy: 'user',
        status: 'pending',
        gloss: why,
      },
      {
        ...base,
        id: makeId(),
        s: { kind: 'iri', value: iri },
        p: { kind: 'iri', value: TASK_GOAL },
        o: { kind: 'literal', value: reading.sentence },
        verifiableBy: 'user',
        status: 'pending',
        gloss: `Goal, in the words dictated: "${reading.sentence}"`,
      },
      {
        ...base,
        id: makeId(),
        s: { kind: 'iri', value: iri },
        p: { kind: 'iri', value: TASK_STATE },
        o: { kind: 'literal', value: 'proposed' },
        confidence: 1,
        verifiableBy: 'user',
        status: 'pending',
        gloss: 'Not runnable: no effects declared and no done-when — a person must supply both',
      },
      // Provenance, on the same terms as every other extracted triple: that this task came from a
      // sentence dictated at a time is a record the pipeline wrote and can re-derive.
      ((): Statement => {
        const link: Statement = {
          ...base,
          id: makeId(),
          s: { kind: 'iri', value: iri },
          p: { kind: 'iri', value: EXTRACTED_FROM },
          o: { kind: 'iri', value: note.iri },
          confidence: 1,
          status: 'pending',
        };
        return { ...link, status: statusForNewFact(link) };
      })(),
    ];

    return { iri, reading, statements };
  });
}
