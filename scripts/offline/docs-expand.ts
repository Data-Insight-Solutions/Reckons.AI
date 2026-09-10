#!/usr/bin/env npx tsx
/**
 * Expand thin docs entities (F74.3, AGENT tier) — a local model drafts the missing prose.
 *
 * WHAT THIS IS NOT. It is not doc GENERATION. `scripts/docs-pages.ts` renders TTL into
 * `content/**.md` and must stay deterministic forever: `md-align` asserts every committed file is
 * byte-identical to what the generator would re-emit, so a model anywhere in the renderer would
 * make CI fail on a diff nobody wrote. The rendering is a rule, and rules belong in the script
 * tier. What is NOT a rule is having something worth saying — and that is what this drafts.
 *
 * WHY IT EXISTS. Measured 2026-09-06: 138 of 316 generated pages carried under 40 words of prose.
 * Folding thin entities into their parents fixed most of that structurally (316 pages -> 172), but
 * ~32 remain genuinely thin: a real subject with one sentence about it. No amount of layout fixes
 * a page that has nothing on it. That is an authoring gap, and authoring is judgment over
 * language — agent tier, local model, human-gated.
 *
 *   ground    → the entity's own triples, its parent, and its siblings' definitions, so the draft
 *               sits in the same register as the pages around it. The graph IS the context.
 *   prompt    → one paragraph, in the house voice, from the grounding only
 *   validate  → reject empty, too short, hedging, invented IRIs, or a restatement of the label
 *   emit      → a pending SUGGESTION in knowledge.pending.jsonl, gated in the Review tab.
 *               It NEVER edits a TTL. A bad draft costs a click, not a commit.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/docs-expand.ts \
 *     [--model=qwen3:32b] [--limit=10] [--entity=<iri>] [--min-words=45] [--dry-run]
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';
import { transactPendingQueue } from './pending-queue.js';
import { readTextOr } from '../lib/read-file.js';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const DRY = raw.includes('--dry-run');
const OLLAMA = process.env.OLLAMA_BASE_URL ?? process.env.VITE_OLLAMA_BASE_URL ?? '';
const MODEL = flag('model') ?? process.env.DOCS_EXPAND_MODEL ?? 'qwen3:32b';
const LIMIT = Number(flag('limit') ?? 10);
const ONLY = flag('entity');
/** Mirrors PAGE_THRESHOLD_WORDS in docs-pages.ts — below this, an entity is not a page. */
const MIN_WORDS = Number(flag('min-words') ?? 45);
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const DESCRIPTION = `${KPRED}description`;

/** The graphs docs-pages.ts publishes from. Anything else is not a docs page. */
const DOCS_GRAPHS = [
  'docs-triples-rdf.ttl', 'docs-llm.ttl', 'docs-use-cases.ttl', 'docs-features.ttl',
  'docs-tips.ttl', 'docs-timeline-ecosystem.ttl', 'docs-integrations-tech.ttl',
  'docs-architecture.ttl', 'docs-coding-workflow.ttl', 'docs-testing.ttl',
  'docs-user-paths.ttl', 'starter-guide.ttl',
];

// ── Load the docs corpus ─────────────────────────────────────────────────────

const quads: Array<{ q: Quad; file: string }> = [];
const present = new Set(readdirSync('static').filter((f) => f.endsWith('.ttl')));
for (const name of DOCS_GRAPHS) {
  if (!present.has(name)) continue;
  const file = path.join('static', name);
  try {
    for (const q of new Parser().parse(readFileSync(file, 'utf8'))) quads.push({ q, file });
  } catch (e) {
    // A graph that does not parse is graph-lint's job to report with a useful message; crashing
    // here would hide that behind a stack trace from a job nobody was debugging.
    console.warn(`  skipped ${file}: ${e instanceof Error ? e.message : e}`);
  }
}

const objects = (s: string, p: string): string[] =>
  quads.filter(({ q }) => q.subject.value === s && q.predicate.value === p).map(({ q }) => q.object.value);

