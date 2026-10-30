import type { KBaseDB, SettingsRecord } from './db';
import type { LoadedGraphs } from './multi-graph-store';
import type { Statement } from '$lib/rdf/types';
import type { SourceJudgment } from '$lib/rdf/source-validation';
import { claimFingerprint, claimText, dailyLimit, evidenceProposals, selectNextClaim, spaceEvidence, type EvidenceProposal, type SpaceEvidence, type TripleCheckReport } from '$lib/rdf/triple-check';
import { searchConfigurationError, type WebPassage } from '$lib/integrations/search/triple-check';
export type CheckDependencies = {
  loadSpaces: () => Promise<LoadedGraphs>; providerError: string | null;
  search: (query: string, signal: AbortSignal) => Promise<WebPassage[]>;
  scrape?: (source: WebPassage, signal: AbortSignal) => Promise<WebPassage>;
  judge: (claim: Statement, sources: WebPassage[], signal: AbortSignal) => Promise<SourceJudgment[]>;
  judgeSpaces?: (claim: Statement, sources: SpaceEvidence[], signal: AbortSignal) => Promise<SpaceEvidence[]>;
  /** Write what the check found into Review as pending statements. Returns how many were added. */
  propose?: (proposals: EvidenceProposal[]) => Promise<number>;
};
/** Caller holds a per-space Web Lock. Reserve budget before making any metered request. */
export async function runTripleCheck(db: KBaseDB, spaceId: string, s: SettingsRecord, deps: CheckDependencies, signal: AbortSignal) {
  if (!s.tripleCheckEnabled || signal.aborted) return null;
  const now = Date.now(), [statements, reports] = await Promise.all([db.statements.toArray(), db.tripleChecks.toArray()]);
  const configuration = JSON.stringify([s.tripleCheckWebEnabled !== false, s.tripleCheckSearch, s.tripleCheckScrape, s.tripleCheckBackend ?? 'ollama', s.tripleCheckModel, s.tripleCheckSpaceAnalysis, s.tripleCheckReferenceSpaceIds, searchConfigurationError(s), deps.providerError]);
  const claim = selectNextClaim(statements, reports, now, configuration); if (!claim) return null;
  signal.throwIfAborted();
  const warnings = [searchConfigurationError(s), s.tripleCheckWebEnabled !== false ? deps.providerError : null].filter((v): v is string => !!v);
  let incomplete = false;
  if (reports.filter(r => r.webAttempted && r.checkedAt > now - 86400000).length >= dailyLimit(s.tripleCheckDailyLimit)) { warnings.push('Web not checked: the rolling 24-hour limit has been reached.'); incomplete = true; }
  const report: TripleCheckReport = { id: crypto.randomUUID(), statementId: claim.id, fingerprint: claimFingerprint(claim), configuration, claim: claimText(claim), checkedAt: now, state: 'checking', reviewed: false, webAttempted: false, web: [], spaces: [], searchedSpaces: 0, warnings };
  await db.tripleChecks.add(report);
  try {
    try {
      const loaded = await deps.loadSpaces(); signal.throwIfAborted();
      const result = spaceEvidence(claim, [...loaded.graphs, { id: spaceId, name: 'This space', statements }], spaceId, s.tripleCheckReferenceSpaceIds);
      report.spaces = result.evidence; report.searchedSpaces = loaded.graphs.length;
      if (result.truncated) warnings.push('Showing the 20 closest statement matches; additional matches exist.');
      warnings.push(...loaded.unavailable.map(g => `Space unavailable: ${g.name}.`));
      if (loaded.unavailable.length) incomplete = true;
      if (loaded.capped) warnings.push('Some spaces were excluded by the read limit.');
      if (s.tripleCheckSpaceAnalysis && deps.judgeSpaces && report.spaces.length) {
        try { report.spaces = await deps.judgeSpaces(claim, report.spaces, signal); }
        catch { signal.throwIfAborted(); warnings.push('Semantic space comparison failed; lexical candidates are shown.'); incomplete = true; }
      }
    } catch { signal.throwIfAborted(); warnings.push('Local spaces could not be read.'); incomplete = true; }
    signal.throwIfAborted();
    if (!warnings.some(w => w.startsWith('Web not checked:'))) {
      report.webAttempted = true; await db.tripleChecks.update(report.id, { webAttempted: true });
      try {
        const candidates = await deps.search(claimText(claim).slice(0, 400), signal); signal.throwIfAborted();
        const original = await Promise.all(statements.filter(t => claimFingerprint(t) === report.fingerprint).map(t => db.sources.get(t.sourceId)));
        const seen = new Set(original.map(o => o?.uri?.replace(/\/$/, '')));
        const sources: WebPassage[] = [];
        for (const candidate of candidates) {
          let url: URL; try { url = new URL(candidate.url); } catch { continue; }
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || typeof candidate.content !== 'string') continue;
          url.hash = ''; const key = url.href.replace(/\/$/, ''); if (seen.has(key)) continue; seen.add(key);
          let source = candidate;
          if (deps.scrape) { try { source = await deps.scrape(candidate, signal); } catch { signal.throwIfAborted(); warnings.push(`Page scraping failed for ${url.hostname}; using its search passage.`); } }
          sources.push(source); if (sources.length === 5) break;
        }
        if (sources.length) report.web = await deps.judge(claim, sources, signal);
      } catch { signal.throwIfAborted(); warnings.push('Web search or analysis failed. This is incomplete evidence, not a finding against the claim.'); incomplete = true; }
    }
    signal.throwIfAborted();
    if (deps.propose) {
      const proposals = evidenceProposals(claim, report, statements, spaceId, Date.now());
      try { report.proposed = proposals.length ? await deps.propose(proposals) : 0; }
      catch { signal.throwIfAborted(); warnings.push('What was found could not be added to Review; it will be checked again.'); incomplete = true; }
    }
    report.state = 'complete'; report.incomplete = incomplete; await db.tripleChecks.put(report);
    // One report per claim: a superseded check is history nobody reads, and without this the table grew by
    // one row per check forever. Web-attempted rows from the last 24h stay, because the daily limit counts them.
    const stale = reports.filter(r => r.fingerprint === report.fingerprint && r.id !== report.id && !(r.webAttempted && r.checkedAt > now - 86400000));
    if (stale.length) await db.tripleChecks.bulkDelete(stale.map(r => r.id));
    return report;
  } catch (error) {
    await db.tripleChecks.update(report.id, { state: 'complete', incomplete: true, warnings: [...warnings, 'Check interrupted; evidence is incomplete.'] }); throw error;
  }
}
