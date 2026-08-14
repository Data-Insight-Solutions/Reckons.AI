/**
 * Website alignment (F111) — design intent versus observed output.
 *
 * The tests that matter are about keeping the four divergence kinds SEPARATE. Summing them into
 * one "mismatch" number would be the useful information destroyed: an undeclared page needs a
 * design decision, an unbuilt page needs building, and a divergent field needs a fix. Only the
 * last is unambiguously a bug.
 */
import { describe, it, expect } from 'vitest';
import {
  alignWebsite, describeAlignment,
  type IntendedPage, type ObservedPage,
} from '../website-alignment';

const want = (over: Partial<IntendedPage> & { slug: string }): IntendedPage => ({
  id: over.slug, title: over.slug, section: 'Learn',
  url: `https://reckons.ai/docs/learn/${over.slug}`, ...over,
});

const got = (over: Partial<ObservedPage> & { slug: string }): ObservedPage => ({
  path: `content/learn/${over.slug}.md`,
  section: 'Learn', title: over.slug, template: 'doc',
  status: 'published', nav: 'sidebar',
  url: `https://reckons.ai/docs/learn/${over.slug}`, ...over,
});

describe('the four divergences stay separate', () => {
  it('counts a page present in both as aligned', () => {
    const a = alignWebsite([want({ slug: 'start-here' })], [got({ slug: 'start-here' })]);
    expect(a.aligned).toEqual(['start-here']);
    expect(a.score).toBe(1);
  });

  it('reports a designed page that does not exist as UNBUILT, not as an error elsewhere', () => {
    const a = alignWebsite([want({ slug: 'start-here' })], []);
    expect(a.unbuilt.map((p) => p.slug)).toEqual(['start-here']);
    expect(a.undeclared).toEqual([]);
    expect(a.divergent).toEqual([]);
  });

  it('reports a published page the design never asked for as UNDECLARED', () => {
    const a = alignWebsite([], [got({ slug: 'mystery' })]);
    expect(a.undeclared.map((p) => p.slug)).toEqual(['mystery']);
    expect(a.unbuilt).toEqual([]);
  });

  it('reports a field disagreement as DIVERGENT — the only unambiguous bug', () => {
    const a = alignWebsite(
      [want({ slug: 'start-here', title: 'Start here', template: 'doc' })],
      [got({ slug: 'start-here', title: 'Getting Started', template: 'full' })],
    );
    expect(a.divergent).toEqual([
      { slug: 'start-here', field: 'title', intended: 'Start here', observed: 'Getting Started' },
      { slug: 'start-here', field: 'template', intended: 'doc', observed: 'full' },
    ]);
    // It is still aligned in the sense of EXISTING — the page is there, two fields disagree.
    expect(a.aligned).toEqual(['start-here']);
  });

  it('does not call a case-only title difference a divergence', () => {
    const a = alignWebsite(
      [want({ slug: 'x', title: 'Start Here' })],
      [got({ slug: 'x', title: 'start here' })],
    );
    expect(a.divergent).toEqual([]);
  });

  it('matches on section AND slug, so the same slug in two sections is two pages', () => {
    const a = alignWebsite(
      [want({ slug: 'overview', section: 'Learn' })],
      [got({ slug: 'overview', section: 'Build', path: 'content/build/overview.md' })],
    );
    expect(a.unbuilt.map((p) => p.slug)).toEqual(['overview']);
    expect(a.undeclared.map((p) => p.slug)).toEqual(['overview']);
  });
});

describe('the score, and its published basis', () => {
  it('counts undeclared pages AGAINST alignment', () => {
    // A site publishing 269 pages nobody designed is not aligned with an 8-page design just
    // because those 8 also exist.
    const a = alignWebsite(
      [want({ slug: 'a' })],
      [got({ slug: 'a' }), got({ slug: 'b' }), got({ slug: 'c' })],
    );
    expect(a.score).toBeCloseTo(1 / 3, 5);
  });

  it('always states what the number measured', () => {
    const a = alignWebsite([want({ slug: 'a' })], [got({ slug: 'a' })]);
    // A number quoted without its definition is the kind of unverifiable claim this project refuses.
    expect(a.scoreBasis).toContain('undeclared pages count against alignment');
  });

  it('scores an empty design against an empty site as aligned rather than dividing by zero', () => {
    expect(alignWebsite([], []).score).toBe(1);
  });
});

describe('the sentence a human reads', () => {
  it('splits undeclared pages into machine-generated and hand-authored', () => {
    // The difference between "the generator made a mess" and "someone wrote pages we forgot".
    const a = alignWebsite([], [
      got({ slug: 'gen', generated: 'docs-kb' }),
      got({ slug: 'hand' }),
    ]);
    expect(describeAlignment(a)).toContain('1 machine-generated, 1 hand-authored');
  });

  it('names the unbuilt pages rather than only counting them', () => {
    const a = alignWebsite([want({ slug: 'start-here' }), want({ slug: 'contributing' })], []);
    expect(describeAlignment(a)).toContain('start-here, contributing');
  });

  it('says so plainly when the site matches the design', () => {
    const a = alignWebsite([want({ slug: 'a' })], [got({ slug: 'a' })]);
    expect(describeAlignment(a)).toContain('exactly what the design describes');
  });
});
