/**
 * Pure counting for the example-space inventory (F263 phase 1, SCRIPT tier).
 *
 * Input is one parsed bundled space as plain triples; output is counts. No file reads, no model, so a
 * test can hand it a synthetic small space. The hub rule is NOT re-derived here: it is `hubNodeKeys`
 * from src/lib/rdf/graph-view.ts, the same function the app's hub filter calls, fed the same kind of
 * edges (entity-to-entity statements that are not presentation metadata).
 */
import { hubNodeKeys } from '../../../src/lib/rdf/graph-view';
import { BUILT_IN_TYPES } from '../../../src/lib/rdf/entity-types';
import { isMetaPredicate, type Statement } from '../../../src/lib/rdf/types';

export type Triple = { s: string; p: string; o: string; oKind: 'iri' | 'literal' | 'bnode' };

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PHOTO = 'urn:kbase:predicate/photo';
const SPLAT = 'urn:kbase:predicate/splat';
const VIDEO = 'urn:kbase:predicate/video';
const ICON2D = 'urn:kbase:predicate/icon2d';
const ICON3D = 'urn:kbase:predicate/icon3d';
const PHOTO_CREDIT = 'urn:kbase:predicate/photo-credit';
const PHOTO_SOURCE = 'urn:kbase:predicate/photo-source';
const GENERATED_WITH = 'urn:kbase:predicate/generated-with';
const ASSET_ICON = 'urn:kbase:asset/icon';
const ASSET_PREVIEW = 'urn:kbase:asset/preview';
const ASSET_MODEL = 'urn:kbase:asset/model';
const GLB_MODEL = 'urn:kbase:meta/glbModel';
const GIF_PREVIEW = 'urn:kbase:meta/gifPreview';
const TRUST = 'urn:kbase:meta/trustLevel';

const STORY_STORY = 'urn:reckons:story/Story';
const STORY_STEP = 'urn:reckons:story/Step';
const META_SOURCE = 'urn:kbase:meta/Source';
/** Types that mark a subject as scaffolding (story, source, type definition), not an entity of the space. */
const NOT_ENTITY_TYPES = new Set([STORY_STORY, STORY_STEP, META_SOURCE, 'urn:kbase:type/EntityType']);
const PERSON_TYPES = new Set([
  'urn:kbase:type/Person', 'https://schema.org/Person', 'http://schema.org/Person', 'http://xmlns.com/foaf/0.1/Person',
]);

export type SpaceInventory = {
  statements: number;
  entities: number;
  typed: number;
  untyped: number;
  typedPercent: number;
  /** Built-in type IRIs the space uses, and the built-in types it does not. */
  builtInUsed: string[];
  builtInAvailable: number;
  otherTypes: string[];
  people: number;
  peopleWithoutImage: string[];
  hubs: number;
  hubsWithoutAsset: string[];
  hubsWithoutImage: string[];
  hubsWithoutSplat: string[];
  hubsWithoutGlb: string[];
  entitiesWithImage: number;
  entitiesWithSplat: number;
  entitiesWithGlb: number;
  assets: { references: number; receipted: number; credited: number; unrecorded: number };
  story: { stories: number; steps: number };
  sources: { total: number; trusted: number; review: number; unmarked: number };
};

/** A real picture slot value: a path, URL or data URI, not an emoji stand-in. */
export const isImageFile = (v: string): boolean => /^(\/|https?:|data:image|assets\/|\.\/)/.test(v.trim());

export type InventoryOptions = {
  /** Does a generation receipt exist for this local asset path (e.g. /generated/<dir>/image.webp)? */
  hasReceipt?: (assetPath: string) => boolean;
};

