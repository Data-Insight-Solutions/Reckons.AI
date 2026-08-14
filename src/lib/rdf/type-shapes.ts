/**
 * ENTITY TYPES AND SHACL SHAPES — coupling them without welding them together.
 *
 * Matt, 2026-08-14: "custom entity types should be coupled with custom SHACL shapes?"
 *
 * THEY ALREADY ARE, WEAKLY, which is the useful starting point. EntityTypeDef carries
 * `schemaPredicates` — "suggested predicates for nodes of this type" — and measured
 * 2026-08-14 it is ADVISORY ONLY: rendered in the entity-types settings page and used to
 * suggest fields in the detail panel, enforced nowhere. That is a shape without teeth. A
 * SHACL NodeShape is the rigorous version of the same statement.
 *
 * COUPLED IN AUTHORING, SEPARABLE IN THE MODEL. The link already exists and is standard:
 * sh:targetClass points a shape at a class, and an entity type IS a class. Nothing new is
 * needed to connect them, and a 1:1 welding would break three real cases:
 *
 *   - ONE TYPE, SEVERAL SHAPES. A Recipe might have a strict shape for publishing and a
 *     lenient one for drafting, or shapes at different sh:severity. Forcing one shape per
 *     type makes "warn here, block there" unsayable.
 *   - SHAPES THAT DO NOT TARGET A CLASS AT ALL. sh:targetNode and sh:targetSubjectsOf are
 *     Core SHACL, and a shape keyed to an entity type cannot express either.
 *   - SHARED GRAPHS. A graph package may arrive carrying shapes for types the receiver has
 *     never defined, or types whose shapes live in someone else's graph. Requiring the two
 *     to travel as one object makes a shared contract un-shippable — which is the whole
 *     argument for shapes-as-data.
 *
 * So: one authoring surface, two artefacts.
 *
 * WHY DERIVATION NEVER PROMOTES "SUGGESTED" TO "REQUIRED". schemaPredicates is a hint that
 * existing data was never checked against. Turning each into sh:minCount 1 would declare
 * every node that omits an optional field invalid the moment the user first opens the shape
 * editor — a validation feature whose first act is to condemn the user's existing graph is
 * one they will switch off. The derived shape therefore states the PATHS and constrains
 * nothing, so it cannot fail on data that exists today; tightening is a deliberate act the
 * user performs afterwards, on a shape they can already see.
 */

import type { EntityTypeDef } from './entity-types';

const SH = 'http://www.w3.org/ns/shacl#';

export type DerivedPropertyShape = {
  path: string;
  /** Never set by derivation — the user tightens it deliberately. */
  minCount?: number;
  maxCount?: number;
  message?: string;
};

export type DerivedNodeShape = {
  iri: string;
  label: string;
  targetClass: string;
  properties: DerivedPropertyShape[];
  /** True when the type offered no predicates, so the shape constrains nothing at all. */
  empty: boolean;
};

/** A stable shape IRI for a type, so regenerating does not mint a second shape. */
export function shapeIriForType(typeIri: string): string {
  return `urn:kbase:shape/${typeIri.split('/').pop()}`;
}

/**
 * Turn an entity type into a starter shape.
 *
 * The result targets the type and lists its suggested predicates as paths with NO
 * cardinality — valid against every existing node of that type by construction.
 */
export function entityTypeToShape(def: EntityTypeDef): DerivedNodeShape {
  const properties = (def.schemaPredicates ?? []).map((path) => ({ path }));
  return {
    iri: shapeIriForType(def.iri),
    label: `${def.label} shape`,
    targetClass: def.iri,
    properties,
    empty: properties.length === 0,
  };
}

const ttlString = (s: string) => JSON.stringify(s);

/** Serialize a derived shape to Turtle the SHACL validator can read. */
export function shapeToTurtle(shape: DerivedNodeShape): string {
  const lines = [
    `<${shape.iri}> a <${SH}NodeShape> ;`,
    `    <http://www.w3.org/2000/01/rdf-schema#label> ${ttlString(shape.label)} ;`,
  ];
  if (shape.properties.length === 0) {
    // A shape with no constraints is legal SHACL and always conforms. Emitting it anyway is
    // deliberate: it gives the user something to open and tighten, and it records that the
    // type has been considered rather than overlooked.
    lines.push(`    <${SH}targetClass> <${shape.targetClass}> .`);
    return lines.join('\n');
  }
  lines.push(`    <${SH}targetClass> <${shape.targetClass}> ;`);
  shape.properties.forEach((p, i) => {
    const inner = [`        <${SH}path> <${p.path}>`];
    if (p.minCount !== undefined) inner.push(`        <${SH}minCount> ${p.minCount}`);
    if (p.maxCount !== undefined) inner.push(`        <${SH}maxCount> ${p.maxCount}`);
    if (p.message) inner.push(`        <${SH}message> ${ttlString(p.message)}`);
    lines.push(`    <${SH}property> [`, inner.join(' ;\n'), `    ]${i === shape.properties.length - 1 ? ' .' : ' ;'}`);
  });
  return lines.join('\n');
}

/**
 * Which types have no shape yet.
 *
 * Reported rather than auto-generated: minting a shape for every type the moment one appears
 * would fill a user's graph with empty shapes they never asked for, and the point of
 * shapes-as-data is that the user decides what their graph promises.
 */
export function typesWithoutShapes(
  types: readonly EntityTypeDef[],
  existingShapeTargets: ReadonlySet<string>,
): EntityTypeDef[] {
  return types.filter((t) => !existingShapeTargets.has(t.iri));
}
