/**
 * DRAFT THE GETTING STARTED SAMPLE SOURCES (F248 step 1, agent tier) — a local model writes each
 * sample source's text; a script decides whether the draft is usable.
 *
 *   ground    scripts/starter/everyday-plan.json: the trip, each source's style, and the facts it
 *             must support with the exact words each passage must contain (`must`).
 *   prompt    one source at a time. The model writes prose; it never picks the evidence.
 *   validate  every `must` string occurs verbatim, no URL, length within bounds, no figure (a price,
 *             distance, time or temperature) that is not in this source's facts, no prompt wording
 *             leaked into the text, and for each fact
 *             ONE line or sentence contains all of its `must` strings. That sentence becomes the
 *             fact's excerpt, chosen by this script, so a passage can never claim what the text
 *             does not say (kb:passage-grounding). A failed draft is retried with the misses named.
 *   emit      drafts and excerpts.json into a private folder outside the repository. A draft is a
 *             PROPOSAL: public copy, approved by Matt before it is copied into
 *             static/starter/everyday-sources/ (the 2026-10-08 F248 decision).
 *
 * Usage: OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/starter/draft-sample-sources.ts
 *          [--model=qwen3.6:latest] [--only=sample-thread] [--out=<dir>] [--attempts=3]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ollamaStream } from '../offline/lib/ollama-stream.js';

export type PlanFact = { fact: string; say: string; must: string[]; status?: string; at?: string; reviewer?: string; why?: string; supersedes?: string };
export type PlanSource = { id: string; kind: string; title: string; written: string; reviewer: string; style: string; facts: PlanFact[] };
export type Plan = { trip: string; sources: PlanSource[] };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLAN_PATH = path.join(HERE, 'everyday-plan.json');

export function readPlan(p = PLAN_PATH): Plan {
  return JSON.parse(readFileSync(p, 'utf8')) as Plan;
}

/** The smallest unit (a sentence inside a line, else the line) that contains every needle. Pure. */
export function excerptFor(text: string, needles: string[]): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z"'(])/);
    const s = sentences.find((x) => needles.every((n) => x.includes(n)));
    if (s) return s.trim();
  }
  return lines.find((l) => needles.every((n) => l.includes(n)));
}

export type DraftCheck = { ok: boolean; problems: string[]; excerpts: Record<string, string> };

const FIGURE = /\$\d[\d,]*(?:\.\d+)?|\b\d{1,2}:\d{2}\b|\b\d[\d,]*(?:\.\d+)?\s?(?:ft|feet|mi|miles?|°F|degrees|hours?|hrs?|h|m|min|minutes|am|pm|AM|PM)\b/g;

/**
 * Figures in the text that none of this source's facts contain: an invented price, distance,
 * drive time or temperature. Observed 2026-10-09: a first draft of the Lake George notes added
 * "about 4.5 hours" from San Francisco, contradicting the route notes (5h 40m). Pure.
 */
export function inventedFigures(src: PlanSource, text: string): string[] {
  const allowed = src.facts.map((f) => f.say).join(' \n ');
  return [...new Set(text.match(FIGURE) ?? [])].filter((f) => !allowed.includes(f));
}

/** Is this draft usable for this source? Pure. */
export function checkDraft(src: PlanSource, text: string): DraftCheck {
  const problems: string[] = [];
  const excerpts: Record<string, string> = {};
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 25) problems.push(`too short (${words} words)`);
  if (words > 400) problems.push(`too long (${words} words)`);
  if (/https?:\/\/|www\./i.test(text)) problems.push('contains a URL (samples link nowhere)');
  if (/\bstate "|must contain|EXACTLY as written/i.test(text)) problems.push('prompt wording leaked into the text');
  const invented = inventedFigures(src, text);
  if (invented.length) problems.push(`figures that are not in the facts: ${invented.map((f) => JSON.stringify(f)).join(', ')}`);
  for (const f of src.facts) {
    const missing = f.must.filter((m) => !text.includes(m));
    if (missing.length) { problems.push(`missing exactly: ${missing.map((m) => JSON.stringify(m)).join(', ')}`); continue; }
    const ex = excerptFor(text, f.must);
    if (!ex) problems.push(`no single line or sentence contains all of ${f.must.map((m) => JSON.stringify(m)).join(' + ')}`);
    else excerpts[f.fact] = ex;
  }
  return { ok: problems.length === 0, problems, excerpts };
}

/** The prompt for one source. Pure. */
export function buildPrompt(plan: Plan, src: PlanSource, feedback: string[] = []): string {
  const lines = src.facts.map((f, i) => `${i + 1}. ${f.say}  [use these words exactly: ${f.must.map((m) => JSON.stringify(m)).join(', ')}]`);
  return [
    `Write a short SAMPLE document for a demo of a note-taking app. Everything in it is fictional except real place names.`,
    `Background: ${plan.trip}`,
    `What to write: ${src.style}`,
    `The document must say each of these facts, with the same meaning, in its own natural wording:`,
    ...lines,
    `Each fact must appear in ONE sentence or line that contains all of its bracketed words, character for character (same symbols, spacing and capital letters), without quotation marks around them.`,
    `Rules: say nothing else that is a number: no other prices, distances, times, temperatures or dates. Do not contradict any fact. No links or web addresses, no company or website names, no rules or regulations about real places. No headings or markdown formatting beyond plain lines or "- " bullets. Write only the document itself.`,
    ...(feedback.length ? [`Your previous draft was rejected for: ${feedback.join('; ')}. Fix exactly these.`] : []),
  ].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) { console.error('OLLAMA_BASE_URL is not set; this job needs a local model (check: curl -s localhost:11434/api/tags)'); process.exit(2); }
  const model = flag('model') ?? 'qwen3.6:latest';
  const attempts = Number(flag('attempts') ?? 3);
  const out = flag('out') ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'reckons', 'starter-drafts', new Date().toISOString().slice(0, 10));
  mkdirSync(out, { recursive: true });
  const plan = readPlan();
  const only = flag('only');
  const allExcerpts: Record<string, Record<string, string>> = {};
  let failed = 0;
  for (const src of plan.sources.filter((s) => !only || s.id === only)) {
    let feedback: string[] = [];
    let done = false;
    for (let i = 1; i <= attempts && !done; i++) {
      const t0 = Date.now();
      const { text } = await ollamaStream(base, 'generate', {
        model, prompt: buildPrompt(plan, src, feedback), think: false,
        options: { temperature: i === 1 ? 0.4 : 0.6, num_ctx: 8192, num_predict: 900, seed: 40 + i },
      });
      const draft = text.trim().replace(/^```\w*\n?|\n?```$/g, '') + '\n';
      const check = checkDraft(src, draft);
      console.error(`${src.id}: attempt ${i} ${check.ok ? 'OK' : 'REJECTED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s${check.ok ? '' : ' — ' + check.problems.join('; ')}`);
      if (check.ok) {
        writeFileSync(path.join(out, `${src.id}.md`), draft);
        allExcerpts[src.id] = check.excerpts;
        done = true;
      } else feedback = check.problems;
    }
    if (!done) failed++;
  }
  writeFileSync(path.join(out, 'excerpts.json'), JSON.stringify({ model, drafted: new Date().toISOString(), excerpts: allExcerpts }, null, 2) + '\n');
  console.log(`drafts → ${out} (${model}); ${failed} source(s) failed every attempt. PROPOSALS: read them, then copy approved ones into static/starter/everyday-sources/.`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('draft-sample-sources.ts')) void main();
