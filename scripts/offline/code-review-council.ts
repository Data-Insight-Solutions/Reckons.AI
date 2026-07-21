#!/usr/bin/env npx tsx
/**
 * Tri-party CODE-REVIEW council (F102 kpred:decision, 2026-07-21).
 *
 * A free LOCAL first pass (qwen3-coder) reviews every changed file. Files it flags —
 * and only those — escalate to the frontier voices. This script automates two of the
 * three: the LOCAL voice and the CODEX voice (read-only, schema-constrained). CLAUDE is
 * Claude Code (Opus) in-session: it reads the worksheet this writes, reviews the flagged
 * diffs as the third voice, tallies {local, claude, codex}, and presents the SPLIT to
 * Matt. Proposals only — nothing is edited; the human decides.
 *
 * Cost policy (F102 kpred:constraint): ~1x local on everything + Nx Codex on the flagged
 * minority. Codex runs on Matt's ChatGPT subscription (flat-rate), not per-token API.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/code-review-council.ts \
 *     [--base=origin/dev] [--model=qwen3-coder:latest] [--codex-model=…] [--max-files=25]
 */
import { writeFileSync } from 'fs';
import {
  makeOllama,
  warmUp,
  reviewableFiles,
  fileDiff,
  reviewFileLocally,
} from './lib/local-review.js';
import { groundFile } from './lib/graph-grounding.js';
import { runCodex, codexAvailable } from '../agent/lib/codex.js';
import { tallyFindings, recordCouncil, type MemberResult, type Finding } from '../agent/lib/council.js';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const OLLAMA = process.env.OLLAMA_BASE_URL ?? process.env.VITE_OLLAMA_BASE_URL ?? '';
const MODEL = flag('model') ?? process.env.CODE_REVIEW_MODEL ?? 'qwen3-coder:latest';
const CODEX_MODEL = flag('codex-model');
const BASE = flag('base') ?? 'origin/dev';
const MAX_FILES = Number(flag('max-files') ?? 25);
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const WORKSHEET = 'reckons-workspace/council-review.worksheet.json';

if (!OLLAMA) {
  console.error('OLLAMA_BASE_URL not set — the free local first pass is required (it is the escalation trigger).');
  process.exit(1);
}

/** Codex review prompt for one file — grounded, and asking for the structured findings schema. */
function codexReviewPrompt(file: string, diff: string): string {
  const grounding = groundFile(file);
  return (
    `You are a careful senior reviewer. Review ONLY this unified diff for REAL defects: ` +
    `correctness bugs, security issues, missed edge cases, resource leaks, or clearly broken logic. ` +
    `Ignore style/formatting/nits. Be conservative — only flag issues you are confident are real.\n\n` +
    (grounding ? `What this file is FOR (from the project graph — flag changes that contradict it):\n${grounding}\n\n` : '') +
    `Return findings per the schema; set file="${file}". If there are no real defects, return an empty findings array.\n\n` +
    `File: ${file}\n\`\`\`diff\n${diff}\n\`\`\``
  );
}

