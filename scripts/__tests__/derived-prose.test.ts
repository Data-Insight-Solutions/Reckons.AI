/**
 * DERIVED PROSE (F192, kb:derived-prose) — the sentences a page states that nobody wrote.
 *
 * This test exists because status-evidence.ts caught the feature shipped as `functional` with no
 * test linked and no kpred:test-coverage "none" declared, which kb:honest-status calls an
 * UNDECLARED GAP: you may ship untested code, but not silently.
 *
 * What is worth testing here is not the wording. It is the three rules that make computed text
 * safe to put on a page a reader trusts:
 *
 *   1. It never leads. A derived sentence is ABOUT the thing; with no definition above it, the
 *      page opens with "It has 10 parts below." That happened, on content/principles/thesis.md.
 *   2. It claims only what the facts support — no status, no sentence about status.
 *   3. It is marked as derived, so a reader can tell computed text from written text and
 *      docs-edits.ts never proposes an edit to it back into the graph as though someone wrote it.
 */

import { describe, expect, it } from 'vitest';
import { renderDerived, type ChildRef, type Entity } from '../docs-pages';

const HAS_STATUS = 'urn:kbase:predicate/has-status';
const USES = 'urn:kbase:predicate/uses';

function entity(over: Partial<Entity> = {}): Entity {
  return {
    iri: 'urn:kbase:concept/thing',
    section: 'learn',
    title: 'A thing',
    types: ['Feature'],
    definition: 'A thing that does something.',
    parent: null,
    navOrder: null,
    literalProps: new Map(),
    iriProps: new Map(),
    diagram: null,
    diagramCaption: null,
    scene: null,
    sceneCaption: null,
    sceneAlt: null,
    sceneLive: null,
    leapTo: null,
    renderAs: null,
    ...over,
  };
}

function child(status: string | null): ChildRef {
  return { slug: 's', section: 'learn', title: 'C', types: [], excerpt: '', status, order: 0 } as ChildRef;
}

const text = (out: string[]) => out.join(' ');

describe('renderDerived', () => {
  it('says nothing at all when the entity has no definition of its own', () => {
    // The thesis-page regression: with nothing to introduce the page, a computed sentence becomes
    // the lede. Silence is the correct output, not a fallback sentence.
    const out = renderDerived(
      entity({ definition: '', literalProps: new Map([[HAS_STATUS, ['production']]]) }),
      [child('production'), child('planned')],
    );
    expect(out).toEqual([]);
  });

  it('says nothing when there are no facts to derive from', () => {
    expect(renderDerived(entity(), [])).toEqual([]);
  });

  it('marks its output as derived, so computed text is distinguishable from written text', () => {
    const out = renderDerived(entity({ literalProps: new Map([[HAS_STATUS, ['functional']]]) }), []);
    expect(out[0]).toContain('class="derived"');
  });

  it('turns a status into a plain-English stance', () => {
    const stance = (s: string) =>
      text(renderDerived(entity({ literalProps: new Map([[HAS_STATUS, [s]]]) }), []));
    expect(stance('planned')).toContain('is planned and not built yet');
    expect(stance('production')).toContain('in daily use here');
    expect(stance('speculative')).toContain('nothing is built');
  });

  it('is silent about status when the graph does not state one', () => {
    // The point of derived prose is that it cannot be wrong unless the facts are. An unstated
    // status must produce no claim about status rather than a default one.
    const out = text(renderDerived(entity(), [child('functional')]));
    expect(out).not.toMatch(/built|planned|idea/);
    expect(out).toContain('It has one part below');
  });

  it('counts the parts, and says how many are not built', () => {
    const out = text(renderDerived(entity(), [child('production'), child('planned'), child('planned')]));
    expect(out).toContain('It has 3 parts below, 2 of which are not built yet');
  });

  it('does not append the unbuilt clause when every part is built', () => {
    const out = text(renderDerived(entity(), [child('functional'), child('production')]));
    expect(out).toContain('It has 2 parts below');
    expect(out).not.toContain('not built yet');
  });

  it('agrees in number for one part and one unbuilt part', () => {
    expect(text(renderDerived(entity(), [child('planned')])))
      .toContain('It has one part below, 1 of which is not built yet');
  });

  it('counts what the entity builds on, pluralising correctly', () => {
    const one = text(renderDerived(entity({ iriProps: new Map([[USES, ['a']]]) }), []));
    const many = text(renderDerived(entity({ iriProps: new Map([[USES, ['a', 'b']]]) }), []));
    expect(one).toContain('It builds on 1 other capability');
    expect(many).toContain('It builds on 2 other capabilities');
  });

  it('changes when the status changes and nothing else does — the whole point of the feature', () => {
    const before = text(renderDerived(entity({ literalProps: new Map([[HAS_STATUS, ['planned']]]) }), []));
    const after = text(renderDerived(entity({ literalProps: new Map([[HAS_STATUS, ['production']]]) }), []));
    expect(before).not.toEqual(after);
  });
});
