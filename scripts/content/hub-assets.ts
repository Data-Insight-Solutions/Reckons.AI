import { createHash } from 'node:crypto';
import { hubNodeKeys } from '../../src/lib/rdf/graph-view';
import { BUILT_IN_TYPES } from '../../src/lib/rdf/entity-types';
import { isMetaPredicate, type Statement } from '../../src/lib/rdf/types';
import type { GenerationRequest } from '../../src/lib/generation/protocol';

/**
 * F278.1 and F278.2: plan the pictures every hub should have by default. PURE and deterministic: the
 * same statements give the same plan, ids and seeds included, so a re-run proposes nothing twice.
 *
 * The plan is DATA (typed generation requests), never a command. A hub that lacks an image, a splat and
 * a model gets one image request grounded in its confirmed facts, then one splat request that names the
 * image as its parent (the runner starts it only after the image completed). Nothing here runs a GPU.
 *
 * GROUNDING. The prompt is built from the hub's label, its type, a few confirmed literal facts and the
 * labels of a few confirmed neighbours, and from nothing else: a picture must not assert what the
 * space does not. An entity with no confirmed fact beyond its label is REFUSED rather than invented.
 * A person gets a neutral illustrated portrait that names no one and claims no likeness.
 */

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const P = 'urn:kbase:predicate/';
/** Any of these on an entity means it already has a picture, splat or model (in any review state). */
const ASSET_PREDICATES = new Set([
  `${P}photo`, `${P}splat`, `${P}video`, `${P}icon2d`, `${P}icon3d`,
  'urn:kbase:asset/icon', 'urn:kbase:asset/preview', 'urn:kbase:asset/model',
  'urn:kbase:meta/glbModel', 'urn:kbase:meta/gifPreview',
]);
/** Not facts about the thing: bookkeeping and provenance that must never reach a prompt. */
const NOT_A_FACT = new Set([RDF_TYPE, LABEL, 'http://www.w3.org/2000/01/rdf-schema#comment', `${P}generated-with`, `${P}generated-seed`, `${P}made-from`]);
/** Scaffolding, not entities of the space: stories, their steps, sources and type definitions. The inventory (F263.1) leaves them out of the hub count too. */
const NOT_ENTITY_TYPES = new Set(['urn:reckons:story/Story', 'urn:reckons:story/Step', 'urn:kbase:meta/Source', 'urn:kbase:type/EntityType']);
const PERSON_TYPES = new Set(['urn:kbase:type/Person', 'https://schema.org/Person', 'http://schema.org/Person', 'http://xmlns.com/foaf/0.1/Person']);

/** Predicates that identify a real individual. They never reach a prompt, whoever the entity is. */
const IDENTIFYING = /^(name|full name|given name|family name|first name|last name|surname|email|e mail|phone|telephone|address|birth date|birthday|date of birth|photo credit)$/;
export const MAX_ATTRIBUTES = 3;
export const MAX_NEIGHBOURS = 3;
const MAX_VALUE = 80;

export interface HubAssetPlanItem {
  hub: string;
  label: string;
  /** The confirmed facts the prompt was built from, kept so a reviewer can check the grounding. */
  grounding: string[];
  person: boolean;
  image: GenerationRequest;
  splat: GenerationRequest;
}
export interface HubAssetPlan {
  items: HubAssetPlanItem[];
  /** Hubs that qualified but were not planned, each with the reason. */
  refused: { hub: string; reason: string }[];
  /** Hubs that already have a picture, splat or model. */
  skippedHavingAssets: number;
}

