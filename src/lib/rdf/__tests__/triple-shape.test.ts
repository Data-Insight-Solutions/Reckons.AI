import { describe, it, expect } from 'vitest';
import {
  looksLikeProposition,
  subjectSwallowedTriple,
  rejectCollapsedTriples,
} from '../triple-shape';

describe('looksLikeProposition', () => {
  it('catches the observed failure', () => {
    // Dictated "Orange Logic is an enterprise DAM"; the model emitted the whole sentence as the
    // subject slug and never extracted the relation.
    expect(looksLikeProposition('orange-logic-is-an-enterprise-dam')).toBe(true);
  });

  it('catches other collapsed forms', () => {
    expect(looksLikeProposition('matthew-roe-owns-data-insight-solutions')).toBe(true);
    expect(looksLikeProposition('Enterprise DAMs are used by large teams')).toBe(true);
    expect(looksLikeProposition('reckons_ai_has_a_review_queue')).toBe(true);
  });

  it('leaves ordinary entity names alone', () => {
    for (const name of [
      'Orange Logic',
      'Data Insight Solutions, LLC',
      'Bank of America',
      'Museum of Modern Art',
      'enterprise-dam',
      'Reckons.AI',
      'Matthew Roe',
      'content-orchestration-platform',
    ]) {
      expect(looksLikeProposition(name), name).toBe(false);
    }
  });

  it('leaves predicate-shaped strings alone', () => {
    // A verb at the edge is a relation, not a claim — "is-a" must survive.
    for (const p of ['is-a', 'has-status', 'used-by', 'is', 'owns', 'depends-on']) {
      expect(looksLikeProposition(p), p).toBe(false);
    }
  });

  it('needs at least three words', () => {
    expect(looksLikeProposition('is-dam')).toBe(false);
  });
});

describe('subjectSwallowedTriple', () => {
  it('catches a subject containing both its predicate and object, with no verb', () => {
    expect(
      subjectSwallowedTriple('orange-logic-category-enterprise-dam', 'category', 'enterprise dam'),
    ).toBe(true);
  });

  it('does not fire when the subject is a plain name', () => {
    expect(subjectSwallowedTriple('orange-logic', 'is-a', 'Enterprise DAM')).toBe(false);
  });

  it('does not fire on a short subject', () => {
    expect(subjectSwallowedTriple('dam', 'is-a', 'dam')).toBe(false);
  });
});

describe('rejectCollapsedTriples', () => {
  it('drops the collapsed triple and keeps the good one, saying which went', () => {
    const out = rejectCollapsedTriples([
      { subject: 'orange-logic-is-an-enterprise-dam', predicate: 'is-a', object: 'thing' },
      { subject: 'orange-logic', predicate: 'is-a', object: 'Enterprise DAM' },
    ]);

    expect(out.triples).toHaveLength(1);
    expect(out.triples[0].subject).toBe('orange-logic');
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe('subject-is-a-proposition');
  });

  it('never repairs by splitting — a parse is not a fact', () => {
    // Deliberate: inventing "orange-logic / is-a / enterprise dam" from the bad slug would turn
    // the model's failure into graph content with nothing marking it as a guess.
    const out = rejectCollapsedTriples([
      { subject: 'orange-logic-is-an-enterprise-dam', predicate: 'is-a', object: 'thing' },
    ]);
    expect(out.triples).toHaveLength(0);
  });

  it('rejects a proposition used as a predicate', () => {
    const out = rejectCollapsedTriples([
      { subject: 'orange-logic', predicate: 'orange-logic-is-a-dam', object: 'x' },
    ]);
    expect(out.rejected[0].reason).toBe('predicate-is-a-proposition');
  });

  it('handles a non-string object without throwing', () => {
    const out = rejectCollapsedTriples([
      { subject: 'orange-logic', predicate: 'founded', object: 1999 },
    ]);
    expect(out.triples).toHaveLength(1);
  });

  it('passes a clean batch through untouched', () => {
    const clean = [
      { subject: 'orange-logic', predicate: 'is-a', object: 'Enterprise DAM' },
      { subject: 'matthew-roe', predicate: 'owns', object: 'Data Insight Solutions, LLC' },
    ];
    const out = rejectCollapsedTriples(clean);
    expect(out.triples).toHaveLength(2);
    expect(out.rejected).toHaveLength(0);
  });
});
