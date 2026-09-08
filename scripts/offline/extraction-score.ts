#!/usr/bin/env npx tsx
/**
 * DOES EXTRACTION ACTUALLY GET THE FACTS? — accuracy against hand-checked ground truth. AGENT TIER.
 *
 * WHY THIS EXISTS. `extraction-chain.ts` measures the SHAPE of a graph after the fact — orphans,
 * decisions, facts-per-question. It cannot tell you whether the triples in that graph are the RIGHT
 * triples, because it never sees the text they came from. So every claim of the form "extraction got
 * better" has so far been unfalsifiable. This is the gate that ends that: raw text in, hand-written
 * expectations to check against, one number that moves.
 *
 * Matt, 2026-09-04: "we need to lean less on existing graph if its small or empty. We need to
 * capture more triple facts. We likely need a larger more robust set of local models."
 * Each of those three is a hypothesis, and each needs the same instrument to be settled:
 *
 *   --graph=none,xs,sm,md,lg,full,relevant
 *                             THE CONTEXT LADDER — one graph sliced to controlled anchor budgets
 *                             (0/3/8/20/40/all), plus `relevant`, which is the proposed FIX run as
 *                             its own arm: anchors with no lexical overlap with the source are
 *                             dropped, the rule structural-context already applies to decisions
 *   --thinking                the two-pass extract-then-critic, so "slower but better" is testable
 *   yield                     triples emitted per source — "capture more facts", measured
 *   --models=a,b,c            one run per model, so "more robust set" is a finding and not a guess
 *
 * WHAT IT MEASURES, and what it deliberately does not:
 *
 *   connection        of the entities and predicates the model EMITTED, how many match what it was
 *                     SHOWN. This is what grounding is for, and the first sweep did not measure it:
 *                     F136 exists to raise vocabulary agreement, so a recall-only score gives it no
 *                     credit for succeeding. Recall and connection can move in opposite directions.
 *   recall (strict)   expected fact found with an accepted predicate
 *   recall (loose)    subject+object found, predicate ignored — the DIFFERENCE between these two
 *                     is the vocabulary problem F136 exists for, isolated and sized
 *   yield             raw triples emitted; high yield with low recall is noise, not capture
 *   invention         asserting as fact what the source only requested or explicitly withheld —
 *                     invented history, and the worst thing measured here
 *   misrouting        the same content, but correctly MARKED as a request and still left in the
 *                     fact stream. A different failure with a different owner (note-intent.ts), and
 *                     conflating the two would inflate the one number that must stay trustworthy
 *   shape             subjects that are a whole sentence (looksLikeProposition) — guard regression
 *   fragments         distinct slugs that normalize alike (enterprise-cad-platform vs -platforms):
 *                     one thing minted twice, which is what makes a graph un-navigable
 *
 * It does NOT score altitude separation, hedging/attribution, or intent routing beyond the forbidden
 * list. Those need the app's own stages, not the extractor alone, and pretending to score them here
 * would be the third instance of measuring the file instead of the graph. The *.EXPECTED.txt files
 * carry those as MANUAL judgments, and they stay manual until something can honestly check them.
 *
 * KNOWN-BROKEN EXPECTATIONS ARE SCORED SEPARATELY. Several of the 23 are documented as not-produced
 * today (ASR-boundary damage, the enterprise-DAM homophone, absences that get dropped). They never
 * count as a regression and always report as a gain if they start passing. Deleting one to make a
 * number look better is the failure mode this note exists to prevent.
 *
 *   npx tsx scripts/offline/extraction-score.ts                       one model, no graph context
 *   … --models=qwen3-coder:latest,gemma3:27b,devstral-small-2:latest  compare the local roster
 *   … --graph=none,small,full                                         settle the grounding question
 *   … --pending                                                       queue the findings for review
 *   … --json                                                          machine-readable, for a test
 *
 * Needs OLLAMA_BASE_URL. Emits PROPOSALS only — it never writes source or TTL.
 */
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { extractWithOllama } from '../../src/lib/integrations/llm/ollama-extract.js';
import type { ExtractedTriple } from '../../src/lib/integrations/llm/extractor.js';
import {
  scoreSets, scoreOverlap, scoreTraps,
  type SetExpectation, type NotSetExpectation, type SetScore, type OverlapScore, type TrapScore,
} from './set-score.js';
import { looksLikeProposition } from '../../src/lib/rdf/triple-shape.js';
import { selectVocabulary, buildVocabularySection } from '../../src/lib/rdf/vocabulary-context.js';
import { selectStructuralContext, buildStructuralSection } from '../../src/lib/rdf/structural-context.js';
import { selectKnownClaims, buildClaimsSection } from '../../src/lib/rdf/claims-context.js';
import { readGraph } from './read-graph.js';

const B = '\x1b[1m',
  D = '\x1b[2m',
  G = '\x1b[32m',
  Y = '\x1b[33m',
  C = '\x1b[36m',
  R = '\x1b[31m',
  X = '\x1b[0m';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const JSON_OUT = args.includes('--json');
/*
 * THINKING MODE, MEASURED (F146 extract-then-critic). Matt asked for a slower-but-better pass; this
 * flag is the only thing that can settle whether it IS better. Run the same corpus with and without
 * it — a second pass that does not move strict recall is costing twice the time for nothing, and a
 * second pass that raises yield without raising recall is manufacturing noise for the review queue.
 */
/*
 * REPEAT — because a single run cannot choose anything here, and this harness spent two weeks
 * pretending it could. qwen3:32b scored 74% and 53% AT IDENTICAL SETTINGS ON THE SAME DAY
 * (2026-09-04). Any comparison of two models on one run each is inside that spread and therefore
 * says nothing. kb:task-model-bench already named this as the thing to build FIRST.
 *
 * The median is reported rather than the mean: with a spread this wide one bad run drags a mean
 * somewhere no individual run ever was, and the SPREAD is printed beside it because a median that
 * hides a 21-point range is the same lie in a smaller font.
 */
const REPEAT = Math.max(1, parseInt(arg('repeat', '1'), 10) || 1);
const THINKING = args.includes('--thinking');
const PENDING_OUT = args.includes('--pending');
const CORPUS = arg('corpus', 'tests/fixtures/notes-corpus');
const MODELS = arg('models', 'qwen3-coder:latest')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const CONDITIONS = arg('graph', 'none')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const PENDING = path.join('reckons-workspace', 'knowledge.pending.jsonl');

