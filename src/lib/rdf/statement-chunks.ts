import { termKey, type Statement } from './types';
import type { GraphSource } from './multi-graph-query';
export type ClaimOccurrence = { spaceId: string; spaceName: string; sourceId: string; statementId: string };
export type AggregatedClaim = { key: string; statement: Statement; occurrences: ClaimOccurrence[] };
export const statementClaimKey = (s: Statement) => JSON.stringify([termKey(s.s), termKey(s.p), termKey(s.o)]);
export function aggregateStatements(spaces: GraphSource[], pending = false): AggregatedClaim[] {
  const claims = new Map<string, AggregatedClaim>();
  for (const space of spaces) for (const statement of space.statements) {
    if (!['confirmed', 'refined', ...(pending ? ['pending'] : [])].includes(statement.status) || statement.needsObject) continue;
    const key = statementClaimKey(statement);
    const claim = claims.get(key) ?? { key, statement, occurrences: [] };
    claim.occurrences.push({ spaceId: space.id, spaceName: space.name, sourceId: statement.sourceId, statementId: statement.id });
    claims.set(key, claim);
  }
  return [...claims.values()].sort((a, b) => a.key.localeCompare(b.key));
}
export const termLabel = (v: string) => (v.split(/[/#:]/).pop() || v).replace(/[-_]/g, ' ');
export const claimText = (s: Statement) => `${termLabel(s.s.value)} · ${termLabel(s.p.value)} · ${s.o.kind === 'iri' ? termLabel(s.o.value) : s.o.value}`;
export function aggregateStatementChunks(spaces: GraphSource[], budget = 2400) {
  const chunks: { id: string; text: string; claims: AggregatedClaim[] }[] = [];
  let subject = '';
  for (const claim of aggregateStatements(spaces)) {
    const citations = [...new Set(claim.occurrences.map(o => `${o.spaceName}/${o.sourceId}`))];
    const text = `${claimText(claim.statement)} [${citations.join('; ')}]`;
    let chunk = chunks.at(-1);
    if (!chunk || subject !== termKey(claim.statement.s) || chunk.text.length + text.length > budget) {
      chunk = { id: `statements:${chunks.length}`, text: '', claims: [] }; chunks.push(chunk); subject = termKey(claim.statement.s);
    }
    chunk.text += `${chunk.text ? '\n' : ''}${text}`; chunk.claims.push(claim);
  }
  return chunks;
}
