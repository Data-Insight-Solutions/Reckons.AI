import { chatClaude, chatOpenAI, chatGemini, chatOllama, chatOpenRouter, chatReckons } from './providers';
import { BUILT_IN_TYPES } from '$lib/rdf/entity-types';
import { ETHICS_PREAMBLE } from '$lib/safety/content-policy';

export type AnalysisType = 'enrich' | 'merge' | 'entity-types' | 'delete' | 'align';

export const ANALYSIS_TYPE_LABELS: Record<AnalysisType, string> = {
  'enrich':      'Enrich',
  'merge':       'Merge Entities',
  'entity-types':'Entity Types',
  'delete':      'Entity Delete',
  'align':       'Cross-KB Align',
};

export interface EntitySummary {
  iri: string;
  label: string;
  currentTypeIri: string | null;
  currentTypeLabel: string | null;
  predicates: string[];
  statementCount: number;
  sourceCount: number;
  isIsland: boolean;
  /** Semantically similar entities detected via embedding (cosine ≥ 0.88). */
  nearDuplicates?: Array<{ iri: string; label: string; similarity: number }>;
}

export interface TypeSuggestion {
  entityIri: string;
  entityLabel: string;
  currentTypeIri: string | null;
  currentTypeLabel: string | null;
  suggestedTypeIri: string;
  suggestedTypeLabel: string;
  reason: string;
}

export interface RelationSuggestion {
  subjectIri: string;
  subjectLabel: string;
  predicateIri: string;
  predicateLabel: string;
  objectIri: string;
  objectLabel: string;
  reason: string;
  /** URL of the web source that supports this suggestion (enrich mode only) */
  sourceUrl?: string;
}

export interface MergeSuggestion {
  entityAIri: string;
  entityALabel: string;
  entityBIri: string;
  entityBLabel: string;
  reason: string;
  confidence: number;
}

export interface PruneSuggestion {
  entityIri: string;
  entityLabel: string;
  reason: string;
  confidence: number;
}

