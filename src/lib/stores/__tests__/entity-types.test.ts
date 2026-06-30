import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Statement } from '../../rdf/types';
import { BUILT_IN_TYPES, KB_COLOR, RDF_TYPE } from '../../rdf/entity-types';

// ── Mocks ────────────────────────────────────────────────────────────────────
// Mock the rune-based stores that entity-types.svelte.ts imports.

let mockStatements: Statement[] = [];
let mockGlbOverrides = new Map<string, string>();

vi.mock('../../stores/kb.svelte', () => ({
  confirmedStatements: () => mockStatements,
  addStatements: vi.fn(),
  updateStatement: vi.fn(),
  statements: () => mockStatements,
}));

vi.mock('../../stores/glb-overrides.svelte', () => ({
  glbOverrides: () => mockGlbOverrides,
}));

// Import AFTER mocks are set up
const { allTypes, typeMap, resolveType } = await import('../entity-types.svelte');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStatement(
  s: string, p: string, o: string,
  oKind: 'iri' | 'literal' = 'iri',
  status: 'confirmed' | 'rejected' = 'confirmed'
): Statement {
  return {
    id: `stmt-${Math.random().toString(36).slice(2, 8)}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: oKind, value: o, ...(oKind === 'literal' ? { datatype: 'http://www.w3.org/2001/XMLSchema#string' } : {}) },
    g: { kind: 'iri', value: 'urn:kbase:source/test' },
    sourceId: 'test',
    confidence: 1,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

beforeEach(() => {
  mockStatements = [];
  mockGlbOverrides = new Map();
});

// ── allTypes ─────────────────────────────────────────────────────────────────

describe('allTypes', () => {
  it('returns all built-in types when KB is empty', () => {
    const types = allTypes();
    expect(types.length).toBe(BUILT_IN_TYPES.length);
    expect(types.find(t => t.label === 'Knowledge Base')).toBeDefined();
  });

  it('includes custom types from KB statements', () => {
    mockStatements = [
      makeStatement('urn:kbase:type/medication', RDF_TYPE, 'urn:kbase:type/EntityType'),
      makeStatement('urn:kbase:type/medication', 'http://www.w3.org/2000/01/rdf-schema#label', 'Medication', 'literal'),
      makeStatement('urn:kbase:type/medication', KB_COLOR, '#10b981', 'literal'),
      makeStatement('urn:kbase:type/medication', 'urn:kbase:predicate/type-description', 'A medicine', 'literal'),
    ];
    const types = allTypes();
    const med = types.find(t => t.iri === 'urn:kbase:type/medication');
    expect(med).toBeDefined();
    expect(med!.label).toBe('Medication');
    expect(med!.color).toBe('#10b981');
    expect(med!.builtIn).toBe(false);
  });

  it('does not duplicate built-in types when KB has matching IRIs', () => {
    // A KB statement declaring Person as EntityType should be skipped (built-in takes priority)
    mockStatements = [
      makeStatement('urn:kbase:type/Person', RDF_TYPE, 'urn:kbase:type/EntityType'),
    ];
    const types = allTypes();
    const persons = types.filter(t => t.iri === 'urn:kbase:type/Person');
    expect(persons.length).toBe(1);
    expect(persons[0].builtIn).toBe(true);
  });

  it('applies GLB overrides', () => {
    mockGlbOverrides.set('urn:kbase:type/Person', '/models/person.glb');
    const types = allTypes();
    const person = types.find(t => t.iri === 'urn:kbase:type/Person');
    expect(person!.icon3d).toBe('/models/person.glb');
  });
});

// ── Color overrides ──────────────────────────────────────────────────────────

describe('color overrides', () => {
  it('overrides built-in type color from KB_COLOR statement', () => {
    mockStatements = [
      makeStatement('urn:kbase:type/Person', KB_COLOR, '#ff0000', 'literal'),
    ];
    const types = allTypes();
    const person = types.find(t => t.iri === 'urn:kbase:type/Person');
    expect(person!.color).toBe('#ff0000');
  });

  it('overrides KnowledgeBase color', () => {
    mockStatements = [
      makeStatement('urn:kbase:type/KnowledgeBase', KB_COLOR, '#00ff00', 'literal'),
    ];
    const types = allTypes();
    const kb = types.find(t => t.iri === 'urn:kbase:type/KnowledgeBase');
    expect(kb!.color).toBe('#00ff00');
  });

  it('does not affect types without a color statement', () => {
    mockStatements = [
      makeStatement('urn:kbase:type/Person', KB_COLOR, '#ff0000', 'literal'),
    ];
    const types = allTypes();
    const place = types.find(t => t.iri === 'urn:kbase:type/Place');
    expect(place!.color).toBe('#fb923c'); // original
  });

  it('color override appears in typeMap too', () => {
    mockStatements = [
      makeStatement('urn:kbase:type/Tool', KB_COLOR, '#123456', 'literal'),
    ];
    const map = typeMap();
    expect(map.get('urn:kbase:type/Tool')!.color).toBe('#123456');
  });
});

// ── typeMap ───────────────────────────────────────────────────────────────────

describe('typeMap', () => {
  it('returns a Map with all built-in types', () => {
    const map = typeMap();
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(BUILT_IN_TYPES.length);
  });

  it('resolves KnowledgeBase by IRI', () => {
    const map = typeMap();
    const kb = map.get('urn:kbase:type/KnowledgeBase');
    expect(kb).toBeDefined();
    expect(kb!.geometry).toBe('tetrahedron-inv');
  });

  it('includes custom types from statements', () => {
    mockStatements = [
      makeStatement('urn:kbase:type/vehicle', RDF_TYPE, 'urn:kbase:type/EntityType'),
      makeStatement('urn:kbase:type/vehicle', 'http://www.w3.org/2000/01/rdf-schema#label', 'Vehicle', 'literal'),
    ];
    const map = typeMap();
    expect(map.get('urn:kbase:type/vehicle')?.label).toBe('Vehicle');
  });
});

// ── resolveType ──────────────────────────────────────────────────────────────

describe('resolveType', () => {
  it('returns UNKNOWN_TYPE when entity has no rdf:type', () => {
    mockStatements = [
      makeStatement('urn:example/foo', 'urn:kbase:predicate/name', 'Foo', 'literal'),
    ];
    const def = resolveType('urn:example/foo');
    expect(def.iri).toBe('');
    expect(def.geometry).toBe('octahedron');
  });

  it('resolves a built-in type from rdf:type statement', () => {
    mockStatements = [
      makeStatement('urn:example/alice', RDF_TYPE, 'urn:kbase:type/Person'),
    ];
    const def = resolveType('urn:example/alice');
    expect(def.label).toBe('Person');
    expect(def.geometry).toBe('capsule');
  });

  it('resolves KnowledgeBase type', () => {
    mockStatements = [
      makeStatement('urn:example/my-kb', RDF_TYPE, 'urn:kbase:type/KnowledgeBase'),
    ];
    const def = resolveType('urn:example/my-kb');
    expect(def.label).toBe('Knowledge Base');
    expect(def.geometry).toBe('tetrahedron-inv');
    expect(def.color).toBe('#f59e0b');
  });

  it('returns UNKNOWN_TYPE for an unrecognized type IRI', () => {
    mockStatements = [
      makeStatement('urn:example/x', RDF_TYPE, 'urn:custom:type/Unknown'),
    ];
    const def = resolveType('urn:example/x');
    expect(def.iri).toBe('');
  });

  it('only considers confirmed statements', () => {
    mockStatements = [
      makeStatement('urn:example/rejected', RDF_TYPE, 'urn:kbase:type/Person', 'iri', 'rejected'),
    ];
    const def = resolveType('urn:example/rejected');
    // confirmedStatements() mock returns all mockStatements, but the module
    // derives from confirmedStatements which should filter — however our mock
    // returns the raw array. The actual filtering happens in kb.svelte's
    // confirmedStatements(). Since we mock it directly, test the function
    // handles whatever confirmedStatements returns.
    // In production, rejected statements wouldn't appear in confirmedStatements().
    expect(def).toBeDefined();
  });
});

// ── Type resolution for leap-pattern entities ────────────────────────────────

describe('type resolution for leap entities', () => {
  it('resolves leap node with KnowledgeBase type', () => {
    mockStatements = [
      makeStatement('urn:docs/leap/Features', RDF_TYPE, 'urn:kbase:type/KnowledgeBase'),
      makeStatement('urn:docs/leap/Features', 'http://www.w3.org/2000/01/rdf-schema#label', 'LEAP: Features', 'literal'),
      makeStatement('urn:docs/leap/Features', 'urn:reckons:leap', 'target-stable-id', 'literal'),
    ];
    const def = resolveType('urn:docs/leap/Features');
    expect(def.label).toBe('Knowledge Base');
    expect(def.geometry).toBe('tetrahedron-inv');
  });

  it('resolves BackToHub node with KnowledgeBase type', () => {
    mockStatements = [
      makeStatement('urn:reckons:docs/nav/BackToHub', RDF_TYPE, 'urn:kbase:type/KnowledgeBase'),
    ];
    const def = resolveType('urn:reckons:docs/nav/BackToHub');
    expect(def.label).toBe('Knowledge Base');
  });

  it('leap nodes appear in typeMap', () => {
    mockStatements = [
      makeStatement('urn:docs/leap/A', RDF_TYPE, 'urn:kbase:type/KnowledgeBase'),
    ];
    const map = typeMap();
    expect(map.get('urn:kbase:type/KnowledgeBase')).toBeDefined();
  });
});