/*
 * Graph-context conditions. `small` is the case Matt reported: a graph with a handful of entities,
 * none of which the incoming text is about. `full` is a mature graph. The point of running all
 * three is that a grounding feature which HELPS on `full` can still HURT on `small`, and until now
 * nothing distinguished them.
 */
/*
 * THE CONTEXT LADDER — one graph, sliced to controlled sizes (Matt, 2026-09-04: "we need extraction
 * benchmarking for different levels of existing graph context").
 *
 * THE FIRST VERSION OF THIS WAS CONFOUNDED AND THE RESULT SHOULD NOT BE QUOTED. It compared
 * `small` = tests/fixtures/extraction-chain.ttl against `full` = the personal-notes graph — two
 * DIFFERENT graphs with different subject matter. So "more context is worse" was inseparable from
 * "a different graph is worse", and only the second is surprising. Everything below drives the
 * budget knobs on ONE graph, so the amount of context is the only thing that moves.
 *
 * `relevant` is not a size — it is the PROPOSED FIX, run as its own arm. It applies the lexical
 * overlap floor that structural-context already applies to open decisions but not to anchors, so
 * the ladder measures the defect and the fix side by side rather than in two separate sessions.
 */
const LADDER_GRAPH = 'reckons-workspace/kbs/personal-notes/personal-notes.ttl';

export interface GraphLevel {
  /** Anchors and vocabulary entries offered. 0 means no graph section at all. */
  budget: number;
  /** Drop anchors with no lexical overlap with the source text — the fix under test. */
  relevantOnly?: boolean;
}

const GRAPH_LEVELS: Record<string, GraphLevel> = {
  none: { budget: 0 },
  xs: { budget: 3 },
  sm: { budget: 8 },
  md: { budget: 20 },
  lg: { budget: 40 },
  full: { budget: 1000 },
  relevant: { budget: 1000, relevantOnly: true },
};

// ── Normalization ────────────────────────────────────────────────────────────

