/**
 * SET SCORING'S OWN CORRECTNESS (F187.3).
 *
 * The same requirement the relation scorer carries: it must be able to report that something got
 * WORSE, and it must not manufacture credit. So most of what is asserted here is the scorer
 * FAILING things — a set detector generous enough to find a grouping in any output would sail
 * through a suite that only checked it finds the real ones.
 *
 * Pure: expectations and hand-written triples in, numbers out. No model, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  findCandidateSets, scoreSets, scoreOverlap, scoreTraps,
  type SetExpectation, type NotSetExpectation,
} from '../set-score';

const t = (subject: string, predicate: string, object: string) => ({ subject, predicate, object });

const shortlist: SetExpectation = {
  id: '05.S1', why: 'the shortlist is exactly three',
  label: ['shortlist'],
  members: [['aprimo'], ['bynder'], ['opentext', 'open-text']],
  ordered: false, exclusive: true,
};

describe('finding a grouping in extractor output', () => {
  it('reads forward membership — set has-member entity', () => {
    const c = findCandidateSets([
      t('shortlist', 'has-member', 'aprimo'),
      t('shortlist', 'has-member', 'bynder'),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].members.sort()).toEqual(['aprimo', 'bynder']);
  });

  it('reads INVERSE membership too — entity member-of set', () => {
    // Models emit either; scoring only one would measure a naming convention, not a grouping.
    const c = findCandidateSets([
      t('aprimo', 'member-of', 'shortlist'),
      t('bynder', 'belongs-to', 'shortlist'),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].slug).toBe('shortlist');
    expect(c[0].members.sort()).toEqual(['aprimo', 'bynder']);
  });

  it('does NOT treat a single membership edge as a set', () => {
    // One edge is indistinguishable from an ordinary fact. Counting it would make any relation
    // a grouping and the metric meaningless.
    expect(findCandidateSets([t('aprimo', 'member-of', 'shortlist')])).toEqual([]);
  });

  it('does NOT read part-of as membership', () => {
    // "a wheel is part of a car" is not membership of a set. Reading it as one would manufacture
    // candidate sets out of ordinary structural facts and inflate every score in this file.
    expect(findCandidateSets([
      t('wheel', 'part-of', 'car'), t('engine', 'part-of', 'car'),
    ])).toEqual([]);
  });
});

describe('membership recall and precision are separate numbers', () => {
  it('scores a perfect grouping', () => {
    const [s] = scoreSets([shortlist], [
      t('shortlist', 'has-member', 'aprimo'),
      t('shortlist', 'has-member', 'bynder'),
      t('shortlist', 'has-member', 'opentext'),
    ]);
    expect(s.found).toBe(true);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.extras).toEqual([]);
  });

  it('separates OVER-INCLUSION from recall — the failure an average would hide', () => {
    // Vantage Suite is named in the same paragraph and explicitly excluded. A model that sweeps
    // it in has perfect recall and should still be marked down.
    const [s] = scoreSets([shortlist], [
      t('shortlist', 'has-member', 'aprimo'),
      t('shortlist', 'has-member', 'bynder'),
      t('shortlist', 'has-member', 'opentext'),
      t('shortlist', 'has-member', 'vantage-suite'),
    ]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBeLessThan(1);
    expect(s.extras).toEqual(['vantage-suite']);
  });

  it('scores ZERO when nothing was grouped — the honest baseline', () => {
    // No prompt asks for a set today, so this is what the current pipeline must produce. The zero
    // has to be real or a process change has nothing to beat.
    const [s] = scoreSets([shortlist], [
      t('aprimo', 'is-a', 'dam-vendor'), t('bynder', 'is-a', 'dam-vendor'),
    ]);
    expect(s.found).toBe(false);
    expect(s.recall).toBe(0);
    expect(s.missing.sort()).toEqual(['aprimo', 'bynder', 'opentext']);
  });

  it('reports SPREAD when members are scattered across several sets', () => {
    // Three two-member sets instead of one three-member set is full recall and a failed grouping.
    const [s] = scoreSets([shortlist], [
      t('group-a', 'has-member', 'aprimo'), t('group-a', 'has-member', 'bynder'),
      t('group-b', 'has-member', 'opentext'), t('group-b', 'has-member', 'vantage-suite'),
    ]);
    expect(s.spread).toBe(2);
    expect(s.recall).toBeLessThan(1);
  });
});

describe('order is scored where the source says order matters', () => {
  const migration: SetExpectation = {
    id: '05.S4', why: 'order is not negotiable', label: ['migration'],
    members: [['inventory'], ['map-metadata'], ['dry-run'], ['cut-over']],
    ordered: true, exclusive: true,
  };
  const membership = [
    t('migration', 'has-member', 'inventory'), t('migration', 'has-member', 'map-metadata'),
    t('migration', 'has-member', 'dry-run'), t('migration', 'has-member', 'cut-over'),
  ];

  it('credits a correct sequence stated with ordinals', () => {
    const [s] = scoreSets([migration], [
      ...membership,
      t('inventory', 'phase', '1'), t('map-metadata', 'phase', '2'),
      t('dry-run', 'phase', '3'), t('cut-over', 'phase', '4'),
    ]);
    expect(s.recall).toBe(1);
    expect(s.order).toBe(1);
  });

  it('marks down a WRONG sequence even with perfect membership', () => {
    // Right members in the wrong order is wrong, not partially right — the source says each phase
    // depends on the one before it.
    const [s] = scoreSets([migration], [
      ...membership,
      t('inventory', 'phase', '4'), t('map-metadata', 'phase', '3'),
      t('dry-run', 'phase', '2'), t('cut-over', 'phase', '1'),
    ]);
    expect(s.recall).toBe(1);
    expect(s.order).toBeLessThan(1);
  });

  it('leaves order null for an unordered set rather than scoring it as zero', () => {
    const [s] = scoreSets([shortlist], [
      t('shortlist', 'has-member', 'aprimo'), t('shortlist', 'has-member', 'bynder'),
    ]);
    expect(s.order).toBeNull();
  });
});

describe('overlap — sets overlap, they do not partition', () => {
  const sets: SetExpectation[] = [
    shortlist,
    { id: '05.S2', why: 'deployed', label: ['deployed'],
      members: [['vantage-suite'], ['opentext', 'open-text']], exclusive: true },
    { id: '05.S3', why: 'OpenText is in both', label: ['__overlap__'],
      members: [['opentext', 'open-text']], mustAppearInSets: ['05.S1', '05.S2'] },
  ];
  const both = [
    t('shortlist', 'has-member', 'aprimo'), t('shortlist', 'has-member', 'bynder'),
    t('shortlist', 'has-member', 'opentext'),
    t('deployed', 'has-member', 'vantage-suite'), t('deployed', 'has-member', 'opentext'),
  ];

  it('holds when the member is in both sets', () => {
    const scores = scoreSets(sets, both);
    const [o] = scoreOverlap(sets, scores, both);
    expect(o.held).toBe(true);
    expect(o.presentIn.sort()).toEqual(['05.S1', '05.S2']);
  });

  it('FAILS when the extractor partitioned — the failure F187 exists to prevent', () => {
    const partitioned = both.filter((x) => !(x.subject === 'deployed' && x.object === 'opentext'));
    const scores = scoreSets(sets, partitioned);
    const [o] = scoreOverlap(sets, scores, partitioned);
    expect(o.held).toBe(false);
    expect(o.presentIn).toEqual(['05.S1']);
  });

  it('does not score the overlap assertion as if it were a set of its own', () => {
    // S3 asserts something ABOUT S1 and S2; counting it as a third set would inflate set recall.
    expect(scoreSets(sets, both).map((s) => s.id)).toEqual(['05.S1', '05.S2']);
  });
});

describe('the trap — a list that must NOT be grouped', () => {
  const concerns: NotSetExpectation = {
    id: '05.N1', why: 'the source says these are not a group',
    members: [['aprimo'], ['bynder'], ['opentext', 'open-text']],
  };

  it('is REFUSED when the concerns are emitted as ordinary facts', () => {
    const s = scoreTraps([concerns], [
      t('aprimo', 'concern', 'per-seat-licensing'),
      t('bynder', 'concern', 'no-on-premise'),
      t('opentext', 'concern', 'professional-services'),
    ]);
    expect(s[0].refused).toBe(true);
  });

  it('FAILS when a model groups them — "bullet list => collection"', () => {
    const s = scoreTraps([concerns], [
      t('open-concerns', 'has-member', 'aprimo'),
      t('open-concerns', 'has-member', 'bynder'),
      t('open-concerns', 'has-member', 'opentext'),
    ]);
    expect(s[0].refused).toBe(false);
    expect(s[0].groupedAs).toBe('open-concern');
  });

  it('does NOT fire on the legitimate shortlist, which holds the same three vendors', () => {
    // The critical false positive. The shortlist really is a set and really does contain all three
    // concern-vendors; a trap that fired on it would penalise correct behaviour and make the
    // metric actively misleading. Distinguished by the candidate being no tighter than the trap.
    const s = scoreTraps([concerns], [
      t('shortlist', 'has-member', 'aprimo'),
      t('shortlist', 'has-member', 'bynder'),
      t('shortlist', 'has-member', 'opentext'),
      t('shortlist', 'has-member', 'vantage-suite'),
      t('shortlist', 'has-member', 'lumenpath'),
    ]);
    expect(s[0].refused).toBe(true);
  });
});
