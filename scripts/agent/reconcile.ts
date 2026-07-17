#!/usr/bin/env npx tsx
/**
 * Reconcile the pending queue against reality (F89) — drop findings that fixed themselves.
 *
 * A deterministic check regenerates its findings every run. When such a check is queued into a
 * human review pile (graph-lint --pending, and friends), the findings ACCUMULATE: the issue
 * gets fixed, the check stops reporting it, but the queued copy lingers forever. Measured on
 * 2026-07-14: all 29 graph-lint entries in the queue were STALE — every one already resolved,
 * every one still sitting there. 157 pending facts, and a large slice of them were ghosts.
 *
 * That is not a small annoyance. A review queue is an attention budget, and padding it with
 * resolved findings is how the ONE real item gets skipped — the same failure as a log that is
 * always green, or a filter that shows everything.
 *
 * So: for findings from a check that is deterministic and re-runnable, RE-RUN THE CHECK, and
 * drop the queued entries that no longer reproduce. Safe precisely because the source is
 * deterministic — if graph-lint does not report it now, it is genuinely gone.
 *
 * DELIBERATELY CONSERVATIVE. It only touches entries from sources it can re-run and verify
 * (graph-lint today). It NEVER drops a question, a suggestion, a decision, or anything from a
 * source it cannot reproduce — those are judgment, and a human owns them. When in doubt, keep.
 *
 * Usage:
 *   npx tsx scripts/agent/reconcile.ts            report what is stale
 *   npx tsx scripts/agent/reconcile.ts --apply    drop the stale entries (backs up first)
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m';
const APPLY = process.argv.includes('--apply');

if (!existsSync(PENDING)) {
  console.log('No pending queue.');
  process.exit(0);
}

const lines = readFileSync(PENDING, 'utf8').split('\n').filter(Boolean);
const entries = lines.map((l) => {
  try {
    return { raw: l, obj: JSON.parse(l) as any };
  } catch {
    return { raw: l, obj: null };
  }
});

/**
 * A reconcilable source: an agent whose findings are DETERMINISTIC and can be regenerated, plus
 * the current set of "live" signatures it reports. If a queued entry's signature is not live,
 * it is resolved and safe to drop.
 *
 * The signature must be stable across runs and specific enough not to collide: subject + the
 * check name from the `[graph-lint/<check>]` prefix.
 */
interface Source {
  agent: string;
  live: () => Set<string>;
}

function graphLintLive(): Set<string> {
  const out = execSync('npx tsx scripts/offline/graph-lint.ts --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out.slice(out.indexOf('{')));
  // graph-lint --json emits `errors` AND `warns` — NOT `findings`. Reading only errors would
  // treat every warn-level finding (predicate-economy, honest-header…) as resolved and drop
  // queued copies that STILL FIRE. That is the confidently-wrong-checker failure, in the tool
  // built to fight it. Read both, and only drop what appears in NEITHER.
  const all = [...(parsed.errors ?? []), ...(parsed.warns ?? [])];
  return new Set(all.map((f: any) => `${f.subject}|${f.check}`));
}

const SOURCES: Source[] = [{ agent: 'offline:graph-lint', live: graphLintLive }];

/** The signature of a queued entry, matched against a source's live set. */
function sigOf(obj: any): string | null {
  const m = (obj.question ?? '').match(/^\[graph-lint\/([\w-]+)\]/);
  if (!m) return null;
  return `${obj.subject}|${m[1]}`;
}

const liveBySource = new Map<string, Set<string>>();
for (const s of SOURCES) {
  try {
    liveBySource.set(s.agent, s.live());
  } catch (e) {
    console.log(`${Y}! could not re-run ${s.agent} — its entries will be KEPT (cannot verify)${X}`);
    liveBySource.set(s.agent, new Set(['__unverifiable__']));
  }
}

const reconcilableAgents = new Set(SOURCES.map((s) => s.agent));
const stale: typeof entries = [];
const kept: typeof entries = [];

for (const e of entries) {
  if (!e.obj || !reconcilableAgents.has(e.obj.agent)) {
    kept.push(e); // not a reconcilable source — a human owns it. Keep.
    continue;
  }
  const live = liveBySource.get(e.obj.agent)!;
  if (live.has('__unverifiable__')) {
    kept.push(e); // could not verify → keep, never drop on a failed check.
    continue;
  }
  const sig = sigOf(e.obj);
  if (sig && !live.has(sig)) {
    stale.push(e); // deterministic finding that no longer reproduces → resolved.
  } else {
    kept.push(e);
  }
}

console.log(`${B}Reconcile${X} ${D}— ${entries.length} pending, ${SOURCES.length} reconcilable source(s)${X}\n`);

if (stale.length === 0) {
  console.log(`${G}✓ nothing stale — every reconcilable finding still reproduces.${X}`);
  process.exit(0);
}

console.log(`${Y}${stale.length} stale finding(s)${X} ${D}— resolved, but still in the queue:${X}`);
for (const e of stale.slice(0, 12)) {
  console.log(`  ${D}·${X} ${(e.obj.question ?? '').slice(0, 96)}`);
}
if (stale.length > 12) console.log(`  ${D}… and ${stale.length - 12} more${X}`);
console.log('');

if (!APPLY) {
  console.log(`${D}${stale.length} would be dropped. Pass --apply to remove them (a backup is written first).${X}`);
  console.log(`${D}Kept: ${kept.length} — including everything a human owns (questions, suggestions, judgment).${X}`);
  process.exit(0);
}

copyFileSync(PENDING, PENDING + '.bak');
writeFileSync(PENDING, kept.map((e) => e.raw).join('\n') + (kept.length ? '\n' : ''));
console.log(`${G}Dropped ${stale.length} stale finding(s).${X} ${D}${kept.length} kept. Backup: ${PENDING}.bak${X}`);
console.log(`${D}These were re-derivable and already resolved. The queue now shows work that is actually open.${X}`);
