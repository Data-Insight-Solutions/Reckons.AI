/**
 * Entity type system for Reckons.AI.
 *
 * Built-in types are defined here as static data.
 * Custom types live as confirmed RDF statements in the KB itself
 * (portable, versioned, exported with the KB).
 *
 * Each type maps to a Three.js geometry name so GraphNode can
 * swap geometry without knowing about the type system directly.
 */

export type GeometryName =
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'box'
  | 'box-flat'
  | 'octahedron'
  | 'tetrahedron'
  | 'dodecahedron'
  | 'icosahedron'
  | 'capsule'
  | 'torus'
  | 'torus-knot';

export type EntityTypeDef = {
  iri: string;
  label: string;
  geometry: GeometryName;
  color: string;
  description: string;
  /** Suggested predicates for nodes of this type (shown in detail panel) */
  schemaPredicates: string[];
  builtIn: boolean;
  /** Emoji character (or short text) shown as a billboard icon on the node in 2D and 3D views */
  icon2d?: string;
  /** URL to a .glb model file used instead of the procedural geometry in the 3D view */
  icon3d?: string;
  /** Meshy.AI task ID when a 3D model is being generated */
  meshyTaskId?: string;
  /** Meshy.AI generation status */
  meshyStatus?: 'pending' | 'in-progress' | 'succeeded' | 'failed';
};

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const KB_ENTITY_TYPE = 'urn:kbase:type/EntityType';
export const KB_ICON = 'urn:kbase:predicate/icon';
export const KB_ICON2D = 'urn:kbase:predicate/icon2d';
export const KB_ICON3D = 'urn:kbase:predicate/icon3d';
export const KB_MESHY_TASK_ID = 'urn:kbase:predicate/meshy-task-id';
export const KB_MESHY_STATUS = 'urn:kbase:predicate/meshy-status';
export const KB_COLOR = 'urn:kbase:predicate/color';
export const KB_DESCRIPTION = 'urn:kbase:predicate/type-description';
export const KB_SCHEMA_PREDICATE = 'urn:kbase:predicate/schema-predicate';
export const KB_URL = 'urn:kbase:predicate/url';
export const KB_LOCAL_PATH = 'urn:kbase:predicate/local-path';

export const BUILT_IN_TYPES: EntityTypeDef[] = [
  {
    iri: 'urn:kbase:type/Person',
    label: 'Person',
    geometry: 'capsule',
    color: '#22d3ee',
    description: 'A human individual',
    icon2d: '👤',
    schemaPredicates: [
      'urn:kbase:predicate/birth-date',
      'urn:kbase:predicate/occupation',
      'urn:kbase:predicate/nationality',
      'urn:kbase:predicate/affiliation',
      'urn:kbase:predicate/email'
    ],
    builtIn: true
  },
  {
    iri: 'urn:kbase:type/Place',
    label: 'Place',
    geometry: 'cone',
    color: '#fb923c',
    description: 'A geographic or physical location',
    icon2d: '📍',
    schemaPredicates: [
      'urn:kbase:predicate/location',
      'urn:kbase:predicate/coordinates',
      'urn:kbase:predicate/country',
      'urn:kbase:predicate/address'
    ],
    builtIn: true
  },
  {
    iri: 'urn:kbase:type/Organization',
    label: 'Organization',
    geometry: 'box',
    color: '#c084fc',
    description: 'A company, institution, or group',
    icon2d: '🏛',
    schemaPredicates: [
      'urn:kbase:predicate/founded',
      'urn:kbase:predicate/headquarters',
      'urn:kbase:predicate/industry',
      'urn:kbase:predicate/member-count'
    ],
    builtIn: true
  },
  {
    iri: 'urn:kbase:type/Event',
    label: 'Event',
    geometry: 'torus',
    color: '#f43f5e',
    description: 'A happening at a point or span of time',
    icon2d: '📅',
    schemaPredicates: [
      'urn:kbase:meta/scheduled-at',
      'urn:kbase:meta/ends-at',
      'urn:kbase:meta/location',
      'urn:kbase:meta/description',
      'urn:kbase:predicate/attendee'
    ],
    builtIn: true
  },
  {
    iri: 'urn:kbase:type/CalendarEvent',
    label: 'Calendar Event',
    geometry: 'dodecahedron',
    color: '#4ade80',
    description: 'A calendar event (Google, Indico, iCal)',
    icon2d: '📆',
    schemaPredicates: [
      'urn:kbase:meta/scheduled-at',
      'urn:kbase:meta/ends-at',
      'urn:kbase:meta/location',
      'urn:kbase:meta/description',
      'urn:kbase:meta/attendees',
      'urn:kbase:meta/organizers',
      'urn:kbase:meta/url'
    ],
    builtIn: true
  },
  {
    iri: 'urn:kbase:type/Document',
    label: 'Document',
    geometry: 'box-flat',
    color: '#60a5fa',
    description: 'A written document, article, or file',
    icon2d: '📄',
    schemaPredicates: [
      'urn:kbase:predicate/author',
      'urn:kbase:predicate/published-at',
      'urn:kbase:predicate/url',
      'urn:kbase:predicate/local-path',
      'urn:kbase:predicate/description'
    ],
    builtIn: true
  },
  {
    iri: 'urn:kbase:type/Concept',
    label: 'Concept',
    geometry: 'icosahedron',
    color: '#ff6b35',
    description: 'An abstract idea or topic',
    icon2d: '💡',
    schemaPredicates: [
      'urn:kbase:predicate/definition',
      'urn:kbase:predicate/related-to',
      'urn:kbase:predicate/part-of',
      'urn:kbase:predicate/example'
    ],
    builtIn: true
  },
  {
    iri: 'urn:kbase:type/Tool',
    label: 'Tool',
    geometry: 'cylinder',
    color: '#e879f9',
    description: 'A software tool, library, or physical instrument',
    icon2d: '🔧',
    schemaPredicates: [
      'urn:kbase:predicate/version',
      'urn:kbase:predicate/language',
      'urn:kbase:predicate/url',
      'urn:kbase:predicate/created-by'
    ],
    builtIn: true
  }
];