const labelOf = (s: string) => objects(s, RDFS_LABEL)[0] ?? s.split(/[/#]/).pop() ?? s;

/** Literal predicates that carry prose a reader reads. Mirrors docs-pages.ts's content bands. */
const PROSE_PREDICATES = new Set([
  SKOS_DEFINITION, DESCRIPTION,
  ...['read-first', 'summary', 'decided', 'principle', 'constraint', 'tenet', 'honest-note',
    'note', 'measured', 'evidence', 'proof', 'example', 'known-issue', 'open-question',
    'remaining', 'done', 'audience', 'starts-with', 'ends-with'].map((p) => KPRED + p),
]);

/** How many words a reader would actually read on this entity's page. */
function proseWeight(subject: string): number {
  return quads
    .filter(({ q }) => q.subject.value === subject
      && q.object.termType === 'Literal'
      && PROSE_PREDICATES.has(q.predicate.value))
    .reduce((n, { q }) => n + q.object.value.split(/\s+/).length, 0);
}

// Subjects that are docs entities at all: they must carry a label, or they are not a page.
const subjects = [...new Set(quads
  .filter(({ q }) => q.predicate.value === RDFS_LABEL)
  .map(({ q }) => q.subject.value))];

let targets = subjects.filter((s) => proseWeight(s) < MIN_WORDS);
if (ONLY) targets = targets.filter((s) => s === ONLY || s.endsWith(ONLY));

// ── Grounding ────────────────────────────────────────────────────────────────

/**
 * Everything the graph already knows about this entity, plus its neighbourhood.
 *
 * The siblings matter as much as the entity: a draft that is factually fine but written in a
 * different register than the pages around it still reads as an intruder, and the fastest way to
 * teach a local model the house voice is to show it the neighbours rather than describe the style.
 */
function groundingFor(subject: string): string {
  const own = quads
    .filter(({ q }) => q.subject.value === subject)
    .map(({ q }) => `  ${q.predicate.value.replace(KPRED, 'kpred:')} → ${q.object.value}`)
    .join('\n');

  const parent = objects(subject, SKOS_BROADER)[0];
  const parentBlock = parent
    ? `\nIt sits under: ${labelOf(parent)}\n  ${objects(parent, SKOS_DEFINITION)[0] ?? ''}`
    : '';

  const siblings = parent
    ? quads
      .filter(({ q }) => q.predicate.value === SKOS_BROADER && q.object.value === parent)
      .map(({ q }) => q.subject.value)
      .filter((s) => s !== subject)
      .slice(0, 3)
      .map((s) => `  - ${labelOf(s)}: ${objects(s, SKOS_DEFINITION)[0] ?? '(no definition)'}`)
      .join('\n')
    : '';

  return `Entity: ${labelOf(subject)} <${subject}>\n\nWhat the graph already says:\n${own}`
    + parentBlock
    + (siblings ? `\n\nNeighbouring pages, for voice and register:\n${siblings}` : '');
}

function promptFor(subject: string): string {
  return `You are drafting one paragraph for a documentation page in an existing knowledge graph.

${groundingFor(subject)}

Write ONE paragraph (3-5 sentences) describing "${labelOf(subject)}" for a reader who has not seen it before.

Rules, all of them hard:
- Use ONLY what the grounding above states. Invent no file paths, no IRIs, no numbers, no feature names.
- Do not restate the label as a sentence ("X is X").
- Say what it IS and why it matters. Concrete over abstract.
- No hedging ("might", "could be", "aims to", "is designed to"), no marketing, no first person.
- Plain prose. No markdown, no bullet points, no heading, no preamble, no quotes around the answer.

Output the paragraph and nothing else.`;
}

// ── Validation — what the model must clear before a human is asked to look ────

const HEDGE = /\b(?:might|could be|aims to|is designed to|seeks to|strives|perhaps|possibly|arguably)\b/i;

function rejectReason(text: string, subject: string): string | null {
  const t = text.trim();
  if (!t) return 'empty';
  if (t.split(/\s+/).length < 25) return `too short (${t.split(/\s+/).length} words)`;
  if (t.split(/\s+/).length > 220) return `too long (${t.split(/\s+/).length} words)`;
  if (HEDGE.test(t)) return `hedging: "${t.match(HEDGE)![0]}"`;
  if (/^```|^#|^\s*[-*]\s/m.test(t)) return 'markdown formatting';
  // INLINE emphasis too. The first run produced "*urn:reckons:guide/WhatIsReckonsAI*" and passed,
  // because the check only looked at line starts. The TTL literal is plain prose — asterisks in it
  // survive into the page and render as italics nobody asked for.
  if (/\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`/.test(t)) return 'inline markdown';
  // An invented IRI or path is the failure mode that makes a local draft dangerous rather than
  // merely weak: it reads as a fact and points at nothing.
  const invented = t.match(/\b(?:src|scripts|tests|static|content)\/[\w./-]+/g)?.filter(
    (p) => !quads.some(({ q }) => q.object.termType === 'Literal' && q.object.value.includes(p)),
  );
  if (invented?.length) return `invented path: ${invented[0]}`;
  // A bare project IRI in prose is a leak. An IRI used as an EXAMPLE is not — on a page explaining
  // what an identifier is, showing one is the whole point — so this rejects only our own concept
  // namespace, which a reader has no use for, and leaves illustrative IRIs to the reviewer.
  if (/urn:kbase:concept\/|\bkb:[a-z]/.test(t)) return 'leaked a project IRI into prose';
  const label = labelOf(subject).toLowerCase();
  if (t.toLowerCase().startsWith(`${label} is ${label}`)) return 'restates the label';
  return null;
}

async function ollama(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA.replace(/\/+$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { num_ctx: 16384, temperature: 0.2 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
  return ((await res.json()) as { response?: string }).response?.trim() ?? '';
}

/** Strip a chain-of-thought block some reasoning models emit before the answer. */
const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

// ── Run ──────────────────────────────────────────────────────────────────────

// Idempotence keys on the ENTITY, not the draft text: a re-run with a new model or a tweaked
// prompt must not queue a second competing proposal for the same page.
const alreadyQueued = new Set(
  readTextOr(PENDING, '').split('\n').filter(Boolean).flatMap((l) => {
    try {
      const d = JSON.parse(l) as { subject?: string; predicate?: string; agent?: string };
      return d.agent?.startsWith('offline:docs-expand') && d.predicate === DESCRIPTION
        ? [d.subject ?? ''] : [];
    } catch { return []; }
  }),
);

async function main(): Promise<void> {
  if (!OLLAMA) {
    console.error('OLLAMA_BASE_URL is not set — this is an AGENT-tier job and needs a local model.');
    console.error('  OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/docs-expand.ts');
    process.exit(2);
  }
  const queue = targets.filter((s) => !alreadyQueued.has(s)).slice(0, LIMIT);
  console.log(
    `Docs expand — ${targets.length} thin entit(y/ies) under ${MIN_WORDS} words, `
    + `${alreadyQueued.size} already queued, drafting ${queue.length} · ${DRY ? 'dry-run' : MODEL}\n`,
  );
  if (!queue.length) return;

  const rows: string[] = [];
  let drafted = 0, rejected = 0, failed = 0;
  for (const subject of queue) {
    const name = labelOf(subject);
    try {
      const text = stripThinking(await ollama(promptFor(subject)));
      const bad = rejectReason(text, subject);
      if (bad) { rejected++; console.log(`  ✗ ${name} — rejected: ${bad}`); continue; }
      drafted++;
      console.log(`  ✓ ${name} — ${text.split(/\s+/).length} words`);
      rows.push(JSON.stringify({
        subject, predicate: DESCRIPTION, object: text, objectKind: 'literal',
        type: 'suggestion', agent: `offline:docs-expand:${MODEL}`, priority: 'low',
        addedAt: new Date().toISOString(),
        note: `Drafted from the graph because this page carries only ${proseWeight(subject)} words `
          + `of prose (threshold ${MIN_WORDS}). A LOCAL model wrote it; nothing has verified it is `
          + `true. Read it against the entity's own triples before confirming.`,
      }));
    } catch (e) {
      failed++;
      console.log(`  ! ${name} — ${e instanceof Error ? e.message : e}`);
    }
  }

  if (rows.length && !DRY) {
    // transactPendingQueue takes a function returning { content, result } and is SYNCHRONOUS.
    // Handing it an array returns undefined `content`, so it writes nothing and reports success —
    // which is exactly what happened on the first run of this job: "Queued 4 proposal(s)" with an
    // unchanged file. The count below is re-read from the queue rather than assumed.
    const before = readTextOr(PENDING, '').split('\n').filter(Boolean).length;
    transactPendingQueue(PENDING, (current) => {
      const separator = current && !current.endsWith('\n') ? '\n' : '';
      return { content: current + separator + rows.join('\n') + '\n', result: true };
    });
    const after = readTextOr(PENDING, '').split('\n').filter(Boolean).length;
    if (after - before !== rows.length) {
      throw new Error(`queue write did not land: expected +${rows.length} rows, saw +${after - before}`);
    }
    console.log(`\nQueued ${after - before} proposal(s) -> ${PENDING} (verified on disk; nothing written to a TTL).`);
  } else if (DRY) {
    console.log('\nDry run — nothing queued.');
  }
  console.log(`\n${drafted} drafted · ${rejected} rejected · ${failed} failed`);
}

// Guarded so importing this in a test does not fire a model (the bug that bit extraction-chain).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => { console.error('docs-expand failed:', e); process.exit(1); });
}

export { proseWeight, rejectReason, promptFor, DOCS_GRAPHS, MIN_WORDS };
