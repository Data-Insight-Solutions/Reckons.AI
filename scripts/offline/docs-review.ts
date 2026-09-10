#!/usr/bin/env npx tsx
/**
 * READ THE PUBLISHED PAGES AND SAY WHAT A FIRST-TIME READER WOULD NOT UNDERSTAND (AGENT TIER).
 *
 * Matt, 2026-09-09: "We should design offline tasks that look through web pages for improvements."
 *
 * WHY THIS QUESTION AND NOT "SUGGEST IMPROVEMENTS". An open request for improvements to 151 pages
 * would return 151 rewrites, most of them the model's prose preference, and kb:work-tiering is
 * explicit that a job emitting mostly noise moves cost from generation to TRIAGE rather than
 * removing it. So the model is asked ONE narrow question it is genuinely better at than a script:
 * where does this page use a term it never explains?
 *
 * That question is also the one this product has already failed twice. A careful first-time reader
 * read Reckons.AI as generic note-taking on 2026-09-06 and again on 2026-09-08 — recorded on
 * kb:journey-docs as evidence about legibility, not as a misunderstanding to correct. A script can
 * count words; it cannot notice that "reckoning" is used four times and defined nowhere.
 *
 * THE HARNESS, as kb:work-tiering requires — ground, prompt, validate, emit-proposal:
 *
 *   ground    the page's own rendered prose, stripped of figures and markup, plus the list of
 *             terms the docs DO define elsewhere, so it cannot flag something already explained
 *   prompt    one question, one answer, a hard word limit
 *   validate  the flagged term must actually APPEAR on the page and must NOT be defined elsewhere
 *             in the docs — a hallucinated term is rejected before it reaches the queue
 *   emit      one proposal per page, at most, into knowledge.pending.jsonl for review
 *
 * It never edits a page or a graph. A bad reading costs a click.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/docs-review.ts \
 *     [--limit=10] [--model=qwen3-coder:latest] [--section=guide] [--dry-run]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { transactPendingQueue } from './pending-queue.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const CONTENT = join(ROOT, 'content');
const PENDING = join(ROOT, 'reckons-workspace', 'knowledge.pending.jsonl');

const argv = process.argv.slice(2);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const DRY = argv.includes('--dry-run');
const LIMIT = Number.parseInt(flag('limit') ?? '10', 10);
const MODEL = flag('model') ?? 'qwen3-coder:latest';
const SECTION = flag('section');
const OLLAMA = process.env.OLLAMA_BASE_URL ?? '';

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface Page { path: string; title: string; section: string; prose: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function readPages(): Page[] {
  return walk(CONTENT).sort().map((file) => {
    const raw = readFileSync(file, 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (!m) return null;
    const fm = Object.fromEntries(
      [...m[1].matchAll(/^(\w+):\s*(.*)$/gm)].map(([, k, v]) => [k, v.replace(/^"|"$/g, '')]),
    );
    // A figure is a rendered SVG or an <img>; its markup is not prose and would swamp the prompt.
    const prose = m[2]
      .replace(/<figure[\s\S]*?<\/figure>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*`>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { path: relative(CONTENT, file).replace(/\.md$/, ''), title: fm.title ?? '', section: fm.section ?? '', prose };
  }).filter((p): p is Page => Boolean(p) && p!.prose.length > 200);
}

/**
 * Every term the docs DEFINE somewhere — a page title, or a heading.
 *
 * This is the grounding that makes the answer useful rather than pedantic. Without it the model
 * flags "triple" on every page, when there is a page called The Semantic Triple explaining it.
 */
function definedTerms(pages: Page[]): Set<string> {
  const out = new Set<string>();
  for (const p of pages) {
    for (const t of [p.title, ...p.title.split(/[—–:,]/)]) {
      const clean = t.trim().toLowerCase();
      if (clean.length > 3) out.add(clean);
    }
  }
  return out;
}

