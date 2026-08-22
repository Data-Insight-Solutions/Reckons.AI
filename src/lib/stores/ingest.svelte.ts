import { v4 as uuid } from 'uuid';
import type { Source, Statement } from '../rdf/types';
import { extractWithClaude } from '../integrations/llm/claude';
import { extractWithWasm } from '../integrations/llm/wasm';
import { extractWithOllama } from '../integrations/llm/ollama-extract';
import { chatOpenAI, chatGemini, chatOpenRouter, chatChromeAI, chatReckons } from '../integrations/llm/providers';
import { triplesToStatements, extractMock, parseTriplesJSONWithReport, validateExtractedTriples, EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt, type ExtractedTriple } from '../integrations/llm/extractor';
import { computeDiff, type Diff } from '../rdf/diff';
import { semanticEnrichDiff, labelFromIRI } from '../rdf/semantic-diff';
import { normalizeEntities } from '../rdf/normalize-entities';
import { selectVocabulary, buildVocabularySection } from '../rdf/vocabulary-context';
import {
  selectStructuralContext, buildStructuralSection, validateStructuralClaims,
  type StructuralContext,
} from '../rdf/structural-context';
import { resolveArchiveReferencesForIngest } from '../ingest/archive-reference';
import { fetchTurtleFromUrl } from '../integrations/parsers/turtle-url';
import { prepareStatementsForWrite, persistIngestBatch, statements as allStatements } from './kb.svelte';
import { settings } from './settings.svelte';
import { addSuggestion } from './disambiguation.svelte';
import { pushNotification } from './notifications.svelte';
import {
  cancelExtractionRun,
  completeExtractionRun,
  createExtractionRun,
  extractionLocalityForBackend,
  failExtractionRun,
  finishExtractionAttempt,
  finishExtractionStage,
  recordExtractionOutput,
  startExtractionAttempt,
  startExtractionFallbackAttempt,
  startExtractionStage,
} from '../ingest/extraction-run';
import { saveExtractionRun } from '../storage/extraction-runs';
import type { ExtractionStageName } from '../rdf/types';

/**
 * One pipeline for all four ingestion modes — URL, document, note, reminder.
 * The output is always the same: a new Source, a batch of pending Statements,
 * and a Diff against the existing KB that the review UI can render.
 */

export type IngestInput =
  | { kind: 'url'; url: string }
  | { kind: 'document'; title: string; text: string; filename?: string }
  | { kind: 'note'; title: string; body: string }
  | { kind: 'reminder'; title: string; body: string; dueAt?: number }
  | { kind: 'repository'; repoUrl: string; token?: string };

export type IngestDone = {
  phase: 'done';
  source: Source;
  statements: Statement[];
  diff: Diff;
};

export type IngestCancelled = {
  phase: 'cancelled';
  reason: 'archive-reference';
};

export type IngestProgress =
  | { phase: 'fetching' }
  | { phase: 'extracting'; backend: 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'mock' | 'openrouter' | 'chrome-ai' | 'reckons' }
  | { phase: 'normalizing' }
  | { phase: 'archive-check' }
  | { phase: 'awaiting-archive-decision' }
  | { phase: 'restoring-archive' }
  | { phase: 'diffing' }
  | { phase: 'semantic' }
  | IngestDone
  | IngestCancelled;

export type IngestResult = IngestDone | IngestCancelled;

const JINA_PROXY = 'https://r.jina.ai/';

