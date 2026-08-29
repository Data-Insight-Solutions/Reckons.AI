import { describe, it, expect } from 'vitest';
import { surveyTypes, distinctivePredicates, buildTypeStatements } from '../entity-typing';
import { BUILT_IN_TYPES, RDF_TYPE } from '../entity-types';
import { altitudeOf } from '../fact-altitude';
import type { Statement } from '../types';

const KP = 'urn:kbase:predicate/';
const KB = 'urn:kbase:concept/';

let n = 0;
function st(subject: string, predicate: string, object: string | { iri: string }): Statement {
  return {
    id: `s${++n}`,
    s: { kind: 'iri', value: `${KB}${subject}` },
    p: { kind: 'iri', value: /^(urn|https?):/.test(predicate) ? predicate : `${KP}${predicate}` },
    o: typeof object === 'string'
      ? { kind: 'literal', value: object }
      : { kind: 'iri', value: object.iri },
    g: { kind: 'iri', value: 'urn:kbase:graph/test' },
    sourceId: 'src',
    confidence: 1,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  };
}

const template = { g: { kind: 'iri' as const, value: 'urn:kbase:graph/test' }, sourceId: 'src' };

describe('distinctivePredicates — shared predicates are not evidence', () => {
  const distinctive = distinctivePredicates(BUILT_IN_TYPES);

  it('keeps a predicate only one type claims', () => {
    expect(distinctive.get(`${KP}birth-date`)).toBe('urn:kbase:type/Person');
    expect(distinctive.get(`${KP}founded`)).toBe('urn:kbase:type/Organization');
  });

  it('drops predicates several types share', () => {
    // `description` is on four types and `url` on three. Counting a shared predicate would let
    // the type with the longest schema list win every argument.
    expect(distinctive.has(`${KP}description`)).toBe(false);
    expect(distinctive.has(`${KP}url`)).toBe(false);
  });

  it('compares by IRI, not by the last path segment', () => {
    // Place has urn:kbase:predicate/location and Event has urn:kbase:meta/location — different
    // predicates that read identically when shortened. So predicate/location IS distinctive to
    // Place, and treating the two as one word would wrongly discard real evidence.
    expect(distinctive.get(`${KP}location`)).toBe('urn:kbase:type/Place');
    // And meta/location is correctly NOT distinctive — Event and Calendar Event both use it.
    expect(distinctive.has('urn:kbase:meta/location')).toBe(false);
  });
});

describe('surveyTypes', () => {
  it('takes the type the source stated', () => {
    const survey = surveyTypes([st('orange-logic', 'is-a', 'Organization')], BUILT_IN_TYPES);
    expect(survey.proposals).toHaveLength(1);
    expect(survey.proposals[0].typeIri).toBe('urn:kbase:type/Organization');
    expect(survey.proposals[0].basis).toBe('stated');
  });

  it('matches a stated type however it was written', () => {
    for (const written of ['organization', 'Organization', 'ORGANIZATION']) {
      const survey = surveyTypes([st('x', 'instance-of', written)], BUILT_IN_TYPES);
      expect(survey.proposals[0]?.typeIri).toBe('urn:kbase:type/Organization');
    }
  });

  it('infers from a predicate only one type has', () => {
    const survey = surveyTypes(
      [st('ada', 'birth-date', '1815-12-10'), st('ada', 'occupation', 'mathematician')],
      BUILT_IN_TYPES,
    );
    expect(survey.proposals[0].typeIri).toBe('urn:kbase:type/Person');
    expect(survey.proposals[0].basis).toBe('predicates');
  });

  // The rule that keeps this honest.
  it('declines on a tie rather than picking a winner', () => {
    const survey = surveyTypes(
      [st('thing', 'birth-date', '1815-12-10'), st('thing', 'founded', '1998')],
      BUILT_IN_TYPES,
    );
    expect(survey.proposals).toHaveLength(0);
    expect(survey.undecided.map((u) => u.entityIri)).toEqual([`${KB}thing`]);
  });

  it('declines when nothing distinctive is known', () => {
    const survey = surveyTypes([st('thing', 'relates-to', { iri: `${KB}other` })], BUILT_IN_TYPES);
    expect(survey.proposals).toHaveLength(0);
    expect(survey.undecided[0].predicates).toContain('relates-to');
  });

  it('prefers what the source SAID over what its predicates imply', () => {
    const survey = surveyTypes(
      [st('acme', 'is-a', 'Organization'), st('acme', 'birth-date', '1815-12-10')],
      BUILT_IN_TYPES,
    );
    expect(survey.proposals[0].typeIri).toBe('urn:kbase:type/Organization');
    expect(survey.proposals[0].basis).toBe('stated');
  });

  it('leaves an entity the graph has already typed alone', () => {
    const existing = [st('ada', RDF_TYPE, { iri: 'urn:kbase:type/Person' })];
    const survey = surveyTypes([st('ada', 'birth-date', '1815-12-10')], BUILT_IN_TYPES, existing);
    expect(survey.proposals).toHaveLength(0);
    expect(survey.undecided).toHaveLength(0);
  });

  it('does not re-type an entity typed within the same batch', () => {
    const survey = surveyTypes(
      [st('ada', RDF_TYPE, { iri: 'urn:kbase:type/Person' }), st('ada', 'birth-date', '1815-12-10')],
      BUILT_IN_TYPES,
    );
    expect(survey.proposals).toHaveLength(0);
  });
});

