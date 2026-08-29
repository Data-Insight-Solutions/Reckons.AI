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
  /** Latest local-only execution record for this source's ingest. Never exported as source text. */
  latestExtractionRunId?: string;
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
  /**
   * Opt-in endpoint that mints a SHORT-LIVED Hume EVI access token (F107.6). Lets a shared
   * voice persona be heard by someone who has not configured their own Hume: the sharer runs
   * this endpoint, the viewer's client fetches a scoped, expiring token from it at play-time,
   * and the sharer's secret key never leaves their control. Unlike an API/secret key this is a
   * revocable, rate-limitable delegation — so it is safe to travel with a shared persona.
   */
  humeTokenUrl?: string;
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
  /** Execution record that proposed this statement, when it came through the F136 pipeline. */
  extractionRunId?: string;
  /** Model confidence in [0,1] from the extractor */
  confidence: number;
  /** Statement this one supersedes (if a refinement of an earlier one) */
  supersedes?: string;
  /** Human-readable rendering produced at extraction time */
  gloss?: string;
  /**
   * An altitude set BY HAND on this one fact, overriding what the classifier reads from its
   * predicate (Matt, 2026-08-28: "an easy way to adjust the depth/altitude of the new fact").
   *
   * Two levels of correction exist and they answer different questions. `kpred:altitude` on a
   * PREDICATE fixes the class — every fact using that word, forever, which is the high-leverage
   * repair. This field fixes THIS FACT, for when the predicate is usually right and this one use
   * of it is not. Prefer the predicate-level fix where it applies; a graph full of per-fact
   * overrides is a predicate nobody classified.
   *
   * The union is duplicated here rather than imported because `fact-altitude.ts` imports Statement
   * from this module; `Altitude` there is derived FROM this field, so the two cannot drift.
   */
  altitude?: 'decision' | 'judgment' | 'evidence' | 'record' | 'log';
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
   * Which agent PROPOSED this fact — set on every drained proposal, not only on questions.
   *
   * Distinct from `askedBy`, which exists to route an ANSWER back to whoever is waiting for
   * it. This one exists to answer a different question: WAS RUNNING THAT AGENT WORTH IT.
   *
   * The work-tiering doctrine turns on proposal YIELD — "a local job that emits 30 findings
   * of which 25 are noise moves cost from generation to TRIAGE rather than removing it" — and
   * yield is accepted-over-proposed, per agent. Until 2026-08-13 that was not computable:
   * `drainAndImportPending` attached the agent only to PARTIAL facts, and measured against the
   * real queue that lost attribution for 55% of 736 entries (402 proposals carrying an object).
   * Everything else was folded into one batch source titled "MCP (agent-a, agent-b) — N notes",
   * so an accepted fact could not be traced to the agent that produced it.
   */
  proposedBy?: string;
  /**
   * The deterministic check that settled this fact without a human, if one did.
   *
   * Auto-acceptance is only legitimate when it is auditable and reversible, so the verifier names
   * itself on the statement. A confirmed fact carrying this can be found, questioned, and undone;
   * one that silently appeared could not be.
   */
  verifiedBy?: string;
  /**
   * What KIND of wrong this finding reports — see rdf/finding-class.ts.
   *
   *   form    malformed artifact; a parser or shape settles it, safe to block a build on
   *   drift   the graph's claim disagrees with reality; only a human can decide which side
   *           is wrong, so it must never auto-resolve
   *   defect  the world is broken while the graph is right; the fix never touches the graph
   */
  findingClass?: 'form' | 'drift' | 'defect';
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
  /**
   * The cascade decision that settled this fact (F139.1), when ONE answer settled a whole batch.
   *
   * Points at the user's own recorded statement, so fifty facts settled by one answer can all be
   * traced to it — and reversed from it. A batch settle without this would be indistinguishable from
   * fifty individually reviewed facts, which is the failure the handoff names exactly: a settled
   * fact whose settler is unknown is worse than an unsettled one, because it looks reviewed.
   */
  settledByDecision?: string;
  /**
   * Who settled it, through which channel, and when. Set on the recorded decision itself.
   *
   * Distinct from `verifiedBy`, which names a deterministic check that settled a fact WITHOUT a
   * human. This names the human and the channel they used, which is what keeps "Matt settling
   * through the CLI" distinguishable from "an agent settling its own proposal" (F52).
   */
  settledBy?: { actor: string; channel: string; at: number };

  /** Created / updated timestamps */
  createdAt: number;
  updatedAt: number;
};

/**
 * F136.1's first execution boundary. These are the stages the existing ingest path can
 * truthfully distinguish today. `extract` remains the provider invocation plus parser boundary;
 * `validate` makes candidate-shape losses and an empty usable result explicit before grounding.
 * A later version may still split `extract` into separate invoke and parse stages without
 * rewriting historic runs.
 */
export type ExtractionStageName =
  | 'route'
  | 'extract'
  | 'validate'
  | 'ground'
  | 'normalize'
  | 'type'
  | 'archive'
  | 'diff'
  | 'persist';

export type ExtractionStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type ExtractionRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ExtractionLocality = 'browser' | 'local-network' | 'third-party' | 'manual' | 'unknown';

