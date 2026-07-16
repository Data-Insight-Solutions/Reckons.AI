#!/usr/bin/env npx tsx
/**
 * The orchestrator (F89) — triage the queue, draft the tasks, name what needs a human.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. Opus is the JUDGMENT tier; it cannot be a deterministic
 * script, and pretending otherwise would be the exact overclaim this project keeps catching.
 * So this is the HARNESS an Opus session runs inside, and everything in it is deterministic:
 *
 *   - it CLUSTERS the pending queue by what found each item and what kind it is;
 *   - it DECIDES, by rule, which clusters a free runner can clear vs which need a human;
 *   - it DRAFTS candidate AgentTask entities for the clearable clusters;
 *   - it leaves the frontier decision — promote which drafts, triage which residue — to Opus.
 *
 * The drafts are PROPOSALS. They are written to a proposals file, never into the live task
 * queue. A task an orchestrator invented and ran without review is not orchestration, it is an
 * agent editing its own instructions.
 *
 * THE MOST USEFUL THING IT DOES is separate the queue into three piles that have DIFFERENT
 * fixes, because treating them the same is why the queue grew to 157:
 *
 *   RE-DERIVABLE  a script regenerates this finding every run (most graph-lint output). It does
 *                 not need triage — it needs the underlying fix, or it returns tomorrow. The
 *                 queue is the wrong place for it, and clearing it by hand is Sisyphean.
 *   REMEDIABLE    a known job would settle the whole cluster (missing descriptions -> the local
 *                 describe-entities model). Draft one task for the cluster, not N triage clicks.
 *   JUDGMENT      a suggestion, a decision, a drift-warning that is genuinely a call. This is
 *                 the residue Opus and Matt exist for — and it is far smaller than 157.
 *
 * Usage:
 *   npx tsx scripts/agent/orchestrate.ts              the briefing
 *   npx tsx scripts/agent/orchestrate.ts --draft      also write task drafts to a proposals file
 *   npx tsx scripts/agent/orchestrate.ts --json
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { signature, remedyFor, type Remedy } from './triage.js';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const ANSWERS = 'reckons-workspace/knowledge.answers.jsonl';
const DRAFTS = 'reckons-workspace/task-drafts.ttl';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';
const argv = process.argv.slice(2);
const DRAFT = argv.includes('--draft');
const JSON_OUT = argv.includes('--json');

const readJsonl = (f: string): any[] =>
  existsSync(f)
    ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];

const answered = new Set(readJsonl(ANSWERS).map((a) => `${a.subject}|${a.predicate}`));
const pending = readJsonl(PENDING).filter((p) => !answered.has(`${p.subject}|${p.predicate}`));

// The classifier (signature + REMEDIES + remedyFor) lives in ./triage.js so the question desk
// and this orchestrator can never disagree about what belongs where.

// ── Cluster ─────────────────────────────────────────────────────────────────
const clusters = new Map<string, any[]>();
for (const p of pending) {
  const sig = signature(p);
  clusters.set(sig, [...(clusters.get(sig) ?? []), p]);
}

interface Bucket { rederivable: string[]; remediable: string[]; judgment: string[] }
const bucket: Bucket = { rederivable: [], remediable: [], judgment: [] };
for (const [sig] of clusters) bucket[remedyFor(sig).kind].push(sig);

const count = (sigs: string[]) => sigs.reduce((n, s) => n + (clusters.get(s)?.length ?? 0), 0);

// ── Draft tasks for the remediable clusters ────────────────────────────────
const drafts: { sig: string; label: string; command: string; doneWhen: string; tier: string; clears: number }[] = [];
for (const sig of bucket.remediable) {
  const r = remedyFor(sig);
  if (!r.command || !r.doneWhen) continue;
  drafts.push({ sig, label: `Clear "${sig}" (${clusters.get(sig)!.length} findings)`, command: r.command, doneWhen: r.doneWhen, tier: r.tier ?? 'script', clears: clusters.get(sig)!.length });
}

// ── Report ─────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({
    pending: pending.length,
    clusters: [...clusters].map(([sig, items]) => ({ sig, n: items.length, kind: remedyFor(sig).kind })),
    buckets: { rederivable: count(bucket.rederivable), remediable: count(bucket.remediable), judgment: count(bucket.judgment) },
    drafts,
  }, null, 2));
  process.exit(0);
}

console.log(`${B}Orchestration briefing${X} ${D}— ${pending.length} pending fact(s), ${clusters.size} cluster(s)${X}\n`);

console.log(`${B}the queue splits three ways${X}`);
console.log(`  ${D}re-derivable${X}  ${count(bucket.rederivable).toString().padStart(3)}  ${D}a script regenerates these — fix the source, do not triage${X}`);
console.log(`  ${C}remediable${X}    ${count(bucket.remediable).toString().padStart(3)}  ${D}a known job clears the whole cluster — drafted below${X}`);
console.log(`  ${Y}judgment${X}      ${count(bucket.judgment).toString().padStart(3)}  ${D}genuinely needs Opus or Matt — this is the real backlog${X}\n`);

const show = (title: string, sigs: string[], color: string) => {
  if (!sigs.length) return;
  console.log(`${color}${B}${title}${X}`);
  for (const sig of sigs.sort((a, b) => (clusters.get(b)?.length ?? 0) - (clusters.get(a)?.length ?? 0))) {
    console.log(`  ${(clusters.get(sig)?.length ?? 0).toString().padStart(3)}  ${sig}`);
    console.log(`       ${D}${remedyFor(sig).note}${X}`);
  }
  console.log('');
};
show('re-derivable — the queue is the wrong home for these', bucket.rederivable, D);
show('remediable — one task each', bucket.remediable, C);
show('judgment — Opus/Matt, and smaller than it looks', bucket.judgment, Y);

if (drafts.length) {
  console.log(`${B}drafted tasks${X} ${D}(proposals — nothing is in the live queue)${X}`);
  for (const d of drafts) {
    console.log(`  ${G}+${X} ${d.label} ${D}[${d.tier}]${X}`);
    console.log(`     ${D}run:    ${d.command}${X}`);
    console.log(`     ${D}accept: ${d.doneWhen}${X}`);
  }
  console.log('');
}

if (DRAFT && drafts.length) {
  const ttl =
    `@prefix kpred: <urn:kbase:predicate/> .\n@prefix ktype: <urn:kbase:type/> .\n@prefix task: <urn:reckons:task/> .\n` +
    `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n\n` +
    `# DRAFTED by scripts/agent/orchestrate.ts. PROPOSALS — review, then move the ones you want\n` +
    `# into reckons-workspace/tasks.ttl. Nothing here runs until you do.\n\n` +
    drafts
      .map((d, i) =>
        `task:draft-${i} rdf:type ktype:AgentTask ;\n` +
        `    rdfs:label   ${JSON.stringify(d.label)} ;\n` +
        `    kpred:goal   ${JSON.stringify(`Clear the "${d.sig}" cluster (${d.clears} pending findings).`)} ;\n` +
        `    kpred:tier   ${JSON.stringify(d.tier)} ;\n` +
        `    kpred:command ${JSON.stringify(d.command)} ;\n` +
        `    kpred:done-when ${JSON.stringify(d.doneWhen)} ;\n` +
        `    kpred:task-state "open" .`,
      )
      .join('\n\n') + '\n';
  writeFileSync(DRAFTS, ttl);
  console.log(`${G}${drafts.length} draft(s) written → ${DRAFTS}${X} ${D}— review, then move into tasks.ttl${X}`);
}

console.log(
  `${D}Opus does the rest: promote the drafts worth running, and triage the ${count(bucket.judgment)} judgment item(s).\n` +
    `The ${count(bucket.rederivable)} re-derivable one(s) are noise in the queue — fix the graph and they leave on their own.${X}`,
);
