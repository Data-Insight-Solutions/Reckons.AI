/**
 * Ghost graph — lightweight preview of a target KB for leap node preview.
 *
 * When a leap node is selected, we parse the target KB's TTL and extract
 * a simplified node+edge structure for transparent overlay rendering.
 * This gives users a "see through" preview before they leap — like looking
 * down through an HNSW layer to the denser layer below.
 */

import type { Statement } from './types';

const RDF_TYPE   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_DEF   = 'http://www.w3.org/2004/02/skos/core#definition';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';

export interface GhostNode {
  iri: string;
  label: string;
  /** Whether this is a high-degree hub in the target KB */
  isHub: boolean;
}

export interface GhostEdge {
  source: string; // IRI
  target: string; // IRI
  predicate: string;
}

export interface GhostGraph {
  nodes: GhostNode[];
  edges: GhostEdge[];
  /** How many total entities in the target KB (for scale indicator) */
  totalEntities: number;
}

/** Parse raw TTL text into a ghost graph structure (no IndexedDB, no Statement objects). */
export async function parseGhostGraph(ttlText: string): Promise<GhostGraph> {
  const { Parser } = await import('n3');
  const parser = new Parser();
  const quads = parser.parse(ttlText);

  const labels = new Map<string, string>();
  const types = new Map<string, string>();
  const entityIris = new Set<string>();
  const edges: GhostEdge[] = [];
  const degree = new Map<string, number>();

  // Meta predicates to skip as edges
  const SKIP_PREDICATES = new Set([
    RDF_TYPE, RDFS_LABEL, SKOS_DEF,
    'urn:kbase:meta/kbStableId',
    'urn:kbase:predicate/icon2d',
    'urn:kbase:meta/glbModel',
    'urn:reckons:nav/order',
    'urn:reckons:nav/layer',
    'urn:reckons:leap',
    'urn:reckons:leap/label',
  ]);

  for (const q of quads) {
    const s = q.subject.value;
    const p = q.predicate.value;
    const o = q.object.value;
    const oIsIri = q.object.termType === 'NamedNode';

    if (p === RDFS_LABEL) {
      labels.set(s, o);
      entityIris.add(s);
      continue;
    }

    if (p === RDF_TYPE) {
      types.set(s, o);
      entityIris.add(s);
      continue;
    }

    if (SKIP_PREDICATES.has(p)) continue;
    if (p.startsWith('urn:kbase:meta/')) continue;

    entityIris.add(s);
    if (oIsIri) {
      entityIris.add(o);
      edges.push({ source: s, target: o, predicate: p });
      degree.set(s, (degree.get(s) ?? 0) + 1);
      degree.set(o, (degree.get(o) ?? 0) + 1);
    }
  }

  // Find top hubs by degree
  const sortedByDegree = [...degree.entries()].sort((a, b) => b[1] - a[1]);
  const hubThreshold = sortedByDegree.length > 5 ? sortedByDegree[4][1] : 0;

  const nodes: GhostNode[] = [...entityIris].map(iri => ({
    iri,
    label: labels.get(iri) ?? iri.split('/').pop() ?? iri,
    isHub: (degree.get(iri) ?? 0) >= hubThreshold && hubThreshold > 1,
  }));

  return { nodes, edges, totalEntities: nodes.length };
}

// Simple in-memory cache to avoid re-parsing on hover
const ghostCache = new Map<string, GhostGraph>();

/** Fetch and parse a ghost graph, with caching. */
export async function fetchGhostGraph(filePath: string): Promise<GhostGraph> {
  const cached = ghostCache.get(filePath);
  if (cached) return cached;

  const resp = await fetch(filePath);
  if (!resp.ok) throw new Error(`Failed to fetch ${filePath}`);
  const ttlText = await resp.text();
  const graph = await parseGhostGraph(ttlText);
  ghostCache.set(filePath, graph);
  return graph;
}
