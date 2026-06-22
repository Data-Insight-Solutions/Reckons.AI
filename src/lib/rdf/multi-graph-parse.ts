/**
 * multi-graph-parse.ts
 * Parse multiple Turtle files into a unified structure for multi-graph overlay visualization.
 * Tracks which projects reference each entity so we can render Venn-style membership.
 */

export type GraphDef = {
  id: string;
  label: string;
  color: string;
  tripleCount: number;
};

export type OverlayNode = {
  key: string;
  label: string;
  rdfType: string | null;
  /** Which graph IDs reference this node via membership predicates */
  membership: Set<string>;
};

export type OverlayEdge = {
  sourceKey: string;
  targetKey: string;
  predicate: string;
  predicateIri: string;
  graphIds: Set<string>;
};

export type OverlayData = {
  graphs: GraphDef[];
  nodes: Map<string, OverlayNode>;
  edges: OverlayEdge[];
};

export const GRAPH_COLORS = [
  '#1a9b8e', '#3d7cf5', '#e8534b', '#9b6ee0',
  '#e8b84b', '#5db876', '#ff6b35', '#e06eb8',
  '#6ecfe0', '#b8a05d'
];

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/** Predicates where Project -> Entity means the entity belongs to that project */
export const MEMBERSHIP_PREDICATES = new Set([
  'urn:reckons:ontology/usesTechnology',
  'urn:reckons:ontology/hasComponent',
  'urn:reckons:ontology/hasFeature',
  'urn:reckons:ontology/followsPattern',
  'urn:reckons:ontology/hasDataModel',
  'urn:reckons:ontology/dependsOn',
  'urn:reckons:ontology/hasInterface',
]);

export const MEMBERSHIP_LABELS: Record<string, string> = {
  'urn:reckons:ontology/usesTechnology': 'Technologies',
  'urn:reckons:ontology/hasComponent': 'Components',
  'urn:reckons:ontology/hasFeature': 'Features',
  'urn:reckons:ontology/followsPattern': 'Patterns',
  'urn:reckons:ontology/hasDataModel': 'Data Models',
  'urn:reckons:ontology/dependsOn': 'Dependencies',
  'urn:reckons:ontology/hasInterface': 'Interfaces',
};

function shortLabel(iri: string): string {
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  const pos = Math.max(hash, slash);
  return pos >= 0 ? iri.slice(pos + 1) : iri;
}

export function isProjectIri(iri: string): boolean {
  return iri.startsWith('urn:reckons:project/');
}

export async function parseMultipleGraphs(
  files: Array<{ id: string; content: string }>
): Promise<OverlayData> {
  const { Parser } = await import('n3');

  const graphs: GraphDef[] = [];
  const allNodes = new Map<string, OverlayNode>();
  const edgeMap = new Map<string, OverlayEdge>();

  for (let gi = 0; gi < files.length; gi++) {
    const file = files[gi];
    const parser = new Parser({ format: 'Turtle' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let quads: any[];
    try {
      quads = parser.parse(file.content);
    } catch (e) {
      console.warn(`Failed to parse ${file.id}:`, e);
      continue;
    }

    // Find the rk:Project entity and its label
    let projectLabel = file.id;
    let projectIri: string | null = null;
    for (const q of quads) {
      if (q.predicate.value === RDF_TYPE &&
          q.object.value === 'urn:reckons:ontology/Project') {
        projectIri = q.subject.value;
      }
    }
    if (projectIri) {
      for (const q of quads) {
        if (q.predicate.value === RDFS_LABEL && q.subject.value === projectIri) {
          projectLabel = q.object.value;
          break;
        }
      }
    }

    graphs.push({
      id: file.id,
      label: projectLabel,
      color: GRAPH_COLORS[gi % GRAPH_COLORS.length],
      tripleCount: quads.length
    });

    for (const q of quads) {
      const sIri: string = q.subject.value;
      const pIri: string = q.predicate.value;
      const oVal: string = q.object.value;
      const oIsLiteral = q.object.termType === 'Literal';

      // Skip owl/rdfs schema definitions
      if (pIri.startsWith('http://www.w3.org/2002/07/owl#')) continue;
      if (pIri === 'http://www.w3.org/2000/01/rdf-schema#domain') continue;
      if (pIri === 'http://www.w3.org/2000/01/rdf-schema#range') continue;
      if (pIri === 'http://www.w3.org/2000/01/rdf-schema#comment') continue;
      if (pIri === 'http://purl.org/dc/terms/description') continue;

      // rdf:type — set the type on the node
      if (pIri === RDF_TYPE) {
        const node = allNodes.get(sIri) ?? {
          key: sIri, label: shortLabel(sIri), rdfType: null, membership: new Set()
        };
        node.rdfType = oVal;
        allNodes.set(sIri, node);
        continue;
      }

      // rdfs:label — update display label
      if (pIri === RDFS_LABEL && oIsLiteral) {
        const node = allNodes.get(sIri) ?? {
          key: sIri, label: oVal, rdfType: null, membership: new Set()
        };
        node.label = oVal;
        allNodes.set(sIri, node);
        continue;
      }

      // Skip literal-valued properties
      if (oIsLiteral) continue;

      // Ensure both nodes exist
      const ensure = (iri: string) => {
        if (!allNodes.has(iri)) {
          allNodes.set(iri, { key: iri, label: shortLabel(iri), rdfType: null, membership: new Set() });
        }
      };
      ensure(sIri);
      ensure(oVal);

      // Membership predicates: Project -> Entity
      if (MEMBERSHIP_PREDICATES.has(pIri) && isProjectIri(sIri)) {
        allNodes.get(oVal)!.membership.add(file.id);
        allNodes.get(sIri)!.membership.add(file.id);
      }

      // Create/update edge
      const edgeKey = `${sIri}>${pIri}>${oVal}`;
      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, {
          sourceKey: sIri, targetKey: oVal,
          predicate: shortLabel(pIri), predicateIri: pIri,
          graphIds: new Set()
        });
      }
      edgeMap.get(edgeKey)!.graphIds.add(file.id);
    }
  }

  return { graphs, nodes: allNodes, edges: [...edgeMap.values()] };
}
