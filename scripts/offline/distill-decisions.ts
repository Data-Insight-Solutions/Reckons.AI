#!/usr/bin/env npx tsx
/**
 * DISTILL PROSE DECISIONS INTO OPTIONS A PERSON CAN WEIGH (F139, AGENT tier).
 *
 * MEASURED 2026-08-21 (npm run offline:decisions): 78 of 78 open decisions in the roadmap are
 * prose-only. Every root in the review tree renders "no options modelled, so there is nothing to
 * weigh side by side", and the question shown is a truncated paragraph. The tree can already hide
 * 1,592 bookkeeping facts and rank roots by what they unlock — but the thing it finally puts in
 * front of a human is still a wall of text with no alternatives. That is the core premise failing
 * at the last step.
 *
 * `distillationRequest()` has defined the contract in review-tree.ts since 2026-08-19 and NOTHING
 * EXECUTED IT — graph-decisions.ts called it only to print the task name. This job is the executor.
 *
 *   ground    → the question verbatim + only the facts already under it (judgments, evidence,
 *               standing decisions). Nothing else is in scope, so the model cannot reach for
 *               context it was not given.
 *   prompt    → SPLIT the prose into the alternatives it already contains. Never add one.
 *   validate  → validateProposedOptions(): ungrounded options, invented fact ids, duplicate
 *               labels, paragraph-length labels and drifted restatements are rejected LOUDLY.
 *   emit      → pending `kpred:has-option` proposals for human review. Settles nothing, writes
 *               no TTL, and confirms nothing on its own.
 *
 * WHY THE AGENT TIER AND NOT A SCRIPT. A regex can find "or" in a sentence; it cannot tell that
 * "QUDT for units, or a units predicate, or refuse mixed currencies" is three alternatives while
 * "quieter and shorter" is one. Splitting prose into the courses of action it already contains is
 * judgment over language. The safety does not come from the prompt — it comes from the validator.
 *
 * THE REJECTION RATE IS THE MEASUREMENT, NOT A FOOTNOTE (F74.3: offloading is not free). A run
 * that proposes 40 options and keeps 6 has moved cost to triage rather than removing it, and this
 * prints exactly that so the decision to keep running it can be made on evidence.
 *
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/distill-decisions.ts --limit=5
 *   … --graph=static/reckons-roadmap.ttl --model=qwen3-coder:latest --dry --pending
 */
import { readFileSync, appendFileSync } from 'fs';
import { readGraph } from './read-graph.js';
import { buildReviewTree, distillationRequest, validateProposedOptions, questionText } from '../../src/lib/rdf/review-tree.js';
import type { DistillationRequest, ProposedOptions } from '../../src/lib/rdf/review-tree.js';
import { readTextOr } from '../lib/read-file.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', R = '\x1b[31m', X = '\x1b[0m';

const OLLAMA = process.env.OLLAMA_BASE_URL ?? process.env.VITE_OLLAMA_BASE_URL ?? '';
const args = process.argv.slice(2);
const arg = (n: string, d = '') => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const GRAPH = arg('graph', 'static/reckons-roadmap.ttl');
const MODEL = arg('model', 'qwen3-coder:latest');
const LIMIT = Number(arg('limit', '8'));
const DRY = args.includes('--dry');
const PENDING_OUT = args.includes('--pending');
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

