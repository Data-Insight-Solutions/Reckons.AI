/**
 * Core data model: a personal knowledge base is a set of n-quads.
 *
 * An n-quad is a 4-tuple (subject, predicate, object, graph) where `graph`
 * carries the provenance: which document, which URL, when it was learned.
 * Each statement is reviewable, versioned, and confidence-scored so users
 * can refine the KB over time.
 */

export type IRI = string; // e.g. "kb:concept/coffee"
export type Literal = {
  kind: 'literal';
  value: string;
  datatype?: IRI; // xsd:string, xsd:dateTime, xsd:decimal, etc.
  lang?: string;
};
export type NamedNode = { kind: 'iri'; value: IRI };
export type BlankNode = { kind: 'bnode'; value: string };
export type Term = NamedNode | Literal | BlankNode;

export type Source = {
  /** Stable id of the source document/URL/note in IndexedDB */
  id: string;
  /** Human label */
  title: string;
  /** url:// file:// note:// */
  uri: string;
  /** When the source was ingested */
  ingestedAt: number;
  /** Optional checksum of source content for change detection */
  hash?: string;
  /** Type of source */
  kind: 'url' | 'document' | 'note' | 'reminder' | 'semfile' | 'analysis' | 'calendar' | 'repository';
  /** Trust level: 'trusted' auto-confirms statements, 'review' requires human review */
  trustLevel?: 'trusted' | 'review';
  /** Computed trust score (0.0-1.0) based on user actions and historical patterns */
  trustScore?: number;
  /** Which backend performed triple extraction (claude, openai, gemini, ollama, wasm, etc.) */
  extractionBackend?: string;
  /** Exact model ID used for triple extraction (e.g. 'claude-opus-4-7', 'Xenova/Qwen2.5-0.5B-Instruct') */
  extractionModel?: string;
  /** Analysis-run metadata (present when kind === 'analysis') */
  analysisModel?: string;
  analysisProvider?: string;
  analysisTrigger?: 'manual' | 'import' | 'schedule';
  analysisFocus?: 'enrich' | 'merge' | 'entity-types' | 'delete' | 'new-triples';
  analysisTotalSuggestions?: number;
  /** Repository metadata (present when kind === 'repository') */
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
  /** Last ingested commit SHA — used for delta updates */
  repoHeadSha?: string;
  /** Number of files ingested from the repo */
  repoFileCount?: number;
  /** Merge and prune recommendations stored as actions, NOT as graph statements */
  analysisActions?: {
    merges: Array<{
      entityAIri: string; entityALabel: string;
      entityBIri: string; entityBLabel: string;
      reason: string; confidence: number;
    }>;
    prunes: Array<{
      entityIri: string; entityLabel: string;
      reason: string; confidence: number;
    }>;
  };
};

export type ReviewStatus =
  | 'pending'          // freshly extracted, awaiting human review
  | 'pending-removal'  // an LLM or user suggested deleting this; awaiting confirmation
  | 'confirmed'        // human-approved
  | 'refined'          // edited by human, replaces a pending variant
  | 'rejected'         // dismissed by human
  | 'superseded';      // replaced by a newer statement

export type TurtlePersonality = 'helpful' | 'witty' | 'laid-back' | 'sarcastic';

export type TurtleSettings = {
  // ── Identity ─────────────────────────────────────────────────────────────
  /** Display name of this turtle persona (default: "Shelly") */
  name: string;
  /** Greeting shown when chat opens or on first visit */
  greeting: string;

  // ── Personality & Prompting ──────────────────────────────────────────────
  /** Turtle personality style */
  personality: TurtlePersonality;
  /** Custom system prompt prepended to Shelly's default instructions */
  systemPrompt: string;
  /** Response style: concise bullets vs flowing prose */
  responseStyle: 'concise' | 'detailed' | 'conversational';
  /** Soft word cap for responses (0 = no limit) */
  maxResponseWords: number;
  /** Patience level (0-100): how long before turtle gets impatient */
  patienceLevel: number;
  /** Engagement level: how often to offer suggestions */
  engagement: 'low' | 'medium' | 'high';

  // ── Voice ────────────────────────────────────────────────────────────────
  voiceEnabled: boolean;
  voiceType: 'tts' | 'hume';
  kokoroVoice: string; // e.g. 'af_heart', 'bf_emma'
  speechRate: number;  // 0.5 to 2.0
  volume: number;      // 0 to 100
  /** Hume.AI API Key (for voice persona) */
  humeApiKey: string;
  /** Hume.AI Secret Key (for token-based auth) */
  humeSecretKey: string;
  /** Hume.AI EVI Config ID (voice persona config) */
  humeConfigId: string;
  /** Whisper model for local speech-to-text (e.g. 'onnx-community/whisper-tiny') */
  whisperModel: string;

  // ── Visual ───────────────────────────────────────────────────────────────
  animationSpeed: 'slow' | 'normal' | 'fast';
  opacity: number;    // 0 to 100
  size: 'small' | 'medium' | 'large';
  glowEffect: boolean;
  positionSticky: boolean;
  /** Position persistence (draggable) */
  position: { x: number; y: number };
  /** Wandering behavior when idle */
  wanderRange: number; // 0 (none) to 100 (full screen)

  // ── Interaction ──────────────────────────────────────────────────────────
  /** Configurable click actions */
  clickBindings: {
    single: string;
    double: string;
    right: string;
  };
  /** Help system */
  proactiveHelp: 'never' | 'errors-only' | 'always';
  showTutorialHints: boolean;
  responseFrequency: number; // 0-100
};

