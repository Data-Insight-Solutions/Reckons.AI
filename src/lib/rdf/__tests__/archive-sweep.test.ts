/**
 * Age sweep (F97) — what counts as old.
 *
 * Every test here pins a decision that, made the other way, silently loses something the user
 * still wanted: judging an entity by its oldest date, ageing out undated nodes via `createdAt`,
 * or carrying unreviewed facts into the archive where the review queue can never surface them.
 * The counts are asserted as hard numbers because the plan is what the user consents to before a
 * destructive-shaped move — an approximate promise is not consent.
 */
import { describe, it, expect } from 'vitest';
import { planAgeSweep, describeAgeSweep, AgeSweepPolicyError } from '../archive-sweep';
import { archiveEntities } from '../archive';
import type { NamedNode, ReviewStatus, Statement, Term } from '../types';

const iri = (value: string): NamedNode => ({ kind: 'iri', value });
const lit = (value: string): Term => ({ kind: 'literal', value });

const DAY = 86_400_000;
/** A fixed "now" so no test depends on the wall clock. */
const NOW = Date.parse('2026-07-30T12:00:00Z');

let seq = 0;
const st = (
  s: string,
  p: string,
  o: Term,
  status: ReviewStatus = 'confirmed',
): Statement => ({
  id: `s${seq++}`,
  s: iri(s),
  p: iri(p),
  o,
  g: iri('urn:g'),
  sourceId: 'x',
  confidence: 1,
  status,
  createdAt: 0,
  updatedAt: 0,
});

const SCHEDULED = 'urn:kbase:predicate/scheduled-at';
const ENDS = 'urn:kbase:predicate/ends-at';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
/** ISO instant N days before NOW, so the test never straddles a local-midnight boundary. */
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

