/**
 * Per-edge-kind force weights — the CRITICAL enabler for Graph-as-Site-Navigation (F49,
 * kb:graph-as-navigation).
 *
 * F49 makes published pages first-class graph nodes, so the graph IS the site map. The trap the
 * roadmap flags as CRITICAL: a nav hub linked to many pages (or pages linked across every concept)
 * would collapse or warp the knowledge layout if its edges pulled as hard as concept edges. A
 * force-directed layout is a physics of springs; adding the whole published site must not distort
 * the shape of what the graph actually MEANS.
 *
 * The fix is per-edge-kind spring weights: concept edges pull normally; navigation and page edges
 * pull very LIGHTLY (or are laid out in a secondary pass). This module is the pure classifier the
 * force simulation multiplies its spring strength by — so the knowledge layout stays the knowledge
 * layout, and the site structure rides on top without deforming it.
 *
 * Pure and deterministic: predicate IRI in, weight out. The simulation wiring lives in the 2D/3D
 * graph; this is only the decision of how hard each kind of edge should pull.
 */

export type EdgeForceClass = 'concept' | 'nav' | 'page';

/**
 * Spring-weight multiplier per edge kind. Concept edges are the baseline (1); nav and page edges
 * pull far more weakly so a densely-connected site hub cannot warp the knowledge layout. Tunable,
 * but the ORDER (concept >> nav >= page) is the invariant F49 depends on.
 */
export const EDGE_FORCE_WEIGHT: Record<EdgeForceClass, number> = {
  concept: 1,
  nav: 0.15,
  page: 0.1,
};

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
/** Navigation predicates: the hierarchy/sequence vocabulary the hnav trees already use. */
const NAV_PREDICATES = new Set<string>([
  `${SKOS}broader`,
  `${SKOS}narrower`,
  'urn:reckons:nav/next',
  'urn:reckons:nav/prev',
  'urn:reckons:nav/order',
  'urn:reckons:nav/layer',
]);
const NAV_PREFIXES = ['urn:reckons:nav/'];
/** Page-structure predicates: everything under the page namespace, plus explicit page links. */
const PAGE_PREFIXES = ['urn:kbase:page/'];
const PAGE_PREDICATES = new Set<string>([
  'urn:kbase:predicate/has-page',
  'urn:kbase:predicate/references-page',
  'urn:kbase:predicate/derived-from-page',
  'urn:kbase:predicate/landing-page',
  'urn:kbase:predicate/subpage',
]);

/** Classify an edge by its predicate IRI: concept (default), nav, or page. */
export function edgeForceClass(predicate: string): EdgeForceClass {
  if (PAGE_PREDICATES.has(predicate) || PAGE_PREFIXES.some((p) => predicate.startsWith(p))) return 'page';
  if (NAV_PREDICATES.has(predicate) || NAV_PREFIXES.some((p) => predicate.startsWith(p))) return 'nav';
  return 'concept';
}

/** The spring-weight multiplier for an edge — what the force simulation scales its strength by. */
export function edgeForceWeight(predicate: string): number {
  return EDGE_FORCE_WEIGHT[edgeForceClass(predicate)];
}

/** True when an edge is site structure (nav or page) rather than knowledge — for a secondary pass. */
export function isSiteEdge(predicate: string): boolean {
  return edgeForceClass(predicate) !== 'concept';
}
