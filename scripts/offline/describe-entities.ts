#!/usr/bin/env npx tsx
/**
 * Describe entities (F74.3, AGENT tier) — local model drafts missing descriptions.
 *
 * The script tier (graph-lint) FINDS entities with no kpred:description; that is a
 * rule. Writing the description is not a rule — it is judgment over language — so it
 * goes to a LOCAL model rather than Opus. The model never runs free: this harness
 * grounds it first, constrains it, validates the output, and emits a PROPOSAL.
 *
 *   ground    → the entity's own triples (its subgraph) + the head of every file it
 *               links via kpred:has-file / kpred:tested-by. The graph IS the context.
 *   prompt    → draft one description, from the grounding only
 *   validate  → reject empty / too-short / hedging / invented-file answers
 *   emit      → a pending SUGGESTION in knowledge.pending.jsonl, gated in the Review
 *               tab. It never edits a TTL — a bad draft costs a click, not a commit.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/describe-entities.ts \
 *     [--model=qwen3-coder:latest] [--limit=10] [--entity=kb:foo] [--dry-run]
 */
import { readFileSync, existsSync, appendFileSync, readdirSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const DRY = raw.includes('--dry-run');
const OLLAMA = process.env.OLLAMA_BASE_URL ?? process.env.VITE_OLLAMA_BASE_URL ?? '';
const MODEL = flag('model') ?? process.env.DESCRIBE_MODEL ?? 'qwen3-coder:latest';
const LIMIT = Number(flag('limit') ?? 10);
const ONLY = flag('entity');
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

const KB = 'urn:kbase:concept/';
const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const FEATURE = 'urn:kbase:type/Feature';
const PATH_PREDS = [KPRED + 'has-file', KPRED + 'tested-by'];
/** Enough of a file to infer intent; the local model's context is the scarce resource. */
const FILE_HEAD_LINES = 40;
const MIN_WORDS = 12;

if (!OLLAMA && !DRY) {
  console.error('OLLAMA_BASE_URL not set — this is the agent tier; it needs the local model.');
  console.error('Run with --dry-run to see which entities would be drafted.');
  process.exit(1);
}

const short = (iri: string) => (iri.startsWith(KB) ? `kb:${iri.slice(KB.length)}` : iri);
const expand = (s: string) => (s.startsWith('kb:') ? KB + s.slice(3) : s);

// ── Load the corpus (static/ is the source of truth; workspace kbs are copies).
const files = readdirSync('static').filter((f) => f.endsWith('.ttl')).sort().map((f) => path.join('static', f));
const quads: { q: Quad; file: string }[] = [];
for (const file of files) {
  try {
    for (const q of new Parser().parse(readFileSync(file, 'utf8'))) quads.push({ q, file });
  } catch {
    /* graph-lint reports parse errors; this job just skips the file. */
  }
}

const objects = (subject: string, pred: string) =>
  quads.filter(({ q }) => q.subject.value === subject && q.predicate.value === pred).map(({ q }) => q.object.value);

// ── Targets: features with no description. Exactly what graph-lint flags as `incomplete`.
const featureSubjects = [
  ...new Set(
    quads
      .filter(({ q }) => q.predicate.value === RDF_TYPE && q.object.value === FEATURE)
      .map(({ q }) => q.subject.value),
  ),
];
let targets = featureSubjects.filter((s) => objects(s, KPRED + 'description').length === 0);
if (ONLY) targets = targets.filter((s) => s === expand(ONLY));
targets = targets.slice(0, LIMIT);

if (targets.length === 0) {
  console.log('No features are missing a description. Nothing to draft.');
  process.exit(0);
}

/** The grounding: everything the graph already knows, plus the code it points at. */
function groundingFor(subject: string): string {
  const own = quads.filter(({ q }) => q.subject.value === subject);
  const triples = own
    .map(({ q }) => `  ${short(q.predicate.value).replace(KPRED, 'kpred:')} → ${short(q.object.value)}`)
    .join('\n');

  const linked = PATH_PREDS.flatMap((p) => objects(subject, p))
    .filter((f) => f && !f.startsWith('http') && existsSync(f))
    .slice(0, 4)
    .map((f) => {
      const head = readFileSync(f, 'utf8').split('\n').slice(0, FILE_HEAD_LINES).join('\n');
      return `--- ${f} (first ${FILE_HEAD_LINES} lines) ---\n${head}`;
    })
    .join('\n\n');

  return `Existing triples for ${short(subject)}:\n${triples}` + (linked ? `\n\nLinked source files:\n\n${linked}` : '');
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

const NOW = new Date().toISOString();
// Idempotence must key on the ENTITY, not on the draft text — otherwise a re-run
// (new model, tweaked prompt) queues a second competing proposal for the same entity.
const alreadyQueued = new Set(
  (existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const d = JSON.parse(l) as { subject?: string; predicate?: string; agent?: string };
        return d.agent?.startsWith('offline:describe-entities') && d.predicate === KPRED + 'description'
          ? [d.subject ?? '']
          : [];
      } catch {
        return [];
      }
    }),
);
let drafted = 0, rejected = 0, failed = 0, skipped = 0;