/**
 * Geometry args for each geometry name (passed to Three.js constructors).
 * Sized so each shape has a clearly distinct silhouette at graph viewing distance.
 *
 * THREE arg order:
 *   sphere        (radius, widthSegs, heightSegs)
 *   cylinder      (radiusTop, radiusBottom, height, radialSegs)
 *   cone          (radius, height, radialSegs)
 *   box / box-flat (width, height, depth)
 *   octahedron / tetrahedron / dodecahedron / icosahedron  (radius, detail?)
 *   capsule       (radius, length, capSegs, radialSegs)
 *   torus         (radius, tube, radialSegs, tubularSegs)
 *   torus-knot    (radius, tube, tubularSegs, radialSegs, p, q)
 */
export const GEOMETRY_ARGS: Record<GeometryName, number[]> = {
  sphere:       [0.30, 7, 5],              // round, low-poly — literals / values
  cylinder:     [0.22, 0.22, 0.90, 6],    // tall hexagonal prism — clearly columnar
  cone:         [0.30, 0.95, 4],           // 4-sided spike — unmistakably pointed
  box:          [0.56, 0.56, 0.56],        // solid cube — rectilinear block
  'box-flat':   [0.80, 0.58, 0.08],        // wide, very thin slab — document page
  octahedron:   [0.44],                    // 8-face diamond — default unknown concept
  tetrahedron:  [0.52],                    // 4-face sharp pyramid — abstract concept
  dodecahedron: [0.36],                    // 12 pentagons — complex faceted sphere
  icosahedron:  [0.40, 0],                 // 20 triangles at detail-0 — angular geodesic
  capsule:      [0.20, 0.65, 4, 8],        // pill/elongated — humanoid person shape
  torus:        [0.36, 0.14, 6, 14],       // ring with clear hole — event loop
  'torus-knot': [0.24, 0.08, 80, 8, 2, 3], // knotted loop — complex tool
};

/** Fallback definition for unknown/custom types (nodes with no rdf:type). */
export const UNKNOWN_TYPE: EntityTypeDef = {
  iri: '',
  label: 'Unknown',
  geometry: 'octahedron',  // diamond — clearly not a sphere
  color: '#64748b',
  description: 'Custom or unrecognized entity type',
  schemaPredicates: [],
  builtIn: false
};

/** Build a lookup map from IRI → EntityTypeDef. */
export function buildTypeMap(custom: EntityTypeDef[]): Map<string, EntityTypeDef> {
  const map = new Map<string, EntityTypeDef>();
  for (const t of BUILT_IN_TYPES) map.set(t.iri, t);
  for (const t of custom) map.set(t.iri, t);
  return map;
}

/** Slug an arbitrary label into a valid IRI segment. */
export function labelToIri(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
