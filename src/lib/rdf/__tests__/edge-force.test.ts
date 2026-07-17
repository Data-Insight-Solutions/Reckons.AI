/**
 * F49 per-edge-kind force weights — the CRITICAL invariant: concept edges pull normally, nav and
 * page edges pull much more weakly, so the published site never warps the knowledge layout.
 */
import { describe, it, expect } from 'vitest';
import { edgeForceClass, edgeForceWeight, isSiteEdge, EDGE_FORCE_WEIGHT } from '../edge-force';

const SKOS = 'http://www.w3.org/2004/02/skos/core#';

describe('edgeForceClass', () => {
  it('an ordinary concept predicate is a concept edge', () => {
    expect(edgeForceClass('urn:kbase:predicate/depends-on')).toBe('concept');
    expect(edgeForceClass('urn:kbase:predicate/relates-to')).toBe('concept');
  });
  it('hierarchy/sequence predicates are nav edges', () => {
    expect(edgeForceClass(`${SKOS}broader`)).toBe('nav');
    expect(edgeForceClass('urn:reckons:nav/next')).toBe('nav');
    expect(edgeForceClass('urn:reckons:nav/anything-here')).toBe('nav'); // prefix match
  });
  it('page-namespace and page-link predicates are page edges', () => {
    expect(edgeForceClass('urn:kbase:page/slug')).toBe('page');
    expect(edgeForceClass('urn:kbase:predicate/has-page')).toBe('page');
  });
});

describe('edgeForceWeight — the invariant order concept >> nav >= page', () => {
  it('concept pulls hardest, page softest', () => {
    const concept = edgeForceWeight('urn:kbase:predicate/depends-on');
    const nav = edgeForceWeight(`${SKOS}broader`);
    const page = edgeForceWeight('urn:kbase:page/slug');
    expect(concept).toBeGreaterThan(nav);
    expect(nav).toBeGreaterThanOrEqual(page);
    expect(concept).toBe(1);
  });
  it('site edges pull at most a fraction of a concept edge (so they cannot warp the layout)', () => {
    expect(EDGE_FORCE_WEIGHT.nav).toBeLessThan(0.5);
    expect(EDGE_FORCE_WEIGHT.page).toBeLessThan(0.5);
  });
});

describe('isSiteEdge', () => {
  it('nav and page are site edges; concept is not', () => {
    expect(isSiteEdge(`${SKOS}broader`)).toBe(true);
    expect(isSiteEdge('urn:kbase:page/slug')).toBe(true);
    expect(isSiteEdge('urn:kbase:predicate/depends-on')).toBe(false);
  });
});
