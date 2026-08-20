#!/usr/bin/env npx tsx
/**
 * AGGREGATE MANY FACTS INTO FEW DECISION POINTS (F139.1, AGENT tier) — the local model reads the
 * bare facts and proposes the questions worth asking; a validator makes its output trustworthy.
 *
 * WHY THIS IS THE AGENT TIER AND NOT A SCRIPT. Matt, 2026-08-19: "the summarization of many
 * detailed facts into accurate decision points is not mechanically viable… aggregation and
 * dependency decisions I'm certain need LLM assistance." A `groupBy` over datestamps produces a
 * correct MECHANICAL BATCH and tells you nothing about what question is worth asking. Judging what
 * a pile of facts is collectively ABOUT — and which decisions must be settled before others — is
 * judgment over language. clusterForCascade() is still run first because it is free and exact; this
 * job handles what it cannot reach.
 *
 *   ground    → the bare facts (id, subject, predicate, object) + the decisions already open
 *   prompt    → propose clusters, each with the ONE question that settles it, plus dependencies
 *   validate  → validateProposedAggregation(): unknown ids, invented values, overlapping clusters,
 *               judgment/decision facts and invented predicates are all rejected LOUDLY
 *   emit      → proposals into the review queue. It settles nothing and writes no graph.
 *
 * THE REJECTION COUNT IS THE POINT, NOT A FOOTNOTE. Offloading is not free (F74.3): a job emitting
 * 30 findings of which 25 are noise moves cost to triage rather than removing it. So this prints
 * accepted vs rejected with every reason, and a run whose rejection rate is high is evidence
 * against running it again — which is exactly what it should be.
 *
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/aggregate-decisions.ts
 *   … --graph=static/reckons-roadmap.ttl --limit=120 --model=qwen3-coder:latest --dry
 */
import { readGraph } from './read-graph.js';
import { buildReviewTree } from '../../src/lib/rdf/review-tree.js';
import {
  clusterForCascade, aggregationRequest, validateProposedAggregation, cascadeSummary,
  type ProposedAggregation,
} from '../../src/lib/rdf/fact-aggregation.js';
import { isLit } from '../../src/lib/rdf/types.js';
import { altitudeOf } from '../../src/lib/rdf/fact-altitude.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', R = '\x1b[31m', X = '\x1b[0m';

const OLLAMA = process.env.OLLAMA_BASE_URL ?? process.env.VITE_OLLAMA_BASE_URL ?? '';
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const GRAPH = arg('graph', 'static/reckons-roadmap.ttl');
const LIMIT = Number(arg('limit', '120'));
const MODEL = arg('model', 'qwen3-coder:latest');
const DRY = args.includes('--dry');

if (!OLLAMA && !DRY) {
  console.error(
    `${R}OLLAMA_BASE_URL not set${X} — this is the agent tier and it needs the local model.\n` +
      `  OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/aggregate-decisions.ts\n` +
      `Check it is up with: curl -s localhost:11434/api/tags`,
  );
  process.exit(1);
}