describe('age threshold', () => {
  it('archives an entity whose event predates the cutoff', () => {
    const plan = planAgeSweep(
      [st('urn:old', SCHEDULED, lit(daysAgo(400))), st('urn:old', LABEL, lit('Old meetup'))],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.entities).toEqual(['urn:old']);
    expect(plan.statementCount).toBe(2);
  });

  it('leaves an entity inside the window alone', () => {
    const plan = planAgeSweep([st('urn:recent', SCHEDULED, lit(daysAgo(10)))], {
      olderThanDays: 90,
      now: NOW,
    });
    expect(plan.entities).toEqual([]);
    expect(plan.recentCount).toBe(1);
  });

  it('judges an entity by its NEWEST date, not its oldest', () => {
    // Started long ago, still running. Using the oldest date would archive live knowledge.
    const plan = planAgeSweep(
      [
        st('urn:project', SCHEDULED, lit(daysAgo(500))),
        st('urn:project', ENDS, lit(daysAgo(3))),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.entities).toEqual([]);
    expect(plan.recentCount).toBe(1);
  });

  it('rejects a non-positive threshold instead of sweeping the whole graph', () => {
    const graph = [st('urn:a', SCHEDULED, lit(daysAgo(1)))];
    expect(() => planAgeSweep(graph, { olderThanDays: 0, now: NOW })).toThrow(AgeSweepPolicyError);
    expect(() => planAgeSweep(graph, { olderThanDays: -5, now: NOW })).toThrow(AgeSweepPolicyError);
    expect(() => planAgeSweep(graph, { olderThanDays: NaN, now: NOW })).toThrow(AgeSweepPolicyError);
  });
});

describe('what is never swept', () => {
  it('never archives an undated entity, and reports how many it skipped', () => {
    const plan = planAgeSweep(
      [st('urn:note', LABEL, lit('A thought')), st('urn:other', LABEL, lit('Another'))],
      { olderThanDays: 1, now: NOW },
    );
    expect(plan.entities).toEqual([]);
    expect(plan.undatedCount).toBe(2);
  });

  it('does not fall back to createdAt for an undated entity', () => {
    // Ingested years ago, carries no event date. That is undated, not old.
    const ancient = { ...st('urn:note', LABEL, lit('A thought')), createdAt: NOW - 900 * DAY };
    const plan = planAgeSweep([ancient], { olderThanDays: 90, now: NOW });
    expect(plan.entities).toEqual([]);
    expect(plan.undatedCount).toBe(1);
  });

  it('does not date an entity from an unparseable literal', () => {
    const plan = planAgeSweep([st('urn:x', SCHEDULED, lit('sometime last winter'))], {
      olderThanDays: 90,
      now: NOW,
    });
    expect(plan.entities).toEqual([]);
    expect(plan.undatedCount).toBe(1);
  });

  it('ignores dates on rejected and superseded facts', () => {
    // Written in the direction that actually bites: a date the user REJECTED, or one a later fact
    // superseded, must not keep an old entity looking current forever. Asserted both ways so the
    // entity is archived on the strength of its surviving date alone.
    const rejected = planAgeSweep(
      [
        st('urn:x', SCHEDULED, lit(daysAgo(400)), 'confirmed'),
        st('urn:x', ENDS, lit(daysAgo(2)), 'rejected'),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(rejected.entities).toEqual(['urn:x']);

    const superseded = planAgeSweep(
      [
        st('urn:y', SCHEDULED, lit(daysAgo(400)), 'confirmed'),
        st('urn:y', ENDS, lit(daysAgo(2)), 'superseded'),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(superseded.entities).toEqual(['urn:y']);

    // And a rejected OLD date cannot age out a current entity either.
    const stillCurrent = planAgeSweep(
      [
        st('urn:z', SCHEDULED, lit(daysAgo(400)), 'rejected'),
        st('urn:z', ENDS, lit(daysAgo(2)), 'confirmed'),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(stillCurrent.entities).toEqual([]);
  });

  it('does not age out a person merely because they attended an old event', () => {
    // The date belongs to the meetup, not to Alex — crediting the object would archive everyone
    // who ever appeared at something old.
    const plan = planAgeSweep(
      [
        st('urn:meetup', SCHEDULED, lit(daysAgo(400))),
        st('urn:alex', 'urn:p/attended', iri('urn:meetup')),
        st('urn:alex', SCHEDULED, lit(daysAgo(1))),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.entities).toEqual(['urn:meetup']);
  });

  it('does not date an entity at all from an edge pointing at it', () => {
    // Same rule stated the other way: an inbound edge from a dated node must leave the target
    // UNDATED, not merely "recent". Otherwise every neighbour of an old event becomes sweepable.
    const plan = planAgeSweep(
      [
        st('urn:meetup', SCHEDULED, lit(daysAgo(400))),
        st('urn:meetup', 'urn:p/host', iri('urn:alex')),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.entities).toEqual(['urn:meetup']);
    expect(plan.undatedCount).toBe(1); // alex has no date of his own
    expect(plan.recentCount).toBe(0);
  });
});

describe('unreviewed facts hold an entity back', () => {
  it('holds an old entity carrying a pending fact, and names it', () => {
    const plan = planAgeSweep(
      [
        st('urn:old', SCHEDULED, lit(daysAgo(400))),
        st('urn:old', LABEL, lit('Unsettled'), 'pending'),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.entities).toEqual([]);
    expect(plan.heldForReview).toEqual(['urn:old']);
    expect(plan.statementCount).toBe(0);
  });

  it('holds an old entity that is only the OBJECT of a pending fact', () => {
    // The mover archives by subject OR object, so this pending fact would vanish with it.
    const plan = planAgeSweep(
      [
        st('urn:old', SCHEDULED, lit(daysAgo(400))),
        st('urn:current', 'urn:p/mentions', iri('urn:old'), 'pending'),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.heldForReview).toEqual(['urn:old']);
    expect(plan.entities).toEqual([]);
  });

  it('holds on pending-removal too', () => {
    const plan = planAgeSweep(
      [
        st('urn:old', SCHEDULED, lit(daysAgo(400))),
        st('urn:old', LABEL, lit('Maybe delete'), 'pending-removal'),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.heldForReview).toEqual(['urn:old']);
  });

  it('sweeps a settled old entity while holding an unsettled one', () => {
    const plan = planAgeSweep(
      [
        st('urn:settled', SCHEDULED, lit(daysAgo(400))),
        st('urn:unsettled', SCHEDULED, lit(daysAgo(400))),
        st('urn:unsettled', LABEL, lit('?'), 'pending'),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.entities).toEqual(['urn:settled']);
    expect(plan.heldForReview).toEqual(['urn:unsettled']);
  });
});

describe('the count the user consents to', () => {
  it('predicts exactly what the mover moves', () => {
    const graph = [
      st('urn:old', SCHEDULED, lit(daysAgo(400))),
      st('urn:old', LABEL, lit('Old')),
      st('urn:current', 'urn:p/rel', iri('urn:old')), // edge INTO the archived node
      st('urn:current', SCHEDULED, lit(daysAgo(1))),
      st('urn:current', LABEL, lit('Current')),
    ];
    const plan = planAgeSweep(graph, { olderThanDays: 90, now: NOW });
    const moved = archiveEntities({
      statements: graph,
      entities: plan.entities,
      type: 'age-drop',
      actor: 'human',
      at: NOW,
      eventId: 'e1',
    });
    // The planner's promise and the mover's behaviour must be the same number, always.
    expect(plan.statementCount).toBe(moved.archived.length);
    expect(plan.statementCount).toBe(3);
  });

  it('reports the newest date being archived so the user can see the window', () => {
    const plan = planAgeSweep(
      [
        st('urn:a', SCHEDULED, lit(daysAgo(400))),
        st('urn:b', SCHEDULED, lit(daysAgo(120))),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(plan.entities).toEqual(['urn:a', 'urn:b']);
    expect(plan.newestArchived).toBeCloseTo(Date.parse(daysAgo(120)), -3);
  });
});

describe('the sentence shown to the user', () => {
  it('states the move and both caveats', () => {
    const plan = planAgeSweep(
      [
        st('urn:old', SCHEDULED, lit(daysAgo(400))),
        st('urn:held', SCHEDULED, lit(daysAgo(400))),
        st('urn:held', LABEL, lit('?'), 'pending'),
        st('urn:undated', LABEL, lit('No date')),
      ],
      { olderThanDays: 90, now: NOW },
    );
    const text = describeAgeSweep(plan);
    expect(text).toContain('1 fact across 1 entity would move');
    expect(text).toContain('1 undated entity is never swept');
    expect(text).toContain('held back because they carry unreviewed facts');
  });

  it('explains an empty sweep rather than saying nothing', () => {
    const plan = planAgeSweep(
      [
        st('urn:held', SCHEDULED, lit(daysAgo(400))),
        st('urn:held', LABEL, lit('?'), 'pending'),
      ],
      { olderThanDays: 90, now: NOW },
    );
    expect(describeAgeSweep(plan)).toBe('Nothing to archive (1 held for review).');
  });

  it('says nothing to archive on an empty graph', () => {
    expect(describeAgeSweep(planAgeSweep([], { olderThanDays: 90, now: NOW }))).toBe(
      'Nothing to archive.',
    );
  });
});
