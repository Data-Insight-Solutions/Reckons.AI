/**
 * SETTLE A QUESTION FROM THE GRAPH BEFORE ASKING MATT (kb:question-presettle).
 *
 * Matt, 2026-10-28: "a question with no proposed answer is answered inline, and an agent should
 * first try to settle it from existing decisions in the graph, citing them, before asking him."
 *
 * An open question in the review queue (subject and predicate, no object) cannot be accepted, only
 * rejected or deferred. This job proposes an ANSWER for it, in two stages, cheapest first:
 *
 *   site   (script, zero tokens)  the question names a file, or a file and line, that is gone: the
 *          file was deleted, or the word asked about no longer appears in it at all. A site whose
 *          word merely moved to another line is NOT moot and is left alone.
 *   graph  (agent, local model)   the model sees the question and the graph's kpred:decided
 *          statements BM25 ranks closest to it, numbered, and may answer only by citing them and
 *          copying the words that decide it. An answer citing nothing, a number it was not given, or
 *          a quote that is not in a cited decision is refused (script check); then a second call sees
 *          only the question and the quote and must agree the quote decides it. The emitted row
 *          quotes every cited decision verbatim, so a reviewer checks the citation, not the model.
 *
 * Each answer is one queue row carrying `answers: <decision id>`, which groupDecisions folds into
 * the question's own decision as a claim (mcp-server/src/review-session.ts): accepting it settles
 * the question in one act, and the queue gains no decisions. The job writes proposals only, never
 * knowledge.decisions.jsonl, and never answers a question that already has a claim.
 *
 *   npx tsx scripts/agent/presettle.ts [--stage=site|graph|all] [--limit=N] [--dry-run] [--model=qwen3.8:latest]
 *                                      [--workspace=<dir holding knowledge.pending.jsonl>] [--ref=HEAD] [--verifier=mistral-small3.2:24b]
 *                                      [--only=<decision id>,…]  re-run named decisions, e.g. after an Opus read of a dry run
 *
 * WEAKNESS: the graph stage is only as good as BM25 recall over the decided statements; a decision
 * worded differently from the question is never offered, and the question then waits for Matt.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import { groupDecisions, readJsonl, settledIds, type Decision } from '../../mcp-server/src/review-session.js';
import { appendPendingLines } from '../../mcp-server/src/pending-file.js';
import { bm25Search } from '../../mcp-server/src/search.js';
import type { Triple } from '../../mcp-server/src/kb-reader.js';
import type { PendingRow } from '../../mcp-server/src/review-links.js';
import { DEFAULT_REASONING_MODEL, assertOk, localOptions, retryTransient } from '../offline/lib/local-model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DECIDED = 'urn:kbase:predicate/decided';
const OLLAMA = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const MAX_CANDIDATES = 8;
/**
 * The verifier is a DIFFERENT model from the answerer, so their errors are less correlated. Calibrated
 * 2026-10-28 on two known cases (a CodeQL quote that decides its question, a capture quote that is on
 * the topic but does not): qwen3.8, gemma3:27b and phi4:14b all passed the off-topic quote; only
 * mistral-small3.2:24b refused it, and all four passed the true one. Two cases, one run: a choice,
 * not a measurement.
 */
export const DEFAULT_VERIFIER = 'mistral-small3.2:24b';
export const MAX_ANSWER = 400;

// ── site stage (script) ─────────────────────────────────────────────────────────────────────────

/** A repository path, optionally with a line, as questions write them: `src/x.ts:12`. */
const SITE = /\b((?:src|scripts|static|tests|cli|mcp-server|content|extension|docs)\/[\w@.+-]+(?:\/[\w@.+-]+)*\.[a-z0-9]+)(?::(\d+))?/i;
/** The word a term-senses question asks about: `Which meaning of "node" is used at …`. */
const ASKED_WORD = /meaning of "([^"]+)"/i;

export type SiteFinding = { answer: string; evidence: string };

/** What the site stage may ask of the repository: the file now, and dev's history of it. */
export type SiteProbe = {
  read: (path: string) => string | null;
  /** `<sha> <date>` of the commit on dev that deleted the path, or null if dev never deleted it. */
  deletedIn: (path: string) => string | null;
  /** `<sha> <date>` of the commit on dev that removed the word's last use from the path, or null. */
  wordRemovedIn: (path: string, word: string) => string | null;
};