if (!OLLAMA && !DRY) {
  console.error(
    `${R}OLLAMA_BASE_URL not set${X} — this is the agent tier and it needs the local model.\n` +
      `  OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/distill-decisions.ts\n` +
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
      options: { num_ctx: 16384, temperature: 0.1 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).response ?? '';
}

/**
 * The prompt states the ONE rule the validator will actually enforce, in the model's own terms.
 * Grounding beats instruction (the PR #43 devstral lesson), so the facts are supplied verbatim
 * with their ids and the model is told the ids are the only ones that exist.
 */
function buildPrompt(req: DistillationRequest): string {
  const facts = req.facts.length
    ? req.facts.map((f) => `  ${f.id} | ${f.predicate} | ${String(f.object).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')
    : '  (none)';
  return [
    'You are splitting a written decision into the alternatives it ALREADY CONTAINS.',
    '',
    'THE ONE RULE: every option must already be on the table. If the text does not name a course',
    'of action, you must not invent one. Adding an option nobody proposed would show a person a',
    'choice their own notes never offered. Fewer, faithful options beat more, invented ones.',
    'If the text genuinely names no alternatives, return an empty options array.',
    '',
    `QUESTION (verbatim):\n${req.question}`,
    '',
    `FACTS ALREADY UNDER THIS DECISION (these ids are the only ids that exist):\n${facts}`,
    '',
    'Return JSON only:',
    '{',
    '  "options": [',
    '    { "label": "short name for the alternative, under 60 characters",',
    '      "consequence": "one line on what taking it means",',
    '      "rulesOutIds": ["ids of the facts above that would no longer hold if this option won"] }',
    '  ],',
    '  "restated": "the question in one plain line, under 140 characters"',
    '}',
    '',
    'label: taken from the wording of the question or the facts. Not a sentence, not a paragraph.',
    'rulesOutIds: only ids listed above. Use [] if none. Never invent an id.',
  ].join('\n');
}

// ── GROUND ──────────────────────────────────────────────────────────────────
const { statements, typeOf } = readGraph(GRAPH, { asReviewSet: true });
const tree = buildReviewTree(statements, statements, { typeOf, maxDecisions: 500 });
const proseOnly = tree.decisions.filter((d) => d.proseOnly);

console.log(`\n${B}Distilling prose decisions into weighable options${X} ${D}— ${GRAPH}${X}`);
console.log(`${D}${tree.decisions.length} open decision(s), ${proseOnly.length} prose-only. Taking ${Math.min(LIMIT, proseOnly.length)}.${X}`);
console.log(`${D}model ${MODEL}${DRY ? ' (DRY — no model call)' : ''}${X}\n`);

const targets = proseOnly.slice(0, LIMIT);

if (DRY) {
  for (const node of targets) {
    const req = distillationRequest(node);
    console.log(`${C}◆ ${node.label}${X}`);
    console.log(`  ${D}${questionText(node).replace(/\s+/g, ' ').slice(0, 150)}${X}`);
    console.log(`  ${D}grounded in ${req.facts.length} fact(s); prompt ${buildPrompt(req).length} chars${X}\n`);
  }
  console.log(`${D}Dry run: nothing called, nothing queued.${X}\n`);
  process.exit(0);
}

// ── PROMPT → VALIDATE, one decision at a time so a bad answer poisons only its own root ──
let proposedTotal = 0, acceptedTotal = 0, withOptions = 0, modelFailures = 0;
const emit: Array<{ subject: string; label: string; consequence?: string; question: string }> = [];
const allRejections: string[] = [];

for (const node of targets) {
  const req = distillationRequest(node);
  const q = questionText(node).replace(/\s+/g, ' ');
  console.log(`${C}◆ ${node.label}${X} ${D}— ${req.facts.length} facts${X}`);
  console.log(`  ${D}${q.slice(0, 130)}${q.length > 130 ? '…' : ''}${X}`);

  let raw: string;
  try { raw = await ollama(buildPrompt(req)); }
  catch (e) { console.log(`  ${R}model call failed:${X} ${(e as Error).message}\n`); modelFailures++; continue; }

  let parsed: ProposedOptions;
  try { parsed = JSON.parse(raw); }
  catch { console.log(`  ${R}not JSON${X} ${D}${raw.slice(0, 90)}${X}\n`); modelFailures++; continue; }

  parsed.subjectIri ??= req.subjectIri;
  const n = parsed.options?.length ?? 0;
  proposedTotal += n;
  const outcome = validateProposedOptions(parsed, req);
  acceptedTotal += outcome.options.length;
  if (outcome.options.length) withOptions++;

  if (outcome.restated) console.log(`  ${G}↳${X} ${outcome.restated}`);
  for (const o of outcome.options) {
    console.log(`    ${Y}○ ${o.label}${X}${o.consequence ? ` ${D}— ${o.consequence.slice(0, 80)}${X}` : ''}` +
      `${o.rulesOutIds.length ? ` ${D}(kills ${o.rulesOutIds.length})${X}` : ''}`);
    emit.push({ subject: node.subjectIri, label: o.label, consequence: o.consequence, question: q });
  }
  if (!outcome.options.length) console.log(`    ${D}no options survived${X}`);
  for (const r of outcome.rejected) { console.log(`    ${R}✗${X} ${D}${r}${X}`); allRejections.push(r); }
  console.log('');
}

// ── REPORT — the yield is the argument for or against running this again ────
const rate = proposedTotal ? (acceptedTotal / proposedTotal) * 100 : 0;
console.log(`${B}Yield${X}: ${acceptedTotal}/${proposedTotal} proposed options survived validation (${rate.toFixed(0)}%), ` +
  `across ${withOptions}/${targets.length} decisions.`);
if (modelFailures) console.log(`${R}${modelFailures} decision(s) got no usable answer from the model.${X}`);
console.log(`${D}A low rate is evidence against running this again — it moves cost to triage rather than removing it.${X}`);
if (allRejections.length) {
  const kinds = new Map<string, number>();
  for (const r of allRejections) {
    const kind = /nobody proposed/.test(r) ? 'invented an option'
      : /not in the request/.test(r) ? 'invented a fact id'
      : /duplicates/.test(r) ? 'duplicate label'
      : /paragraph/.test(r) ? 'label was a paragraph'
      : /drifted/.test(r) ? 'restatement drifted'
      : /not a decision/.test(r) ? 'left a single option'
      : 'other';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log(`\n${R}Rejections by kind${X}`);
  for (const [k, c] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${D}${String(c).padStart(3)} × ${k}${X}`);
}

// ── EMIT — proposals only. Nothing here is a fact until a person says so. ───
if (PENDING_OUT && emit.length) {
  const now = new Date().toISOString();
  const existing = readTextOr(PENDING, '');
  let queued = 0;
  for (const e of emit) {
    const note = `[distill/${MODEL}] option for "${e.question.slice(0, 90)}"${e.consequence ? ` — ${e.consequence}` : ''}`;
    if (existing.includes(JSON.stringify(`${e.subject}|${e.label}`).slice(1, -1))) continue;
    appendFileSync(PENDING, JSON.stringify({
      subject: e.subject,
      predicate: 'urn:kbase:predicate/has-option',
      object: e.label,
      question: note,
      note: `${e.subject}|${e.label}`,
      type: 'suggestion',
      agent: `offline:distill-decisions`,
      priority: 'normal',
      addedAt: now,
      addedByMcp: true,
    }) + '\n');
    queued++;
  }
  console.log(`\n${queued} option(s) queued → ${PENDING} ${D}(confirm in Reckons.AI; nothing is a fact until you say so)${X}`);
}
console.log('');