console.log(`Describe entities — ${targets.length} feature(s) missing a description · ${DRY ? 'dry-run' : MODEL}\n`);

for (const subject of targets) {
  const label = objects(subject, RDFS_LABEL)[0] ?? short(subject);
  process.stdout.write(`  ${short(subject)} … `);
  if (!DRY && alreadyQueued.has(subject)) {
    skipped++;
    console.log('already queued — awaiting review');
    continue;
  }
  const grounding = groundingFor(subject);

  if (DRY) {
    console.log(`would draft (${grounding.length} chars of grounding)`);
    continue;
  }

  const prompt =
    `You are documenting a feature in a knowledge graph for the app Reckons.AI (a local-first ` +
    `personal knowledge base: SvelteKit + TypeScript + Dexie/IndexedDB, RDF triples).\n\n` +
    `Write ONE kpred:description for the feature "${label}".\n\n` +
    `RULES:\n` +
    `- 2-4 sentences, plain prose, present tense. No markdown, no bullets, no preamble.\n` +
    `- Say what the feature IS and what it DOES, concretely.\n` +
    `- Do NOT open with "<name> is a feature that…" — start with the substance.\n` +
    `- Use ONLY the grounding below. Do not invent file names, APIs, or capabilities.\n` +
    `- If the grounding is too thin to describe it, reply with exactly: INSUFFICIENT\n\n` +
    `GROUNDING\n=========\n${grounding}\n\n` +
    `Now write the description for "${label}" and nothing else:`;

  try {
    const out = await ollama(prompt);
    if (/^\s*insufficient\b/i.test(out)) {
      rejected++;
      console.log('model says grounding is insufficient — left for a human');
      continue;
    }
    const problem = validateProblem(out, subject);
    if (problem) {
      rejected++;
      console.log(`REJECTED (${problem})`);
      continue;
    }
    const text = clean(out);
    const question =
      `[local draft] ${short(subject)} has no kpred:description. Proposed: "${text}" — accept, edit, or reject.`;
    appendFileSync(PENDING, JSON.stringify({
      subject,
      predicate: KPRED + 'description',
      object: text,
      note: `Drafted offline by ${MODEL} from ${short(subject)}'s own triples + linked source files. PROPOSAL — verify before accepting.`,
      question,
      type: 'suggestion',
      agent: `offline:describe-entities (${MODEL})`,
      priority: 'medium',
      addedAt: NOW,
      addedByMcp: true,
    }) + '\n');
    alreadyQueued.add(subject);
    drafted++;
    console.log(`drafted → queued (${text.split(/\s+/).length} words)`);
  } catch (e) {
    failed++;
    console.log(`FAILED (${e instanceof Error ? e.message : e})`);
  }
}

if (DRY) process.exit(0);

console.log(
  `\n${drafted} draft(s) queued → ${PENDING}; ${rejected} rejected by validation; ${skipped} already awaiting review.`,
);
if (failed > 0) console.log(`⚠ ${failed} entity(ies) FAILED — check Ollama/${MODEL}, or describe those by hand.`);
console.log('Drafts are PROPOSALS: accept/edit/reject in the Reckons.AI Review tab. No TTL was changed.');
process.exit(failed > 0 && drafted === 0 ? 1 : 0);

// ── validation helpers (declared last; hoisted) ────────────────────────────────
function clean(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?|```$/g, '')
    .replace(/^(description|answer)\s*:\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

/** Returns a reason string when the draft is unusable, or null when it passes. */
function validateProblem(textRaw: string, _subject: string): string | null {
  const t = clean(textRaw);
  if (!t) return 'empty response';
  if (t.split(/\s+/).length < MIN_WORDS) return `too short (<${MIN_WORDS} words)`;
  if (/^(i (cannot|can't|don't|am unable)|as an ai|sorry\b|there (is|are) (no|not enough))/i.test(t))
    return 'model declined / hedged';
  if (/\b(TODO|TBD|placeholder|lorem ipsum)\b/i.test(t)) return 'placeholder text';
  // The most damaging failure mode: inventing a file that does not exist.
  for (const m of t.match(/\b[\w./-]+\.(ts|svelte|js|json|ttl|sh)\b/g) ?? []) {
    if (!m.includes('*') && !existsSync(m)) return `cites a file that does not exist: ${m}`;
  }
  if (t.includes('urn:kabase:')) return 'namespace typo (urn:kabase:)';
  return null;
}
