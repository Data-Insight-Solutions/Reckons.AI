import { describe, it, expect } from 'vitest';
import { selectKnownClaims, buildClaimsSection } from '../claims-context';
import type { StructuralAnchor } from '../structural-context';
import type { Statement } from '../types';

let n = 0;
function st(
  subject: string,
  predicate: string,
  object: string,
  status: Statement['status'] = 'confirmed',
): Statement {
  return {
    id: `c${n++}`,
    s: { kind: 'iri', value: `urn:kbase:concept/${subject}` },
    p: { kind: 'iri', value: `urn:kbase:predicate/${predicate}` },
    o: { kind: 'literal', value: object },
    g: { kind: 'iri', value: 'urn:kbase:graph/personal-notes' },
    sourceId: 'src',
    confidence: 1,
    status,
    createdAt: 0,
    updatedAt: 0,
  } as Statement;
}

const anchor = (slug: string): StructuralAnchor =>
  ({ slug, label: slug, dependsOn: [] }) as unknown as StructuralAnchor;

describe('selectKnownClaims', () => {
  it('collects what is already claimed about an anchor', () => {
    const ctx = selectKnownClaims(
      [st('orange-logic', 'is-a', 'Enterprise DAM')],
      [anchor('orange-logic')],
    );
    expect(ctx.anchorsCovered).toBe(1);
    expect(ctx.claims[0]).toMatchObject({
      subjectSlug: 'orange-logic',
      predicate: 'is-a',
      object: 'Enterprise DAM',
      confirmed: true,
    });
  });

  it('includes UNCONFIRMED claims, flagged — the follow-up case needs them', () => {
    // A second note usually arrives while the first note's facts are still pending. Excluding
    // them would miss the exact case this module exists for.
    const ctx = selectKnownClaims(
      [st('orange-logic', 'is-a', 'Enterprise DAM', 'pending')],
      [anchor('orange-logic')],
    );
    expect(ctx.claims[0].confirmed).toBe(false);
  });

  it('never grounds on a rejected or superseded claim', () => {
    const ctx = selectKnownClaims(
      [
        st('orange-logic', 'is-a', 'a river dam', 'rejected'),
        st('orange-logic', 'is-a', 'nope', 'superseded'),
      ],
      [anchor('orange-logic')],
    );
    expect(ctx.claims).toHaveLength(0);
  });

  it('prefers confirmed claims when the per-anchor budget truncates', () => {
    const statements = [
      st('x', 'p1', 'pending one', 'pending'),
      st('x', 'p2', 'pending two', 'pending'),
      st('x', 'p3', 'settled', 'confirmed'),
    ];
    const ctx = selectKnownClaims(statements, [anchor('x')], { perAnchor: 1 });
    expect(ctx.claims).toHaveLength(1);
    expect(ctx.claims[0].object).toBe('settled');
  });

  it('is budgeted so a large graph cannot blow up the prompt', () => {
    const statements = Array.from({ length: 50 }, (_, i) => st('x', `p${i}`, `v${i}`));
    const anchors = Array.from({ length: 30 }, (_, i) => anchor(`a${i}`));
    anchors[0] = anchor('x');
    const ctx = selectKnownClaims(statements, anchors);
    expect(ctx.claims.length).toBeLessThanOrEqual(6);
  });

  it('says nothing about an anchor the graph holds no claims for', () => {
    const ctx = selectKnownClaims([st('other', 'p', 'v')], [anchor('orange-logic')]);
    expect(ctx.claims).toHaveLength(0);
  });
});

describe('buildClaimsSection', () => {
  it('costs an empty graph nothing', () => {
    expect(buildClaimsSection({ claims: [], anchorsCovered: 0 })).toBe('');
  });

  it('marks unconfirmed claims and invites contradiction', () => {
    const ctx = selectKnownClaims(
      [st('orange-logic', 'is-a', 'Enterprise DAM', 'pending')],
      [anchor('orange-logic')],
    );
    const section = buildClaimsSection(ctx);

    expect(section).toContain('(unconfirmed)');
    // The whole point: the model must be free to say something BETTER, not just echo.
    expect(section).toContain('CONTRADICTS');
    expect(section).toContain('Do NOT re-emit');
  });

  it('does not label a confirmed claim as unconfirmed', () => {
    const ctx = selectKnownClaims([st('orange-logic', 'is-a', 'DAM')], [anchor('orange-logic')]);
    // Check the CLAIM LINE, not the whole section — the trailing instructions legitimately use
    // the word "(unconfirmed)" while explaining what the marker means.
    const claimLine = buildClaimsSection(ctx)
      .split('\n')
      .find((l) => l.trim().startsWith('- is-a'));
    expect(claimLine).toBeDefined();
    expect(claimLine).not.toContain('(unconfirmed)');
  });
});
