import { describe, it, expect } from 'vitest';
import {
  CAPTURED_NOTE,
  EXTRACTED_AT,
  EXTRACTED_FROM,
  findUnextractedNotes,
  noteTitle,
  buildExtractionMarker,
  buildProvenanceLinks,
  buildRepairProposals,
  rejectionKey,
} from '../captured-notes';
import { SKOS_ALT_LABEL } from '../merge-aliases';
import type { VocabularyEntry } from '../vocabulary-repair';
import type { Statement } from '../types';

let n = 0;
const nextId = () => `id${n++}`;

function st(
  subject: string,
  predicate: string,
  object: { kind: 'literal' | 'iri'; value: string },
  status: Statement['status'] = 'pending',
): Statement {
  return {
    id: nextId(),
    s: { kind: 'iri', value: subject },
    p: { kind: 'iri', value: predicate },
    o: object,
    g: { kind: 'iri', value: 'urn:kbase:graph/personal-notes' },
    sourceId: 'src-1',
    confidence: 1,
    status,
    createdAt: 0,
    updatedAt: 0,
  } as Statement;
}

const NOTE = 'urn:kbase:concept/note-2026-08-27T16-56-41-444Z';
const TEXT =
  "I have a new idea for Recon's AI.  It's gonna be a content orchestration platform built on top of Enterprise dams like Orange Logic.";
const template = { g: { kind: 'iri' as const, value: 'urn:kbase:graph/personal-notes' }, sourceId: 'src-1' };

function lit(value: string) {
  return { kind: 'literal' as const, value };
}
function iri(value: string) {
  return { kind: 'iri' as const, value };
}

describe('findUnextractedNotes', () => {
  it('finds a dictated note waiting to be extracted', () => {
    const notes = findUnextractedNotes([st(NOTE, CAPTURED_NOTE, lit(TEXT))]);
    expect(notes).toHaveLength(1);
    expect(notes[0].iri).toBe(NOTE);
    expect(notes[0].text).toBe(TEXT);
  });

  it('skips a note already extracted, so a re-drain costs nothing', () => {
    // Capture is deliberately at-least-once, so the same note DOES arrive twice.
    const notes = findUnextractedNotes([
      st(NOTE, CAPTURED_NOTE, lit(TEXT)),
      st(NOTE, EXTRACTED_AT, lit('2026-08-27T17:00:00.000Z'), 'confirmed'),
    ]);
    expect(notes).toHaveLength(0);
  });

  it('extracts a duplicated note only once', () => {
    const notes = findUnextractedNotes([
      st(NOTE, CAPTURED_NOTE, lit(TEXT)),
      st(NOTE, CAPTURED_NOTE, lit(TEXT)),
    ]);
    expect(notes).toHaveLength(1);
  });

  it('ignores rejected notes and blank dictations', () => {
    expect(findUnextractedNotes([st(NOTE, CAPTURED_NOTE, lit(TEXT), 'rejected')])).toHaveLength(0);
    expect(findUnextractedNotes([st(NOTE, CAPTURED_NOTE, lit('   '))])).toHaveLength(0);
  });

  it('a rejected extraction marker does not block re-extraction', () => {
    const notes = findUnextractedNotes([
      st(NOTE, CAPTURED_NOTE, lit(TEXT)),
      st(NOTE, EXTRACTED_AT, lit('2026-08-27T17:00:00.000Z'), 'rejected'),
    ]);
    expect(notes).toHaveLength(1);
  });
});

describe('noteTitle', () => {
  it('uses the first sentence, not an invented entity name', () => {
    const [note] = findUnextractedNotes([st(NOTE, CAPTURED_NOTE, lit(TEXT))]);
    expect(noteTitle(note)).toBe("Dictated note - I have a new idea for Recon's AI.");
  });

  it('truncates a long rambling sentence', () => {
    const [note] = findUnextractedNotes([
      st(NOTE, CAPTURED_NOTE, lit('a'.repeat(200))),
    ]);
    const title = noteTitle(note, 30);
    expect(title.endsWith('...')).toBe(true);
    expect(title.length).toBeLessThan(60);
  });
});

