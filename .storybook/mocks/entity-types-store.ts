/** Mock for $lib/stores/entity-types.svelte */
import { BUILT_IN_TYPES, type EntityTypeDef } from '$lib/rdf/entity-types';
import type { Statement } from '$lib/rdf/types';

export function allTypes(): EntityTypeDef[] { return BUILT_IN_TYPES; }
export function typeMap(): Map<string, EntityTypeDef> {
  return new Map(BUILT_IN_TYPES.map(t => [t.iri, t]));
}
export function customTypes(): EntityTypeDef[] { return []; }

export async function addCustomType(_label: string, _geometry: string, _color: string, _description: string): Promise<void> {}
export async function updateCustomType(_iri: string, _patch: Partial<EntityTypeDef>): Promise<void> {}
export async function deleteCustomType(_iri: string): Promise<void> {}
export async function addSchemaPredicate(_typeIri: string, _predicateIri: string): Promise<void> {}
export async function removeSchemaPredicate(_typeIri: string, _predicateIri: string): Promise<void> {}
export async function setTypeIcon2d(_typeIri: string, _icon: string): Promise<void> {}
export function labelToIri(_label: string): string { return `urn:kbase:type/${_label}`; }