/**
 * Is the site this question is about gone? Conservative by construction. ABSENT IS NOT GONE: a file
 * or a word can be missing from dev because it lives on a branch that has not merged yet (the first
 * dry run, 2026-10-28, called six #537 files "no longer exists"). So a site is moot only when dev's
 * own history removed it, and the answer names that commit. Lines shift with every edit, so a word
 * still in the file anywhere says the site MOVED, not that the question is moot.
 */
export function siteCheck(question: string, probe: SiteProbe, today: string): SiteFinding | null {
  const m = question.match(SITE);
  if (!m) return null;
  const [, path, line] = m;
  const evidence = `checked ${today} against dev's history`;
  const text = probe.read(path);
  if (text === null) {
    const commit = probe.deletedIn(path);
    return commit ? { answer: `no longer applies: ${path} was deleted (${commit})`, evidence } : null;
  }
  const word = question.match(ASKED_WORD)?.[1];
  if (word && !new RegExp(`\\b${escapeRegExp(word)}`, 'i').test(text)) {
    const commit = probe.wordRemovedIn(path, word);
    return commit
      ? { answer: `no longer applies: "${word}" was removed from ${path} (${commit})`, evidence: `${evidence}${line ? `; asked at line ${line}` : ''}` }
      : null;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The real probe: the working tree for the file, `git log` on `ref` for its history. */
export function gitProbe(root: string, ref: string): SiteProbe {
  const git = (args: string[]) => {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
  };
  const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
  return {
    read,
    deletedIn: (p) => git(['log', ref, '--diff-filter=D', '-1', '--format=%h %as', '--', p]) || null,
    // -S lists commits that changed how many times the word occurs; the newest is the one that left
    // it at zero, since the file holds none now. None means dev never had the word there.
    wordRemovedIn: (p, w) => git(['log', ref, '-1', '--format=%h %as', `-S${w}`, '--', p]) || null,
  };
}

// ── graph stage (agent) ─────────────────────────────────────────────────────────────────────────

export type Candidate = { subject: string; text: string };
export type ModelAnswer = { settled: boolean; answer?: string; cites?: number[]; quote?: string };
export const MIN_QUOTE = 20;

/** The graph's decisions, as triples bm25Search can rank. */
export function decidedTriples(ttlFiles: { path: string; text: string }[]): Triple[] {
  const out: Triple[] = [];
  for (const f of ttlFiles) {
    let quads;
    try { quads = new Parser().parse(f.text); } catch { continue; }
    for (const q of quads) {
      if (q.predicate.value === DECIDED && q.object.termType === 'Literal') {
        out.push({ subject: q.subject.value, predicate: DECIDED, object: q.object.value, objectIsLiteral: true, graph: f.path });
      }
    }
  }
  return out;
}

export function candidatesFor(d: Pick<Decision, 'question' | 'subject'>, decided: Triple[]): Candidate[] {
  return bm25Search(decided, `${d.question} ${shortName(d.subject)}`, MAX_CANDIDATES)
    .filter((r) => r.score > 0)
    .map((r) => ({ subject: r.triple.subject, text: r.triple.object }));
}

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: { settled: { type: 'boolean' }, answer: { type: 'string' }, cites: { type: 'array', items: { type: 'integer' } }, quote: { type: 'string' } },
  required: ['settled'],
};

export const SYSTEM = [
  'You settle open questions in a review queue ONLY from decisions already recorded in a knowledge graph.',
  'You are given one question and numbered decisions. Answer only if one or more of them actually decides it.',
  'Remembered facts, guesses and general advice are not allowed. If no decision settles it, return {"settled": false}.',
  `Otherwise return {"settled": true, "answer": "<the answer, under ${MAX_ANSWER} characters>", "cites": [<the numbers you relied on>], "quote": "<the exact words, copied from one cited decision, that decide this question>"}.`,
  'A decision about a related but different matter does not settle the question: return {"settled": false}.',
].join(' ');

export function promptFor(d: Pick<Decision, 'question' | 'subject' | 'predicate'>, cands: Candidate[]): string {
  return [
    `QUESTION about ${shortName(d.subject)} (${shortName(d.predicate)}):`,
    d.question,
    '',
    'DECISIONS:',
    ...cands.map((c, i) => `${i + 1}. [${shortName(c.subject)}] ${c.text}`),
  ].join('\n');
}

/**
 * Refuses any answer a reviewer could not check against the graph. Returns the reason, or null.
 * THE QUOTE IS THE CHECK THAT MATTERS. The first dry run (2026-10-28, 40 questions) settled 4, and 2
 * of the 4 cited a real decision about a DIFFERENT matter. A model must now copy the words that
 * decide the question, and they must occur in a decision it cited; the verifier (see verifyPrompt)
 * then judges the quote alone against the question.
 */
export function validateAnswer(a: ModelAnswer, given: Candidate[]): string | null {
  if (!a || typeof a.settled !== 'boolean') return 'no settled flag';
  if (!a.settled) return null;
  const answer = (a.answer ?? '').trim();
  if (!answer) return 'settled with no answer';
  if (answer.length > MAX_ANSWER) return `answer over ${MAX_ANSWER} characters`;
  const cites = a.cites ?? [];
  if (cites.length === 0) return 'cites no decision';
  if (cites.some((n) => !Number.isInteger(n) || n < 1 || n > given.length)) return `cites a decision it was not given (1-${given.length})`;
  const quote = norm(a.quote ?? '');
  if (!quote) return 'gives no quote';
  if (quote.length < MIN_QUOTE) return `quote too short (under ${MIN_QUOTE} characters)`;
  if (!cites.some((n) => norm(given[n - 1].text).includes(quote))) return 'quote is not in a decision it cited';
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The independent check: the question and the quote, nothing else, so a nearby topic cannot carry it. */
export const VERIFY_SCHEMA = { type: 'object', properties: { decides: { type: 'boolean' } }, required: ['decides'] };
export const VERIFY_SYSTEM = 'You check one thing. Given a QUESTION and a QUOTE from a recorded decision, return {"decides": true} only if the quote by itself answers this exact question. A quote about a related but different matter returns {"decides": false}.';
export function verifyPrompt(question: string, quote: string): string {
  return `QUESTION:\n${question}\n\nQUOTE:\n${quote}`;
}

// ── the emitted row ─────────────────────────────────────────────────────────────────────────────

export function answerRow(d: Pick<Decision, 'id' | 'kb' | 'subject' | 'predicate'>, answer: string, agent: string, note: string, run: string, now: string): PendingRow & { answers: string } {
  return {
    subject: d.subject, predicate: d.predicate, object: answer, type: 'suggestion',
    ...(d.kb ? { kb: d.kb } : {}), agent, note, run, addedAt: now, answers: d.id,
  } as PendingRow & { answers: string };
}

export function citationNote(cands: Candidate[], cites: number[]): string {
  return 'Settled from the graph, citing: ' + [...new Set(cites)].map((n) => `[${shortName(cands[n - 1].subject)}] kpred:decided "${cands[n - 1].text}"`).join(' | ');
}

function shortName(iri: string): string {
  return iri.replace(/^urn:kbase:concept\//, 'kb:').replace(/^urn:kbase:predicate\//, 'kpred:');
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

async function askModel<T>(model: string, system: string, prompt: string, schema: object): Promise<T> {
  return retryTransient(async () => {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model, stream: false, think: false, format: schema,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        options: localOptions({ temperature: 0, num_ctx: 8192 }),
      }),
    });
    await assertOk(res);
    const body = await res.json() as { message?: { content?: string } };
    return JSON.parse(body.message?.content ?? '{}') as T;
  });
}

