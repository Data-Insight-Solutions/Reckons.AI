#!/usr/bin/env npx tsx
/**
 * Design / architecture council — the automated Codex voice for a design decision.
 * See F102 kpred:decision (2026-07-21): higher-level review and architectural/design
 * decisions are made between MATT + CLAUDE + CODEX.
 *
 * This script does the AUTOMATED half: it convenes CODEX over a design question,
 * grounded in the project's own graph (Codex reads static/*.ttl under a read-only
 * sandbox), and prints its independent POSITION as structured points. The other two
 * members are live: CLAUDE is Claude Code (Opus) reasoning in-session, and MATT
 * decides. Claude Code tallies the two positions, leads with the SPLIT, presents it
 * to Matt, and records the decision to the graph only after he rules.
 *
 * It never writes to a graph or to source — Codex is a read-only advisory voice.
 *
 * Usage:
 *   npm run council:design -- --question="Should X depend on Y, or stay independent?"
 *   npx tsx scripts/agent/council-design.ts --question="…" [--target=kb:some-entity] [--model=…]
 */
import { writeFileSync } from 'fs';
import { runCodex } from './lib/codex.js';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const question = flag('question');
const target = flag('target');
const model = flag('model');
const WORKSHEET = 'reckons-workspace/council-design.worksheet.json';

if (!question) {
  console.error('Usage: council-design --question="<design/architecture question>" [--target=kb:entity]');
  console.error('A council with no question is not a council. Give it something to decide.');
  process.exit(1);
}

const prompt =
  `You are one voice on a design council for the Reckons.AI project (local dir "tripleNotes"). ` +
  `The project's PLAN and source-of-truth are TTL knowledge graphs in static/*.ttl — the roadmap ` +
  `is static/reckons-roadmap.ttl (features are kb:<name> with kpred:has-status / kpred:depends-on / ` +
  `kpred:principle / kpred:decision). READ the entities relevant to the question before answering; ` +
  `ground your position in what the graph actually says, and name the entities you relied on.\n\n` +
  `DESIGN QUESTION: ${question}\n` +
  (target ? `FOCUS ENTITY: ${target}\n` : '') +
  `\nReturn your position as findings: each finding = ONE concrete recommendation, trade-off, or ` +
  `risk, phrased so a human can accept or reject it on its own. Set file=null (this is a design ` +
  `question, not a code review). If you genuinely have no substantive position, return an empty ` +
  `findings array rather than padding.`;

console.log(`Design council — convening Codex on:\n  "${question}"${target ? `\n  focus: ${target}` : ''}\n`);
process.stdout.write('  asking Codex (grounded in the graph, read-only) … ');

const t0 = Date.now();
// Design reasoning over the graph can take longer than a diff review — give it room.
const res = runCodex(prompt, { model, timeoutMs: 300_000 });
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (!res.ok) {
  console.error(`\nCodex voice UNAVAILABLE: ${res.reason}`);
  console.error('The council cannot convene with one voice. Fix Codex, or decide with Claude + Matt only');
  console.error('and record that Codex was absent — do not pretend a two-voice split.');
  process.exit(1);
}

// Persist Codex's position so Claude Code can tally it against its own in-session
// position and present the split to Matt. This file is the hand-off to the live half.
writeFileSync(
  WORKSHEET,
  JSON.stringify({ question, target: target ?? null, codex: res.findings, at: new Date().toISOString() }, null, 2)
);

console.log(`\n── Codex's position (${res.findings.length} point(s)) ──`);
if (res.findings.length === 0) {
  console.log('  (no substantive position)');
} else {
  res.findings.forEach((f, i) => console.log(`  ${i + 1}. ${f.text}`));
}
console.log(`\nWorksheet → ${WORKSHEET}`);
console.log('NEXT (in Claude Code): Claude adds its own grounded position, tallies the SPLIT against');
console.log("Codex's, presents it to Matt, and records the decision to the graph only after he rules.");