describe('buildTypeStatements', () => {
  const proposals = () =>
    surveyTypes([st('ada', 'birth-date', '1815-12-10')], BUILT_IN_TYPES).proposals;

  it('emits a pending rdf:type routed to the user', () => {
    const [fact] = buildTypeStatements(proposals(), template, () => 'id-1');
    expect(fact.p.value).toBe(RDF_TYPE);
    expect(fact.o.value).toBe('urn:kbase:type/Person');
    expect(fact.status).toBe('pending');
    expect(fact.verifiableBy).toBe('user');
  });

  it('says why, so the card does not just assert a type', () => {
    const [fact] = buildTypeStatements(proposals(), template, () => 'id-1');
    expect(fact.gloss).toContain('Person');
    expect(fact.gloss).toContain('birth-date');
  });

  it('scores an inference below a quotation', () => {
    const [inferred] = buildTypeStatements(proposals(), template, () => 'a');
    const [stated] = buildTypeStatements(
      surveyTypes([st('acme', 'is-a', 'Organization')], BUILT_IN_TYPES).proposals,
      template,
      () => 'b',
    );
    expect(inferred.confidence).toBeLessThan(stated.confidence);
  });
});

// Matt, 2026-08-28: "an easy way to adjust the depth/altitude of the new fact."
describe('a hand-set altitude on one fact', () => {
  it('overrides what the predicate would say', () => {
    const fact = st('thing', 'has-status', 'functional');
    expect(altitudeOf(fact)).toBe('judgment');
    expect(altitudeOf({ ...fact, altitude: 'log' })).toBe('log');
  });

  it('outranks a predicate-level classification too — it is more specific', () => {
    const fact = { ...st('thing', 'depends-on', { iri: `${KB}other` }), altitude: 'record' as const };
    expect(altitudeOf(fact)).toBe('record');
  });

  it('changes nothing when absent', () => {
    const fact = st('thing', 'has-file', 'src/a.ts');
    expect(altitudeOf({ ...fact, altitude: undefined })).toBe(altitudeOf(fact));
  });
});

// A user's ruling on one fact has to survive the file, or the next sync silently undoes it.
describe('a hand-set altitude round-trips through Turtle', () => {
  const fact = (): Statement => ({ ...st('thing', 'has-status', 'functional'), altitude: 'log' });

  it('is written and read back', async () => {
    const { toTurtleFull } = await import('../serialize');
    const { importTurtleFull } = await import('../import-ttl');
    const f = fact();
    const ttl = toTurtleFull([f], []);
    expect(ttl).toContain('meta:altitude "log"');
    const back = await importTurtleFull(ttl);
    expect(back.statements.find((s) => s.id === f.id)?.altitude).toBe('log');
  });

  it('drops a value that is not an altitude rather than trusting the file', async () => {
    const { toTurtleFull } = await import('../serialize');
    const { importTurtleFull } = await import('../import-ttl');
    const f = fact();
    const tampered = toTurtleFull([f], []).replace('meta:altitude "log"', 'meta:altitude "boss"');
    const back = await importTurtleFull(tampered);
    expect(back.statements.find((s) => s.id === f.id)?.altitude).toBeUndefined();
  });
});

// Matt, 2026-08-28: "notes are documents."
describe('a captured note types itself', () => {
  const captured = {
    iri: 'urn:kbase:concept/note-2026-08-28T13-38-52-197Z',
    text: 'some dictation',
    statement: st('note', 'urn:kbase:predicate/captured-note', 'some dictation'),
  };
  const tmpl = { g: { kind: 'iri' as const, value: 'urn:kbase:graph/personal-notes' }, sourceId: 'src' };

  it('is a Document, decided by the pipeline rather than a model', async () => {
    const { buildNoteType, DOCUMENT_TYPE } = await import('../captured-notes');
    const fact = buildNoteType(captured, tmpl, () => 'id-1');
    expect(fact.p.value).toBe(RDF_TYPE);
    expect(fact.o.value).toBe(DOCUMENT_TYPE);
    expect(fact.s.value).toBe(captured.iri);
  });

  it('says in its gloss that nothing inferred it', async () => {
    const { buildNoteType } = await import('../captured-notes');
    expect(buildNoteType(captured, tmpl, () => 'id-1').gloss).toContain('not inferred');
  });

  // The gap this closes: surveyTypes could settle 1 of 183 entities on a real captured graph,
  // because most of the rest were notes and no type existed for a note to have.
  it('removes the note from what the type survey has to decide', async () => {
    const { buildNoteType } = await import('../captured-notes');
    const noteFact = st('note-1', 'urn:kbase:predicate/captured-note', 'text');
    const before = surveyTypes([noteFact], BUILT_IN_TYPES);
    expect(before.undecided.map((u) => u.entityIri)).toContain(`${KB}note-1`);

    const typed = buildNoteType(
      { iri: `${KB}note-1`, text: 'text', statement: noteFact },
      tmpl,
      () => 'id-2',
    );
    const after = surveyTypes([noteFact], BUILT_IN_TYPES, [typed]);
    expect(after.undecided).toHaveLength(0);
    expect(after.proposals).toHaveLength(0);
  });
});