export type Statement = {
  /** Unique id (uuid) */
  id: string;
  /** Subject node */
  s: Term;
  /** Predicate IRI */
  p: NamedNode;
  /** Object node */
  o: Term;
  /** Provenance graph: identifies which Source this came from */
  g: NamedNode;

  /** Reference to Source for fast joins */
  sourceId: string;
  /** Model confidence in [0,1] from the extractor */
  confidence: number;
  /** Statement this one supersedes (if a refinement of an earlier one) */
  supersedes?: string;
  /** Human-readable rendering produced at extraction time */
  gloss?: string;
  /** Verbatim source sentence/phrase the triple was derived from */
  excerpt?: string;
  /** Review state */
  status: ReviewStatus;
  /** Created / updated timestamps */
  createdAt: number;
  updatedAt: number;
};

/* ---------- predicate namespaces ---------- */

/** Predicates under this prefix are graph connections (rendered as edges) */
export const PREDICATE_PREFIX = 'urn:kbase:predicate/';
/** Predicates under this prefix are node metadata (shown in detail panel, NOT as edges) */
export const META_PREFIX = 'urn:kbase:meta/';

/** Returns true if the predicate is metadata (should not render as a graph edge/node) */
export function isMetaPredicate(predicateIri: string): boolean {
  return predicateIri.startsWith(META_PREFIX);
}

/* ---------- term helpers ---------- */

export const iri = (value: IRI): NamedNode => ({ kind: 'iri', value });
export const lit = (value: string, datatype?: IRI, lang?: string): Literal => ({
  kind: 'literal',
  value,
  ...(datatype ? { datatype } : {}),
  ...(lang ? { lang } : {})
});
export const bnode = (value: string): BlankNode => ({ kind: 'bnode', value });

export const isIRI = (t: Term): t is NamedNode => t.kind === 'iri';
export const isLit = (t: Term): t is Literal => t.kind === 'literal';
export const isBNode = (t: Term): t is BlankNode => t.kind === 'bnode';

/** Render a term in N3/Turtle short form for display */
export function termToString(t: Term): string {
  if (t.kind === 'iri') return `<${t.value}>`;
  if (t.kind === 'bnode') return `_:${t.value}`;
  let s = JSON.stringify(t.value);
  if (t.lang) s += `@${t.lang}`;
  else if (t.datatype && t.datatype !== 'http://www.w3.org/2001/XMLSchema#string')
    s += `^^<${t.datatype}>`;
  return s;
}

/** Canonical key for equality of two terms (used for diff/merge) */
export function termKey(t: Term): string {
  if (t.kind === 'iri') return `i:${t.value}`;
  if (t.kind === 'bnode') return `b:${t.value}`;
  return `l:${t.value}|${t.datatype ?? ''}|${t.lang ?? ''}`;
}

/** Canonical key for the (s,p,o) triple part — ignores graph and metadata */
export function tripleKey(st: Pick<Statement, 's' | 'p' | 'o'>): string {
  return `${termKey(st.s)}>${termKey(st.p)}>${termKey(st.o)}`;
}

/** Canonical key for the full n-quad including graph */
export function quadKey(st: Pick<Statement, 's' | 'p' | 'o' | 'g'>): string {
  return `${tripleKey(st)}>${termKey(st.g)}`;
}
