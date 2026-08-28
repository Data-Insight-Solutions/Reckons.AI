import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Parser, type Quad } from 'n3';
import { ALTITUDE_RANK } from '../fact-altitude';
import { TASK_EFFECTS } from '../agent-task';

/**
 * The controlled vocabularies are only worth having if they agree with the code and with
 * themselves. These are the invariants that make `static/reckons-vocabulary.ttl` enforcement
 * rather than decoration — and the one that matters most is the LAST one, because a SHACL `sh:in`
 * list and its SKOS scheme are two statements of the same closed set, written in two places.
 */
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const SH = 'http://www.w3.org/ns/shacl#';
const quads: Quad[] = new Parser().parse(
  readFileSync('static/reckons-vocabulary.ttl', 'utf8'),
) as Quad[];

function notationsOf(scheme: string): string[] {
  const concepts = quads
    .filter((q) => q.predicate.value === `${SKOS}inScheme` && q.object.value === scheme)
    .map((q) => q.subject.value);
  return concepts
    .map((c) => quads.find((q) => q.subject.value === c && q.predicate.value === `${SKOS}notation`)?.object.value)
    .filter((v): v is string => Boolean(v))
    .sort();
}

/** The members of a `sh:in` list, following the RDF list. */
function shIn(shape: string): string[] {
  const property = quads
    .filter((q) => q.subject.value === shape && q.predicate.value === `${SH}property`)
    .map((q) => q.object.value);
  const out: string[] = [];
  for (const p of property) {
    const head = quads.find((q) => q.subject.value === p && q.predicate.value === `${SH}in`)?.object.value;
    if (!head) continue;
    let node = head;
    while (node && node !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil') {
      const first = quads.find((q) => q.subject.value === node && q.predicate.value.endsWith('#first'));
      const rest = quads.find((q) => q.subject.value === node && q.predicate.value.endsWith('#rest'));
      if (first) out.push(first.object.value);
      node = rest?.object.value ?? '';
    }
  }
  return out.sort();
}

describe('the vocabulary file', () => {
  it('parses, and is not empty', () => {
    expect(quads.length).toBeGreaterThan(200);
  });

  it('gives every concept a notation — the bridge the code still reads', () => {
    const concepts = quads
      .filter((q) => q.predicate.value === `${SKOS}inScheme`)
      .map((q) => q.subject.value);
    expect(concepts.length).toBeGreaterThan(0);
    for (const c of concepts) {
      const notation = quads.find((q) => q.subject.value === c && q.predicate.value === `${SKOS}notation`);
      expect(notation, `${c} has no skos:notation`).toBeDefined();
    }
  });

  it('gives every concept a definition, so a reviewer can tell them apart', () => {
    const concepts = quads
      .filter((q) => q.predicate.value === `${SKOS}inScheme`)
      .map((q) => q.subject.value);
    for (const c of concepts) {
      const def = quads.find((q) => q.subject.value === c && q.predicate.value === `${SKOS}definition`);
      expect(def, `${c} has no skos:definition`).toBeDefined();
    }
  });
});

describe('the schemes agree with the code', () => {
  it('altitude matches ALTITUDE_RANK exactly', () => {
    expect(notationsOf('urn:kbase:type/AltitudeScheme')).toEqual(Object.keys(ALTITUDE_RANK).sort());
  });

  it('the lifecycle includes in-progress, which the corpus actually uses', () => {
    // Recorded as de-facto rather than designed. Omitting it would fail 14 valid entities.
    expect(notationsOf('urn:kbase:type/FeatureLifecycle')).toContain('in-progress');
  });
});

describe('the SHACL shapes agree with the schemes', () => {
  /*
   * THE ONE THAT MATTERS. sh:in and skos:notation state the same closed set twice, in two places,
   * by hand. Nothing else in the repo would notice them drifting apart — the shapes are declared
   * and not yet validated, so a stale sh:in would sit there looking authoritative and enforcing
   * nothing.
   */
  it('altitude shape offers exactly the scheme notations', () => {
    expect(shIn('urn:kbase:shape/Altitude')).toEqual(notationsOf('urn:kbase:type/AltitudeScheme'));
  });

  it('feature-status shape offers exactly the lifecycle notations', () => {
    expect(shIn('urn:kbase:shape/FeatureStatus')).toEqual(notationsOf('urn:kbase:type/FeatureLifecycle'));
  });

  it('statement-status shape offers exactly the review-status notations', () => {
    expect(shIn('urn:kbase:shape/StatementStatus')).toEqual(notationsOf('urn:kbase:type/ReviewStatusScheme'));
  });

  it('the task shape offers the task states and the code effects', () => {
    const inLists = shIn('urn:kbase:shape/TaskState');
    for (const state of notationsOf('urn:kbase:type/TaskStateScheme')) {
      expect(inLists, `task-state "${state}" missing from the shape`).toContain(state);
    }
    for (const effect of TASK_EFFECTS) {
      expect(inLists, `effect "${effect}" missing from the shape`).toContain(effect);
    }
  });
});