describe('provenance', () => {
  it('marks the note extracted as confirmed bookkeeping, not a pending claim', () => {
    const [note] = findUnextractedNotes([st(NOTE, CAPTURED_NOTE, lit(TEXT))]);
    const marker = buildExtractionMarker(note, template, nextId, 1000);
    expect(marker.p.value).toBe(EXTRACTED_AT);
    expect(marker.status).toBe('confirmed');
    expect(marker.o.value).toBe(new Date(1000).toISOString());
  });

  it('links every extracted subject back to the sentence it came from', () => {
    const [note] = findUnextractedNotes([st(NOTE, CAPTURED_NOTE, lit(TEXT))]);
    const extracted = [
      st('urn:kbase:concept/orange-logic', 'urn:kbase:predicate/is-a', lit('DAM')),
      st('urn:kbase:concept/orange-logic', 'urn:kbase:predicate/used-by', lit('x')),
    ];
    const links = buildProvenanceLinks(note, extracted, template, nextId);
    // One link per distinct subject, not one per triple.
    expect(links).toHaveLength(1);
    expect(links[0].p.value).toBe(EXTRACTED_FROM);
    expect(links[0].o.value).toBe(NOTE);
  });

  it('does not link the note to itself', () => {
    const [note] = findUnextractedNotes([st(NOTE, CAPTURED_NOTE, lit(TEXT))]);
    const links = buildProvenanceLinks(note, [st(NOTE, CAPTURED_NOTE, lit(TEXT))], template, nextId);
    expect(links).toHaveLength(0);
  });
});

describe('buildRepairProposals', () => {
  const vocab: VocabularyEntry[] = [
    { name: 'Reckons.AI', iri: 'urn:kbase:concept/reckons-ai', viaAlias: false },
    { name: 'Orange Logic', iri: 'urn:kbase:concept/orange-logic', viaAlias: false },
  ];

  it("proposes an altLabel for a mis-heard name, as PENDING", () => {
    const extracted = [
      st('urn:kbase:concept/recons-ai', 'urn:kbase:predicate/is-a', lit('platform')),
    ];
    const proposals = buildRepairProposals(extracted, vocab, template, nextId);
    const hit = proposals.find((p) => p.candidate.iri === 'urn:kbase:concept/reckons-ai');

    expect(hit).toBeDefined();
    expect(hit!.statement.p.value).toBe(SKOS_ALT_LABEL);
    expect(hit!.statement.status).toBe('pending');
    // The card must be able to explain itself.
    expect(hit!.statement.gloss).toContain('sounds like');
  });

  it('proposes nothing for a name the graph already matches exactly', () => {
    const extracted = [st('urn:kbase:concept/x', 'urn:kbase:predicate/eg', lit('Orange Logic'))];
    const proposals = buildRepairProposals(extracted, vocab, template, nextId);
    expect(proposals.some((p) => p.candidate.match === 'Orange Logic')).toBe(false);
  });

  it('never re-asks a question the user already rejected', () => {
    const extracted = [
      st('urn:kbase:concept/recons-ai', 'urn:kbase:predicate/is-a', lit('platform')),
    ];
    const rejected = new Set([rejectionKey('urn:kbase:concept/reckons-ai', 'recons ai')]);

    const proposals = buildRepairProposals(extracted, vocab, template, nextId, {
      alreadyRejected: rejected,
    });

    expect(proposals.some((p) => p.candidate.iri === 'urn:kbase:concept/reckons-ai')).toBe(false);
  });

  it('does not propose the same alias twice in one batch', () => {
    const extracted = [
      st('urn:kbase:concept/recons-ai', 'urn:kbase:predicate/is-a', lit('platform')),
      st('urn:kbase:concept/recons-ai', 'urn:kbase:predicate/built-on', iri('urn:kbase:concept/dam')),
    ];
    const proposals = buildRepairProposals(extracted, vocab, template, nextId);
    const keys = proposals.map((p) => rejectionKey(p.candidate.iri, p.statement.o.value));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('respects a confidence floor', () => {
    const extracted = [
      st('urn:kbase:concept/recons-ai', 'urn:kbase:predicate/is-a', lit('platform')),
    ];
    expect(buildRepairProposals(extracted, vocab, template, nextId, { minConfidence: 0.99 }))
      .toHaveLength(0);
  });
});
