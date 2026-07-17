#!/usr/bin/env npx tsx
/**
 * Offline LOCAL code review (F74.2) — runs WITHOUT Opus / any cloud.
 *
 * A local Ollama coding model (qwen3-coder by default) reviews the current branch
 * diff, file by file, and queues each concrete finding as a pending QUESTION for
 * review in Reckons.AI. It ONLY proposes — it never edits code — so a wrong review
 * is just ignored in the Review tab: no spiral, no cost. Opt-in via OLLAMA_BASE_URL.
 *
 * This is the "offload grunt review to local, Opus decides" primitive: it moves
 * first-pass review off the subscription while keeping a human/Opus gate.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/code-review.ts \
 *     [--base=origin/dev] [--model=qwen3-coder:latest] [--max-files=25]
 */
import { appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { groundFile } from './lib/graph-grounding.js';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const OLLAMA = process.env.OLLAMA_BASE_URL ?? process.env.VITE_OLLAMA_BASE_URL ?? '';
const MODEL = flag('model') ?? process.env.CODE_REVIEW_MODEL ?? 'qwen3-coder:latest';
const BASE = flag('base') ?? 'origin/dev';
const MAX_FILES = Number(flag('max-files') ?? 25);
const MAX_DIFF_CHARS = 14_000; // keep each file's diff within the local model's context
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

if (!OLLAMA) {
  console.error('OLLAMA_BASE_URL not set — the local coding model is required for the review.');
  process.exit(1);
}

// Files worth reviewing: skip lockfiles, generated, binary, vendored.
const SKIP = /(package-lock\.json|pnpm-lock|yarn\.lock|\.min\.|\.map$|\.svg$|\.png$|\.jpe?g$|\.webm$|\.glb$|\.wasm$|\/draco\/|node_modules\/|content\/|\.snap$)/i;

function sh(cmd: string): string {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e: any) { return e?.stdout ?? ''; }
}

async function ollama(prompt: string): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { num_ctx: 16384, temperature: 0 } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
    const j = (await res.json()) as { response?: string };
    return (j.response ?? '').trim();
  } catch (e: any) {
    // Node's fetch reports every transport failure as the bare string "fetch failed" and
    // hides the reason in .cause. That is how a COLD MODEL LOAD looked like 25 identical
    // mystery failures (2026-07-14): every file "FAILED (fetch failed)", exit 0, zero
    // findings — a review that reviewed nothing and said so quietly. Surface the cause.
    const cause = e?.cause?.code ?? e?.cause?.message;
    throw new Error(cause ? `${e.message} (${cause})` : String(e?.message ?? e));
  }
}

/**
 * Load the model BEFORE the loop.
 *
 * The first request to a cold model must pull it into VRAM — 18GB for qwen3-coder, which
 * can outlast the HTTP client's patience. When that request died, the script did not stop:
 * it logged "FAILED" and moved to the next file, and the next, reporting a clean exit
 * having reviewed nothing. An agent tier that silently reviews zero files is worse than no
 * agent tier, because the queue it feeds looks merely empty rather than broken.
 *
 * So: warm up first, with a trivial prompt, and REFUSE TO START if the model will not load.
 * Loud beats quiet.
 */
async function warmUp(): Promise<void> {
  process.stdout.write(`  warming ${MODEL} … `);
  const t0 = Date.now();
  try {
    await ollama('Reply with exactly: OK');
    console.log(`ready (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  } catch (e) {
    console.log('FAILED\n');
    console.error(`Could not load ${MODEL} from ${OLLAMA}: ${e instanceof Error ? e.message : e}`);
    console.error('Refusing to run: a review that reviews nothing must not report success.');
    process.exit(1);
  }
}

function queue(file: string, finding: string) {
  const line = JSON.stringify({
    subject: `urn:sweep:review/${file.replace(/[^a-z0-9]+/gi, '-')}`,
    predicate: 'urn:sweep:pred/code-review',
    question: `[local review] ${file}: ${finding.slice(0, 600)}`,
    // A local-model review finding is a PROPOSAL to verify then fix or dismiss (some are false
    // positives) — reviewed in the Review tab, not a blocking decision for the question desk.
    type: 'suggestion',
    agent: `offline:code-review (${MODEL})`,
    priority: 'medium',
    addedAt: new Date().toISOString(),
    addedByMcp: true,
  });
  appendFileSync(PENDING, line + '\n');
}

// Which files changed vs the base (fall back to last commit if base is unknown).
let mergeBase = sh(`git merge-base ${BASE} HEAD 2>/dev/null`).trim();
if (!mergeBase) mergeBase = 'HEAD~1';
const files = sh(`git diff --name-only ${mergeBase}...HEAD`)
  .split('\n').map((f) => f.trim()).filter((f) => f && !SKIP.test(f)).slice(0, MAX_FILES);

if (files.length === 0) {
  console.log(`No reviewable files changed vs ${mergeBase}. Nothing to do.`);
  process.exit(0);
}

console.log(`Local code review — ${files.length} file(s) vs ${BASE} · ${MODEL}\n`);
await warmUp();
let flagged = 0, reviewed = 0, failed = 0;

for (const file of files) {
  process.stdout.write(`  ${file} … `);
  let diff = sh(`git diff ${mergeBase}...HEAD -- "${file}"`);
  if (!diff.trim()) { console.log('no diff'); continue; }
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + '\n… [diff truncated]';

  // GROUND: ask the graph what this file is supposed to be before judging the diff. A reviewer
  // that knows the file's owning feature and purpose can catch a change that contradicts intent,
  // not just one that is syntactically broken. Empty when the graph knows nothing — harmless.
  const grounding = groundFile(file);

  const prompt =
    `You are a careful senior reviewer. Review ONLY this unified diff for real defects: ` +
    `correctness bugs, security issues, missed edge cases, resource leaks, or clearly broken logic. ` +
    `Ignore style/formatting/nits. Be conservative — only flag issues you are confident are real.\n\n` +
    (grounding ? `Context from the project's knowledge graph (what this file is FOR — flag changes that contradict it):\n${grounding}\n\n` : '') +
    `Output one finding per line as: "<file>:<line-ish> — <concise issue>". ` +
    `If there are no real defects, reply with exactly: NONE\n\n` +
    `File: ${file}\n\`\`\`diff\n${diff}\n\`\`\``;

  try {
    const out = await ollama(prompt);
    reviewed++;
    if (/^\s*none\b/i.test(out) || !out.trim()) { console.log('clean'); continue; }
    const findings = out.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((l) => l && !/^none\b/i.test(l) && l.length > 8);
    if (findings.length === 0) { console.log('clean'); continue; }
    for (const f of findings) queue(file, f);
    flagged += findings.length;
    console.log(`${findings.length} finding(s) → queued`);
  } catch (e) {
    failed++;
    console.log(`FAILED (${e instanceof Error ? e.message : e})`);
  }
}

// Report failures loudly — a silent local failure is exactly what we DON'T want.
console.log(`\nReviewed ${reviewed}/${files.length} file(s): ${flagged} finding(s) queued → ${PENDING}.`);
if (failed > 0) console.log(`⚠ ${failed} file(s) FAILED to review locally — check Ollama/${MODEL}, re-run or review those by hand.`);
console.log('Findings are PROPOSALS: accept/reject in the Reckons.AI Review tab. Nothing was changed.');
process.exit(failed > 0 && flagged === 0 ? 1 : 0);
