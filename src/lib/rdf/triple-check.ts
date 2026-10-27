import type { Statement } from './types';
import { isMetaPredicate, termKey } from './types';
import type { GraphSource } from './multi-graph-query';
import type { SourceJudgment } from './source-validation';
import { aggregateStatements, aggregateStatementChunks, statementClaimKey, claimText } from './statement-chunks';
export { claimText } from './statement-chunks';
export const claimFingerprint = statementClaimKey;
export type SpaceEvidence = {
  spaceId: string; spaceName: string; statementId: string; entity: string; claim: string;
  relation: 'matches' | 'possible-conflict' | 'similar'; provenance: 'shared-source' | 'different-source' | 'unknown';
  context?: string; reference: boolean; stance?: 'supports' | 'contradicts' | 'neutral'; explanation?: string; suggestedWording?: string;
};
export type TripleCheckReport = {
  id: string; statementId: string; fingerprint: string; configuration: string; claim: string; checkedAt: number;
  state: 'checking' | 'complete'; reviewed: boolean; webAttempted: boolean; web: SourceJudgment[];
  /** Something transient failed (a read, a search, the daily limit, an interruption): retry after an hour.
   *  Configuration warnings ("web disabled", "credentials missing") are NOT incomplete — they re-run when
   *  the configuration key changes, so a deliberate choice does not re-check every claim hourly forever. */
  incomplete?: boolean;
  spaces: SpaceEvidence[]; searchedSpaces: number; warnings: string[];
};
/** A claim about the world. Story steps, navigation order and presentation metadata are the space's own
 *  furniture: checking them only filled Review with "evidence" about a walkthrough's step text. */
export const checkable = (s: Statement) => ['pending', 'confirmed', 'refined'].includes(s.status) && !s.needsObject && s.s.kind === 'iri' && s.o.kind !== 'bnode'
  && !isMetaPredicate(s.p.value) && !s.p.value.startsWith('urn:reckons:story/');
export const dailyLimit = (n?: number) => Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n!))) : 20;
export function selectNextClaim(statements: Statement[], reports: TripleCheckReport[], now: number, configuration: string) {
  const latest = new Map<string, TripleCheckReport>();
  for (const r of reports) if ((latest.get(r.fingerprint)?.checkedAt ?? -1) < r.checkedAt) latest.set(r.fingerprint, r);
  return statements.filter(checkable).filter(s => {
    const r = latest.get(claimFingerprint(s));
    return !r || r.configuration !== configuration || now - r.checkedAt >= (r.incomplete || r.state === 'checking' ? 3600000 : 7 * 86400000);
  }).sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending')
    || (latest.get(claimFingerprint(a))?.checkedAt ?? 0) - (latest.get(claimFingerprint(b))?.checkedAt ?? 0) || a.createdAt - b.createdAt)[0];
}
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
export function spaceEvidence(claim: Statement, spaces: GraphSource[], currentId: string, references: string[] = [], limit = 20) {
  const tokens = words(claimText(claim));
  const ranked: { score: number; evidence: SpaceEvidence }[] = [];
  for (const space of spaces) {
    const contexts = references.includes(space.id) ? aggregateStatementChunks([space], 6000) : [];
    for (const { statement: s } of aggregateStatements([space])) {
      if (space.id === currentId && claimFingerprint(s) === claimFingerprint(claim)) continue;
      const exact = termKey(s.s) === termKey(claim.s) && termKey(s.p) === termKey(claim.p);
      const overlap = [...words(claimText(s))].filter(w => tokens.has(w)).length;
      if (!exact && overlap < 2) continue;
      ranked.push({ score: (exact ? 100 : overlap) + (references.includes(space.id) ? 10 : 0), evidence: {
        spaceId: space.id, spaceName: space.name, statementId: s.id, entity: s.s.value, claim: claimText(s),
        relation: exact ? (termKey(s.o) === termKey(claim.o) ? 'matches' : 'possible-conflict') : 'similar',
        provenance: s.sourceId && claim.sourceId ? (s.sourceId === claim.sourceId ? 'shared-source' : 'different-source') : 'unknown',
        reference: references.includes(space.id), context: contexts.find(c => c.claims.some(k => termKey(k.statement.s) === termKey(s.s)))?.text,
      } });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.evidence.spaceId.localeCompare(b.evidence.spaceId));
  return { evidence: ranked.slice(0, limit).map(r => r.evidence), truncated: ranked.length > limit };
}
export function parseWebJudgments(raw: string, sources: { url: string; title: string; content: string }[]): SourceJudgment[] {
  const values: unknown = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(values) || values.length !== sources.length) throw new Error('Incomplete evidence judgments.');
  const seen = new Set<number>();
  return values.map(v => {
    if (!v || !Number.isInteger(v.index) || !sources[v.index] || seen.has(v.index) || !['supports', 'contradicts', 'neutral'].includes(v.stance) || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) throw new Error('Invalid evidence judgment.');
    seen.add(v.index); const source = sources[v.index];
    return { url: source.url, title: source.title, snippet: source.content.slice(0, 1200), stance: v.stance, confidence: v.confidence };
  });
}
export function evidenceEstimate(web: SourceJudgment[]) {
  const publishers = new Map<string, SourceJudgment>(); const passages = new Set<string>();
  for (const source of web) {
    try {
      const text = source.snippet.toLowerCase().replace(/\W/g, '');
      if (source.confidence < 0.7 || source.stance === 'neutral' || passages.has(text)) continue;
      const host = new URL(source.url).hostname.split('.').slice(-2).join('.');
      if (!publishers.has(host)) { publishers.set(host, source); passages.add(text); }
    } catch { /* Invalid stored citations never count as evidence. */ }
  }
  const rows = [...publishers.values()];
  if (rows.length < 3) return 'Not enough distinct evidence for a likely truth estimate';
  const supports = rows.filter(r => r.stance === 'supports').length / rows.length;
  if (supports >= 0.8) return 'Likely true — sampled sources mostly support this';
  if (supports <= 0.2) return 'Likely false — sampled sources mostly dispute this';
  return 'Mixed evidence — sources disagree';
}
export const hasConflict = (r: TripleCheckReport) => r.web.some(s => s.stance === 'contradicts') || r.spaces.some(s => s.stance === 'contradicts' || (!s.stance && s.relation === 'possible-conflict'));