const iriOf = (statement: Statement, side: 's' | 'o') => (statement[side].kind === 'iri' ? statement[side].value : undefined);
const humanize = (predicate: string) => (predicate.split(/[#/]/).pop() ?? predicate).replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** A v4-shaped id from a hash, so the same hub and stage always get the same request id. */
function stableId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  const variant = '89ab'[parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const stableSeed = (seed: string) => parseInt(createHash('sha256').update(`seed:${seed}`).digest('hex').slice(0, 7), 16);

export function planHubAssets(statements: Statement[], opts: { spaceId?: string; limit?: number } = {}): HubAssetPlan {
  const spaceId = opts.spaceId ?? 'space';
  const confirmed = statements.filter(st => st.status === 'confirmed');
  const labels = new Map<string, string>();
  const types = new Map<string, string[]>();
  for (const st of confirmed) {
    const subject = iriOf(st, 's');
    if (!subject) continue;
    if (st.p.value === LABEL && st.o.kind === 'literal' && !labels.has(subject)) labels.set(subject, st.o.value.trim());
    if (st.p.value === RDF_TYPE && st.o.kind === 'iri') (types.get(subject) ?? types.set(subject, []).get(subject)!).push(st.o.value);
  }

  // Hub rule: the app's own, over confirmed entity-to-entity facts. A type that opts out of hubs stays out.
  const isEntity = (iri: string) => !(types.get(iri) ?? []).some(t => NOT_ENTITY_TYPES.has(t));
  const edges = confirmed.filter(st => st.o.kind === 'iri' && st.s.kind === 'iri' && isEntity(st.s.value) && st.p.value !== RDF_TYPE && !isMetaPredicate(st.p.value));
  const hubs = hubNodeKeys(edges, Number.POSITIVE_INFINITY, {
    eligible: (key) => {
      const ty = types.get(key.slice(2))?.[0];
      return !ty || BUILT_IN_TYPES.find(b => b.iri === ty)?.allowHub !== false;
    },
  }).map(key => key.slice(2)).filter(hub => labels.has(hub));

  const hasAsset = new Set<string>();
  for (const st of statements) if (ASSET_PREDICATES.has(st.p.value) && st.s.kind === 'iri') hasAsset.add(st.s.value);

  const plan: HubAssetPlan = { items: [], refused: [], skippedHavingAssets: 0 };
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const hub of hubs) {
    if (hasAsset.has(hub)) { plan.skippedHavingAssets++; continue; }
    if (plan.items.length >= limit) break;
    const label = labels.get(hub)!;
    const hubTypes = types.get(hub) ?? [];
    const person = hubTypes.some(t => PERSON_TYPES.has(t));

    const attributes: string[] = [];
    const neighbours: string[] = [];
    for (const st of confirmed) {
      if (iriOf(st, 's') !== hub || NOT_A_FACT.has(st.p.value) || isMetaPredicate(st.p.value) || ASSET_PREDICATES.has(st.p.value)) continue;
      if (st.o.kind === 'literal') {
        const value = st.o.value.trim();
        if (value && value.length <= MAX_VALUE && !/^https?:/.test(value) && !humanize(st.p.value).includes(':') && !IDENTIFYING.test(humanize(st.p.value)) && attributes.length < MAX_ATTRIBUTES) attributes.push(`${humanize(st.p.value)}: ${value}`);
      } else if (st.o.kind === 'iri' && !person && !(types.get(st.o.value) ?? []).some(t => PERSON_TYPES.has(t))) {
        // A person's links, and links TO people, are left out: a prompt must not name an individual.
        const name = labels.get(st.o.value);
        if (name && !neighbours.includes(name) && neighbours.length < MAX_NEIGHBOURS) neighbours.push(`${humanize(st.p.value)} ${name}`);
      }
    }
    const grounding = [...attributes, ...neighbours];
    if (grounding.length === 0) { plan.refused.push({ hub, reason: 'no confirmed fact beyond its label, so a prompt would have to invent detail' }); continue; }

    const typeLabel = BUILT_IN_TYPES.find(b => hubTypes.includes(b.iri))?.label;
    const style = 'Clean illustration, single centered subject, plain background, no text.';
    const prompt = person
      // Neutral by construction: no name, no appearance claims, and the picture says it is not a likeness.
      ? `A neutral illustrated portrait of a person, shoulders up, stylized and generic, not a likeness of any real individual. Context only: ${grounding.join('; ')}. ${style}`
      : `An illustration of "${label}"${typeLabel ? `, ${/^[aeiou]/i.test(typeLabel) ? 'an' : 'a'} ${typeLabel.toLowerCase()}` : ''}. Confirmed facts only: ${grounding.join('; ')}. ${style}`;

    const imageId = stableId(`${spaceId}|${hub}|image`);
    const image: GenerationRequest = { version: 1, id: imageId, spaceId, stage: 'image', prompt: prompt.slice(0, 2000), seed: stableSeed(`${spaceId}|${hub}`), forEntity: hub };
    const splat: GenerationRequest = { version: 1, id: stableId(`${spaceId}|${hub}|splat`), spaceId, stage: 'splat', prompt: image.prompt, seed: image.seed, parentId: imageId, forEntity: hub };
    plan.items.push({ hub, label, grounding, person, image, splat });
  }
  return plan;
}