const PREFIXES = [/^urn:kbase:(concept|predicate|meta|type)\//, /^kb:/, /^kpred:/, /^rdfs?:/, /^skos:/];

/**
 * Lowercase, de-prefix, hyphenate, de-pluralize. Deliberately modest: a lenient matcher inflates
 * the score, and a score that cannot fail is not a gate.
 */
export function norm(value: string): string {
  let v = String(value ?? '')
    .trim()
    .toLowerCase();
  for (const p of PREFIXES) v = v.replace(p, '');
  v = v
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return v
    .split('-')
    .map((w) =>
      w.length > 3 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w,
    )
    .join('-');
}

/** Predicates additionally shed the copula prefixes models sprinkle on inconsistently. */
export function normPredicate(value: string): string {
  return norm(value).replace(/^(is|are|was|has|have|had)-/, '');
}

type Slot = 'subject' | 'predicate' | 'object';
function normSlot(value: string, slot: Slot): string {
  return slot === 'predicate' ? normPredicate(value) : norm(value);
}

export function slotMatches(accepted: string[], actual: string, slot: Slot): boolean {
  const a = normSlot(actual, slot);
  if (!a) return false;
  return accepted.some((exp) => {
    const e = normSlot(exp, slot);
    return e === a || (e.length > 4 && a.length > 4 && (a.startsWith(e) || e.startsWith(a)));
  });
}

// ── Ground truth ─────────────────────────────────────────────────────────────

export interface Expectation {
  id: string;
  why?: string;
  knownBroken?: boolean;
  s: string[];
  p: string[];
  o: string[];
}
export interface FileSpec {
  title: string;
  expected: Expectation[];
  forbidden?: { slugs: string[]; why: string };
  /** F187.3 — groupings this source should produce. Scored by set-score.ts, reported apart. */
  sets?: SetExpectation[];
  /** F187.3 — lists that must NOT become groupings. Never averaged into set recall. */
  notSets?: NotSetExpectation[];
}

export function loadSpecs(dir = CORPUS): Record<string, FileSpec> {
  const file = path.join(dir, 'expectations.json');
  if (!existsSync(file)) throw new Error(`No ground truth at ${file} — the scorer cannot score without it.`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const out: Record<string, FileSpec> = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith('_')) out[k] = v as FileSpec;
  return out;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface Score {
  file: string;
  model: string;
  condition: string;
  /** Which repetition this came from (0-based). Always 0 unless --repeat=N. */
  run: number;
  /**
   * Facts found under the WRONG predicate name, with both names kept.
   *
   * Matt, 2026-09-08: "the terminology synonyms should be identified in these tests, to better
   * score extractions." The harness already knew a synonym existed — the loose-minus-strict count
   * IS that number — and threw the pair away in a `.some()`, reporting "2 facts found under a
   * DIFFERENT predicate name" without ever saying which. So the measurement produced a complaint
   * where it could have produced DATA: every one of these pairs is a candidate skos:altLabel,
   * discovered by running the corpus rather than guessed at a whiteboard.
   */
  drift: Array<{ id: string; expected: string[]; emitted: string }>;
  /** F187.3 — grouping stage, kept apart from relation recall so neither hides the other. */
  sets: SetScore[];
  overlaps: OverlapScore[];
  traps: TrapScore[];
  yield: number;
  strict: string[];
  loose: string[];
  missed: string[];
  brokenFixed: string[];
  brokenStillBroken: string[];
  invented: Array<{ slug: string; triple: string }>;
  misrouted: Array<{ slug: string; triple: string }>;
  /** Source text stored verbatim under a provenance predicate — not a claim, but not extraction either. */
  verbatim: Array<{ slug: string; triple: string }>;
  shapeViolations: string[];
  fragments: Array<[string, string[]]>;
  /** Triples the thinking-mode critic contributed that the first pass missed. 0 when off. */
  criticAdded?: number;
  /*
   * CONNECTION — the thing graph grounding is actually FOR, and the thing the first sweep did not
   * measure. Matt, 2026-09-04: "We are still connecting the extraction to existing graph
   * terminology, nodes and their synonyms?" The honest answer was that recall could not tell you:
   * F136 exists to raise VOCABULARY AGREEMENT, and a recall-only score gives it no credit for
   * succeeding. These count how much of what the model emitted matches what it was SHOWN.
   */
  entitiesEmitted: number;
  entitiesReused: number;
  predicatesEmitted: number;
  predicatesReused: number;
  seconds: number;
  error?: string;
}

export function scoreOne(
  spec: FileSpec,
  triples: ExtractedTriple[],
  offered: { offered: Set<string>; offeredPredicates: Set<string> } = { offered: new Set(), offeredPredicates: new Set() },
): Omit<Score, 'file' | 'model' | 'condition' | 'seconds' | 'run'> {
  const strict: string[] = [],
    loose: string[] = [],
    missed: string[] = [];
  const brokenFixed: string[] = [],
    brokenStillBroken: string[] = [];
  const drift: Score['drift'] = [];

  for (const exp of spec.expected) {
    const hitStrict = triples.some(
      (t) =>
        slotMatches(exp.s, t.subject, 'subject') &&
        slotMatches(exp.p, t.predicate, 'predicate') &&
        slotMatches(exp.o, t.object, 'object'),
    );
    // Predicate ignored. The gap between this and strict is the vocabulary problem, sized.
    const hitLoose = triples.some(
      (t) => slotMatches(exp.s, t.subject, 'subject') && slotMatches(exp.o, t.object, 'object'),
    );

    if (exp.knownBroken) {
      if (hitStrict || hitLoose) brokenFixed.push(exp.id);
      else brokenStillBroken.push(exp.id);
      continue;
    }
    if (hitStrict) strict.push(exp.id);
    if (hitLoose) loose.push(exp.id);
    if (!hitLoose) missed.push(exp.id);
    // The synonym, named. Only when the fact WAS found: a miss has no rival term to learn from.
    if (hitLoose && !hitStrict) {
      const t = triples.find(
        (x) => slotMatches(exp.s, x.subject, 'subject') && slotMatches(exp.o, x.object, 'object'),
      );
      if (t) drift.push({ id: exp.id, expected: exp.p, emitted: t.predicate });
    }
  }

  /*
   * INVENTION vs MISROUTING — a distinction the first run forced, and it matters.
   *
   * A forbidden slug means the source only REQUESTED the thing, or explicitly withheld it. But
   * qwen3-coder emitted `user | request-to-generate | comparison-document` on 2026-09-04, and that
   * is NOT the same failure as asserting the document exists: the model understood the intent
   * perfectly and marked it as a request. What went wrong is that note-intent.ts never got to move
   * it out of the fact stream. So a triple whose predicate or subject marks it as a request is
   * counted as MISROUTED — a real failure, but one that writes nothing false into the graph.
   *
   * Invention is the only measure here where a higher number is categorically worse rather than
   * merely weaker, so it must not be inflated by failures of a different kind.
   */
  const REQUEST_MARKER = /(request|task|asks?|asked|wants?|todo|to-do|action-item|intent|instruct)/;
  /*
   * VERBATIM STORAGE is a third thing, and the first full sweep proved it has to be separated.
   * devstral emitted `note-2026-09-02T11-40-13-902Z | note-text | "Generate a comparison document…"`
   * — that stores the source sentence under a provenance predicate. It asserts nothing about the
   * world, so calling it invented history was simply wrong, and it inflated the one number that
   * has to stay trustworthy. (It is still a finding: nothing was EXTRACTED from that note, and the
   * note-id subject came straight from the graph-context anchors. It is just not a lie.)
   */
  const VERBATIM_PREDICATE = /^(note-)?(text|content|body|raw|transcript|excerpt|note|source|value)$/;
  const invented: Array<{ slug: string; triple: string }> = [];
  const misrouted: Array<{ slug: string; triple: string }> = [];
  const verbatim: Array<{ slug: string; triple: string }> = [];
  for (const slug of spec.forbidden?.slugs ?? []) {
    const n = norm(slug);
    if (n.length <= 3) continue;
    for (const t of triples) {
      if (![t.subject, t.predicate, t.object].some((v) => norm(v).includes(n))) continue;
      const row = { slug, triple: `${t.subject} | ${t.predicate} | ${t.object}` };
      if (VERBATIM_PREDICATE.test(normPredicate(t.predicate))) verbatim.push(row);
      else if (REQUEST_MARKER.test(norm(t.predicate)) || REQUEST_MARKER.test(norm(t.subject))) misrouted.push(row);
      else invented.push(row);
    }
  }

  const shapeViolations = [...new Set(triples.map((t) => t.subject).filter((s) => looksLikeProposition(s)))];

  /*
   * FRAGMENTS. Two distinct emitted slugs that normalize to the same key are one thing minted twice
   * in a single run — measured live on 2026-09-04: qwen3-coder emitted `enterprise-cad-platform` and
   * `enterprise-cad-platforms` from two adjacent sentences. Nothing downstream rejoins them.
   */
  const byKey = new Map<string, Set<string>>();
  for (const t of triples) {
    for (const v of [t.subject, t.object]) {
      const k = norm(v);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k)!.add(String(v).trim());
    }
  }
  const fragments = [...byKey.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([k, set]) => [k, [...set]] as [string, string[]]);

  /*
   * Reuse is measured against what the model was SHOWN, not against the whole graph: crediting a
   * match with an entity that was never offered would count coincidence as grounding. With an
   * empty context both denominators are 0 and the metric correctly reports n/a rather than 0%.
   */
  const emittedEntities = new Set<string>();
  const emittedPredicates = new Set<string>();
  for (const t of triples) {
    for (const v of [t.subject, t.object]) {
      const k = norm(v);
      if (k) emittedEntities.add(k);
    }
    const pk = normPredicate(t.predicate);
    if (pk) emittedPredicates.add(pk);
  }
  const entitiesReused = [...emittedEntities].filter((e) => offered.offered.has(e)).length;
  const predicatesReused = [...emittedPredicates].filter((pr) => offered.offeredPredicates.has(pr)).length;

  return {
    entitiesEmitted: emittedEntities.size,
    entitiesReused,
    predicatesEmitted: emittedPredicates.size,
    predicatesReused,
    yield: triples.length,
    strict,
    loose,
    drift,
    sets: scoreSets(spec.sets ?? [], triples),
    overlaps: scoreOverlap(spec.sets ?? [], scoreSets(spec.sets ?? [], triples), triples),
    traps: scoreTraps(spec.notSets ?? [], triples),
    missed,
    brokenFixed,
    brokenStillBroken,
    invented,
    misrouted,
    verbatim,
    shapeViolations,
    fragments,
  };
}

// ── Graph context ────────────────────────────────────────────────────────────

/** Words worth matching an anchor label against — same rule structural-context uses internally. */
function textTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}

export interface GraphContext {
  section: string;
  /** Entities actually OFFERED to the model — the denominator for reuse. */
  offered: Set<string>;
  /** Predicates actually offered. */
  offeredPredicates: Set<string>;
  anchors: number;
  chars: number;
}

const EMPTY_CONTEXT: GraphContext = {
  section: '',
  offered: new Set(),
  offeredPredicates: new Set(),
  anchors: 0,
  chars: 0,
};

