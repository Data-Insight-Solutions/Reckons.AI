import type { Source, Statement, Term } from './types';
import { isMetaPredicate, termKey } from './types';
import type { GraphSource } from './multi-graph-query';
import type { SourceJudgment } from './source-validation';
import { aggregateStatements, aggregateStatementChunks, statementClaimKey, claimText } from './statement-chunks';
export { claimText } from './statement-chunks';
export const claimFingerprint = statementClaimKey;
export type SpaceEvidence = {
  spaceId: string; spaceName: string; statementId: string; entity: string; claim: string;
  /** The other statement's object, so a match or a conflict can come back as a proposal (absent on reports
   *  written before 2026-10-27, which can only be shown, not proposed). */
  object?: Term;
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
  /** How many pending statements this check added to Review (see evidenceProposals). */
  proposed?: number;
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
        spaceId: space.id, spaceName: space.name, statementId: s.id, entity: s.s.value, claim: claimText(s), object: s.o,
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
    // The value a contradicting page states instead. Without it a contradiction can only be asked as a
    // question; with it, it becomes its own statement beside the claim. It must occur in the passage:
    // a value the model supplied from memory is exactly the unsourced claim this feature exists to catch.
    const value = typeof v.value === 'string' ? v.value.trim() : '';
    const statedValue = v.stance === 'contradicts' && value && value.length <= 160 && source.content.toLowerCase().includes(value.toLowerCase()) ? value : undefined;
    return { url: source.url, title: source.title, snippet: source.content.slice(0, 1200), stance: v.stance, confidence: v.confidence, ...(statedValue ? { statedValue } : {}) };
  });
}

/** Who proposed what a check found. Review groups and attributes by this, like any other agent. */
export const TRIPLE_CHECK_AGENT = 'triple-check';
const MIN_WEB_CONFIDENCE = 0.7;
export type EvidenceProposal = { source: Source; statements: Statement[] };
const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0; return h.toString(36); };

/**
 * What a finished check FOUND, as ordinary pending statements from a new source (Matt, 2026-10-27).
 *
 * The first cut kept evidence in a panel beside the queue: a "Possible conflict" label, a collapsible
 * report, and a "mark reviewed" button — a second review process next to the first, with nothing to
 * accept. Matt: "I would much rather the triple check add additional sources to validate, or add a
 * conflicting statement separate to the existing." So:
 *
 *   • a page or another space that SAYS THE SAME THING becomes the same statement from that source,
 *     which Review already shows as "reinforces" and which, accepted, is the extra citation;
 *   • one that says SOMETHING ELSE becomes that other statement, beside the claim, where the existing
 *     conflict handling lets the person keep one, both, or neither;
 *   • a page that disputes the claim without stating a value becomes a QUESTION (F32) carrying the
 *     page's passage, because inventing the value it did not state would be the overclaim this exists
 *     to catch.
 *
 * Nothing is settled here: every row is pending, attributed to TRIPLE_CHECK_AGENT, and the write path
 * downgrades anything else (F52). A proposal already made — same source, same statement, in any status,
 * including rejected — is not made again, so a rejected citation stays rejected across re-checks.
 */
export function evidenceProposals(claim: Statement, report: TripleCheckReport, held: Statement[], currentSpaceId: string, now: number,
  id: () => string = () => crypto.randomUUID()): EvidenceProposal[] {
  const made = new Set(held.map(s => `${s.sourceId}|${termKey(s.s)}|${termKey(s.p)}|${s.needsObject ? '?' : termKey(s.o)}`));
  const groups = new Map<string, EvidenceProposal>();
  const add = (source: Source, o: Term, extra: Partial<Statement>) => {
    const key = `${source.id}|${termKey(claim.s)}|${termKey(claim.p)}|${extra.needsObject ? '?' : termKey(o)}`;
    if (made.has(key)) return; made.add(key);
    const group = groups.get(source.id) ?? { source, statements: [] }; groups.set(source.id, group);
    group.statements.push({ id: id(), s: claim.s, p: claim.p, o, g: { kind: 'iri', value: `urn:kbase:source/${source.id}` }, sourceId: source.id,
      status: 'pending', confidence: 1, proposedBy: TRIPLE_CHECK_AGENT, createdAt: now, updatedAt: now, ...extra });
  };
  for (const web of report.web) {
    if (web.stance === 'neutral' || web.confidence < MIN_WEB_CONFIDENCE) continue;
    let host: string; try { host = new URL(web.url).hostname; } catch { continue; }
    const source: Source = { id: `triple-check-web-${hash(web.url)}`, title: web.title || host, uri: web.url, kind: 'url', trustLevel: 'review', ingestedAt: now };
    const excerpt = web.snippet.slice(0, 600);
    if (web.stance === 'supports') add(source, claim.o, { confidence: web.confidence, excerpt });
    else if (web.statedValue) add(source, { kind: 'literal', value: web.statedValue }, { confidence: web.confidence, excerpt });
    else add(source, { kind: 'literal', value: '?' }, { confidence: web.confidence, excerpt, needsObject: true, askedBy: TRIPLE_CHECK_AGENT,
      question: `${source.title} disputes "${report.claim}". What does it say instead?` });
  }
  for (const e of report.spaces) {
    // Same space: Review already compares a pending statement with what this space holds. Only another
    // space is news. A 'similar' match is about something else, so it is not this claim's evidence.
    if (e.spaceId === currentSpaceId || !e.object || e.relation === 'similar') continue;
    const agrees = e.relation === 'matches';
    // A copy of the same source is not a second witness; a judged-neutral difference is two values that both stand.
    if (agrees ? e.provenance === 'shared-source' || e.stance === 'contradicts' : e.stance === 'neutral' || e.stance === 'supports') continue;
    const source: Source = { id: `triple-check-space-${e.spaceId}`, title: `${e.spaceName} (another space)`, uri: `space://${e.spaceId}`, kind: 'document', trustLevel: 'review', ingestedAt: now };
    add(source, e.object, e.explanation ? { gloss: e.explanation } : {});
  }
  return [...groups.values()];
}
