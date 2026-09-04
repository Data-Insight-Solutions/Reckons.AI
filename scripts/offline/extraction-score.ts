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
import { readFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { extractWithOllama } from '../../src/lib/integrations/llm/ollama-extract.js';
import type { ExtractedTriple } from '../../src/lib/integrations/llm/extractor.js';
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
): Omit<Score, 'file' | 'model' | 'condition' | 'seconds'> {
  const strict: string[] = [],
    loose: string[] = [],
    missed: string[] = [];
  const brokenFixed: string[] = [],
    brokenStillBroken: string[] = [];

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
          scores.push({ ...s, file: fileName, model, condition, criticAdded, seconds: (Date.now() - t0) / 1000 });
          if (!JSON_OUT) reportOne(scores[scores.length - 1], spec, ctx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          scores.push({
            file: fileName,
            model,
            condition,
            yield: 0,
            strict: [],
            loose: [],
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
  if (s.loose.length > s.strict.length) {
    console.log(
      `  ${Y}· ${s.loose.length - s.strict.length} fact(s) found under a DIFFERENT predicate name — vocabulary drift, not a miss${X}`,
    );
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

  for (const s of scores) {
    if (s.invented.length) {
      add(
        'kb:extraction-accuracy',
        'kpred:invented-fact',
        `${s.model} on ${s.file}`,
        `${s.invented.length} triple(s) assert something the source only REQUESTED: ${s.invented
          .slice(0, 2)
          .map((i) => i.triple)
          .join(' ; ')}`,
        'drift-warning',
        'high',
      );
    }
    if (s.verbatim.length) {
      add(
        'kb:extraction-accuracy',
        'kpred:verbatim-not-extracted',
        `${s.model} on ${s.file}`,
        `${s.verbatim.length} note(s) were STORED as a sentence rather than extracted into facts: ${s.verbatim[0].triple.slice(0, 160)}`,
        'observation',
        'medium',
      );
    }
    if (s.misrouted.length) {
      add(
        'kb:note-intent',
        'kpred:misrouted-request',
        `${s.model} on ${s.file}`,
        `${s.misrouted.length} triple(s) were correctly marked as REQUESTS but stayed in the fact stream: ${s.misrouted
          .slice(0, 2)
          .map((i) => i.triple)
          .join(' ; ')}`,
        'observation',
        'medium',
      );
    }
    if (s.shapeViolations.length) {
      add(
        'kb:triple-shape',
        'kpred:guard-regression',
        `${s.model} on ${s.file}`,
        `looksLikeProposition should reject these subjects: ${s.shapeViolations.slice(0, 3).join(' ; ')}`,
        'drift-warning',
        'high',
      );
    }
    if (s.fragments.length) {
      add(
        'kb:extraction-accuracy',
        'kpred:entity-fragmented',
        `${s.model} on ${s.file}`,
        `${s.fragments.length} entity minted more than once in ONE run: ${s.fragments
          .slice(0, 3)
          .map(([, v]) => v.join(' / '))
          .join(' ; ')}`,
        'observation',
        'medium',
      );
    }
    const total = (specs[s.file]?.expected ?? []).filter((e) => !e.knownBroken).length;
    if (s.loose.length > s.strict.length) {
      add(
        'kb:vocabulary-grounding',
        'kpred:predicate-drift',
        `${s.model} on ${s.file}`,
        `${s.loose.length - s.strict.length} of ${total} expected facts were found under a different predicate name — F136 grounding is not landing here.`,
        'observation',
        'medium',
      );
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
