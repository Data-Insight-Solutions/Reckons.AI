/**
 * Client-side merge analysis.
 *
 * Replaces the dead src/routes/api/merge-analysis.ts (which was a server-side
 * RequestHandler that can never execute under adapter-static). All LLM calls go
 * directly from the browser to the chosen provider, exactly like re-analyze.ts.
 */

import { chatClaude, chatOpenAI, chatGemini, chatOllama, chatOpenRouter, chatReckons } from './providers';
import { settings } from '$lib/stores/settings.svelte';
import { db } from '$lib/storage/db';
import { ETHICS_PREAMBLE } from '$lib/safety/content-policy';
import { findTemporalConflicts } from '$lib/rdf/temporal';
import { embedMany, cosine } from '$lib/embed';

export interface MergeAnalysisStatement {
  s: { value: string };
  p: { value: string };
  o: { value: string };
  sourceId: string;
}

export interface MergeAnalysisSource {
  id: string;
  title: string;
  trustLevel?: 'trusted' | 'review';
}

export interface MergeAnalysisParams {
  entityKeyA: string;
  entityKeyB: string;
  statementsA: MergeAnalysisStatement[];
  statementsB: MergeAnalysisStatement[];
  sourcesInfo: MergeAnalysisSource[];
  /** Present on follow-up calls; absent on the initial analysis. */
  followUpQuestion?: string;
  /** The first assistant response — required for follow-up calls. */
  previousAnalysis?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatStatements(stmts: MergeAnalysisStatement[], sources: MergeAnalysisSource[]): string {
  return stmts.map(st => {
    const src = sources.find(s => s.id === st.sourceId);
    const trust = src?.trustLevel === 'trusted' ? '⭐' : '◐';
    return `${st.s.value} → ${st.p.value} → ${st.o.value} [${trust} ${src?.title ?? 'unknown'}]`;
  }).join('\n');
}

async function buildHistoricalContext(countA: number, countB: number): Promise<string> {
  try {
    const decisions = await db.mergeDecisions.toArray();
    if (decisions.length === 0) return '';

    const ratio = Math.min(countA, countB) / Math.max(countA, countB);
    const similar = decisions.filter(d => {
      const pastRatio = Math.min(d.statementCountA, d.statementCountB) /
                        Math.max(d.statementCountA, d.statementCountB);
      return Math.abs(ratio - pastRatio) < 0.3;
    });
    if (similar.length === 0) return '';

    const acceptanceRate = (similar.filter(d => d.acceptedAI).length / similar.length * 100).toFixed(0);
    const preferLarger = similar.filter(d =>
      (d.decision === 'keep_a' && d.statementCountA > d.statementCountB) ||
      (d.decision === 'keep_b' && d.statementCountB > d.statementCountA)
    ).length / similar.length * 100;

    return `\n\n**Historical Pattern:** ${similar.length} similar merges. AI recommendations accepted ${acceptanceRate}% of the time. Larger entity kept in ${preferLarger.toFixed(0)}% of cases.`;
  } catch {
    return '';
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run a merge analysis (or follow-up question) using the configured analyze backend.
 * Returns the assistant's text response.
 */
export async function analyzeMerge(params: MergeAnalysisParams): Promise<string> {
  const s = settings();
  const backendPref = s.mergeAnalysisBackend ?? s.analyzeBackend ?? s.preferredBackend;
  const provider: 'claude' | 'openai' | 'gemini' | 'ollama' | 'openrouter' | 'reckons' =
    backendPref === 'openai'     ? 'openai' :
    backendPref === 'gemini'     ? 'gemini' :
    backendPref === 'ollama'     ? 'ollama' :
    backendPref === 'openrouter' ? 'openrouter' :
    backendPref === 'reckons'    ? 'reckons' : 'claude';

  const apiKey =
    provider === 'openai'     ? (s.openaiApiKey     ?? '') :
    provider === 'gemini'     ? (s.geminiApiKey     ?? '') :
    provider === 'openrouter' ? (s.openrouterApiKey ?? '') :
    provider === 'reckons'    ? (s.reckonsApiKey    ?? '') :
    provider === 'ollama'     ? '__ollama__' :
    (s.claudeApiKey ?? '');

  const model =
    provider === 'openai'     ? s.openaiModel :
    provider === 'gemini'     ? s.geminiModel :
    provider === 'ollama'     ? s.ollamaModel :
    provider === 'openrouter' ? s.openrouterModel :
    provider === 'reckons'    ? (s.reckonsModel ?? '@cf/meta/llama-3.1-8b-instruct') :
    s.claudeModel;

  const { entityKeyA, entityKeyB, statementsA, statementsB, sourcesInfo,
          followUpQuestion, previousAnalysis } = params;

  let prompt: string;

  if (!previousAnalysis) {
    // ── Initial analysis with enriched context ──────────────────────────────
    const stmtsAText = formatStatements(statementsA, sourcesInfo);
    const stmtsBText = formatStatements(statementsB, sourcesInfo);

    // Temporal conflicts
    let temporalText = '';
    const conflicts = findTemporalConflicts([...statementsA, ...statementsB] as Parameters<typeof findTemporalConflicts>[0]);
    if (conflicts.length > 0) {
      temporalText = `\n\n**Temporal Conflicts Detected:**\n${conflicts.map(c =>
        `- ${c.subject} (${c.predicate}): ${c.values.map(v => `"${v.value}"`).join(' vs ')} [severity: ${c.severity}]`
      ).join('\n')}`;
    }

    // Historical merge patterns
    const historicalText = await buildHistoricalContext(statementsA.length, statementsB.length);

    // Semantic label similarity
    let similarityText = '';
    try {
      const labelA = entityKeyA.split('/').pop() ?? entityKeyA;
      const labelB = entityKeyB.split('/').pop() ?? entityKeyB;
      const embeddings = await embedMany([labelA, labelB]);
      const sim = cosine(embeddings[0], embeddings[1]);
      similarityText = `\n\nSemantic Similarity (label): ${(sim * 100).toFixed(0)}%`;
    } catch { /* non-fatal */ }

    prompt = ETHICS_PREAMBLE + `You are a semantic data analyst helping a user decide whether to merge two RDF entities.

**Entity A: ${entityKeyA}**
${statementsA.length} statements:
${stmtsAText}

**Entity B: ${entityKeyB}**
${statementsB.length} statements:
${stmtsBText}
${temporalText}${similarityText}${historicalText}

Provide a concise analysis (under 200 words) covering:
1. **Key differences** — what semantic content distinguishes these entities?
2. **Data loss** — what is lost if merging into A vs B?
3. **Trust** — which entity has more trusted sources?
4. **Redundancy** — overlapping or duplicate statements?
5. **Recommendation** — which should be the merge target and why?

Be specific and actionable.`;
  } else {
    // ── Follow-up question with full context ────────────────────────────────
    prompt = ETHICS_PREAMBLE + `Previous analysis of merge between ${entityKeyA} and ${entityKeyB}:
${previousAnalysis}

User follow-up: ${followUpQuestion ?? '(no question provided)'}

Answer concisely (under 150 words) based on the context above.`;
  }

  const messages = [{ role: 'user' as const, content: prompt }];

  if (provider === 'openai')     return chatOpenAI(messages, '', apiKey, model, 1024);
  if (provider === 'gemini')     return chatGemini(messages, '', apiKey, model, 1024);
  if (provider === 'ollama')     return chatOllama(messages, '', model, s.ollamaBaseUrl, 1024);
  if (provider === 'openrouter') return chatOpenRouter(messages, '', apiKey, model, 1024);
  if (provider === 'reckons')    return chatReckons(messages, '', apiKey, s.reckonsBaseUrl, model, 1024);
  return chatClaude(messages, '', apiKey, model, 1024);
}
