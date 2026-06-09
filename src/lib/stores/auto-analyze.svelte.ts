/**
 * Auto-analyze store.
 *
 * Owns the periodic scheduler and the core runAndStoreAnalysis() function.
 * Results are persisted as a Source (kind='analysis') + pending Statements
 * so they flow through the normal review pipeline.
 */
import { v4 as uuid } from 'uuid';
import { settings } from './settings.svelte';
import { addSource, addStatements, confirmedStatements, onAfterAddSource } from './kb.svelte';
import { typeMap } from './entity-types.svelte';
import { reAnalyze, type EntitySummary, type AnalysisType } from '$lib/integrations/llm/re-analyze';
import { RDF_TYPE } from '$lib/rdf/entity-types';
import type { Statement, Source } from '$lib/rdf/types';
import { pushNotification } from './notifications.svelte';
import { embedMany, cosine } from '$lib/embed';
import { labelFromIRI } from '$lib/rdf/semantic-diff';

export type AnalysisTrigger = 'manual' | 'import' | 'schedule';

// ── Reactive state ──────────────────────────────────────────────────────────

let _running = $state(false);
let _lastRunAt = $state<number | null>(null);
let _lastError = $state<string | null>(null);
let _intervalId: ReturnType<typeof setInterval> | null = null;

export function analysisRunning() { return _running; }
export function lastAnalysisAt() { return _lastRunAt; }
export function lastAnalysisError() { return _lastError; }

// ── Entity summaries (duplicated here to avoid circular imports) ────────────

function buildEntitySummaries(): EntitySummary[] {
  const stmts = confirmedStatements();
  const tm = typeMap();
  const bySubject = new Map<string, Statement[]>();
  for (const st of stmts) {
    if (st.s.kind !== 'iri') continue;
    if (!bySubject.has(st.s.value)) bySubject.set(st.s.value, []);
    bySubject.get(st.s.value)!.push(st);
  }
  return [...bySubject.entries()]
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 50)
    .map(([iri, sts]) => {
      const typeStmt = sts.find(s => s.p.value === RDF_TYPE);
      const currentTypeIri = typeStmt?.o.value ?? null;
      const currentTypeDef = currentTypeIri ? tm.get(currentTypeIri) : null;
      const labelStmt = sts.find(s => s.p.value === 'http://www.w3.org/2000/01/rdf-schema#label');
      const label = labelStmt?.o.value ?? iri.split('/').pop() ?? iri;
      const predicates = sts
        .filter(s => s.p.value !== RDF_TYPE).slice(0, 8)
        .map(s => `${s.p.value.split('/').pop() ?? s.p.value} → ${s.o.value.slice(0, 60)}`);
      const sourceCount = new Set(sts.map(s => s.sourceId)).size;
      const isIsland = sts.length <= 2 && sourceCount === 1;
      return {
        iri, label, currentTypeIri,
        currentTypeLabel: currentTypeDef?.label ?? null,
        predicates,
        statementCount: sts.length,
        sourceCount,
        isIsland,
      };
    });
}

// ── Core run function ───────────────────────────────────────────────────────

/**
 * Run re-analysis and persist results as:
 *   • a Source record (kind='analysis') tracking model / trigger / count
 *   • pending Statements for every suggestion, linked to that source
 *
 * Returns the new analysis sourceId, or null if skipped / failed.
 */
