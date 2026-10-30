import type { Statement } from './types';
export type PurposeGroup = { purpose: string; statementIds: string[] };
/** Produces organization only. Member assertions and their review states remain untouched. */
export function purposeOrganization(purposes: string[], groups: PurposeGroup[], statements: Statement[], sourceId: string, at: number): Statement[] {
  const allowed = new Set(purposes), known = new Map(statements.map(s => [s.id, s])), seen = new Set<string>(), used = new Set<string>();
  const output: Statement[] = [];
  function emit(subject: string, predicate: string, object: Statement['o']) {
    output.push({ id: `${sourceId}:${output.length}`, s: { kind: 'iri', value: subject }, p: { kind: 'iri', value: predicate }, o: object, g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` }, sourceId, status: 'confirmed', confidence: 1, createdAt: at, updatedAt: at, verifiableBy: 'user', gloss: 'Purpose organization applied by the user; member claims are not validated by this action.' });
  }
  for (const [index, group] of groups.entries()) {
    if (!allowed.has(group.purpose) || used.has(group.purpose) || !group.statementIds.length) throw new Error('Unknown, repeated or empty purpose.');
    used.add(group.purpose); const unit = `urn:kbase:concept/${sourceId}/purpose-${index}`, entities = new Set<string>();
    emit(unit, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', { kind: 'iri', value: 'http://www.w3.org/2004/02/skos/core#Collection' });
    emit(unit, 'http://www.w3.org/2004/02/skos/core#prefLabel', { kind: 'literal', value: group.purpose });
    for (const id of group.statementIds) {
      const member = known.get(id); if (!member || member.s.kind !== 'iri' || seen.has(id)) throw new Error('Unknown or repeated statement.');
      seen.add(id); if (!entities.has(member.s.value)) emit(unit, 'http://www.w3.org/2004/02/skos/core#member', member.s); entities.add(member.s.value);
    }
  }
  if (seen.size !== known.size) throw new Error('Not every statement was assigned; nothing changed.');
  return output;
}
