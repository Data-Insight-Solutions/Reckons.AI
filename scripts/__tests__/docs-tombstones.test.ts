/**
 * RETIRED PAGES (kpred:superseded-by). A retired page keeps a tombstone entity; it builds no page
 * and its old URL, plus any old per-step URLs, answers with a 301 to the successor. Derived from
 * the graph so no hand-kept list can drift.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  splitTombstones, tombstoneRedirects, pagePath, SUPERSEDED_BY, RETIRED_STEPS, type Entity,
} from '../docs-pages';

function ent(iri: string, over: Partial<Entity> = {}): Entity {
  return {
    iri, section: 'Testing', title: iri, types: [], definition: '', parent: null, navOrder: null,
    literalProps: new Map(), iriProps: new Map(), diagram: null, diagramCaption: null,
    scene: null, sceneCaption: null, sceneAlt: null, sceneLive: null, leapTo: null, renderAs: null,
    ...over,
  };
}

const OLD = 'urn:reckons:test/Workflow-BuildChange';
const NEW = 'urn:reckons:test/Workflow-CompareV029';

describe('retired pages', () => {
  const old = ent(OLD, {
    iriProps: new Map([[SUPERSEDED_BY, [NEW]]]),
    literalProps: new Map([[RETIRED_STEPS, ['3']]]),
  });
  const next = ent(NEW);

  it('sets tombstones apart so they build no page', () => {
    const { live, tombstones } = splitTombstones([old, next]);
    expect(live.map((e) => e.iri)).toEqual([NEW]);
    expect(tombstones.map((e) => e.iri)).toEqual([OLD]);
  });

  it('derives the old URL from section and slug, as a page path is derived', () => {
    expect(pagePath(old)).toBe('/docs/testing/workflow-build-change');
  });

  it('redirects the old URL and its step URLs to the successor page', () => {
    const { rules, missing } = tombstoneRedirects([old], () => '/docs/testing/workflow-compare-v029');
    expect(missing).toEqual([]);
    expect(rules).toEqual([
      { from: '/docs/testing/workflow-build-change', to: '/docs/testing/workflow-compare-v029' },
      { from: '/docs/testing/workflow-build-change-step1', to: '/docs/testing/workflow-compare-v029' },
      { from: '/docs/testing/workflow-build-change-step2', to: '/docs/testing/workflow-compare-v029' },
      { from: '/docs/testing/workflow-build-change-step3', to: '/docs/testing/workflow-compare-v029' },
    ]);
  });

  it('reports a successor with no page instead of emitting a dead redirect', () => {
    const { rules, missing } = tombstoneRedirects([old], () => null);
    expect(rules).toEqual([]);
    expect(missing).toHaveLength(1);
  });

  it('honours an explicit page slug and section override', () => {
    const e = ent('urn:x/Thing', { literalProps: new Map([['urn:kbase:predicate/page-slug', ['old-name']], ['urn:kbase:predicate/page-section', ['Learn']]]) });
    expect(pagePath(e)).toBe('/docs/learn/old-name');
  });

  it('the committed redirects file holds the Workflow-BuildChange rules', () => {
    const text = readFileSync(join(resolve(import.meta.dirname ?? '.', '..', '..'), 'static', '_redirects'), 'utf8');
    expect(text).toContain('/docs/testing/workflow-build-change  /docs/testing/workflow-compare-v029  301');
    expect(text).toContain('/docs/testing/workflow-build-change-step6  /docs/testing/workflow-compare-v029  301');
  });
});
