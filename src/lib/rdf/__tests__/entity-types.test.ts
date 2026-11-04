import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_TYPES,
  GEOMETRY_ARGS,
  UNKNOWN_TYPE,
  buildTypeMap,
  labelToIri,
  type GeometryName,
  type EntityTypeDef,
  RDF_TYPE,
  KB_COLOR,
  KNOWLEDGE_BASE_ENTITY_TYPE,
} from '../entity-types';
import { isMetaPredicate, GENERATION_PROVENANCE_PREDICATES } from '../types';

// ── BUILT_IN_TYPES ──────────────────────────────────────────────────────────

describe('BUILT_IN_TYPES', () => {
  it('includes the KnowledgeBase type', () => {
    const kb = BUILT_IN_TYPES.find(t => t.iri === 'urn:kbase:type/KnowledgeBase');
    expect(kb).toBeDefined();
    expect(kb!.label).toBe('Graph');
    expect(kb!.geometry).toBe('tetrahedron-inv');
    expect(kb!.builtIn).toBe(true);
  });

  it('has all expected built-in types', () => {
    const labels = BUILT_IN_TYPES.map(t => t.label);
    expect(labels).toContain('Person');
    expect(labels).toContain('Place');
    expect(labels).toContain('Organization');
    expect(labels).toContain('Event');
    expect(labels).toContain('Calendar Event');
    expect(labels).toContain('Document');
    expect(labels).toContain('Concept');
    expect(labels).toContain('Tool');
    expect(labels).toContain('Graph');
  });

  it('all types have unique IRIs', () => {
    const iris = BUILT_IN_TYPES.map(t => t.iri);
    expect(new Set(iris).size).toBe(iris.length);
  });

  it('all types have unique geometries except known shares', () => {
    // cone and tetrahedron share the upward triangle in 2D — that's by design.
    // box-flat (the flat page slab) is shared by Document and Web Page — both are
    // flat "page" concepts, differentiated by color and icon (📄 blue vs 🌐 green).
    // torus-knot is shared by the TWO SPELLINGS OF ONE TYPE: ktype:EntitySet (F65, still in
    // graphs in the wild) and skos:Collection (what the app writes since 2026-09-11). They are
    // deliberately identical in every visible way — a set must not change shape on the canvas
    // because of which dialect wrote it.
    // F58.9.5: Image (box-flat), Video (box) and License (cylinder) reuse a shape because the
    // renderer has no unused shape left; they differ by color and icon, like Document and Web Page.
    // F166.1.2: Job reuses box for the same reason.
    const SHARED_GEOMETRIES = new Set(['cone', 'tetrahedron', 'box-flat', 'torus-knot', 'box', 'cylinder']);
    const geoCounts = new Map<string, string[]>();
    for (const t of BUILT_IN_TYPES) {
      const list = geoCounts.get(t.geometry) ?? [];
      list.push(t.label);
      geoCounts.set(t.geometry, list);
    }
    // Each geometry should map to at most 1 type (except the known shares)
    for (const [geo, types] of geoCounts) {
      if (SHARED_GEOMETRIES.has(geo)) continue;
      expect(types, `geometry '${geo}' used by: ${types.join(', ')}`).toHaveLength(1);
    }
  });

  it('the two spellings of Set are visually identical', () => {
    const sets = BUILT_IN_TYPES.filter((t) => t.label === 'Collection');
    expect(sets).toHaveLength(2);
    const [a, b] = sets;
    // If these ever diverge, the same set renders differently depending on which vocabulary
    // wrote it — the exact confusion merging the two vocabularies was meant to end.
    expect(a.geometry).toBe(b.geometry);
    expect(a.color).toBe(b.color);
    expect(a.icon2d).toBe(b.icon2d);
  });

  it('all types have a color string starting with #', () => {
    for (const t of BUILT_IN_TYPES) {
      expect(t.color, `${t.label} color`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('all built-in types have builtIn=true', () => {
    for (const t of BUILT_IN_TYPES) {
      expect(t.builtIn, `${t.label} builtIn`).toBe(true);
    }
  });

  it('all types have a non-empty description', () => {
    for (const t of BUILT_IN_TYPES) {
      expect(t.description.length, `${t.label} description`).toBeGreaterThan(0);
    }
  });

  it('all types have an icon2d', () => {
    for (const t of BUILT_IN_TYPES) {
      expect(t.icon2d, `${t.label} icon2d`).toBeDefined();
    }
  });
});

// ── GEOMETRY_ARGS ────────────────────────────────────────────────────────────

describe('GEOMETRY_ARGS', () => {
  it('has an entry for every GeometryName used by built-in types', () => {
    for (const t of BUILT_IN_TYPES) {
      expect(GEOMETRY_ARGS[t.geometry], `missing GEOMETRY_ARGS for '${t.geometry}'`).toBeDefined();
    }
  });

  it('has an entry for tetrahedron-inv', () => {
    expect(GEOMETRY_ARGS['tetrahedron-inv']).toBeDefined();
    expect(GEOMETRY_ARGS['tetrahedron-inv'].length).toBeGreaterThan(0);
  });

  it('all entries are non-empty number arrays', () => {
    for (const [name, args] of Object.entries(GEOMETRY_ARGS)) {
      expect(Array.isArray(args), `${name} is array`).toBe(true);
      expect(args.length, `${name} has args`).toBeGreaterThan(0);
      for (const a of args) {
        expect(typeof a, `${name} arg type`).toBe('number');
      }
    }
  });
});

// ── UNKNOWN_TYPE ─────────────────────────────────────────────────────────────

describe('UNKNOWN_TYPE', () => {
  it('uses octahedron geometry', () => {
    expect(UNKNOWN_TYPE.geometry).toBe('octahedron');
  });

  it('is not built-in', () => {
    expect(UNKNOWN_TYPE.builtIn).toBe(false);
  });

  it('has an empty IRI', () => {
    expect(UNKNOWN_TYPE.iri).toBe('');
  });
});

// ── buildTypeMap ─────────────────────────────────────────────────────────────

describe('buildTypeMap', () => {
  it('includes all built-in types', () => {
    const map = buildTypeMap([]);
    for (const t of BUILT_IN_TYPES) {
      expect(map.get(t.iri), `missing ${t.label}`).toBeDefined();
    }
  });

  it('includes custom types', () => {
    const custom: EntityTypeDef = {
      iri: 'urn:kbase:type/Medication',
      label: 'Medication',
      geometry: 'capsule',
      color: '#10b981',
      description: 'A medicine',
      schemaPredicates: ['urn:kbase:predicate/dosage'],
      builtIn: false,
    };
    const map = buildTypeMap([custom]);
    expect(map.get('urn:kbase:type/Medication')?.label).toBe('Medication');
  });

  it('custom type overrides a built-in with same IRI', () => {
    const override: EntityTypeDef = {
      iri: 'urn:kbase:type/Person',
      label: 'Custom Person',
      geometry: 'sphere',
      color: '#ff0000',
      description: 'Overridden',
      schemaPredicates: [],
      builtIn: false,
    };
    const map = buildTypeMap([override]);
    expect(map.get('urn:kbase:type/Person')?.label).toBe('Custom Person');
  });

  it('returns a Map keyed by IRI', () => {
    const map = buildTypeMap([]);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(BUILT_IN_TYPES.length);
  });
});

// ── labelToIri ───────────────────────────────────────────────────────────────

describe('labelToIri', () => {
  it('converts spaces and special chars to hyphens', () => {
    expect(labelToIri('My Custom Type!')).toBe('my-custom-type');
  });

  it('lowercases the result', () => {
    expect(labelToIri('CamelCase')).toBe('camelcase');
  });

  it('trims whitespace', () => {
    expect(labelToIri('  trimmed  ')).toBe('trimmed');
  });

  it('collapses multiple special chars into one hyphen', () => {
    expect(labelToIri('hello---world')).toBe('hello-world');
  });

  it('strips leading and trailing hyphens', () => {
    expect(labelToIri('--test--')).toBe('test');
  });
});

// ── KnowledgeBase type specifics ─────────────────────────────────────────────

describe('KnowledgeBase type', () => {
  const kb = BUILT_IN_TYPES.find(t => t.iri === 'urn:kbase:type/KnowledgeBase')!;

  it('uses amber color', () => {
    expect(kb.color).toBe('#f59e0b');
  });

  it('has schema predicates for KB metadata', () => {
    expect(kb.schemaPredicates).toContain('urn:reckons:meta/kbStableId');
    expect(kb.schemaPredicates).toContain('urn:reckons:leap');
  });

  it('resolves via buildTypeMap', () => {
    const map = buildTypeMap([]);
    const resolved = map.get('urn:kbase:type/KnowledgeBase');
    expect(resolved).toBeDefined();
    expect(resolved!.geometry).toBe('tetrahedron-inv');
  });
});

describe('media and generation types (F58.9.5)', () => {
  const byIri = (i: string) => BUILT_IN_TYPES.find((t) => t.iri === i)!;
  const MEDIA = ['Prompt', 'Image', 'Video', 'Model3D', 'GaussianSplat', 'License'];

  it('Prompt, Image, Video, 3D model, Gaussian splat and License are built in', () => {
    for (const n of MEDIA) {
      const t = byIri(`urn:kbase:type/${n}`);
      expect(t, n).toBeDefined();
      expect(t.builtIn).toBe(true);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('the colors of the six are all different', () => {
    const colors = MEDIA.map((n) => byIri(`urn:kbase:type/${n}`).color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('a Gaussian splat is glossed in plain English', () => {
    expect(byIri('urn:kbase:type/GaussianSplat').description).toMatch(/blobs/);
  });

  it('generated media list their provenance as schema fields', () => {
    for (const n of ['Image', 'Video', 'Model3D', 'GaussianSplat']) {
      const fields = byIri(`urn:kbase:type/${n}`).schemaPredicates;
      for (const p of ['generated-with', 'generated-seed', 'generated-duration', 'generated-at']) {
        expect(fields, `${n} ${p}`).toContain(`urn:kbase:predicate/${p}`);
      }
    }
    expect(byIri('urn:kbase:type/Video').schemaPredicates).toContain('urn:kbase:predicate/generated-frames');
    expect(byIri('urn:kbase:type/GaussianSplat').schemaPredicates).toContain('urn:kbase:predicate/generated-gaussians');
  });

  it('a License carries its SPDX id and URL as fields', () => {
    expect(byIri('urn:kbase:type/License').schemaPredicates).toEqual([
      'urn:kbase:predicate/spdx-id', 'urn:kbase:predicate/license-url',
    ]);
  });

  it('every schema field of the six is metadata, so no value node is drawn for it', () => {
    for (const n of MEDIA) {
      for (const p of byIri(`urn:kbase:type/${n}`).schemaPredicates) expect(isMetaPredicate(p), p).toBe(true);
    }
    for (const p of GENERATION_PROVENANCE_PREDICATES) expect(isMetaPredicate(p)).toBe(true);
  });

  it('links between entities stay visible edges', () => {
    expect(isMetaPredicate('urn:kbase:predicate/made-from')).toBe(false);
    expect(isMetaPredicate('https://schema.org/license')).toBe(false);
  });
});
