import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import SHACLValidator from 'rdf-validate-shacl';
import { entityTypeToShape, shapeToTurtle, shapeIriForType, typesWithoutShapes } from '../type-shapes';
import type { EntityTypeDef } from '../entity-types';

function type(p: Partial<EntityTypeDef> = {}): EntityTypeDef {
  return {
    iri: 'urn:kbase:type/Recipe',
    label: 'Recipe',
    geometry: 'box',
    color: '#fff',
    description: '',
    schemaPredicates: ['urn:kbase:predicate/ingredient', 'urn:kbase:predicate/steps'],
    builtIn: false,
    ...p,
  } as EntityTypeDef;
}

describe('entityTypeToShape', () => {
  it('targets the entity type — sh:targetClass is the coupling, no new link needed', () => {
    const s = entityTypeToShape(type());
    expect(s.targetClass).toBe('urn:kbase:type/Recipe');
  });

  it('carries the suggested predicates across as paths', () => {
    expect(entityTypeToShape(type()).properties.map((p) => p.path)).toEqual([
      'urn:kbase:predicate/ingredient',
      'urn:kbase:predicate/steps',
    ]);
  });

  it('NEVER promotes a suggested predicate to required', () => {
    // schemaPredicates is a hint existing data was never checked against. Deriving minCount 1
    // would condemn every node missing an optional field the moment the user opens the editor.
    for (const p of entityTypeToShape(type()).properties) {
      expect(p.minCount).toBeUndefined();
      expect(p.maxCount).toBeUndefined();
    }
  });

  it('marks a type with no suggested predicates as empty rather than skipping it', () => {
    const s = entityTypeToShape(type({ schemaPredicates: [] }));
    expect(s.empty).toBe(true);
    expect(s.properties).toEqual([]);
  });

  it('mints a stable IRI so regenerating does not create a second shape', () => {
    expect(shapeIriForType('urn:kbase:type/Recipe')).toBe('urn:kbase:shape/Recipe');
    expect(entityTypeToShape(type()).iri).toBe(shapeIriForType('urn:kbase:type/Recipe'));
  });
});

describe('shapeToTurtle', () => {
  it('emits parseable Turtle', () => {
    const ttl = shapeToTurtle(entityTypeToShape(type()));
    expect(() => new Parser().parse(ttl)).not.toThrow();
  });

  it('emits a legal always-conforming shape for an empty type', () => {
    const ttl = shapeToTurtle(entityTypeToShape(type({ schemaPredicates: [] })));
    expect(() => new Parser().parse(ttl)).not.toThrow();
    expect(ttl).toMatch(/targetClass/);
  });

  it('serializes tightened constraints once a user adds them', () => {
    const s = entityTypeToShape(type());
    s.properties[0].minCount = 1;
    s.properties[0].message = 'A recipe needs at least one ingredient.';
    const ttl = shapeToTurtle(s);
    expect(ttl).toMatch(/minCount> 1/);
    expect(ttl).toMatch(/needs at least one ingredient/);
  });
});

describe('the derived shape is valid against existing data — the load-bearing property', () => {
  it('does NOT flag a node that omits every suggested predicate', async () => {
    // A validation feature whose first act is to condemn the user's existing graph is one
    // they switch off. This is the test that keeps derivation safe to run unprompted.
    const shapes = new Parser().parse(shapeToTurtle(entityTypeToShape(type())));
    const v = new SHACLValidator(shapes);
    const data = v.factory.dataset(
      new Parser().parse(
        '<urn:kbase:concept/soup> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:kbase:type/Recipe> .',
      ),
    );
    const report = await v.validate(data);
    expect(report.conforms).toBe(true);
  });

  it('DOES flag it once the user tightens the shape deliberately', async () => {
    const s = entityTypeToShape(type());
    s.properties[0].minCount = 1;
    const shapes = new Parser().parse(shapeToTurtle(s));
    const v = new SHACLValidator(shapes);
    const data = v.factory.dataset(
      new Parser().parse(
        '<urn:kbase:concept/soup> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:kbase:type/Recipe> .',
      ),
    );
    const report = await v.validate(data);
    expect(report.conforms).toBe(false);
  });
});

describe('typesWithoutShapes', () => {
  it('reports the gap rather than auto-minting shapes nobody asked for', () => {
    const types = [type(), type({ iri: 'urn:kbase:type/Person', label: 'Person' })];
    const covered = new Set(['urn:kbase:type/Recipe']);
    expect(typesWithoutShapes(types, covered).map((t) => t.label)).toEqual(['Person']);
  });

  it('returns nothing when every type is covered', () => {
    expect(typesWithoutShapes([type()], new Set(['urn:kbase:type/Recipe']))).toEqual([]);
  });
});
