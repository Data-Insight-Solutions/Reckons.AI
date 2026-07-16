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
  kind: 'url' | 'document' | 'note' | 'reminder' | 'semfile' | 'analysis' | 'calendar' | 'repository' | 'turtle';
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
  analysisFocus?: 'enrich' | 'merge' | 'entity-types' | 'delete' | 'new-triples' | 'align';
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

/**
 * What would SETTLE a fact — and therefore who is competent to approve it (F88).
 * Defined here beside Statement; the routing logic lives in rdf/verifiability.ts.
 *
 * `external-graph` (F91): the fact is an ANSWER another graph gave to a routed question. It is
 * that party's claim, not our verified knowledge — an unverifiable claim made by the party it
 * benefits is not evidence (the thesis), so it enters pending and is always reviewed, never
 * machine-settled. It carries who answered and the hop chain it came back along.
 */
export type Verifiability = 'code' | 'test' | 'source' | 'user' | 'unknown' | 'external-graph';

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
  /**
   * Did `excerpt` actually occur in the source text? (kb:passage-grounding)
   * true  = verified quote.  false = the model fabricated or paraphrased it, and the
   * excerpt has been DROPPED rather than shown.  undefined = not checked (no source text).
   */
  grounded?: boolean;
  /** Review state */
  status: ReviewStatus;
  /**
   * Partial fact (F32): subject + predicate are known but the object is a
   * "loose end" the reviewer must fill before accepting. When true, `o` is a
   * placeholder and the review card shows an entity picker instead of accept.
   */
  needsObject?: boolean;
  /** The sub-agent's question that produced this partial fact (F32). */
  question?: string;
  /**
   * What this unanswered question BLOCKS — entity IRIs (F80 / kb:mission).
   *
   * This is the field that makes a partial fact more than a gap. "Subject known, predicate
   * known, object open, and FOUR THINGS STALLED BEHIND IT" is the whole value: it turns
   * "go find out what we're missing" into "answer this one question, and four blocked
   * things unblock". Without it the graph knows it has a hole but not what the hole costs,
   * which is the difference between a to-do and a priority.
   */
  blocks?: string[];
  /**
   * Which agent asked. Needed to route the answer BACK to it — with more than one agent
   * running, an unattributed answer cannot be claimed by the one that is waiting.
   */
  askedBy?: string;
  /**
   * HOW could this fact be checked — and therefore WHO is competent to approve it (F88).
   *
   * `code` | `test` a script or a suite settles it; the user need not be asked at all.
   * `source`        a cited passage backs it.
   * `user`          only the person knows: their business, their intent. Self-attested.
   * `unknown`       nobody has established this. Unsettled, not false.
   *
   * Undefined means UNCLASSIFIED, which routes to the user — never auto-approve a fact whose
   * verifiability nobody has established. See `gateFor()` in rdf/verifiability.ts, and note
   * that AUTHORITY OVERRIDES THIS: a roadmap change or a core principle is the user's to
   * decide however checkable it happens to be.
   */
  verifiableBy?: Verifiability;
  /**
   * F91 question router: when this fact is an ANSWER another graph returned to a routed
   * question, the graph that answered it. Its presence makes the fact `external-graph`
   * verifiable (another party's claim — always reviewed, never machine-settled).
   */
  answeredByGraph?: string;
  /**
   * The chain of graphs the question travelled and the answer returned along — [origin, …,
   * answerer]. One hop today ([origin, target]); the list is the forward-compatible seed of the
   * F84 RBAC daisy-chain, where each hop is authorized and provenance-stamped.
   */
  hopChain?: string[];
  /** Created / updated timestamps */
  createdAt: number;
  updatedAt: number;
};

/* ---------- predicate namespaces ---------- */

/** Predicates under this prefix are graph connections (rendered as edges) */
export const PREDICATE_PREFIX = 'urn:kbase:predicate/';
/** Predicates under this prefix are node metadata (shown in detail panel, NOT as edges) */
export const META_PREFIX = 'urn:kbase:meta/';

/** Predicates under this prefix are hierarchical navigation metadata */
export const NAV_PREFIX = 'urn:reckons:nav/';

/** Predicates under this prefix are web-page publishing metadata (slug, section, template, status, nav, excerpt, body) */
export const PAGE_PREFIX = 'urn:reckons:page/';

/** Predicates under this prefix are graph-level currents settings (F29) */
export const CURRENTS_PREFIX = 'urn:reckons:meta/currents/';

/** PROV-O provenance (wasDerivedFrom, startedAtTime, endedAtTime, …). This is accountability
 * METADATA about a statement — where it came from, when — not knowledge the graph is about. It is
 * materialized as reification triples (<urn:kbase:stmt/{id}> prov:wasDerivedFrom <source>) for
 * round-tripping; rendered as edges it fills the canvas with UUID nodes joined by "wasDerivedFrom",
 * which is exactly the unreadable noise the graph must not show (kb:graph-legibility, F83). */
export const PROV_PREFIX = 'http://www.w3.org/ns/prov#';
/** Statement-reification subjects (urn:kbase:stmt/{id}) — the id-nodes provenance hangs off. */
export const STMT_PREFIX = 'urn:kbase:stmt/';

/** Predicates whose object is a presentation image (2D icon / preview photo).
 * They're consumed directly by the icon/preview maps; as edges they'd render
 * the raw data-URI or URL as a junk literal node, so they're metadata here. */
export const PRESENTATION_IMAGE_PREDICATES = new Set([
  'urn:kbase:predicate/icon2d',
  'urn:kbase:predicate/photo',
]);

/** Returns true if the predicate is metadata (should not render as a graph edge/node) */
export function isMetaPredicate(predicateIri: string): boolean {
  if (predicateIri.startsWith(META_PREFIX)) return true;
  // Icon/preview image predicates are presentation metadata, not semantic edges —
  // otherwise their data-URI/URL object becomes a junk literal node in the graph.
  if (PRESENTATION_IMAGE_PREDICATES.has(predicateIri)) return true;
  // nav:order and nav:layer are node metadata, not graph edges
  if (predicateIri === `${NAV_PREFIX}order` || predicateIri === `${NAV_PREFIX}layer`) return true;
  // page:* are per-page publishing metadata (literals) — the site tree still renders
  // via skos:broader/related/next/prev, which stay visible edges.
  if (predicateIri.startsWith(PAGE_PREFIX)) return true;
  // currents settings are graph-level config, never edges
  if (predicateIri.startsWith(CURRENTS_PREFIX)) return true;
  // PROV-O provenance is accountability metadata, not a semantic edge — otherwise the graph fills
  // with UUID statement-nodes joined by "wasDerivedFrom" (kb:graph-legibility, F83).
  if (predicateIri.startsWith(PROV_PREFIX)) return true;
  return false;
}

/** Friendly one-line label for a literal object node: URLs collapse to their
 * host, data: URIs to a type glyph, everything else truncates. Keeps long links
 * and stray data-URIs from rendering as unreadable node labels. */
export function displayLiteralLabel(value: string): string {
  if (!value) return value;
  if (value.startsWith('data:')) {
    const semi = value.indexOf(';');
    const mime = value.slice(5, semi > 0 ? semi : 5);
    return mime.startsWith('image/') ? '🖼 image' : '📎 data';
  }
  if (/^https?:\/\//i.test(value)) {
    try { return '🔗 ' + new URL(value).hostname.replace(/^www\./, ''); } catch { /* fall through */ }
  }
  return value.length > 48 ? value.slice(0, 45) + '...' : value;
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
