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
 * first-pass review off the subscription while keeping a human/Opus gate. The review
 * loop itself lives in ./lib/local-review.ts, shared with the tri-party council
 * (code-review-council.ts) so there is ONE copy of it.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/code-review.ts \
 *     [--base=origin/dev] [--model=qwen3-coder:latest] [--max-files=25]
 */
import { appendFileSync } from 'fs';
import { makeOllama, warmUp, reviewableFiles, fileDiff, reviewFileLocally } from './lib/local-review.js';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const OLLAMA = process.env.OLLAMA_BASE_URL ?? process.env.VITE_OLLAMA_BASE_URL ?? '';
const MODEL = flag('model') ?? process.env.CODE_REVIEW_MODEL ?? 'qwen3-coder:latest';
const BASE = flag('base') ?? 'origin/dev';
const MAX_FILES = Number(flag('max-files') ?? 25);
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

if (!OLLAMA) {
  console.error('OLLAMA_BASE_URL not set — the local coding model is required for the review.');
  process.exit(1);
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

const { mergeBase, files } = reviewableFiles(BASE, MAX_FILES);
if (files.length === 0) {
  console.log(`No reviewable files changed vs ${mergeBase}. Nothing to do.`);
  process.exit(0);
}

console.log(`Local code review — ${files.length} file(s) vs ${BASE} · ${MODEL}\n`);
const ollama = makeOllama(OLLAMA, MODEL);
process.stdout.write(`  warming ${MODEL} … `);
try {
  await warmUp(ollama);
  console.log('ready\n');
} catch (e) {
  console.log('FAILED\n');
  console.error(`Could not load ${MODEL} from ${OLLAMA}: ${e instanceof Error ? e.message : e}`);
  console.error('Refusing to run: a review that reviews nothing must not report success.');
  process.exit(1);
}

let flagged = 0, reviewed = 0, failed = 0;
for (const file of files) {
  process.stdout.write(`  ${file} … `);
  const diff = fileDiff(file, mergeBase);
  if (!diff.trim()) { console.log('no diff'); continue; }
  try {
    const findings = await reviewFileLocally(file, diff, ollama);
    reviewed++;
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