async function ollama(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA.replace(/\/+$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // think:false — a hybrid-thinking model spends its whole budget reasoning and returns
    // nothing. Measured on 2026-09-08 when the VLM gate scored a competent model at 0%.
    body: JSON.stringify({
      model: MODEL, prompt, stream: false, think: false,
      options: { num_ctx: 16384, temperature: 0.1, num_predict: 220 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
  return ((await res.json()) as { response?: string }).response?.trim() ?? '';
}

const PROMPT = (p: Page, defined: string[]) => `You are checking one page of software documentation for terms it uses without explaining.

PAGE TITLE: ${p.title}

PAGE TEXT:
${p.prose.slice(0, 6000)}

Terms that ARE explained elsewhere in this documentation (do not flag these):
${defined.slice(0, 60).join(', ')}

Name AT MOST ONE term or phrase that this page uses as though the reader already knows it, and which a first-time reader would not. It must be a term that literally appears in the page text above.

Answer in exactly this form, and nothing else:
TERM: <the term, copied exactly from the page>
WHY: <one sentence, under 25 words, on what a reader would not know>

If every term on the page is either explained or ordinary English, answer exactly:
NONE`;

function parse(answer: string): { term: string; why: string } | null {
  if (/^\s*NONE\s*$/im.test(answer)) return null;
  const term = /TERM:\s*(.+)/i.exec(answer)?.[1]?.trim();
  const why = /WHY:\s*(.+)/i.exec(answer)?.[1]?.trim();
  if (!term || !why) return null;
  return { term: term.replace(/^["'`]|["'`]$/g, ''), why };
}

async function main(): Promise<void> {
  if (!OLLAMA) {
    console.error(C.red('OLLAMA_BASE_URL is not set. This is the agent tier and needs a local model.'));
    console.error(C.dim('  OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/docs-review.ts'));
    process.exit(1);
  }
  const all = readPages();
  const defined = definedTerms(all);
  const targets = all.filter((p) => !SECTION || p.section.toLowerCase().includes(SECTION.toLowerCase())).slice(0, LIMIT);

  console.log('');
  console.log(C.bold('docs review') + C.dim(` — ${targets.length} of ${all.length} page(s) · ${DRY ? 'dry-run' : MODEL}`));
  console.log(C.dim(`  asking one question: which term does this page use without explaining?`));
  console.log('');

  const findings: Array<{ page: Page; term: string; why: string }> = [];
  let none = 0, rejected = 0, failed = 0;

  for (const p of targets) {
    let answer: string;
    try {
      answer = await ollama(PROMPT(p, [...defined]));
    } catch (e) {
      console.log(`  ${C.red('FAILED')}  ${p.path}  ${(e as Error).message}`);
      failed++;
      continue;
    }
    const parsed = parse(answer);
    if (!parsed) { none++; continue; }

    /*
     * VALIDATE BEFORE THE QUEUE SEES IT. Two rejections, and both were observed in practice on
     * other jobs: a term the model invented and did not read on the page, and a term the docs
     * already explain on a page of its own. Either would train a reviewer to ignore this job.
     */
    const onPage = p.prose.toLowerCase().includes(parsed.term.toLowerCase());
    const alreadyExplained = defined.has(parsed.term.toLowerCase());
    if (!onPage || alreadyExplained) {
      console.log(`  ${C.dim('rejected')}  ${p.path}  ${C.dim(!onPage ? `"${parsed.term}" is not on the page` : `"${parsed.term}" is explained elsewhere`)}`);
      rejected++;
      continue;
    }
    console.log(`  ${C.yellow('term')}  ${C.cyan(p.path)}  ${C.bold(parsed.term)} ${C.dim('— ' + parsed.why)}`);
    findings.push({ page: p, term: parsed.term, why: parsed.why });
  }

  console.log('');
  console.log(`  ${findings.length} finding(s) · ${none} page(s) clean · ${rejected} rejected by validation · ${failed} failed`);

  if (DRY || findings.length === 0) {
    if (!DRY && findings.length === 0) console.log(C.green('  nothing to queue.'));
    else console.log(C.dim('  dry run — nothing queued.'));
    return;
  }

  /*
   * AGGREGATE BY TERM, NOT BY PAGE — the first run made the case on its own.
   *
   * Six use-case pages were checked and FIVE flagged the same word: "Reckoning", the product's own
   * central verb, used across the use cases and explained on none of them. That is one problem, and
   * queuing it five times would put five rows in front of a reviewer who has one decision to make.
   *
   * It also changes what the finding SAYS. "Reckoning is unexplained on 5 pages" is a documentation
   * gap worth fixing once; "this page uses Reckoning" is a note about a page. The count is the
   * evidence, so it travels with the proposal.
   */
  const byTerm = new Map<string, { why: string; pages: string[] }>();
  for (const f of findings) {
    const key = f.term.toLowerCase();
    const cur = byTerm.get(key) ?? { why: f.why, pages: [] };
    cur.pages.push(f.page.path);
    byTerm.set(key, cur);
  }
  const lines = [...byTerm.entries()].map(([, v], i) => {
    const term = findings.find((f) => f.term.toLowerCase() === [...byTerm.keys()][i])?.term ?? '';
    const n = v.pages.length;
    return JSON.stringify({
      subject: 'kb:journey-docs',
      predicate: 'urn:kbase:predicate/unexplained-term',
      object: term,
      note: `${v.why} Used without explanation on ${n} page${n === 1 ? '' : 's'}: `
        + `${v.pages.slice(0, 6).join(', ')}${n > 6 ? `, and ${n - 6} more` : ''}. `
        + `Either explain it once and link to it, or reject this if the term is ordinary for the `
        + `audience of those pages.`,
      type: 'suggestion',
      // kb:journey-docs is asserted in static/reckons-roadmap.ttl. An unscoped row is retained by
      // the drain rather than imported, so omitting this silently delivers nothing.
      kb: 'roadmap',
      agent: 'offline:docs-review',
      // A term unexplained on many pages is a real gap; on one page it is probably fine.
      priority: n >= 3 ? 'medium' : 'low',
    });
  });
  transactPendingQueue(PENDING, (current) => ({
    content: current + (current.endsWith('\n') || current === '' ? '' : '\n') + lines.join('\n') + '\n',
    result: undefined,
  }));
  console.log(C.green(`  queued ${lines.length} proposal(s) from ${findings.length} finding(s) → reckons-workspace/knowledge.pending.jsonl`));
  console.log(C.dim('  Proposals only. Nothing on any page or in any graph was changed.'));
}

if (process.argv[1] && process.argv[1].endsWith('docs-review.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