async function main() {
  const { mergeBase, files } = reviewableFiles(BASE, MAX_FILES);
  if (files.length === 0) {
    console.log(`No reviewable files changed vs ${mergeBase}. Nothing to do.`);
    return 0;
  }

  console.log(`Code-review council — ${files.length} file(s) vs ${BASE}\n`);
  const ollama = makeOllama(OLLAMA, MODEL);
  process.stdout.write(`  warming ${MODEL} … `);
  try {
    await warmUp(ollama);
    console.log('ready');
  } catch (e) {
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    console.error('Refusing to run: with no local first pass there is no escalation trigger.');
    return 1;
  }

  // ── Local first pass on EVERY file (free). Flagged files escalate. ──
  const localFindings: Finding[] = [];
  const flagged: { file: string; diff: string }[] = [];
  for (const file of files) {
    process.stdout.write(`  [local] ${file} … `);
    const diff = fileDiff(file, mergeBase);
    if (!diff.trim()) { console.log('no diff'); continue; }
    try {
      const found = await reviewFileLocally(file, diff, ollama);
      if (found.length === 0) { console.log('clean'); continue; }
      found.forEach((text) => localFindings.push({ file, text }));
      flagged.push({ file, diff });
      console.log(`${found.length} finding(s) → FLAGGED for escalation`);
    } catch (e) {
      console.log(`FAILED (${e instanceof Error ? e.message : e})`);
    }
  }

  if (flagged.length === 0) {
    console.log('\nLocal pass found nothing to escalate. No frontier spend. Nothing queued.');
    return 0;
  }

  // ── Escalate ONLY flagged files to Codex (the frontier voice we can automate). ──
  const codexAvail = codexAvailable();
  const codexFindings: Finding[] = [];
  let codexResult: MemberResult;
  if (!codexAvail.ok) {
    codexResult = { member: 'codex', ok: false, reason: codexAvail.reason, findings: [] };
    console.log(`\n  [codex] UNAVAILABLE — ${codexAvail.reason}. Recording the split as local-only + absent Codex.`);
  } else {
    console.log(`\n  escalating ${flagged.length} flagged file(s) to Codex …`);
    for (const { file, diff } of flagged) {
      process.stdout.write(`  [codex] ${file} … `);
      const r = runCodex(codexReviewPrompt(file, diff), { model: CODEX_MODEL, timeoutMs: 180_000 });
      if (!r.ok) { console.log(`skipped (${r.reason})`); continue; }
      r.findings.forEach((f) => codexFindings.push({ file, text: f.text }));
      console.log(`${r.findings.length} finding(s)`);
    }
    codexResult = { member: 'codex', ok: true, findings: codexFindings };
  }

  // ── Tally {local, codex}, disagreement-first. CLAUDE adds the third voice in-session. ──
  const localResult: MemberResult = { member: `local:${MODEL}`, ok: true, findings: localFindings };
  const tally = tallyFindings([localResult, codexResult]);

  // Worksheet for the in-session Claude voice: the flagged diffs + both machine voices.
  writeFileSync(
    WORKSHEET,
    JSON.stringify(
      { base: BASE, mergeBase, flagged, local: localFindings, codex: codexFindings, codexOk: codexAvail.ok, at: new Date().toISOString() },
      null,
      2
    )
  );

  const written = recordCouncil(tally, {
    subjectFor: (f) => `urn:sweep:review/${(f.file ?? 'branch').replace(/[^a-z0-9]+/gi, '-')}`,
    predicate: 'urn:sweep:pred/code-review-council',
    agent: `council:code-review (local:${MODEL} + codex)`,
    pendingPath: PENDING,
  });

  const splits = tally.findings.filter((f) => f.agreement === 'split').length;
  console.log(`\n── Council result (disagreement-first) ──`);
  tally.findings.slice(0, 20).forEach((f) => {
    const tag = f.agreement === 'agreed' ? `AGREED(${f.assertedBy.join('+')})` : `split(${f.assertedBy.join('+')})`;
    console.log(`  [${tag}] ${f.file ?? ''}: ${f.text.slice(0, 140)}`);
  });
  console.log(`\n${tally.findings.length} finding(s): ${splits} split, ${tally.findings.length - splits} agreed.`);
  if (!tally.quorum) console.log('⚠ No quorum (Codex absent) — this is a single-voice pass, not a corroborated council.');
  console.log(`${written} proposal(s) → ${PENDING}; worksheet → ${WORKSHEET}.`);
  console.log('NEXT (in Claude Code): Claude reviews the flagged diffs as the third voice, then presents');
  console.log('the full {local, claude, codex} split to Matt. Findings are PROPOSALS — nothing was changed.');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e);
  process.exit(1);
});