export type ExtractionStageRecord = {
  name: ExtractionStageName;
  status: ExtractionStageStatus;
  startedAt?: number;
  endedAt?: number;
  detail?: string;
};

/** One real provider/manual attempt; a successful fallback never erases an earlier failure. */
export type ExtractionRouteAttempt = {
  id: string;
  backend: string;
  model: string;
  locality: ExtractionLocality;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  error?: string;
};

export type ExtractionRouteDecision = {
  /** Deliberately a versioned name even while routing remains today's configured backend rule. */
  policyVersion: string;
  selectedBackend: string;
  selectedModel: string;
  locality: ExtractionLocality;
  reason: string;
  candidates: Array<{ backend: string; model: string; locality: ExtractionLocality }>;
  attempts: ExtractionRouteAttempt[];
};

/**
 * Local execution/provenance record for a single ingestion attempt. It stores hashes, ids,
 * counters and timings — never raw source text, prompts, responses, or secrets.
 */
export type ExtractionRun = {
  id: string;
  sourceId: string;
  sourceHash: string;
  pipelineVersion: string;
  promptId: string;
  schemaId?: string;
  startedAt: number;
  endedAt?: number;
  status: ExtractionRunStatus;
  route: ExtractionRouteDecision;
  stages: ExtractionStageRecord[];
  candidateStatementCount?: number;
  outputStatementIds: string[];
  validationCounts?: {
    /** Every array entry seen at a parser boundary, where that boundary can expose it. */
    candidates?: number;
    /** Candidates accepted by the typed in-memory guard before Statement conversion. */
    accepted?: number;
    /** Entries rejected by the parser before typed validation. */
    parserRejected?: number;
    /** Entries rejected by the typed in-memory guard. */
    rejected?: number;
    grounded: number;
    ungrounded: number;
  };
  failure?: { stage: ExtractionStageName; message: string; at: number };
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

/** Automated test/crawl telemetry (button-crawl findings, route probes).
 *
 * These are OBSERVATIONS ABOUT A TEST RUN, not knowledge the graph is about. Their objects are UI
 * strings scraped off a page — a button captioned "bookmarked (0)", or a select chevron whose whole
 * accessible name is "▾". Rendered as edges, each such caption becomes a literal node, and each
 * crawled route becomes a concept node, so a single crawl silently populates the canvas with
 * entities nothing can ever be said about. Same failure mode as PROV reification (kb:graph-legibility,
 * F83), arriving through a different door.
 *
 * They remain fully reviewable — the review LIST is not filtered by this, only the graph view — so
 * a finding is still a decision you rule on, just not a thing the graph pretends to know about. */
export const TEST_TELEMETRY_PREFIX = 'urn:reckons:test/';

/** Predicates whose object is a presentation asset (2D icon / photo / video).
 * They're consumed directly by the icon/preview maps; as edges they'd render
 * the raw data-URI or URL as a junk literal node, so they're metadata here.
 * GIF and GLB references already live under urn:kbase:meta/* and are covered by
 * the namespace check in isMetaPredicate(). */
export const PRESENTATION_IMAGE_PREDICATES = new Set([
  'urn:kbase:predicate/icon2d',
  'urn:kbase:predicate/photo',
  'urn:kbase:predicate/video',
  // Provenance ABOUT a photo — who made it, where to check the licence. Belongs in the detail
  // panel beside the image, never as an edge to a literal node holding a credit line or a URL.
  'urn:kbase:predicate/photo-credit',
  'urn:kbase:predicate/photo-source',
]);

/**
 * How an ENTITY TYPE renders — geometry name, hex colour, 3D model, generation bookkeeping.
 * These are the predicates `stores/entity-types.svelte.ts` reads to draw a type, so they cannot
 * be renamed; but they are configuration, not knowledge. Left visible they put literal nodes
 * labelled "tetrahedron" and "#e0a13c" into the graph — which is exactly what a first-time user
 * meets in the starter graph, next to the real facts, meaning nothing (Matt, 2026-07-23).
 * Same reasoning as the image predicates above: presentation is metadata.
 */
export const TYPE_PRESENTATION_PREDICATES = new Set([
  'urn:kbase:predicate/icon',
  'urn:kbase:predicate/icon3d',
  'urn:kbase:predicate/color',
  'urn:kbase:predicate/type-description',
  'urn:kbase:predicate/meshy-task-id',
  'urn:kbase:predicate/meshy-status',
]);

/** Returns true if the predicate is metadata (should not render as a graph edge/node) */
export function isMetaPredicate(predicateIri: string): boolean {
  if (predicateIri.startsWith(META_PREFIX)) return true;
  // Icon/preview image predicates are presentation metadata, not semantic edges —
  // otherwise their data-URI/URL object becomes a junk literal node in the graph.
  if (PRESENTATION_IMAGE_PREDICATES.has(predicateIri)) return true;
  // Entity-type presentation config (geometry name, hex colour, …) is not a fact about anything.
  if (TYPE_PRESENTATION_PREDICATES.has(predicateIri)) return true;
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
  // Test/crawl telemetry: findings about a button or route, not facts about the world.
  if (predicateIri.startsWith(TEST_TELEMETRY_PREFIX)) return true;
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
