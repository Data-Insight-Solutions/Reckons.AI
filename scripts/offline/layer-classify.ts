#!/usr/bin/env npx tsx
/**
 * PROPOSE A LAYER FOR EACH PREDICATE (F194) — agent tier. Proposals only; writes no TTL.
 *
 * The bulk job behind the claim / provenance / question split. 355 predicates carry 9,634 uses in
 * this repository and none of them is classified; naming the layer of each is judgment over
 * language, cheap to be wrong because a human gates it, and exactly what kb:work-tiering says to
 * hand a local model.
 *
 * WHY A MODEL AT ALL, when layer-risk.ts already flags names. Because names lie in both directions.
 * `has-file` is provenance and `has-status` is a claim about a feature, and no stem list separates
 * them — the discriminator is what the relation is ABOUT, which needs reading the values. So the
 * script tier does the arithmetic and the ordering, and the model reads.
 *
 * THE HARNESS, per kb:work-tiering — ground, prompt, validate, emit-proposal:
 *
 *   ground    the predicate's real usage: how often, in how many graphs, whether objects are IRIs
 *             or literals, and actual sample values. Plus the three layer definitions read FROM
 *             the vocabulary, so this cannot drift from what the graph says they mean.
 *   prompt    one question, one of three answers, a reason under 20 words.
 *   validate  three rules, all deterministic and all biased the same way — see below.
 *   emit      one proposal per predicate, carrying its BLAST RADIUS so the reviewer sees the cost
 *             of accepting before they accept it.
 *
 * VALIDATION FAILS TOWARD `claim`, ALWAYS. Matt decided provenance auto-confirms, which makes this
 * a trust boundary rather than a taxonomy: a predicate wrongly filed provenance writes into the
 * confirmed graph with no review. So an unparseable answer, an unknown layer, or a provenance
 * verdict over prose-shaped values all resolve to `claim`. Being wrong toward `claim` costs a
 * reviewer one card. Being wrong toward `provenance` costs the review itself.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/layer-classify.ts \
 *     [--limit=50] [--model=qwen3:32b] [--dry-run] [--min-uses=1]
 */

import { Parser, type Quad } from 'n3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { transactPendingQueue } from './pending-queue.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STATIC_DIR = join(ROOT, 'static');
const PENDING = join(ROOT, 'reckons-workspace', 'knowledge.pending.jsonl');

const argv = process.argv.slice(2);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const DRY = argv.includes('--dry-run');
const LIMIT = Number.parseInt(flag('limit') ?? '40', 10);
const MIN_USES = Number.parseInt(flag('min-uses') ?? '1', 10);
// qwen3:32b by default: the 2026-09-09 roster benchmark measured ZERO invented facts across 20
// runs, and invention is the failure that matters most when the output becomes a trust boundary.
const MODEL = flag('model') ?? 'qwen3:32b';
const OLLAMA = process.env.OLLAMA_BASE_URL ?? '';

const KPRED = 'urn:kbase:predicate/';
const LAYER = `${KPRED}layer`;
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface Pred {
  iri: string; local: string; uses: number; graphs: number;
  iriObjects: number; literalObjects: number; samples: string[]; subjects: string[];
}

