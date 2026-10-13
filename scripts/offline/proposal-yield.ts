/**
 * PROPOSAL YIELD — was running that agent worth it? Script tier, zero tokens.
 *
 * WHY THIS EXISTS. CLAUDE.md's work-tiering doctrine rests entirely on a number nobody was
 * computing: "Offloading is not free. A local job that emits 30 findings of which 25 are noise
 * moves cost from generation to TRIAGE rather than removing it." That is a claim about YIELD —
 * accepted over proposed, per agent — and the promotion ladder ("anything an agent gets right
 * RELIABLY is demoted to a script") cannot be applied without it.
 *
 * The measurement that prompted it, 2026-08-13: the review queue held 736 proposals and 8
 * recorded answers, having grown from the 586 that kb:graph-sets already described as "never
 * drained". The top producers were offline:branch-align (273), offline:code-review with
 * qwen3-coder (119) and offline:history-lessons (65) — and NOTHING said whether any of those
 * 273 were ever right. An unmeasured queue is not a backlog, it is an unpriced liability.
 *
 * TWO NUMBERS, AND THE SECOND IS THE HONEST ONE:
 *   YIELD    accepted / (accepted + rejected)  — of the proposals a human has RULED ON, how
 *            many were right. This is the quality signal.
 *   TRIAGED  (accepted + rejected) / proposed  — how much of what an agent produced has been
 *            looked at. A brilliant yield over 3 of 273 proposals is not evidence of anything,
 *            so yield is never reported without it.
 *
 * WHAT THIS CANNOT SEE, stated up front. It reads exported graphs, so a proposal still sitting
 * in knowledge.pending.jsonl (never drained into a graph) is counted as PROPOSED and nothing
 * else. It also cannot distinguish "rejected because wrong" from "rejected because already
 * known" — both are a human declining to accept, which is the cost either way.
 *
 * Run: npx tsx scripts/offline/proposal-yield.ts
 */

import { tallyWorkspace } from './lib/proposal-tally.js';

const ROOT = new URL('../..', import.meta.url).pathname;

// ── 1-2. What is still queued, what reached a graph, and what a human did with it ─
// The counting lives in lib/proposal-tally.ts, shared with the queue worker's back-pressure (F74.9).
const { tallies: byAgent, queued: queuedTotal, annotatedFiles } = tallyWorkspace(ROOT);

// ── 3. Report ────────────────────────────────────────────────────────────────

const rows = [...byAgent.entries()].sort((a, b) => b[1].proposed - a[1].proposed);
const pct = (n: number, d: number) => (d === 0 ? '  —  ' : `${Math.round((100 * n) / d)}%`.padStart(5));

console.log('proposal yield \x1b[2m— accepted over ruled-on, per agent\x1b[0m');
console.log(`\x1b[2m  ${queuedTotal} still queued · ${annotatedFiles} graph file(s) carry attribution\x1b[0m\n`);

console.log('  proposed  ruled  yield  triaged  agent');
for (const [agentName, t] of rows) {
  const ruled = t.accepted + t.rejected;
  console.log(
    `  ${String(t.proposed).padStart(8)}  ${String(ruled).padStart(5)}  ${pct(t.accepted, ruled)}  ${pct(ruled, t.proposed)}  ${agentName}`,
  );
}

const totals = rows.reduce(
  (a, [, t]) => ({
    proposed: a.proposed + t.proposed,
    accepted: a.accepted + t.accepted,
    rejected: a.rejected + t.rejected,
  }),
  { proposed: 0, accepted: 0, rejected: 0 },
);
const ruledTotal = totals.accepted + totals.rejected;

console.log(`\n  ${totals.proposed} proposed · ${ruledTotal} ruled on · ${totals.proposed - ruledTotal} never looked at`);

if (ruledTotal === 0) {
  console.log(
    '\n\x1b[33mNO PROPOSAL HAS BEEN RULED ON YET, so yield is unknown rather than good or bad.\x1b[0m\n' +
      '\x1b[2mThat is itself the finding: the agent tier is running and producing, and nothing has\n' +
      'confirmed any of it is worth the triage. Attribution only began on 2026-08-13, so earlier\n' +
      'proposals are unattributable by construction — this number becomes meaningful as the\n' +
      'queue is drained from here, not retroactively.\x1b[0m',
  );
} else if (ruledTotal < 20) {
  console.log(
    `\n\x1b[33mOnly ${ruledTotal} proposals ruled on — too few to rank agents.\x1b[0m ` +
      '\x1b[2mReported as a baseline, not a verdict.\x1b[0m',
  );
}

// Never fails the build: this is a measurement, and a low yield is information rather than a
// broken invariant. Failing CI on it would make the honest number the inconvenient one.
process.exit(0);