async function buildGraphContext(condition: string, text: string): Promise<GraphContext> {
  const level = GRAPH_LEVELS[condition];
  if (!level) {
    console.warn(`${Y}unknown graph level '${condition}' — known: ${Object.keys(GRAPH_LEVELS).join(', ')}${X}`);
    return EMPTY_CONTEXT;
  }
  if (level.budget === 0) return EMPTY_CONTEXT;
  if (!existsSync(LADDER_GRAPH)) {
    console.warn(`${Y}graph level '${condition}' skipped — ${LADDER_GRAPH} not present${X}`);
    return EMPTY_CONTEXT;
  }

  const { statements } = await readGraph(LADDER_GRAPH);
  const vocab = selectVocabulary(statements, text, {
    predicateBudget: level.budget,
    entityBudget: level.budget,
  });
  let struct = selectStructuralContext(statements, { sourceText: text, anchorBudget: level.budget });

  if (level.relevantOnly) {
    /*
     * THE FIX, APPLIED HERE RATHER THAN IN THE APP ON PURPOSE. Proving it in the harness first is
     * the whole point of having published a baseline: if it does not move the number, it does not
     * go into structural-context.ts. Anchors with no token in common with the source text are
     * dropped — which is exactly the rule that module already applies to open decisions.
     */
    const tokens = textTokens(text);
    struct = {
      ...struct,
      anchors: struct.anchors.filter((a) =>
        [...textTokens(`${a.label} ${a.slug.replace(/-/g, ' ')}`)].some((w) => tokens.has(w)),
      ),
    };
  }

  const claims = selectKnownClaims(statements, struct.anchors);
  const section = `${buildVocabularySection(vocab)}${buildStructuralSection(struct)}${buildClaimsSection(claims)}`;
  return {
    section,
    // What the model was SHOWN, not what the graph holds — reuse of something never offered is
    // coincidence, and counting it would flatter the feature.
    offered: new Set([...struct.anchors.map((a) => norm(a.slug)), ...vocab.entities.map((e) => norm(e.slug))]),
    offeredPredicates: new Set(vocab.predicates.map((pr) => normPredicate(pr.slug))),
    anchors: struct.anchors.length,
    chars: section.length,
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const specs = loadSpecs(CORPUS);
  const scores: Score[] = [];

  if (!JSON_OUT) {
    console.log(
      `\n${B}Extraction score${X} ${D}— ${Object.keys(specs).length} source(s) · ${MODELS.length} model(s) · graph ${CONDITIONS.join(', ')}${THINKING ? ' · THINKING MODE (two-pass)' : ''}${X}`,
    );
    console.log(`${D}Ground truth: ${path.join(CORPUS, 'expectations.json')} · ${BASE_URL}${X}\n`);
  }

  for (const model of MODELS) {
    for (const condition of CONDITIONS) {
     for (let run = 0; run < REPEAT; run++) {
      for (const [fileName, spec] of Object.entries(specs)) {
        const src = path.join(CORPUS, fileName);
        if (!existsSync(src)) continue;
        const text = readFileSync(src, 'utf8');
        const ctx = await buildGraphContext(condition, text);
        let criticAdded = 0;
        const t0 = Date.now();
        try {
          const triples = await extractWithOllama(text, fileName.replace(/\.\w+$/, ''), {
            model,
            baseUrl: BASE_URL,
            maxTokens: 4096,
            graphContext: ctx.section || undefined,
            thinking: THINKING,
            onCritic: (info) => {
              criticAdded = info.added;
            },
          });
          const s = scoreOne(spec, triples, ctx);
          scores.push({ ...s, file: fileName, model, condition, run, criticAdded, seconds: (Date.now() - t0) / 1000 });
          if (!JSON_OUT) reportOne(scores[scores.length - 1], spec, ctx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          scores.push({
            file: fileName,
            model,
            condition,
            run,
            yield: 0,
            strict: [],
            loose: [],
            drift: [],
            sets: [],
            overlaps: [],
            traps: [],
            missed: spec.expected.filter((x) => !x.knownBroken).map((x) => x.id),
            brokenFixed: [],
            brokenStillBroken: [],
            entitiesEmitted: 0,
            entitiesReused: 0,
            predicatesEmitted: 0,
            predicatesReused: 0,
            invented: [],
            misrouted: [],
            verbatim: [],
            shapeViolations: [],
            fragments: [],
            seconds: (Date.now() - t0) / 1000,
            error: msg,
          });
          if (!JSON_OUT) console.log(`  ${R}✗ ${model} / ${condition} / ${fileName}: ${msg.slice(0, 160)}${X}\n`);
        }
      }
     }
    }
  }

  /*
   * ALWAYS PERSIST THE RUN. Twice on 2026-09-08 a multi-hour benchmark was piped through `tail`
   * and its headline table — the medians the whole run existed to produce — was destroyed by the
   * command that displayed it. The numbers survived only as far as a terminal scrollback that had
   * already scrolled.
   *
   * A measurement that exists only in scrollback is not a record. It is written before anything is
   * printed, so a truncated view of the output costs a look at a file rather than the run.
   */
  try {
    const dir = path.resolve('tests/bench/results');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = path.join(dir, `extraction-score_${stamp}.json`);
    writeFileSync(out, JSON.stringify({
      at: new Date().toISOString(), base: BASE_URL, models: MODELS, conditions: CONDITIONS,
      repeat: REPEAT, thinking: THINKING, corpus: CORPUS, scores,
    }, null, 2) + '\n', 'utf8');
    if (!JSON_OUT) console.log(`${D}Run saved to ${out}${X}`);
  } catch (e) {
    // Never fail a benchmark because its archive could not be written — but say so loudly.
    console.log(`${R}Could not save the run: ${e instanceof Error ? e.message : String(e)}${X}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE_URL, models: MODELS, conditions: CONDITIONS, scores }, null, 2));
    return;
  }
  summary(scores, specs);
  if (PENDING_OUT) queue(scores, specs);
}

function pct(n: number, d: number) {
  return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(0).padStart(3)}%`;
}

function reportOne(s: Score, spec: FileSpec, ctx: GraphContext) {
  const total = spec.expected.filter((e) => !e.knownBroken).length;
  const shown = ctx.chars === 0 ? '' : ` ${D}(+${ctx.chars} chars, ${ctx.anchors} anchors, ${ctx.offered.size} entities offered)${X}`;
  console.log(`${B}${s.model}${X} ${D}/${X} graph ${C}${s.condition}${X} ${D}/${X} ${s.file}${shown}`);
  const recall = s.strict.length === total ? G : s.strict.length === 0 ? R : Y;
  const critic = s.criticAdded ? ` ${C}(+${s.criticAdded} from critic)${X}` : '';
  console.log(
    `  ${recall}strict ${pct(s.strict.length, total)}${X} ${D}(${s.strict.length}/${total})${X}   loose ${pct(s.loose.length, total)} ${D}(${s.loose.length}/${total})${X}   yield ${String(s.yield).padStart(3)} triples${critic}   ${D}${s.seconds.toFixed(1)}s${X}`,
  );
  if (s.drift.length > 0) {
    console.log(
      `  ${Y}· ${s.drift.length} fact(s) found under a DIFFERENT predicate name — vocabulary drift, not a miss${X}`,
    );
    for (const d of s.drift) {
      console.log(`      ${D}${d.id}${X}  expected ${C}${d.expected.join(' | ')}${X}  got ${Y}${d.emitted}${X}`);
    }
  }
  /*
   * THE GROUPING STAGE, REPORTED APART FROM RECALL (F187.3, Matt 2026-09-08).
   *
   * Four numbers and never one. A model can have perfect membership recall and be wrong in three
   * distinct ways — it swept in nearby nouns (precision), it got the sequence backwards (order),
   * it split one group into three (spread) — and a single averaged figure would show none of them.
   */
  if (s.sets.length > 0) {
    const anyFound = s.sets.some((x) => x.found);
    console.log(`  ${anyFound ? C : D}· sets${X}`);
    for (const x of s.sets) {
      if (!x.found) {
        console.log(`      ${D}${x.id}${X}  ${R}not grouped${X}  ${D}missing ${x.missing.join(', ')}${X}`);
        continue;
      }
      const bits = [`recall ${(x.recall * 100).toFixed(0)}%`];
      if (x.precision !== null) bits.push(`precision ${(x.precision * 100).toFixed(0)}%`);
      if (x.order !== null) bits.push(`order ${(x.order * 100).toFixed(0)}%`);
      if (x.spread > 1) bits.push(`${Y}SPREAD across ${x.spread} sets${X}`);
      const bad = x.extras.length ? `  ${Y}extras: ${x.extras.join(', ')}${X}` : '';
      console.log(`      ${D}${x.id}${X}  as ${C}${x.matched}${X}  ${bits.join('  ')}${bad}`);
    }
  }
  for (const o of s.overlaps) {
    console.log(o.held
      ? `      ${D}${o.id}${X}  ${G}overlap held${X} ${D}— member is in ${o.presentIn.join(' and ')}${X}`
      : `      ${D}${o.id}${X}  ${R}PARTITIONED${X} ${D}— member reached ${o.presentIn.length || 'none'} of `
        + `${o.requiredIn.length} required sets; sets overlap, they do not partition${X}`);
  }
  for (const tr of s.traps) {
    console.log(tr.refused
      ? `      ${D}${tr.id}${X}  ${G}trap refused${X} ${D}— the non-group was left ungrouped${X}`
      : `      ${D}${tr.id}${X}  ${R}TRAP FAILED${X} ${D}— grouped as "${tr.groupedAs}"; `
        + `the model has learned "bullet list => collection"${X}`);
  }

  if (ctx.offered.size > 0) {
    const ec = s.entitiesReused > 0 ? G : R;
    console.log(
      `  ${ec}· connected ${s.entitiesReused}/${s.entitiesEmitted} entities and ${s.predicatesReused}/${s.predicatesEmitted} predicates to what it was shown${X}`,
    );
  }
  if (s.invented.length) {
    console.log(`  ${R}· ${s.invented.length} INVENTED — asserted as fact what the source only requested or withheld:${X}`);
    for (const i of s.invented.slice(0, 3)) console.log(`      ${D}${i.triple}${X}`);
  }
  if (s.misrouted.length) {
    console.log(`  ${Y}· ${s.misrouted.length} MISROUTED — correctly marked as a request, but still in the fact stream:${X}`);
    for (const i of s.misrouted.slice(0, 3)) console.log(`      ${D}${i.triple}${X}`);
  }
  if (s.verbatim.length) {
    console.log(`  ${Y}· ${s.verbatim.length} VERBATIM — the sentence stored, not extracted (asserts nothing, but yields nothing):${X}`);
    for (const i of s.verbatim.slice(0, 2)) console.log(`      ${D}${i.triple.slice(0, 120)}${X}`);
  }
  if (s.shapeViolations.length)
    console.log(`  ${R}· ${s.shapeViolations.length} sentence-shaped subject(s) — looksLikeProposition regression${X}`);
  if (s.fragments.length) {
    console.log(
      `  ${Y}· ${s.fragments.length} entity minted twice in one run: ${s.fragments
        .slice(0, 3)
        .map(([, v]) => v.join(' / '))
        .join(', ')}${X}`,
    );
  }
  if (s.brokenFixed.length)
    console.log(`  ${G}· ${s.brokenFixed.length} known-broken expectation(s) now PASSING: ${s.brokenFixed.join(', ')}${X}`);
  if (s.missed.length) console.log(`  ${D}· missed: ${s.missed.join(', ')}${X}`);
  console.log();
}

function summary(scores: Score[], specs: Record<string, FileSpec>) {
  const totalExpected = (file: string) => (specs[file]?.expected ?? []).filter((e) => !e.knownBroken).length;
  console.log(`${B}══ summary ══${X}`);
  console.log(
    `${D}model                        graph      strict  loose   GAP   ent-reuse  pred-reuse  yield  inv  mis${X}`,
  );
  console.log(
    `${D}                                        ^ did it get the fact  ^ did it connect to the graph${X}`,
  );

  const key = (s: Score) => `${s.model} ${s.condition}`;
  const groups = new Map<string, Score[]>();
  for (const s of scores) {
    if (!groups.has(key(s))) groups.set(key(s), []);
    groups.get(key(s))!.push(s);
  }

  const rows: Array<{
    model: string;
    condition: string;
    strict: number;
    loose: number;
    total: number;
    y: number;
    inv: number;
    mis: number;
    verb: number;
    frag: number;
    entEmit: number;
    entReuse: number;
    predEmit: number;
    predReuse: number;
  }> = [];
  for (const [k, group] of groups) {
    const [model, condition] = k.split(' ');
    const total = group.reduce((n, s) => n + totalExpected(s.file), 0);
    rows.push({
      model,
      condition,
      total,
      strict: group.reduce((n, s) => n + s.strict.length, 0),
      loose: group.reduce((n, s) => n + s.loose.length, 0),
      y: group.reduce((n, s) => n + s.yield, 0),
      inv: group.reduce((n, s) => n + s.invented.length, 0),
      mis: group.reduce((n, s) => n + s.misrouted.length, 0),
      verb: group.reduce((n, s) => n + s.verbatim.length, 0),
      entEmit: group.reduce((n, s) => n + s.entitiesEmitted, 0),
      entReuse: group.reduce((n, s) => n + s.entitiesReused, 0),
      predEmit: group.reduce((n, s) => n + s.predicatesEmitted, 0),
      predReuse: group.reduce((n, s) => n + s.predicatesReused, 0),
      frag: group.reduce((n, s) => n + s.fragments.length, 0),
    });
  }
  // Ordered by the LADDER, not by score: the whole question is how the numbers move as context
  // grows, and sorting by score would scramble exactly the axis being measured.
  const order = ['none', 'xs', 'sm', 'md', 'lg', 'full', 'relevant'];
  rows.sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      (order.indexOf(a.condition) - order.indexOf(b.condition) || a.condition.localeCompare(b.condition)),
  );
  for (const r of rows) {
    const c = r.strict === 0 ? R : r.strict / r.total > 0.6 ? G : Y;
    const gap = r.loose - r.strict;
    const gapPct = r.total === 0 ? '  n/a' : `${((gap / r.total) * 100).toFixed(0).padStart(3)}%`;
    console.log(
      `${r.model.slice(0, 26).padEnd(28)} ${r.condition.padEnd(9)} ${c}${pct(r.strict, r.total)}${X}  ${pct(r.loose, r.total)}  ${D}${gapPct}${X}  ` +
        `${r.entEmit ? pct(r.entReuse, r.entEmit) : '  n/a'}      ${r.predEmit ? pct(r.predReuse, r.predEmit) : '  n/a'}  ` +
        `${String(r.y).padStart(5)}  ${r.inv ? R : D}${String(r.inv).padStart(3)}${X}  ${r.mis ? Y : D}${String(r.mis).padStart(3)}${X}`,
    );
  }

  /*
   * MEDIAN AND SPREAD ACROSS REPEATS — the table above is a MEAN over all runs, and a mean is the
   * wrong summary for a distribution this wide. Printed only when there is more than one run,
   * because a "median of 1" would dress a single sample up as a result.
   *
   * The SPREAD is the number that decides whether a comparison is allowed at all: if two models'
   * ranges overlap, the harness has not distinguished them, and saying which is better on these
   * data would be exactly the marketing instrument F146 phase 1 warned about.
   */
  if (REPEAT > 1) {
    const median = (xs: number[]): number => {
      const a = [...xs].sort((p, q) => p - q);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    console.log(`\n${B}Median of ${REPEAT} runs, with the spread${X} ${D}— the table above is the mean${X}`);
    const ranges = new Map<string, { lo: number; hi: number; med: number }>();
    for (const [k, group] of groups) {
      const [model, condition] = k.split(' ');
      const byRun = new Map<number, { hit: number; tot: number }>();
      for (const sc of group) {
        const cur = byRun.get(sc.run) ?? { hit: 0, tot: 0 };
        cur.hit += sc.strict.length;
        cur.tot += totalExpected(sc.file);
        byRun.set(sc.run, cur);
      }
      const perRun = [...byRun.values()].map((v) => (v.tot ? (v.hit / v.tot) * 100 : 0));
      const med = median(perRun);
      const lo = Math.min(...perRun);
      const hi = Math.max(...perRun);
      ranges.set(k, { lo, hi, med });
      const runs = perRun.map((x) => `${x.toFixed(0)}%`).join(' ');
      console.log(
        `  ${model.slice(0, 26).padEnd(28)} ${condition.padEnd(9)} median ${C}${med.toFixed(0).padStart(3)}%${X}` +
          `  spread ${lo.toFixed(0)}-${hi.toFixed(0)}%  ${D}(${runs})${X}`,
      );
    }
    // Do the ranges overlap? If they do, this run distinguished nothing, and it must say so.
    const keys = [...ranges.keys()];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = ranges.get(keys[i])!;
        const b = ranges.get(keys[j])!;
        if (a.lo <= b.hi && b.lo <= a.hi) {
          console.log(
            `\n${Y}${keys[i]} and ${keys[j]} have OVERLAPPING ranges ` +
              `(${a.lo.toFixed(0)}-${a.hi.toFixed(0)}% vs ${b.lo.toFixed(0)}-${b.hi.toFixed(0)}%). ` +
              `This run did not distinguish them — do not pick one on these data.${X}`,
          );
        }
      }
    }
  }

  const best = rows[0];
  console.log();
  if (!best || best.strict === 0) {
    console.log(`${R}NOTHING SCORED. Either Ollama is unreachable or every model failed — this is not a pass.${X}`);
    return;
  }
  console.log(
    `${B}Best${X} ${C}${best.model}${X} at graph ${C}${best.condition}${X} — ${best.strict}/${best.total} strict, ${best.loose}/${best.total} loose.`,
  );

  /*
   * The grounding question, answered PER MODEL rather than in aggregate: a mean across models with
   * different competence hides exactly the effect being tested.
   */
  const conds = [...new Set(rows.map((r) => r.condition))];
  if (conds.length > 1) {
    /*
     * TWO QUESTIONS, NOT ONE — and reporting only the first is what made the 2026-09-04 headline
     * misleading. Recall asks "did it get the fact"; reuse asks "did it connect to the graph",
     * which is what F136 was built for. They can move in OPPOSITE directions, and a single verdict
     * line that reads only recall gives grounding no credit for doing its actual job.
     */
    console.log(`\n${B}How does each level move recall vs connection?${X} ${D}(per model — a mean across models hides the effect)${X}`);
    for (const model of MODELS) {
      const mine = rows.filter((r) => r.model === model);
      if (mine.length < 2) continue;
      console.log(`  ${C}${model}${X}`);
      const base = mine.find((r) => r.condition === 'none');
      for (const r of mine) {
        const dStrict = base ? r.strict - base.strict : 0;
        const arrow = !base || r.condition === 'none' ? '' : dStrict > 0 ? `${G}+${dStrict} facts${X}` : dStrict < 0 ? `${R}${dStrict} facts${X}` : `${D}same${X}`;
        console.log(
          `    ${r.condition.padEnd(9)} recall ${pct(r.strict, r.total)}  connection ${r.entEmit ? pct(r.entReuse, r.entEmit) : ' n/a'}  ${arrow}`,
        );
      }
    }
  }

  /*
   * SYNONYM CANDIDATES — the harness's most useful by-product, and until 2026-09-08 it was thrown
   * away. Every row here is a fact the model FOUND under a rival predicate name, so the pair is a
   * candidate skos:altLabel discovered by measurement rather than guessed.
   *
   * Counted across runs on purpose: a drift seen once is a model having a bad day, the same drift
   * seen in every run is the vocabulary genuinely disagreeing with ours, and the two deserve very
   * different treatment. So the run count is printed and NOT collapsed.
   *
   * This is the same finding kb:ingest-synonyms (F126.1) made from the other end — zero
   * skos:altLabel triples existed across 25 graphs because the only alias trigger was a human
   * confirming a merge. The corpus is a second path to the same data, and it needs no human.
   */
  const drifts = new Map<string, { expected: string; emitted: string; runs: Set<string>; ids: Set<string> }>();
  for (const sc of scores) {
    for (const d of sc.drift) {
      const key = `${d.expected[0]} → ${d.emitted}`;
      const cur = drifts.get(key) ?? { expected: d.expected[0], emitted: d.emitted, runs: new Set(), ids: new Set() };
      cur.runs.add(`${sc.model}#${sc.run}`);
      cur.ids.add(d.id);
      drifts.set(key, cur);
    }
  }
  if (drifts.size > 0) {
    const totalRuns = new Set(scores.map((sc) => `${sc.model}#${sc.run}`)).size;
    console.log(`\n${B}Synonym candidates${X} ${D}— the fact was found, our predicate name was not the one used${X}`);
    const sorted = [...drifts.entries()].sort((a, b) => b[1].runs.size - a[1].runs.size);
    for (const [, d] of sorted) {
      const persistent = d.runs.size > totalRuns / 2;
      console.log(
        `  ${persistent ? Y : D}${d.runs.size}/${totalRuns} runs${X}  ours ${C}${d.expected}${X}` +
          `  theirs ${Y}${d.emitted}${X}  ${D}(${[...d.ids].sort().join(', ')})${X}`,
      );
    }
    console.log(
      `${D}  A pair seen in most runs is the vocabulary disagreeing, not a fluke — those are the ones worth\n` +
        `  proposing as skos:altLabel. Pass --pending to queue them for review.${X}`,
    );
  }

  /*
   * THE GROUPING STAGE ACROSS RUNS — a second table, not a column in the first.
   *
   * Set recall and relation recall answer different questions and must not be summed: a run that
   * extracts every fact and produces no groupings is 100% on one and 0% on the other, which is
   * precisely the state of the pipeline today and the reason 05-list-structured.md exists.
   */
  const setModels = [...new Set(scores.filter((s) => s.sets.length > 0).map((s) => s.model))];
  if (setModels.length > 0) {
    console.log(`\n${B}Grouping stage${X} ${D}— separate from relation recall, and from each other${X}`);
    console.log(`${D}model                        found  recall  precis  order   spread  overlap  trap${X}`);
    for (const model of setModels) {
      const mine = scores.filter((s) => s.model === model);
      const sets = mine.flatMap((s) => s.sets);
      const overlaps = mine.flatMap((s) => s.overlaps);
      const traps = mine.flatMap((s) => s.traps);
      const mean = (xs: Array<number | null>) => {
        const v = xs.filter((x): x is number => x !== null);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      const pctOrNa = (x: number | null) => (x === null ? '   n/a' : `${(x * 100).toFixed(0).padStart(5)}%`);
      const found = sets.filter((x) => x.found).length;
      const fragmented = sets.filter((x) => x.spread > 1).length;
      const overlapHeld = overlaps.filter((o) => o.held).length;
      const trapsRefused = traps.filter((t) => t.refused).length;
      const c = found === 0 ? R : G;
      console.log(
        `${model.slice(0, 26).padEnd(28)} ${c}${String(found).padStart(2)}/${String(sets.length).padEnd(3)}${X}`
        + `${pctOrNa(mean(sets.map((x) => x.recall)))} ${pctOrNa(mean(sets.map((x) => x.precision)))} `
        + `${pctOrNa(mean(sets.map((x) => x.order)))}  ${fragmented ? Y : D}${String(fragmented).padStart(5)}${X}  `
        + `${overlapHeld === overlaps.length && overlaps.length ? G : R}${overlapHeld}/${overlaps.length}${X}      `
        + `${trapsRefused === traps.length ? G : R}${trapsRefused}/${traps.length}${X}`,
      );
    }
    console.log(
      `${D}  spread = expectations whose members were split across several sets.\n`
      + `  trap = lists the source says are NOT groups and that must be left ungrouped. A high recall\n`
      + `  with a failed trap is a bullet-list heuristic, not an understanding of sets.${X}`,
    );
  }

  const anyInvented = rows.reduce((n, r) => n + r.inv, 0);
  const anyMisrouted = rows.reduce((n, r) => n + r.mis, 0);
  if (anyInvented > 0)
    console.log(`\n${R}${anyInvented} invented fact(s) across all runs — asserting what a source only asked for is the worst failure here.${X}`);
  if (anyMisrouted > 0)
    console.log(
      `${Y}${anyMisrouted} misrouted request(s) — the extractor understood the intent; note-intent.ts never got to move them out of the fact stream.${X}`,
    );
  const fixed = [...new Set(scores.flatMap((s) => s.brokenFixed))];
  if (fixed.length)
    console.log(
      `${G}Known-broken expectations now passing: ${fixed.join(', ')} — update expectations.json and the EXPECTED.txt that documents them.${X}`,
    );
}

function queue(scores: Score[], specs: Record<string, FileSpec>) {
  const lines: string[] = [];
  const add = (subject: string, predicate: string, object: string, note: string, type: string, priority: string) =>
    lines.push(JSON.stringify({ subject, predicate, object, note, type, agent: 'extraction-score', priority }));

  /*
   * SYNONYMS FIRST — proposed as skos:altLabel, which is what a rival term for the same fact IS.
   *
   * Aggregated across runs BEFORE queuing rather than one row per occurrence, because a five-run
   * benchmark would otherwise put the same synonym in the review queue five times, and a job that
   * floods the queue moves cost from collection to triage rather than removing it
   * (kb:work-tiering). One row per pair, carrying how persistent it was, is the reviewable unit.
   *
   * Deliberately a PROPOSAL and never a write. Which of two rival terms should lead is an
   * authorship decision — Matt, 2026-09-08, on users setting the lead term — and altLabel is the
   * safe half of it: adding a synonym never demotes anything. Promoting one to skos:prefLabel is
   * the part a human does.
   */
  const pairs = new Map<string, { expected: string; emitted: string; runs: Set<string>; ids: Set<string> }>();
  for (const s of scores) {
    for (const d of s.drift) {
      const key = `${d.expected[0]} → ${d.emitted}`;
      const cur = pairs.get(key) ?? { expected: d.expected[0], emitted: d.emitted, runs: new Set(), ids: new Set() };
      cur.runs.add(`${s.model}#${s.run}`);
      cur.ids.add(d.id);
      pairs.set(key, cur);
    }
  }
  const totalRuns = new Set(scores.map((s) => `${s.model}#${s.run}`)).size;
  for (const [, d] of pairs) {
    add(
      d.expected,
      'skos:altLabel',
      d.emitted,
      `Extraction found the fact under "${d.emitted}" where the corpus expects "${d.expected}" — `
        + `seen in ${d.runs.size} of ${totalRuns} run(s), expectation(s) ${[...d.ids].sort().join(', ')}. `
        + `A rival term for the same fact is a synonym. Accepting adds it as an alias; it does NOT `
        + `change which term leads.`,
      d.runs.size > totalRuns / 2 ? 'suggestion' : 'observation',
      d.runs.size > totalRuns / 2 ? 'medium' : 'low',
    );
  }

  /*
   * EVERY OTHER FINDING IS AGGREGATED ACROSS RUNS TOO — because --repeat multiplies the queue.
   *
   * This loop used to emit one row per SCORE, which is one per (model, file, run). That was fine
   * at --repeat=1 and becomes flooding the moment it is not: six models over three files at
   * --repeat=5 is 90 scores and would have put roughly 200 rows into a queue already holding 403,
   * most of them the same finding restated five times. kb:work-tiering is explicit that a job
   * which floods the queue moves cost from collection to triage rather than removing it.
   *
   * So the unit is (model, file, finding) with the run count carried, exactly as synonyms above.
   * The run count is not decoration: an invention in one run of five is a sampling artefact, an
   * invention in five of five is the model's behaviour, and a reviewer needs to see which.
   */
  const totalRunsPerModel = new Map<string, number>();
  for (const s of scores) {
    const k = `${s.model} ${s.file}`;
    totalRunsPerModel.set(k, Math.max(totalRunsPerModel.get(k) ?? 0, s.run + 1));
  }

  interface Finding {
    subject: string;
    predicate: string;
    kind: string;
    type: string;
    priority: string;
    describe: (s: Score) => string | null;
  }
  const FINDINGS: Finding[] = [
    {
      subject: 'kb:extraction-accuracy', predicate: 'kpred:invented-fact', kind: 'invented',
      type: 'drift-warning', priority: 'high',
      describe: (s) => s.invented.length
        ? `${s.invented.length} triple(s) assert something the source only REQUESTED: `
          + s.invented.slice(0, 2).map((i) => i.triple).join(' ; ')
        : null,
    },
    {
      subject: 'kb:extraction-accuracy', predicate: 'kpred:verbatim-not-extracted', kind: 'verbatim',
      type: 'observation', priority: 'medium',
      describe: (s) => s.verbatim.length
        ? `${s.verbatim.length} note(s) were STORED as a sentence rather than extracted into facts: `
          + s.verbatim[0].triple.slice(0, 160)
        : null,
    },
    {
      subject: 'kb:note-intent', predicate: 'kpred:misrouted-request', kind: 'misrouted',
      type: 'observation', priority: 'medium',
      describe: (s) => s.misrouted.length
        ? `${s.misrouted.length} triple(s) were correctly marked as REQUESTS but stayed in the fact stream: `
          + s.misrouted.slice(0, 2).map((i) => i.triple).join(' ; ')
        : null,
    },
    {
      subject: 'kb:triple-shape', predicate: 'kpred:guard-regression', kind: 'shape',
      type: 'drift-warning', priority: 'high',
      describe: (s) => s.shapeViolations.length
        ? `looksLikeProposition should reject these subjects: ${s.shapeViolations.slice(0, 3).join(' ; ')}`
        : null,
    },
    {
      subject: 'kb:extraction-accuracy', predicate: 'kpred:entity-fragmented', kind: 'fragments',
      type: 'observation', priority: 'medium',
      describe: (s) => s.fragments.length
        ? `${s.fragments.length} entity minted more than once in ONE run: `
          + s.fragments.slice(0, 3).map(([, v]) => v.join(' / ')).join(' ; ')
        : null,
    },
    {
      subject: 'kb:vocabulary-grounding', predicate: 'kpred:predicate-drift', kind: 'drift',
      type: 'observation', priority: 'medium',
      describe: (s) => {
        if (s.loose.length <= s.strict.length) return null;
        const total = (specs[s.file]?.expected ?? []).filter((e) => !e.knownBroken).length;
        return `${s.loose.length - s.strict.length} of ${total} expected facts were found under a `
          + `different predicate name — F136 grounding is not landing here.`;
      },
    },
  ];

  for (const f of FINDINGS) {
    const seen = new Map<string, { hits: number; sample: string }>();
    for (const s of scores) {
      const desc = f.describe(s);
      if (!desc) continue;
      const k = `${s.model} ${s.file}`;
      const cur = seen.get(k) ?? { hits: 0, sample: desc };
      cur.hits += 1;
      seen.set(k, cur);
    }
    for (const [k, v] of seen) {
      const runs = totalRunsPerModel.get(k) ?? 1;
      const persistence = runs > 1 ? ` Seen in ${v.hits} of ${runs} run(s).` : '';
      add(f.subject, f.predicate, k, `${v.sample}${persistence}`, f.type,
        // A finding in a minority of runs is weaker evidence and is filed as such.
        runs > 1 && v.hits <= runs / 2 ? 'low' : f.priority);
    }
  }
  if (!lines.length) {
    console.log(`\n${D}Nothing to queue — no inventions, regressions, fragments or drift.${X}`);
    return;
  }
  appendFileSync(PENDING, lines.join('\n') + '\n');
  console.log(`\nQueued ${lines.length} finding(s) to ${PENDING} — review in Reckons.AI.`);
}

/*
 * Guarded so the scoring functions above can be unit-tested WITHOUT running an extraction. Every
 * other offline job calls main() at import; this one must not, because importing it would fire six
 * models at Ollama from inside vitest — a test suite that needs a GPU is a test suite nobody runs.
 */
if (process.argv[1]?.includes('extraction-score')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