export function inventorySpace(triples: Triple[], opts: InventoryOptions = {}): SpaceInventory {
  const typesOf = new Map<string, string[]>();
  const objectsOf = (p: string | string[]) => {
    const set = new Set(Array.isArray(p) ? p : [p]);
    const m = new Map<string, string[]>();
    for (const t of triples) if (set.has(t.p) && t.oKind === 'literal') (m.get(t.s) ?? m.set(t.s, []).get(t.s)!).push(t.o);
    return m;
  };
  for (const t of triples) {
    if (t.p === RDF_TYPE && t.oKind === 'iri') (typesOf.get(t.s) ?? typesOf.set(t.s, []).get(t.s)!).push(t.o);
  }

  const subjects = new Set(triples.filter((t) => !t.s.startsWith('_:') && t.s.includes(':')).map((t) => t.s));
  const entities = [...subjects].filter((s) => !(typesOf.get(s) ?? []).some((ty) => NOT_ENTITY_TYPES.has(ty)));
  const entitySet = new Set(entities);

  const typedEntities = entities.filter((e) => (typesOf.get(e) ?? []).length > 0);
  const builtIn = new Set(BUILT_IN_TYPES.map((t) => t.iri));
  const usedTypes = new Set(typedEntities.flatMap((e) => typesOf.get(e)!));
  const builtInUsed = [...usedTypes].filter((t) => builtIn.has(t)).sort();
  const otherTypes = [...usedTypes].filter((t) => !builtIn.has(t)).sort();

  const imageVals = objectsOf([PHOTO, ICON2D, ASSET_ICON, ASSET_PREVIEW, GIF_PREVIEW]);
  const splatVals = objectsOf(SPLAT);
  const glbVals = objectsOf([ASSET_MODEL, GLB_MODEL, ICON3D]);
  const hasImage = (e: string) => (imageVals.get(e) ?? []).some(isImageFile);
  const hasSplat = (e: string) => (splatVals.get(e) ?? []).some((v) => v.trim() !== '');
  const hasGlb = (e: string) => (glbVals.get(e) ?? []).some((v) => v.trim() !== '');

  const people = entities.filter((e) => (typesOf.get(e) ?? []).some((t) => PERSON_TYPES.has(t)));

  // Hubs: the app's rule over entity-to-entity edges that are facts, not presentation metadata.
  const edges: Statement[] = triples
    .filter((t) => t.oKind === 'iri' && t.p !== RDF_TYPE && !isMetaPredicate(t.p) && entitySet.has(t.s))
    .map((t) => ({
      id: '', s: { kind: 'iri', value: t.s }, p: { kind: 'iri', value: t.p }, o: { kind: 'iri', value: t.o },
      g: { kind: 'iri', value: 'urn:inventory' }, sourceId: '', confidence: 1,
    }) as unknown as Statement);
  const hubKeys = hubNodeKeys(edges, Number.POSITIVE_INFINITY, {
    eligible: (key) => {
      const iriValue = key.slice(2);
      const ty = (typesOf.get(iriValue) ?? [])[0];
      if (!ty) return true;
      return BUILT_IN_TYPES.find((b) => b.iri === ty)?.allowHub !== false;
    },
  });
  const hubs = hubKeys.map((k) => k.slice(2)).filter((h) => entitySet.has(h));

  // Asset references: every local path held in a picture, clip or splat slot.
  const refs: { entity: string; path: string }[] = [];
  for (const m of [objectsOf(PHOTO), objectsOf(VIDEO), splatVals, objectsOf(ASSET_PREVIEW), objectsOf(ASSET_MODEL)]) {
    for (const [entity, vals] of m) for (const v of vals) if (v.startsWith('/')) refs.push({ entity, path: v });
  }
  const credited = new Set([...objectsOf(PHOTO_CREDIT).keys(), ...objectsOf(PHOTO_SOURCE).keys()]);
  const generated = new Set(objectsOf(GENERATED_WITH).keys());
  let receipted = 0, creditedCount = 0, unrecorded = 0;
  for (const r of refs) {
    if (generated.has(r.entity) || opts.hasReceipt?.(r.path)) receipted++;
    else if (credited.has(r.entity)) creditedCount++;
    else unrecorded++;
  }

  const sources = [...subjects].filter((s) => (typesOf.get(s) ?? []).includes(META_SOURCE));
  const trust = objectsOf(TRUST);
  const trustOf = (s: string) => (trust.get(s) ?? [])[0];

  return {
    statements: triples.length,
    entities: entities.length,
    typed: typedEntities.length,
    untyped: entities.length - typedEntities.length,
    typedPercent: entities.length ? Math.round((typedEntities.length / entities.length) * 100) : 0,
    builtInUsed,
    builtInAvailable: builtIn.size,
    otherTypes,
    people: people.length,
    peopleWithoutImage: people.filter((p) => !hasImage(p)),
    hubs: hubs.length,
    hubsWithoutAsset: hubs.filter((h) => !hasImage(h) && !hasSplat(h) && !hasGlb(h)),
    hubsWithoutImage: hubs.filter((h) => !hasImage(h)),
    hubsWithoutSplat: hubs.filter((h) => !hasSplat(h)),
    hubsWithoutGlb: hubs.filter((h) => !hasGlb(h)),
    entitiesWithImage: entities.filter(hasImage).length,
    entitiesWithSplat: entities.filter(hasSplat).length,
    entitiesWithGlb: entities.filter(hasGlb).length,
    assets: { references: refs.length, receipted, credited: creditedCount, unrecorded },
    story: {
      stories: [...subjects].filter((s) => (typesOf.get(s) ?? []).includes(STORY_STORY)).length,
      steps: [...subjects].filter((s) => (typesOf.get(s) ?? []).includes(STORY_STEP)).length,
    },
    sources: {
      total: sources.length,
      trusted: sources.filter((s) => trustOf(s) === 'trusted').length,
      review: sources.filter((s) => trustOf(s) === 'review').length,
      unmarked: sources.filter((s) => !trustOf(s)).length,
    },
  };
}

/** The gaps worth one proposal: empty when the space has none. Wording is counts only. */
export function gapsOf(inv: SpaceInventory): string[] {
  const gaps: string[] = [];
  if (inv.untyped > 0) gaps.push(`${inv.untyped} of ${inv.entities} entities have no type (${inv.typedPercent}% typed)`);
  if (inv.peopleWithoutImage.length > 0) gaps.push(`${inv.peopleWithoutImage.length} of ${inv.people} people have no picture`);
  if (inv.hubsWithoutAsset.length > 0) gaps.push(`${inv.hubsWithoutAsset.length} of ${inv.hubs} hubs have no picture, splat or 3D model`);
  if (inv.assets.unrecorded > 0) gaps.push(`${inv.assets.unrecorded} of ${inv.assets.references} assets have neither a receipt nor a credit`);
  if (inv.story.stories === 0) gaps.push('no story');
  if (inv.sources.review > 0) gaps.push(`${inv.sources.review} of ${inv.sources.total} sources still await review`);
  return gaps;
}