export async function runAndStoreAnalysis(trigger: AnalysisTrigger = 'manual', analysisType: AnalysisType = 'new-triples'): Promise<string | null> {
  if (_running) return null;

  const s = settings();
  // Use per-task analyzeBackend, falling back to preferredBackend.
  // Analysis only supports cloud + ollama providers.
  const backendPref = s.analyzeBackend ?? s.preferredBackend;
  const provider: 'claude' | 'openai' | 'gemini' | 'ollama' | 'openrouter' | 'reckons' =
    backendPref === 'openai'     ? 'openai' :
    backendPref === 'gemini'     ? 'gemini' :
    backendPref === 'ollama'     ? 'ollama' :
    backendPref === 'openrouter' ? 'openrouter' :
    backendPref === 'reckons'    ? 'reckons' : 'claude';
  const apiKey =
    provider === 'openai'     ? s.openaiApiKey :
    provider === 'gemini'     ? s.geminiApiKey :
    provider === 'openrouter' ? s.openrouterApiKey :
    provider === 'reckons'    ? s.reckonsApiKey :
    provider === 'ollama'     ? '__ollama__' : // ollama needs no key
    s.claudeApiKey;

  if (!apiKey) {
    _lastError = `No ${provider} API key configured.`;
    return null;
  }

  _running = true;
  _lastError = null;
  const now = Date.now();
  const analysisId = uuid();
  const model =
    provider === 'openai'     ? s.openaiModel :
    provider === 'gemini'     ? s.geminiModel :
    provider === 'ollama'     ? s.ollamaModel :
    provider === 'openrouter' ? s.openrouterModel :
    provider === 'reckons'    ? (s.reckonsModel ?? '@cf/meta/llama-3.1-8b-instruct') :
    s.claudeModel;

  try {
    const entities = buildEntitySummaries();
    if (entities.length === 0) return null;

    // Annotate each entity with semantically similar near-duplicates so the
    // LLM has embedding evidence alongside its own heuristics.
    try {
      const labels = entities.map(e => labelFromIRI(e.iri));
      const vecs = await embedMany(labels);
      const THRESHOLD = 0.88;
      for (let i = 0; i < entities.length; i++) {
        const near: EntitySummary['nearDuplicates'] = [];
        for (let j = 0; j < entities.length; j++) {
          if (i === j) continue;
          const sim = cosine(vecs[i], vecs[j]);
          if (sim >= THRESHOLD) near.push({ iri: entities[j].iri, label: entities[j].label, similarity: sim });
        }
        if (near.length > 0) {
          entities[i].nearDuplicates = near.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
        }
      }
    } catch {
      // Embedding failure is non-fatal — continue without semantic annotations
    }

    const result = await reAnalyze({ provider, apiKey, model, ollamaBaseUrl: s.ollamaBaseUrl, reckonsBaseUrl: s.reckonsBaseUrl, entities, analysisType, kbTitle: s.kbTitle, kbDescription: s.kbDescription });
    const total =
      result.typeSuggestions.length +
      result.relationSuggestions.length +
      result.mergeSuggestions.length +
      (result.pruneSuggestions?.length ?? 0);

    // ── Persist analysis source record ──────────────────────────────────────
    // Merge and prune suggestions are stored as actions on the Source, NOT as
    // graph statements — they are editorial recommendations, not RDF facts.
    const source: Source = {
      id: analysisId,
      title: `Analysis · ${new Date(now).toLocaleString()}`,
      uri: `urn:kbase:analysis/${analysisId}`,
      ingestedAt: now,
      kind: 'analysis',
      trustLevel: 'review',
      analysisModel: model,
      analysisProvider: provider,
      analysisTrigger: trigger,
      analysisFocus: analysisType,
      analysisTotalSuggestions: total,
      analysisActions: {
        merges: result.mergeSuggestions,
        prunes: result.pruneSuggestions ?? [],
      },
    };
    await addSource(source);

    // ── Persist type + relation suggestions as pending statements ────────────
    // These ARE actual graph mutations (new rdf:type or predicate triple),
    // so they go through the normal statement review pipeline.
    const g = { kind: 'iri' as const, value: `urn:kbase:analysis/${analysisId}` };
    const pending: Statement[] = [];

    for (const t of result.typeSuggestions) {
      pending.push({
        id: uuid(),
        s: { kind: 'iri', value: t.entityIri },
        p: { kind: 'iri', value: RDF_TYPE },
        o: { kind: 'iri', value: t.suggestedTypeIri },
        g, sourceId: analysisId,
        confidence: 0.9,
        gloss: `[type] ${t.entityLabel}: ${t.currentTypeLabel ?? 'untyped'} → ${t.suggestedTypeLabel}. ${t.reason}`,
        status: 'pending', createdAt: now, updatedAt: now,
      });
    }

    for (const r of result.relationSuggestions) {
      pending.push({
        id: uuid(),
        s: { kind: 'iri', value: r.subjectIri },
        p: { kind: 'iri', value: r.predicateIri },
        o: { kind: 'iri', value: r.objectIri },
        g, sourceId: analysisId,
        confidence: 0.85,
        gloss: `[relation] ${r.subjectLabel} ${r.predicateLabel} ${r.objectLabel}. ${r.reason}`,
        status: 'pending', createdAt: now, updatedAt: now,
      });
    }

    if (pending.length > 0) await addStatements(pending);

    _lastRunAt = now;
    if (total > 0) {
      pushNotification({
        id: `analysis-${analysisId}`,
        type: 'success',
        title: 'Analysis complete',
        body: `${total} suggestion${total !== 1 ? 's' : ''} ready to review.`,
        action: { label: 'Go to Review →', href: '/review' }
      });
    }
    return analysisId;
  } catch (e) {
    _lastError = e instanceof Error ? e.message : String(e);
    console.error('Auto-analyze failed:', e);
    return null;
  } finally {
    _running = false;
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────

export function startScheduler() {
  stopScheduler();
  const minutes = settings().autoAnalyzeIntervalMinutes ?? 0;
  if (minutes > 0) {
    _intervalId = setInterval(() => runAndStoreAnalysis('schedule'), minutes * 60 * 1000);
  }
}

export function stopScheduler() {
  if (_intervalId !== null) { clearInterval(_intervalId); _intervalId = null; }
}

// ── Import hook ─────────────────────────────────────────────────────────────
// Registered once when this module is first imported.

onAfterAddSource((src) => {
  if (src.kind !== 'analysis' && settings().autoAnalyzeOnImport) {
    // Small delay so the import's statements are committed first
    setTimeout(() => runAndStoreAnalysis('import'), 1500);
  }
});
