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

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';

const ROOT = new URL('../..', import.meta.url).pathname;
const WORKSPACES = ['reckons-workspace/kbs', 'mcp-workspace/kbs'];
const PENDING = join(ROOT, 'reckons-workspace/knowledge.pending.jsonl');

const META = 'urn:kbase:meta/';

type Tally = { proposed: number; accepted: number; rejected: number; open: number };

const byAgent = new Map<string, Tally>();
const tally = (agent: string): Tally => {
  if (!byAgent.has(agent)) byAgent.set(agent, { proposed: 0, accepted: 0, rejected: 0, open: 0 });
  return byAgent.get(agent)!;
};

// ── 1. What is still queued and has never reached a graph ────────────────────

let queuedTotal = 0;
if (existsSync(PENDING)) {
  for (const line of readFileSync(PENDING, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      queuedTotal++;
      const t = tally(e.agent ?? '(unattributed)');
      t.proposed++;
      t.open++;
    } catch {
      /* a malformed line is not a proposal */
    }
  }
}

// ── 2. What reached a graph, and what a human then did with it ───────────────

function ttlFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) ttlFiles(p, out);
    else if (name.endsWith('.ttl')) out.push(p);
  }
  return out;
}

let annotatedFiles = 0;
for (const ws of WORKSPACES) {
  for (const file of ttlFiles(join(ROOT, ws))) {
    let quads;
    try {
      quads = new Parser().parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // a graph that does not parse is graph-lint's problem, not this job's
    }
    // Reification blocks carry status and (since 2026-08-13) attribution.
    const status = new Map<string, string>();
    const agent = new Map<string, string>();
    for (const q of quads) {
      if (q.predicate.value === META + 'status') status.set(q.subject.value, q.object.value);
      else if (q.predicate.value === META + 'proposed-by') agent.set(q.subject.value, q.object.value);
    }
    if (agent.size > 0) annotatedFiles++;
    for (const [stmt, who] of agent) {
      const t = tally(who);
      t.proposed++;
      const s = status.get(stmt);
      if (s === 'confirmed' || s === 'refined') t.accepted++;
      else if (s === 'rejected') t.rejected++;
      else t.open++;
    }
  }
}

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