/** Free a model's memory now rather than at keep-alive expiry: the job holds ONE model at a time
 *  (2026-10-28, a third resident model OOM-killed Ollama's llama-server on this 31 GB host). */
async function unload(model: string): Promise<void> {
  await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => undefined);
}

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const stage = arg('stage') ?? 'all';
  const limit = Number(arg('limit') ?? Infinity);
  const dry = process.argv.includes('--dry-run');
  const model = arg('model') ?? DEFAULT_REASONING_MODEL;
  const verifier = arg('verifier') ?? DEFAULT_VERIFIER;
  // The queue is git-ignored, so a worktree has none: --workspace names the checkout that holds it.
  const ws = resolve(arg('workspace') ?? resolve(ROOT, 'reckons-workspace'));
  const queue = join(ws, 'knowledge.pending.jsonl');
  const now = new Date().toISOString(), today = now.slice(0, 10), run = `presettle-${now}`;

  const settled = settledIds(join(ws, 'knowledge.decisions.jsonl'));
  const only = arg('only')?.split(',').filter(Boolean);
  const open = groupDecisions(readJsonl<PendingRow>(queue))
    .filter((d) => !settled.has(d.id) && d.open && d.claims.length === 0)
    .filter((d) => !only || only.includes(d.id));
  const probe = gitProbe(ROOT, arg('ref') ?? 'HEAD');
  const ttl = readdirSync(join(ROOT, 'static')).filter((f) => f.endsWith('.ttl')).map((f) => ({ path: `static/${f}`, text: readFileSync(join(ROOT, 'static', f), 'utf8') }));
  const decided = stage === 'site' ? [] : decidedTriples(ttl);

  const rows: string[] = [];
  const answered: { d: Decision; a: ModelAnswer; cands: Candidate[] }[] = [];
  const tally = { open: open.length, site: 0, graph: 0, unsettled: 0, refused: 0, unverified: 0, noCandidates: 0, failed: 0 };
  console.log(`presettle: ${open.length} open question-only decisions; ${decided.length} decided statements; model ${stage === 'site' ? '(none)' : `${model}, verifier ${verifier}`}`);
  for (const d of open.slice(0, limit)) {
    if (stage !== 'graph') {
      const s = siteCheck(d.question, probe, today);
      if (s) {
        tally.site++;
        rows.push(JSON.stringify(answerRow(d, s.answer, 'presettle:site', s.evidence, run, now)));
        console.log(`  site   ${d.id} ${s.answer}`);
        continue;
      }
    }
    if (stage === 'site') continue;
    const cands = candidatesFor(d, decided);
    if (cands.length === 0) { tally.noCandidates++; continue; }
    let a: ModelAnswer;
    try { a = await askModel<ModelAnswer>(model, SYSTEM, promptFor(d, cands), ANSWER_SCHEMA); } catch (e) { tally.failed++; console.log(`  FAIL   ${d.id} ${(e as Error).message.slice(0, 120)}`); continue; }
    const why = validateAnswer(a, cands);
    if (why) { tally.refused++; console.log(`  refuse ${d.id} ${why}`); continue; }
    if (!a.settled) { tally.unsettled++; continue; }
    answered.push({ d, a, cands });
  }

  // Verify in a second pass, after the answering model is unloaded, so only one model is resident.
  if (answered.length) {
    await unload(model);
    for (const { d, a, cands } of answered) {
      const v = await askModel<{ decides?: boolean }>(verifier, VERIFY_SYSTEM, verifyPrompt(d.question, a.quote!), VERIFY_SCHEMA).catch(() => ({ decides: false }));
      if (v.decides !== true) { tally.unverified++; console.log(`  unverified ${d.id} (${verifier}) quote does not decide it: ${a.quote!.slice(0, 90)}`); continue; }
      tally.graph++;
      rows.push(JSON.stringify(answerRow(d, a.answer!.trim(), `presettle:graph:${model}+${verifier}`, `Deciding words: "${a.quote!.trim()}". ${citationNote(cands, a.cites!)}`, run, now)));
      console.log(`  graph  ${d.id} ${a.answer!.trim().slice(0, 110)}`);
      // A dry run is for judging precision, so it shows the question and the citations in full.
      if (dry) console.log(`         Q: ${d.question}\n         A: ${a.answer!.trim()}\n         QUOTE: ${a.quote}\n         ${citationNote(cands, a.cites!)}\n`);
    }
    await unload(verifier);
  } else if (stage !== 'site') await unload(model);
  if (!dry && rows.length) appendPendingLines(queue, rows);
  console.log(`presettle: ${JSON.stringify(tally)}${dry ? ' (dry run, nothing written)' : `; ${rows.length} answer row(s) appended to ${queue}`}`);
}

if (process.argv[1] && process.argv[1].endsWith('presettle.ts')) await main();