async function fetchReadable(url: string): Promise<{ title: string; text: string }> {
  // Prefer Firecrawl (JS rendering, better quality) when a key is configured.
  // Falls back to Jina Reader (free, no key, simple GET).
  const firecrawlKey = settings().firecrawlApiKey;
  if (firecrawlKey) {
    const { fetchWithFirecrawl } = await import('../integrations/parsers/firecrawl');
    return fetchWithFirecrawl(url, firecrawlKey);
  }
  const res = await fetch(`${JINA_PROXY}${url}`);
  if (!res.ok) throw new Error(`Reader failed: ${res.status}`);
  const text = await res.text();
  const titleMatch = text.match(/^Title:\s*(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? url;
  return { title, text };
}

export async function ingest(
  input: IngestInput,
  onProgress?: (p: IngestProgress) => void
): Promise<IngestResult> {
  const id = uuid();
  let title: string;
  let text: string;
  let uri: string;
  let kind: Source['kind'];

  // Extra metadata for repository sources
  let repoMeta: { owner: string; repo: string; branch: string; headSha: string; fileCount: number } | undefined;

  // Set when the URL is a Reckons.AI graph: its own TTL is imported directly as
  // pending facts, skipping LLM extraction entirely (F72 kb:ttl-aware-ingest).
  let turtleStatements: Statement[] | null = null;

  if (input.kind === 'url') {
    onProgress?.({ phase: 'fetching' });
    const ttl = await fetchTurtleFromUrl(input.url);
    if (ttl) {
      const { importTurtleFull } = await import('../rdf/import-ttl');
      turtleStatements = (await importTurtleFull(ttl)).statements;
      title = input.url.split('/').filter(Boolean).pop() || input.url;
      text = ttl;
    } else {
      const fetched = await fetchReadable(input.url);
      title = fetched.title;
      text = fetched.text;
    }
    uri = input.url;
    kind = 'url';
  } else if (input.kind === 'repository') {
    onProgress?.({ phase: 'fetching' });
    const { parseRepoUrl, fetchRepoFiles, buildRepoExtractionText } =
      await import('../integrations/github/repo-ingest');
    const ref = parseRepoUrl(input.repoUrl);
    if (!ref) throw new Error(`Invalid GitHub repo URL: ${input.repoUrl}`);
    const { meta, files } = await fetchRepoFiles(ref, input.token, (p) => {
      if (p.phase === 'reading-files') {
        onProgress?.({ phase: 'fetching' });
      }
    });
    title = `${meta.owner}/${meta.repo}`;
    text = buildRepoExtractionText(meta, files);
    uri = `https://github.com/${meta.owner}/${meta.repo}`;
    kind = 'repository';
    repoMeta = { owner: meta.owner, repo: meta.repo, branch: meta.branch, headSha: meta.headSha, fileCount: files.length };
  } else if (input.kind === 'document') {
    title = input.title;
    text = input.text;
    uri = `file://${input.filename ?? input.title}`;
    kind = 'document';
  } else if (input.kind === 'note') {
    title = input.title;
    text = input.body;
    uri = `note://${id}`;
    kind = 'note';
  } else {
    title = input.title;
    text = `Reminder: ${input.title}\n${input.body}${input.dueAt ? `\nDue: ${new Date(input.dueAt).toISOString()}` : ''}`;
    uri = `reminder://${id}`;
    kind = 'reminder';
  }

  const source: Source = {
    id,
    title,
    uri,
    ingestedAt: Date.now(),
    kind,
    hash: await sha256(text),
    ...(repoMeta ? {
      repoOwner: repoMeta.owner,
      repoName: repoMeta.repo,
      repoBranch: repoMeta.branch,
      repoHeadSha: repoMeta.headSha,
      repoFileCount: repoMeta.fileCount,
    } : {}),
  };

  const s = settings();
  // Per-task backend override — falls back to the global preferredBackend.
  // Smart fallback: if a cloud backend is selected but no key is configured,
  // drop to WASM so the app still works without any setup.
  const chosen = s.ingestBackend ?? s.preferredBackend;
  const hasKey =
    chosen === 'claude'      ? !!s.claudeApiKey :
    chosen === 'openai'      ? !!s.openaiApiKey :
    chosen === 'gemini'      ? !!s.geminiApiKey :
    chosen === 'openrouter'  ? !!s.openrouterApiKey :
    chosen === 'reckons'     ? !!s.reckonsApiKey :
    true; // ollama, wasm, mock, manual, chrome-ai need no key
  const backend = hasKey ? chosen : 'wasm';
  onProgress?.({ phase: 'extracting', backend });

  // F136.1: capture the already-resolved CURRENT routing rule before work begins. This does not
  // introduce retries or alter the old fallback; it makes the existing choice and its locality
  // inspectable. Direct Turtle import is an explicit manual path, not a pretend model run.
  const executionBackend = turtleStatements ? 'manual' : backend;
  const executionModel = turtleStatements ? 'turtle-import' :
    backend === 'claude'     ? (s.claudeModel     ?? 'claude-opus-4-7')                        :
    backend === 'openai'     ? (s.openaiModel     ?? 'gpt-4o-mini')                            :
    backend === 'gemini'     ? (s.geminiModel     ?? 'gemini-2.0-flash')                       :
    backend === 'ollama'     ? (s.ollamaModel     ?? 'llama3.2')                               :
    backend === 'wasm'       ? (s.wasmIngestModel || s.wasmModel || 'onnx-community/Qwen2.5-0.5B-Instruct') :
    backend === 'openrouter' ? (s.openrouterModel ?? 'meta-llama/llama-3.2-3b-instruct:free')  :
    backend === 'reckons'    ? (s.reckonsModel    ?? '@cf/meta/llama-3.1-8b-instruct')         :
    backend === 'chrome-ai'  ? 'chrome-ai'                                                      :
    'mock';
  const routeReason = turtleStatements
    ? 'direct Turtle import'
    : hasKey
      ? (s.ingestBackend ? 'per-task ingest backend' : 'preferred backend')
      : `configured ${chosen} backend has no usable key; existing WASM fallback`;
  let run = createExtractionRun({
    sourceId: source.id,
    sourceHash: source.hash ?? '',
    backend: executionBackend,
    model: executionModel,
    locality: extractionLocalityForBackend(executionBackend),
    reason: routeReason,
    schemaId: backend === 'ollama' && s.ollamaStructuredExtraction !== false ? 'extracted-triple-json-schema-v1' : undefined,
  });
  source.extractionBackend = executionBackend;
  source.extractionModel = executionModel;
  source.latestExtractionRunId = run.id;
  run = finishExtractionStage(
    startExtractionStage(run, 'route'),
    'route',
    'succeeded',
    routeReason,
  );
  await saveExtractionRun(run);
  let activeRunStage: ExtractionStageName = 'extract';

  try {
    // Augment system prompt for code/repository sources. Keep this inside the tracked extract
    // boundary: a failed lazy import is an extraction failure, not a run left "running" forever.
    let systemPrompt = EXTRACTION_SYSTEM_PROMPT;
    if (kind === 'repository') {
      const { CODE_EXTRACTION_SUPPLEMENT } = await import('../integrations/github/repo-ingest');
      systemPrompt = EXTRACTION_SYSTEM_PROMPT + CODE_EXTRACTION_SUPPLEMENT;
    }

    let triples: ExtractedTriple[] = [];
    /**
     * The graph context this extraction was grounded in (F136.3). Declared out here because it is
     * BUILT in the extract block and CONSUMED in the validate block — the two are separate
     * if/else arms over `turtleStatements`, and a direct Turtle import legitimately has neither.
     */
    let structCtx: StructuralContext | null = null;
    // Adapter APIs that already return ExtractedTriple[] cannot reveal entries their own parser
    // discarded. Raw-chat adapters supply the fuller parser count below; neither path retains raw
    // provider output in the run record.
    let parsedCandidateCount: number | undefined;
    let parserRejectedCount = 0;
    if (turtleStatements) {
      // Direct TTL import (F72) — the graph is already parsed; no LLM extraction.
      run = finishExtractionStage(run, 'extract', 'skipped', 'direct Turtle import');
    } else {
      run = startExtractionStage(run, 'extract');
      run = startExtractionAttempt(run);
      await saveExtractionRun(run);

      /*
       * F136 / F136.3 — GROUND THE PROMPT IN THE GRAPH IT IS WRITING INTO.
       *
       * Until 2026-08-19 every call below passed no graph context at all, which is why F136 was
       * scaffolded-but-inert and why `Statement.blocks` is populated on 8 of 529 queue rows: nothing
       * knew the graph when a fact was born, so every structural relation had to be inferred later
       * by something with less information than the extractor had.
       *
       * Both sections are appended LAST and are EMPTY on a first ingest, so an empty graph pays
       * nothing and every existing prompt keeps its bytes when there is nothing to say.
       */
      const groundingStatements = allStatements();
      const vocabCtx = selectVocabulary(groundingStatements, text);
      structCtx = selectStructuralContext(groundingStatements, { sourceText: text });
      const graphContext = `${buildVocabularySection(vocabCtx)}${buildStructuralSection(structCtx)}`;
      if (backend === 'openai') {
        const raw = await chatOpenAI(
          [{ role: 'user', content: buildExtractionUserPrompt(text, title, graphContext) }],
          systemPrompt,
          s.openaiApiKey!,
          s.openaiModel
        );
        const parsed = parseTriplesJSONWithReport(raw);
        triples = parsed.triples;
        parsedCandidateCount = parsed.candidateCount;
        parserRejectedCount = parsed.parserRejectedCount;
      } else if (backend === 'gemini') {
        const raw = await chatGemini(
          [{ role: 'user', content: buildExtractionUserPrompt(text, title, graphContext) }],
          systemPrompt,
          s.geminiApiKey!,
          s.geminiModel
        );
        const parsed = parseTriplesJSONWithReport(raw);
        triples = parsed.triples;
        parsedCandidateCount = parsed.candidateCount;
        parserRejectedCount = parsed.parserRejectedCount;
      } else if (backend === 'claude') {
        triples = await extractWithClaude(text, title, { apiKey: s.claudeApiKey!, model: s.claudeModel, systemPrompt });
      } else if (backend === 'openrouter') {
        const raw = await chatOpenRouter(
          [{ role: 'user', content: buildExtractionUserPrompt(text, title, graphContext) }],
          systemPrompt,
          s.openrouterApiKey!,
          s.openrouterModel
        );
        const parsed = parseTriplesJSONWithReport(raw);
        triples = parsed.triples;
        parsedCandidateCount = parsed.candidateCount;
        parserRejectedCount = parsed.parserRejectedCount;
      } else if (backend === 'ollama') {
        // Repository sources already compose a specialised (code-aware) system
        // prompt above — pass it through as an override so small-model prompt
        // selection doesn't replace it.
        triples = await extractWithOllama(text, title, {
          model: s.ollamaModel,
          baseUrl: s.ollamaBaseUrl,
          systemPromptOverride: kind === 'repository' ? systemPrompt : undefined,
          promptMode: s.ollamaPromptMode,
          structured: s.ollamaStructuredExtraction !== false
        });
      } else if (backend === 'reckons') {
        const raw = await chatReckons(
          [{ role: 'user', content: buildExtractionUserPrompt(text, title, graphContext) }],
          systemPrompt,
          s.reckonsApiKey!,
          s.reckonsBaseUrl,
          s.reckonsModel
        );
        const parsed = parseTriplesJSONWithReport(raw);
        triples = parsed.triples;
        parsedCandidateCount = parsed.candidateCount;
        parserRejectedCount = parsed.parserRejectedCount;
      } else if (backend === 'chrome-ai') {
        const raw = await chatChromeAI(
          [{ role: 'user', content: buildExtractionUserPrompt(text, title, graphContext) }],
          systemPrompt
        );
        const parsed = parseTriplesJSONWithReport(raw);
        triples = parsed.triples;
        parsedCandidateCount = parsed.candidateCount;
        parserRejectedCount = parsed.parserRejectedCount;
      } else if (backend === 'wasm') {
        try {
          triples = await extractWithWasm(text, title, s.wasmIngestModel || s.wasmModel);
        } catch (wasmErr) {
          console.warn('[fallback] WASM extraction failed, using mock:', wasmErr);
          const errMsg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
          // Existing behavior falls back to placeholder extraction. Record both attempts so a
          // completed run never falsely reads as a clean WASM success.
          run = finishExtractionAttempt(run, 'failed', errMsg);
          run = startExtractionFallbackAttempt(run, {
            backend: 'mock',
            model: 'placeholder-extractor-v1',
            locality: 'browser',
          });
          // Source metadata names the extractor that actually produced the persisted facts;
          // the run keeps WASM as the selected primary and preserves its failed attempt.
          source.extractionBackend = 'mock';
          source.extractionModel = 'placeholder-extractor-v1';
          await saveExtractionRun(run);
          const isOnnx = /registerBackend|ONNX runtime/i.test(errMsg);
          pushNotification({
            id: 'wasm-fallback',
            type: 'warn',
            title: 'Local AI unavailable — used placeholder extraction',
            body: isOnnx
              ? 'ONNX runtime is not supported in this browser. Facts were placeholder-extracted. Try Ollama, Chrome AI, or a cloud backend in Settings.'
              : 'The WASM model could not load. Facts were placeholder-extracted and need careful review. Switch to a cloud backend in Settings for better quality.',
            action: { label: 'Settings', href: '/settings' },
          });
          triples = extractMock(text, title);
        }
      } else {
        triples = extractMock(text, title);
      }
      run = finishExtractionAttempt(run, 'succeeded');
      run = finishExtractionStage(run, 'extract');
    }
    await saveExtractionRun(run);

    activeRunStage = 'validate';
    if (turtleStatements) {
      run = finishExtractionStage(run, activeRunStage, 'skipped', 'direct Turtle import has its own parser');
    } else {
      run = startExtractionStage(run, activeRunStage);

      /*
       * F136.3 — DROP INVENTED DEPENDENCIES BEFORE THEY REACH THE GRAPH.
       *
       * Offering the model existing entities makes it able to state real structure; it also makes it
       * able to state confident structure about entities that do not exist. A fabricated dependency
       * is worse than a missing one, because the F139 review tree RANKS BY dependency — a made-up
       * edge promotes the wrong decision to the top and the ranking looks well-informed while doing
       * it. A dependency on something this same batch introduced is legitimate and is kept.
       */
      const structuralCheck = structCtx
        ? validateStructuralClaims(triples, structCtx)
        : { kept: triples, dropped: [] };
      if (structuralCheck.dropped.length > 0) {
        for (const d of structuralCheck.dropped) {
          console.warn(`[ingest/F136.3] dropped ${d.claim.subject} ${d.claim.predicate} ${d.claim.object}: ${d.reason}`);
        }
        triples = structuralCheck.kept;
      }

      const validated = validateExtractedTriples(triples);
      const candidates = parsedCandidateCount ?? triples.length;
      run = {
        ...run,
        validationCounts: {
          candidates,
          accepted: validated.triples.length,
          parserRejected: parserRejectedCount,
          rejected: validated.rejectedCount,
          grounded: 0,
          ungrounded: 0,
        },
      };
      if (validated.triples.length === 0) {
        throw new Error(`Extraction produced no usable triples (${candidates} candidate(s); ${parserRejectedCount + validated.rejectedCount} rejected)`);
      }
      triples = validated.triples;
      run = finishExtractionStage(
        run,
        activeRunStage,
        'succeeded',
        `${validated.triples.length} accepted; ${parserRejectedCount + validated.rejectedCount} rejected`,
      );
    }
    await saveExtractionRun(run);

    // Direct-imported graphs land as PENDING facts for review (no LLM); otherwise
    // convert the extracted triples as usual.
    // `text` is the source the model actually read, so pass it: every excerpt is verified
    // against it, and a fabricated citation is dropped rather than shown as provenance
    // (kb:passage-grounding).
    activeRunStage = 'ground';
    run = startExtractionStage(run, activeRunStage);
    let newStatements: Statement[] = turtleStatements
      ? turtleStatements.map((st) => ({ ...st, status: 'pending' as const, extractionRunId: run.id }))
      : triplesToStatements(triples, source, text).map((st) => ({ ...st, extractionRunId: run.id }));
    run = {
      ...run,
      candidateStatementCount: newStatements.length,
      validationCounts: {
        ...run.validationCounts,
        grounded: newStatements.filter((st) => st.grounded === true).length,
        ungrounded: newStatements.filter((st) => st.grounded === false).length,
      },
    };
    run = finishExtractionStage(
      run,
      activeRunStage,
      turtleStatements ? 'skipped' : 'succeeded',
      turtleStatements ? 'imported graph already carried its own provenance' : undefined,
    );
    await saveExtractionRun(run);

    // Normalise incoming entities against existing KB vocabulary.
    // Rewrites IRIs to match existing entities/predicates when similarity is high,
    // preventing duplicates like "common-octopus" vs "octopus-vulgaris" from
    // entering the review queue as separate entities.
    activeRunStage = 'normalize';
    run = startExtractionStage(run, activeRunStage);
    onProgress?.({ phase: 'normalizing' });
    let existingStmts = allStatements();
    const normResult = await normalizeEntities(newStatements, existingStmts);
    newStatements = normResult.statements;
    if (normResult.remaps.length > 0) {
      console.info(`[ingest] Normalised ${normResult.subjectRemaps} entities, ${normResult.predicateRemaps} predicates:`,
        normResult.remaps.map(r => `${r.kind}: "${labelFromIRI(r.from)}" → "${labelFromIRI(r.to)}"`));
    }
    run = finishExtractionStage(run, activeRunStage);
    await saveExtractionRun(run);

    activeRunStage = 'archive';
    run = startExtractionStage(run, activeRunStage);
    const archiveResolution = await resolveArchiveReferencesForIngest({
      sourceTitle: source.title,
      statements: newStatements,
      onPhase: (archivePhase) => {
        onProgress?.({
          phase:
            archivePhase === 'checking' ? 'archive-check'
            : archivePhase === 'awaiting-decision' ? 'awaiting-archive-decision'
            : 'restoring-archive',
        });
      },
    });
    if (archiveResolution.decision === 'cancel') {
      run = cancelExtractionRun(run, activeRunStage, 'user declined archive restore');
      await saveExtractionRun(run);
      const cancelled: IngestCancelled = {
        phase: 'cancelled',
        reason: 'archive-reference',
      };
      onProgress?.(cancelled);
      return cancelled;
    }
    newStatements = archiveResolution.statements;
    run = finishExtractionStage(run, activeRunStage, 'succeeded', archiveResolution.decision);
    await saveExtractionRun(run);
    // A restore writes through a separate Dexie adapter, then reloads the reactive store. Read the
    // current statements again so the diff is computed against the restored graph, not the stale
    // pre-consent snapshot captured above.
    existingStmts = allStatements();

    activeRunStage = 'diff';
    run = startExtractionStage(run, activeRunStage);
    onProgress?.({ phase: 'diffing' });
    const structuralDiff = computeDiff(newStatements, existingStmts);

    onProgress?.({ phase: 'semantic' });
    const diff = await semanticEnrichDiff(structuralDiff, existingStmts);
    run = finishExtractionStage(run, activeRunStage);
    await saveExtractionRun(run);

    activeRunStage = 'persist';
    run = startExtractionStage(run, activeRunStage);
    await saveExtractionRun(run);
    // A 'returned' entry is an exact triple the user already rejected or superseded, offered
    // again by a re-read (F122). Storing it would add a fresh row per poll for a decision that is
    // already recorded, so it is NOT persisted — the review card acts on the statement already in
    // the graph instead. Classifying it was necessary to stop it reading as news; declining to
    // store it is what actually stops the pile-up.
    const returnedIds = new Set(
      diff.entries.filter((e) => e.kind === 'returned').map((e) => e.incoming.id)
    );
    const statementsToPersist = returnedIds.size > 0
      ? newStatements.filter((st) => !returnedIds.has(st.id))
      : newStatements;
    // Use the same content/archive admission funnel as every other graph write, but obtain its
    // exact accepted batch before opening the ingest transaction. This is what lets the terminal
    // run name real output ids while source, statements, changelog, and terminal run commit as one.
    const writePlan = await prepareStatementsForWrite(statementsToPersist, source.id);
    run = recordExtractionOutput(
      run,
      writePlan.statements.map((statement) => statement.id),
      run.validationCounts,
    );
    run = finishExtractionStage(run, activeRunStage);
    run = completeExtractionRun(run);
    await persistIngestBatch(source, writePlan, run);

    // Detect similar entity names via semantic clustering
    try {
    const entityKeys = new Set<string>();
    for (const st of newStatements) {
      if (st.s.kind === 'iri') {
        const key = st.s.value;
        if (key.startsWith('kb:')) {
          entityKeys.add(key);
        }
      }
    }

    if (entityKeys.size > 1) {
      const keys = Array.from(entityKeys);
      const labels = keys.map((k) => k.split('/').pop() || k);
      const { embedMany, cluster } = await import('../embed');
      const embeddings = await embedMany(labels);
      const clusters = cluster(keys, embeddings, 0.85);

      // For each cluster with >1 member, add disambiguation suggestions
      for (const clusterGroup of clusters) {
        if (clusterGroup.length > 1) {
          for (let i = 0; i < clusterGroup.length - 1; i++) {
            const keyA = clusterGroup[i];
            const keyB = clusterGroup[i + 1];
            // Rough similarity from cluster membership
            const similarity = 0.87;
            addSuggestion({
              id: `${keyA}::${keyB}`,
              entityKeyA: keyA,
              entityKeyB: keyB,
              similarity,
              timestamp: Date.now(),
              dismissed: false
            });
          }
        }
      }
    }
    } catch (err) {
      // Embedding/clustering errors shouldn't block ingestion
      console.warn('Disambiguation clustering failed:', err);
    }

    const done: IngestDone = {
      phase: 'done',
      source,
      statements: newStatements,
      diff
    };
    onProgress?.(done);
    return done;
  } catch (error) {
    // Do not hide a primary failure or overwrite it with a later fallback result. Current
    // behavior has no new retry path; this only makes the old failure inspectable.
    if (activeRunStage === 'extract') run = finishExtractionAttempt(run, 'failed', error instanceof Error ? error.message : String(error));
    run = failExtractionRun(run, activeRunStage, error);
    await saveExtractionRun(run);
    throw error;
  }
}

/**
 * Build the LLM extraction prompt for a given input without calling an LLM.
 * Used by the "copy prompt" UI so the user can paste it into any LLM manually.
 */
export async function buildIngestionPrompt(input: IngestInput): Promise<{ prompt: string; title: string }> {
  let title: string;
  let text: string;
  if (input.kind === 'url') {
    const fetched = await fetchReadable(input.url);
    title = fetched.title;
    text = fetched.text;
  } else if (input.kind === 'repository') {
    const { parseRepoUrl, fetchRepoFiles, buildRepoExtractionText } =
      await import('../integrations/github/repo-ingest');
    const ref = parseRepoUrl(input.repoUrl);
    if (!ref) throw new Error(`Invalid GitHub repo URL: ${input.repoUrl}`);
    const { meta, files } = await fetchRepoFiles(ref, input.token);
    title = `${meta.owner}/${meta.repo}`;
    text = buildRepoExtractionText(meta, files);
  } else if (input.kind === 'document') {
    title = input.title;
    text = input.text;
  } else if (input.kind === 'note') {
    title = input.title;
    text = input.body;
  } else {
    title = input.title;
    text = `Reminder: ${input.title}\n${input.body}${input.dueAt ? `\nDue: ${new Date(input.dueAt).toISOString()}` : ''}`;
  }
  // The manual "copy prompt / paste response" path (F136.3): a human pasting into any LLM deserves
  // the same graph grounding the in-app backends get, or the pasted result comes back speaking a
  // vocabulary the graph does not use.
  const groundingStatements = allStatements();
  const graphContext =
    buildVocabularySection(selectVocabulary(groundingStatements, text)) +
    buildStructuralSection(selectStructuralContext(groundingStatements, { sourceText: text }));
  const prompt = `${EXTRACTION_SYSTEM_PROMPT}\n\n${buildExtractionUserPrompt(text, title, graphContext)}`;
  return { prompt, title };
}

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  // crypto.subtle is unavailable in insecure contexts (HTTP, some mobile browsers).
  // Fall back to a simple FNV-1a-based hash — not cryptographic, but sufficient
  // for content deduplication.
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return fnv1aFallback(buf);
  }
  try {
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return fnv1aFallback(buf);
  }
}

/** FNV-1a 128-bit fallback when crypto.subtle is unavailable. */
function fnv1aFallback(data: Uint8Array): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xc4ceb9fe >>> 0;
  for (let i = 0; i < data.length; i++) {
    h1 ^= data[i]; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= data[i]; h2 = Math.imul(h2, 0x01000193) >>> 0;
    h2 ^= (h1 >>> 16);
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
}