async function ollama(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA.replace(/\/+$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: { num_ctx: 32768, temperature: 0.1 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).response ?? '';
}

// ── GROUND ──────────────────────────────────────────────────────────────────
const { statements, typeOf } = readGraph(GRAPH, { asReviewSet: true });
const tree = buildReviewTree(statements, statements, { typeOf });

const openDecisions = tree.decisions.slice(0, 40).map((d) => ({
  id: d.question.id,
  subject: d.subjectIri.replace('urn:kbase:concept/', 'kb:'),
  question: (isLit(d.question.o) ? d.question.o.value : (d.question.question ?? '')).replace(/\s+/g, ' ').slice(0, 200),
}));

// Only cascadable altitudes are candidates at all: a judgment or a decision is never batched.
const cascadable = statements.filter((s) => {
  const a = altitudeOf(s);
  return a === 'log' || a === 'record' || a === 'evidence';
});

// The FLOOR runs first: whatever a script can batch EXACTLY, it batches for free.
const mechanical = clusterForCascade(cascadable);
const alreadyBatched = new Set(mechanical.flatMap((c) => c.members.map((m) => m.id)));

const candidates = cascadable.filter((s) => !alreadyBatched.has(s.id)).slice(0, LIMIT);
const request = aggregationRequest(candidates, openDecisions);

console.log(`\n${B}Aggregate decisions${X} ${D}— ${GRAPH}${X}`);
console.log(`${D}cascadable   : ${cascadable.length} of ${statements.length} facts (log/record/evidence only)${X}`);
console.log(`${D}script floor : ${mechanical.length} mechanical batch(es) covering ${alreadyBatched.size} facts${X}`);
console.log(`${D}agent input  : ${request.facts.length} bare facts, ${openDecisions.length} open decisions, model ${MODEL}${X}\n`);
if (mechanical.length) console.log(`${G}${cascadeSummary(mechanical)}${X}\n`);

if (request.facts.length === 0) {
  console.log(`${Y}Nothing left for the agent tier — the script floor covered it.${X}\n`);
  process.exit(0);
}

// ── PROMPT ──────────────────────────────────────────────────────────────────
const prompt =
  `You group knowledge-graph facts so a person can settle many at once with ONE question.\n\n` +
  `TASK\n` +
  `1. Find groups of facts that ONE question would settle. A group needs at least 3 facts.\n` +
  `2. For each group give the single question a person can answer yes/no, and the ONE fact their\n` +
  `   answer would record (subject, predicate, object).\n` +
  `3. State dependencies between the OPEN DECISIONS listed below: which must be settled first.\n\n` +
  `HARD RULES — output breaking any of these is discarded:\n` +
  `- Use ONLY the fact ids given. Never invent an id.\n` +
  `- The "object" you record MUST appear in the text of one of that group's own facts. Never\n` +
  `  introduce a value the facts do not contain.\n` +
  `- Predicates must start with "kpred:" or "urn:kbase:".\n` +
  `- Each fact belongs to at most ONE group.\n` +
  `- "question" must end with a question mark.\n` +
  `- Dependencies may only reference the decision ids given.\n\n` +
  `Reply with JSON only:\n` +
  `{"clusters":[{"memberIds":["..."],"question":"...?","proposes":{"subject":"kb:x","predicate":"kpred:y","object":"z"},"rationale":"..."}],` +
  `"dependencies":[{"blocker":"id","blocked":"id","because":"..."}]}\n\n` +
  `OPEN DECISIONS\n==============\n` +
  openDecisions.map((d) => `${d.id} | ${d.subject} | ${d.question}`).join('\n') +
  `\n\nFACTS\n=====\n` +
  request.facts.map((f) => `${f.id} | ${f.subject} | ${f.predicate} | ${f.object.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');

if (DRY) {
  console.log(`${D}--dry: prompt is ${prompt.length} chars; not calling the model.${X}\n`);
  process.exit(0);
}

// ── VALIDATE ────────────────────────────────────────────────────────────────
let raw = '';
try {
  raw = await ollama(prompt);
} catch (e) {
  console.error(`${R}model call failed:${X} ${(e as Error).message}`);
  process.exit(1);
}

let parsed: ProposedAggregation;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error(`${R}model did not return JSON${X} — ${raw.slice(0, 200)}`);
  process.exit(1);
}

const outcome = validateProposedAggregation(parsed, request, candidates);

console.log(`${B}Proposed${X} ${parsed.clusters?.length ?? 0} cluster(s), ${parsed.dependencies?.length ?? 0} dependency(ies)`);
console.log(`${G}accepted${X} ${outcome.clusters.length} cluster(s), ${outcome.dependencies.length} dependency(ies)`);
console.log(`${R}rejected${X} ${outcome.rejected.length}\n`);

for (const c of outcome.clusters) {
  console.log(`${C}◆ ${c.question}${X}`);
  console.log(`  ${D}settles ${c.members.length} facts · records ${c.proposes.predicate.replace('urn:kbase:predicate/', 'kpred:')} "${c.proposes.object.slice(0, 50)}"${X}`);
  console.log(`  ${D}why: ${c.key.slice(0, 100)}${X}\n`);
}
for (const d of outcome.dependencies) {
  console.log(`${Y}⇢ settle ${d.blocker} before ${d.blocked}${X}${d.because ? ` ${D}— ${d.because.slice(0, 90)}${X}` : ''}`);
}
if (outcome.rejected.length) {
  console.log(`\n${R}Rejections${X} ${D}— the yield measurement, not a footnote:${X}`);
  for (const r of outcome.rejected) console.log(`  ${D}· ${r}${X}`);
}

const accepted = outcome.clusters.reduce((n, c) => n + c.members.length, 0);
const rate = (parsed.clusters?.length ?? 0) > 0 ? (outcome.clusters.length / parsed.clusters.length) * 100 : 0;
console.log(
  `\n${B}Yield${X}: ${outcome.clusters.length}/${parsed.clusters?.length ?? 0} clusters survived validation (${rate.toFixed(0)}%), ` +
    `covering ${accepted} facts. ${D}A low rate is evidence against running this again.${X}\n`,
);
console.log(`${D}Proposals only — nothing was settled and no graph was written (F52).${X}\n`);