function corpus(): { preds: Pred[]; defs: Map<string, string>; assigned: Set<string> } {
  const stats = new Map<string, Pred & { g: Set<string> }>();
  const defs = new Map<string, string>();
  const assigned = new Set<string>();

  for (const f of readdirSync(STATIC_DIR).filter((n) => n.endsWith('.ttl'))) {
    if (f === 'docs-all.ttl') continue;          // a concatenation; it would double every count
    let quads: Quad[];
    try { quads = new Parser().parse(readFileSync(join(STATIC_DIR, f), 'utf8')); } catch { continue; }
    for (const q of quads) {
      // The three layer definitions, read from the vocabulary so this prompt cannot drift from it.
      if (q.predicate.value === `${SKOS}definition` && q.subject.value.startsWith('urn:kbase:type/layer/')) {
        defs.set(q.subject.value.split('/').pop()!, q.object.value);
      }
      if (q.predicate.value === LAYER) assigned.add(q.subject.value);

      const p = q.predicate.value;
      if (!p.startsWith(KPRED) || p === LAYER) continue;
      const st = stats.get(p) ?? {
        iri: p, local: p.slice(KPRED.length), uses: 0, graphs: 0,
        iriObjects: 0, literalObjects: 0, samples: [], subjects: [], g: new Set<string>(),
      };
      st.uses++;
      st.g.add(f);
      if (q.object.termType === 'NamedNode') st.iriObjects++; else st.literalObjects++;
      if (st.samples.length < 3) st.samples.push(q.object.value.replace(/\s+/g, ' ').slice(0, 160));
      if (st.subjects.length < 2) st.subjects.push(q.subject.value.split(/[/#]/).pop() ?? '');
      stats.set(p, st);
    }
  }
  const preds = [...stats.values()].map((s) => ({ ...s, graphs: s.g.size }));
  return { preds, defs, assigned };
}

async function ollama(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA.replace(/\/+$/, '')}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // think:false — a hybrid-thinking model spends its budget reasoning and returns nothing.
    // Measured 2026-09-08 when the VLM gate scored a competent model at 0%.
    body: JSON.stringify({
      model: MODEL, prompt, stream: false, think: false,
      options: { num_ctx: 8192, temperature: 0, num_predict: 120 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
  return ((await res.json()) as { response?: string }).response?.trim() ?? '';
}

const PROMPT = (p: Pred, defs: Map<string, string>) => `You are sorting the predicates of a knowledge graph into exactly three layers.

CLAIM: ${defs.get('claim') ?? 'A statement about the world, settled by a person.'}
PROVENANCE: ${defs.get('provenance') ?? 'Where a claim came from: source, file, run, commit. Settled by the machine.'}
QUESTION: ${defs.get('question') ?? 'A relation deliberately left open, to be answered rather than confirmed.'}

The test is what the relation is ABOUT. "Aprimo is-a DAM vendor" is about Aprimo — a CLAIM.
"Aprimo mentioned-in report.pdf" is about the document — PROVENANCE.
A predicate holding a description, a principle, a status, a decision or an opinion is a CLAIM.
Only a predicate that leaves something open and expects an answer is a QUESTION.

THE HARD TEST, apply it before answering PROVENANCE:
If every source document were deleted, would this statement still mean anything?
  "moduleA imports moduleB" still means something -> CLAIM (a script can verify it; that does not make it provenance)
  "this fact came from report.pdf section 3" means nothing without the source -> PROVENANCE
Being checkable by a machine does NOT make a relation provenance. Provenance is only about
where a statement came from, never about the thing the statement describes.
When in doubt, answer CLAIM.

PREDICATE: ${p.local}
Used ${p.uses} time(s) across ${p.graphs} graph(s). Objects are mostly ${p.iriObjects > p.literalObjects ? 'links to other entities' : 'text values'}.
Example subjects: ${p.subjects.join(', ') || '(none)'}
Example values:
${p.samples.map((s) => `  - ${s}`).join('\n') || '  (none)'}

Answer in exactly this form and nothing else:
LAYER: <claim|provenance|question>
WHY: <one reason, under 20 words>`;

function parse(answer: string): { layer: string; why: string } | null {
  const layer = /LAYER:\s*(\w+)/i.exec(answer)?.[1]?.toLowerCase();
  const why = /WHY:\s*(.+)/i.exec(answer)?.[1]?.trim();
  if (!layer || !why) return null;
  return { layer, why };
}

/** Median length of the sample values — prose is long, an identifier is not. */
function medianLen(samples: string[]): number {
  if (samples.length === 0) return 0;
  const v = samples.map((s) => s.length).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

async function main(): Promise<void> {
  if (!OLLAMA) {
    console.error(C.red('OLLAMA_BASE_URL is not set. This is the agent tier and needs a local model.'));
    process.exit(1);
  }
  const { preds, defs, assigned } = corpus();
  if (defs.size < 3) {
    console.error(C.red(`Only ${defs.size} layer definition(s) found in static/. Expected 3 from ktype:LayerScheme.`));
    process.exit(1);
  }

  // Biggest blast radius first: the predicates whose classification matters most get looked at
  // while attention is freshest, and a run cut short has still done the consequential ones.
  const targets = preds
    .filter((p) => !assigned.has(p.iri) && p.uses >= MIN_USES)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, LIMIT);

  console.log('');
  console.log(C.bold('layer classify') + C.dim(` — ${targets.length} of ${preds.length} predicate(s) · ${MODEL}${DRY ? ' · dry-run' : ''}`));
  console.log(C.dim('  ordered by blast radius. Unparseable, unknown or prose-shaped provenance all fall back to claim.'));
  console.log('');

  const results: Array<{ p: Pred; layer: string; why: string; forced?: string }> = [];
  let failed = 0;

  for (const p of targets) {
    let answer: string;
    try { answer = await ollama(PROMPT(p, defs)); }
    catch (e) { console.log(`  ${C.red('FAILED')}  ${p.local}  ${(e as Error).message}`); failed++; continue; }

    const parsed = parse(answer);
    let layer = parsed?.layer ?? 'claim';
    let why = parsed?.why ?? 'unparseable answer';
    let forced: string | undefined;

    /*
     * THE THREE GUARDS, all pushing the same way. Each one has a reason to exist beyond tidiness:
     * every path out of an uncertain answer must land on `claim`, because that is the direction
     * where being wrong costs a review card instead of costing the review.
     */
    if (!parsed) { forced = 'the answer did not parse'; layer = 'claim'; }
    else if (!defs.has(layer)) { forced = `"${parsed.layer}" is not a layer in the scheme`; layer = 'claim'; }
    else if (layer === 'provenance' && medianLen(p.samples) > 120) {
      // Provenance values are identifiers — a path, a URL, a hash, a model name. A 120-character
      // median means the values are prose, and prose is somebody's claim however the name reads.
      forced = `provenance rejected: values are prose (median ${medianLen(p.samples)} chars)`;
      layer = 'claim';
    }

    const tag = layer === 'provenance' ? C.red('provenance') : layer === 'question' ? C.yellow('question  ') : C.dim('claim     ');
    console.log(`  ${tag} ${C.cyan(p.local.padEnd(26))} ${String(p.uses).padStart(5)} use(s)  ${C.dim(forced ? `↓ ${forced}` : why)}`);
    results.push({ p, layer, why, forced });
  }

  const counts = results.reduce<Record<string, number>>((a, r) => ({ ...a, [r.layer]: (a[r.layer] ?? 0) + 1 }), {});
  const forcedCount = results.filter((r) => r.forced).length;
  console.log('');
  console.log(`  ${results.length} classified · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} · ${forcedCount} fell back to claim · ${failed} failed`);

  const provUses = results.filter((r) => r.layer === 'provenance').reduce((n, r) => n + r.p.uses, 0);
  if (provUses > 0) {
    console.log(C.red(`  ${provUses} use(s) would stop being reviewed if every provenance verdict here were accepted.`));
  }

  if (DRY || results.length === 0) {
    console.log(C.dim('  dry run — nothing queued.'));
    return;
  }

  const lines = results.map((r) => JSON.stringify({
    subject: r.p.iri,
    predicate: LAYER,
    object: r.layer,
    note: `${r.forced ? `FELL BACK TO claim — ${r.forced}. Model said: ${r.why}` : r.why}`
      + ` · ${r.p.uses} use(s) across ${r.p.graphs} graph(s).`
      + (r.layer === 'provenance'
        ? ` ACCEPTING THIS STOPS ${r.p.uses} STATEMENT(S) BEING REVIEWED — provenance auto-confirms. Check the sample values before accepting.`
        : ''),
    type: 'suggestion',
    agent: `offline:layer-classify (${MODEL})`,
    // A provenance verdict is the one that removes a human from the loop. It is not a routine
    // suggestion and should not queue as one.
    priority: r.layer === 'provenance' ? 'high' : 'low',
  }));

  transactPendingQueue(PENDING, (current) => ({
    content: current + (current.endsWith('\n') || current === '' ? '' : '\n') + lines.join('\n') + '\n',
    result: undefined,
  }));
  console.log(C.green(`  queued ${lines.length} proposal(s) → reckons-workspace/knowledge.pending.jsonl`));
  console.log(C.dim('  Proposals only. No TTL was written and no predicate is classified until a human accepts.'));
}

if (process.argv[1] && process.argv[1].endsWith('layer-classify.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