export interface ReAnalyzeResponse {
  typeSuggestions: TypeSuggestion[];
  mergeSuggestions: MergeSuggestion[];
  pruneSuggestions: PruneSuggestion[];
  relationSuggestions: RelationSuggestion[];
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function kbHeader(kbTitle?: string, kbDescription?: string, analyzeGuidance?: string): string {
  const parts: string[] = [];
  if (kbTitle || kbDescription) {
    parts.push(`KNOWLEDGE BASE: ${kbTitle ?? 'Unnamed'}\nPURPOSE: ${kbDescription ?? '(not specified)'}`);
  }
  if (analyzeGuidance) {
    parts.push(`GUIDANCE: ${analyzeGuidance}`);
  }
  return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
}

function entityBlock(entities: EntitySummary[]): string {
  return entities.map((e) => {
    const typeStr = e.currentTypeLabel ? `[${e.currentTypeLabel}]` : '[UNTYPED]';
    const island = e.isIsland ? ' ⚑ISLAND' : '';
    const meta = `${e.statementCount} stmts, ${e.sourceCount} src${e.sourceCount !== 1 ? 's' : ''}${island}`;
    const preds = e.predicates.slice(0, 6).join('\n    ');
    const nearDups = e.nearDuplicates?.length
      ? `\n  ~SIMILAR: ${e.nearDuplicates.map(d => `${d.label} (${(d.similarity * 100).toFixed(0)}%)`).join(', ')}`
      : '';
    return `• ${e.label} ${typeStr}  (${meta})\n  IRI: ${e.iri}\n  ${preds || '(no predicates)'}${nearDups}`;
  }).join('\n\n');
}

// ── Focused prompt builders ─────────────────────────────────────────────────

function buildNewTriplesPrompt(entities: EntitySummary[], kbTitle?: string, kbDescription?: string, analyzeGuidance?: string): string {
  return `${kbHeader(kbTitle, kbDescription, analyzeGuidance)}You are enriching an RDF knowledge graph. Your ONLY task is to identify MISSING RELATIONS — new predicate triples that connect existing entities.

IMPORTANT — OPEN WORLD ASSUMPTION:
This KB is deliberately scoped. Absence of a fact does NOT mean the fact is false — it means this KB hasn't captured it yet. Your suggestions should surface connections that the KB *probably* should contain given its current focus, not everything that *could* be true in the world.

RULES:
- Only suggest relations between entities that appear in the list below.
- Do not suggest type corrections or merges.
- A relation is worth suggesting only if it is clearly implied by the entities' existing predicates or labels.
- Prefer specific, meaningful predicates over vague ones.
- Limit: up to 6 suggestions. Only high-confidence ones.
- Output valid JSON only — no prose, no markdown fences.

ENTITIES (${entities.length}):
${entityBlock(entities)}

Return exactly:
{
  "relationSuggestions": [
    {
      "subjectIri": "<iri>",
      "subjectLabel": "<label>",
      "predicateIri": "urn:kbase:predicate/<slug>",
      "predicateLabel": "<human label>",
      "objectIri": "<iri of another entity in the list>",
      "objectLabel": "<label>",
      "reason": "<one sentence — why this relation is clearly implied>"
    }
  ]
}`;
}

function buildEnrichPrompt(entities: EntitySummary[], webContext: string, kbTitle?: string, kbDescription?: string, analyzeGuidance?: string): string {
  return `${kbHeader(kbTitle, kbDescription, analyzeGuidance)}You are enriching an RDF knowledge graph using web search results.

IMPORTANT — OPEN WORLD ASSUMPTION:
This KB is deliberately scoped. Absence of a fact does NOT mean the fact is false — it means this KB hasn't captured it yet. Your job is to identify facts from the web search results that would meaningfully fill gaps in this KB's coverage, given its existing focus and entities.

TASK:
1. Compare the web search results against the existing entities below.
2. Identify facts from the web that are RELEVANT to this KB's scope and would fill notable gaps.
3. Suggest new triples — either connecting existing entities with newly discovered facts, or introducing new entities that clearly belong in this KB's scope.

RULES:
- Every suggestion must cite which web result it came from.
- Prefer facts that connect to existing entities over facts about entirely new topics.
- Do not suggest facts the KB already contains — check the entity predicates.
- New entity IRIs should follow the pattern: urn:kbase:<type>/<slug>
- Limit: up to 8 suggestions. Only facts well-supported by the search results.
- Output valid JSON only — no prose, no markdown fences.

EXISTING ENTITIES (${entities.length}):
${entityBlock(entities)}

WEB SEARCH RESULTS:
${webContext}

Return exactly:
{
  "relationSuggestions": [
    {
      "subjectIri": "<existing or new entity iri>",
      "subjectLabel": "<label>",
      "predicateIri": "urn:kbase:predicate/<slug>",
      "predicateLabel": "<human label>",
      "objectIri": "<existing or new entity iri>",
      "objectLabel": "<label>",
      "reason": "<one sentence — what web source supports this and why it fills a gap>",
      "sourceUrl": "<url of the web result>"
    }
  ]
}`;
}

function buildMergePrompt(entities: EntitySummary[], kbTitle?: string, kbDescription?: string, analyzeGuidance?: string): string {
  return `${kbHeader(kbTitle, kbDescription, analyzeGuidance)}You are simplifying an RDF knowledge graph by finding DUPLICATE ENTITIES — nodes that represent the same real-world thing and should be merged into one.

Signs of duplicates: same name in different case, abbreviation vs full name, spelling variants, same identifier in different formats.

RULES:
- Never suggest merging entities of clearly different concrete types (Person ≠ Document, Organization ≠ Concept).
- Untyped entities may be merged with typed ones if they clearly represent the same thing.
- Only suggest merges with confidence ≥ 0.85.
- Limit: up to 8 merge suggestions.
- Explain specifically WHY they are the same real-world thing.
- Output valid JSON only — no prose, no markdown fences.

ENTITIES (${entities.length}):
${entityBlock(entities)}

Return exactly:
{
  "mergeSuggestions": [
    {
      "entityAIri": "<iri>",
      "entityALabel": "<label>",
      "entityBIri": "<iri>",
      "entityBLabel": "<label>",
      "reason": "<one sentence — name similarity, shared predicates, or same real-world referent>",
      "confidence": <0.0–1.0>
    }
  ]
}`;
}

function buildEntityTypesPrompt(entities: EntitySummary[], kbTitle?: string, kbDescription?: string, analyzeGuidance?: string): string {
  const typeList = BUILT_IN_TYPES.map(
    (t) => `  ${t.iri} | "${t.label}" — ${t.description}`
  ).join('\n');

  return `${kbHeader(kbTitle, kbDescription, analyzeGuidance)}You are correcting entity types in an RDF knowledge graph. Your ONLY task is to find MISTYPED or UNTYPED entities that need a type correction.

Common errors:
- A Document node typed as Concept
- A Person typed as Organization
- A raw URL or file path typed as a Person or Concept
- An entity that clearly belongs to a known type but has no type at all

Also flag entities that appear to CONFLATE two different concepts — for example an entity with predicates from two unrelated domains. Note this in the reason field.

RULES:
- Only suggest a type when you are confident — do not guess.
- An untyped entity with no predicates is better left untyped than mistyped.
- Use only the types listed below.
- Limit: up to 6 suggestions.
- Output valid JSON only — no prose, no markdown fences.

AVAILABLE TYPES:
${typeList}

ENTITIES (${entities.length}):
${entityBlock(entities)}

Return exactly:
{
  "typeSuggestions": [
    {
      "entityIri": "<iri>",
      "entityLabel": "<label>",
      "currentTypeIri": "<iri or null>",
      "currentTypeLabel": "<label or null>",
      "suggestedTypeIri": "<one of the available type IRIs above>",
      "suggestedTypeLabel": "<matching label>",
      "reason": "<one sentence — why this type is more accurate>"
    }
  ]
}`;
}

function buildDeletePrompt(entities: EntitySummary[], kbTitle?: string, kbDescription?: string, analyzeGuidance?: string): string {
  const islands = entities.filter(e => e.isIsland).map(e => `  • ${e.label} (${e.iri})`).join('\n');

  return `${kbHeader(kbTitle, kbDescription, analyzeGuidance)}You are pruning an RDF knowledge graph. Your ONLY task is to identify NOISE NODES — entities that should be deleted.

PRIORITY ORDER (assess in this order):
1. ISLAND NODES — low-connectivity nodes with few statements and a single source, especially if the label looks like a raw keyword, partial phrase, or accidental IRI.
2. LITERAL LEAKS — entities that should be literal values (bare numbers, dates, short phrases, URLs) that were mistakenly promoted to IRI nodes.
3. FRAGMENTS — partial words, truncated phrases, or obviously malformed labels.

FLAGGED AS LIKELY ISLANDS (⚑ in entity list):
${islands || '  (none detected)'}

RULES:
- Confidence ≥ 0.75 required. Do not prune entities that could be meaningful.
- Limit: up to 6 prune suggestions.
- Output valid JSON only — no prose, no markdown fences.

ENTITIES (${entities.length}):
${entityBlock(entities)}

Return exactly:
{
  "pruneSuggestions": [
    {
      "entityIri": "<iri>",
      "entityLabel": "<label>",
      "reason": "<one sentence — why this node is noise, a fragment, or should be a literal>",
      "confidence": <0.0–1.0>
    }
  ]
}`;
}

// ── Default prompt access (for prompt editor UI) ────────────────────────────

/** Returns the built-in default prompt for a given analysis type. Used by the settings UI to pre-fill prompt editors. */
export function getDefaultPrompt(analysisType: Exclude<AnalysisType, 'align'>, entityCount = 12, kbTitle?: string, kbDescription?: string, analyzeGuidance?: string): string {
  const placeholder: EntitySummary[] = [{ iri: 'urn:example', label: '(sample entity)', currentTypeIri: null, currentTypeLabel: null, predicates: [], statementCount: 1, sourceCount: 1, isIsland: false }];
  switch (analysisType) {
    case 'enrich': return buildNewTriplesPrompt(placeholder, kbTitle, kbDescription, analyzeGuidance);
    case 'merge': return buildMergePrompt(placeholder, kbTitle, kbDescription, analyzeGuidance);
    case 'entity-types': return buildEntityTypesPrompt(placeholder, kbTitle, kbDescription, analyzeGuidance);
    case 'delete': return buildDeletePrompt(placeholder, kbTitle, kbDescription, analyzeGuidance);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export type ReAnalyzeProvider = 'claude' | 'openai' | 'gemini' | 'ollama' | 'openrouter' | 'reckons';

export interface ReAnalyzeOptions {
  provider: ReAnalyzeProvider;
  apiKey: string;
  model?: string;
  ollamaBaseUrl?: string;
  reckonsBaseUrl?: string;
  entities: EntitySummary[];
  analysisType: AnalysisType;
  kbTitle?: string;
  kbDescription?: string;
  /** Central guidance text shared across all analyze operations */
  analyzeGuidance?: string;
  /** Pre-formatted web search context (for 'enrich' analysis type) */
  webContext?: string;
  /** Custom user-edited prompt — replaces the built-in prompt entirely when set */
  customPrompt?: string;
}

const EMPTY: ReAnalyzeResponse = {
  typeSuggestions: [],
  relationSuggestions: [],
  mergeSuggestions: [],
  pruneSuggestions: [],
};

export async function reAnalyze(opts: ReAnalyzeOptions): Promise<ReAnalyzeResponse> {
  const { provider, apiKey, model, ollamaBaseUrl, reckonsBaseUrl, entities, analysisType, kbTitle, kbDescription, analyzeGuidance, webContext, customPrompt } = opts;
  if (entities.length === 0) return EMPTY;
  if (analysisType === 'align') return EMPTY; // Align is handled by cross-kb-align, not LLM

  const prompt = customPrompt ??
    (analysisType === 'enrich'        ? (webContext ? buildEnrichPrompt(entities, webContext, kbTitle, kbDescription, analyzeGuidance) : buildNewTriplesPrompt(entities, kbTitle, kbDescription, analyzeGuidance)) :
    analysisType === 'merge'         ? buildMergePrompt(entities, kbTitle, kbDescription, analyzeGuidance) :
    analysisType === 'entity-types'  ? buildEntityTypesPrompt(entities, kbTitle, kbDescription, analyzeGuidance) :
                                       buildDeletePrompt(entities, kbTitle, kbDescription, analyzeGuidance));

  const messages = [{ role: 'user' as const, content: prompt }];

  const DEFAULT_CLAUDE     = 'claude-sonnet-4-6';
  const DEFAULT_OPENAI     = 'gpt-4o-mini';
  const DEFAULT_GEMINI     = 'gemini-2.0-flash';
  const DEFAULT_OLLAMA     = 'llama3.2';
  const DEFAULT_OPENROUTER = 'meta-llama/llama-3.2-3b-instruct:free';

  const systemPrompt = ETHICS_PREAMBLE.trim();

  let raw: string;
  if (provider === 'openai') {
    raw = await chatOpenAI(messages, systemPrompt, apiKey, model ?? DEFAULT_OPENAI, 2048);
  } else if (provider === 'gemini') {
    raw = await chatGemini(messages, systemPrompt, apiKey, model ?? DEFAULT_GEMINI, 2048);
  } else if (provider === 'ollama') {
    raw = await chatOllama(messages, systemPrompt, model ?? DEFAULT_OLLAMA, ollamaBaseUrl, 2048);
  } else if (provider === 'openrouter') {
    raw = await chatOpenRouter(messages, systemPrompt, apiKey, model ?? DEFAULT_OPENROUTER, 2048);
  } else if (provider === 'reckons') {
    raw = await chatReckons(messages, systemPrompt, apiKey, reckonsBaseUrl, model ?? '@cf/meta/llama-3.1-8b-instruct', 2048);
  } else {
    raw = await chatClaude(messages, systemPrompt, apiKey, model ?? DEFAULT_CLAUDE, 2048);
  }

  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
  const parsed = JSON.parse(cleaned);

  // Merge partial response with EMPTY so callers always get all four arrays
  return { ...EMPTY, ...parsed };
}
