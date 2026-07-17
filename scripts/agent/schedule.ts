#!/usr/bin/env npx tsx
/**
 * Schedules live in the graph (F81 / kb:local-orchestration) — "plan schedule start from TTL".
 *
 * The runner already understands `kpred:every` on a single task. This is the meta-level: a
 * ktype:Schedule entity says WHAT should run and HOW OFTEN, so the thing that triggers it —
 * cron, a systemd timer, unsnooze, or a human — reads the GRAPH to find out what to do, instead
 * of having the plan baked into a crontab nobody can diff.
 *
 * WHY A GRAPH AND NOT A CRONTAB. A crontab is invisible: it is not in the repo, not reviewable,
 * not diffable, and it rots silently — the cloud cron that "fired on schedule and produced
 * nothing" was exactly a schedule nobody could see. A schedule in the graph is a fact like any
 * other: searchable, mergeable, and it carries its own outcome. `npm run schedule` tells you
 * what is due; a trigger runs the due ones; the outcome is written back.
 *
 * AND IT IS STILL DRAIN-NOT-SCHEDULE. `kpred:every` is an interval, never a cron expression.
 * "Not more often than this", not "at exactly 03:40". Whatever wakes next runs what is due; the
 * next due time is computed from when it ACTUALLY ran, so a machine asleep for a week wakes
 * owing one run, not seven. A weaker promise, and therefore one we can keep.
 *
 *   npx tsx scripts/agent/schedule.ts --graph reckons-workspace/schedules.ttl          list + due
 *   npx tsx scripts/agent/schedule.ts --graph … --run                                  run the due ones
 *   npx tsx scripts/agent/schedule.ts --graph … --run --force                          run all, ignore due-at
 *
 * SECURITY: same boundary as the runner. It executes kpred:command out of a LOCAL graph named
 * on the command line, never an imported or user-supplied one.
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { Parser, Writer, DataFactory, type Quad } from 'n3';

const { namedNode, literal, quad } = DataFactory;

const KPRED = 'urn:kbase:predicate/';
const KTYPE = 'urn:kbase:type/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEDULE = `${KTYPE}Schedule`;
const JOURNAL = 'reckons-workspace/schedule.log.jsonl';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', X = '\x1b[0m';

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const GRAPH = flag('graph');
const RUN = argv.includes('--run');
const FORCE = argv.includes('--force');

if (!GRAPH) {
  console.error(`${R}--graph <schedules.ttl> is required.${X}`);
  console.error(`${D}Schedules run commands. Only a LOCAL graph you name, never an imported one.${X}`);
  process.exit(2);
}
if (!existsSync(GRAPH)) {
  console.error(`${R}No such graph: ${GRAPH}${X}`);
  process.exit(2);
}

const STATE = GRAPH.replace(/\.ttl$/, '.state.ttl');
const quads = new Parser().parse(readFileSync(GRAPH, 'utf8')) as Quad[];
const stateQuads: Quad[] = existsSync(STATE)
  ? (() => {
      try {
        return new Parser().parse(readFileSync(STATE, 'utf8')) as Quad[];
      } catch {
        console.log(`${Y}! schedule state unreadable — ignoring and rebuilding${X}`);
        return [];
      }
    })()
  : [];

const one = (iri: string, p: string) => {
  const s = stateQuads.find((q) => q.subject.value === iri && q.predicate.value === `${KPRED}${p}`);
  if (s) return s.object.value;
  return quads.find((q) => q.subject.value === iri && q.predicate.value === `${KPRED}${p}`)?.object.value;
};

function parseEvery(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!m) return null;
  return Number(m[1]) * (m[2].toLowerCase() === 'm' ? 60_000 : m[2].toLowerCase() === 'h' ? 3_600_000 : 86_400_000);
}

interface Sched {
  iri: string;
  label: string;
  command?: string;
  every?: string;
  dueAt?: number;
  lastRun?: number;
  enabled: boolean;
}

const schedules: Sched[] = [
  ...new Set(quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === SCHEDULE).map((q) => q.subject.value)),
].map((iri) => ({
  iri,
  label: quads.find((q) => q.subject.value === iri && q.predicate.value.endsWith('#label'))?.object.value ?? iri.split('/').pop()!,
  command: one(iri, 'command'),
  every: one(iri, 'every'),
  dueAt: Number(one(iri, 'due-at') ?? 0) || undefined,
  lastRun: Number(one(iri, 'last-run') ?? 0) || undefined,
  enabled: one(iri, 'enabled') !== 'false',
}));

const now = Date.now();
const isDue = (s: Sched) => s.enabled && s.command && (FORCE || s.dueAt === undefined || now >= s.dueAt);

function setState(iri: string, facts: Record<string, string>) {
  const keep = (existsSync(STATE) ? (new Parser().parse(readFileSync(STATE, 'utf8')) as Quad[]) : []).filter(
    (q) => !(q.subject.value === iri && Object.keys(facts).some((p) => q.predicate.value === `${KPRED}${p}`)),
  );
  for (const [p, v] of Object.entries(facts)) keep.push(quad(namedNode(iri), namedNode(`${KPRED}${p}`), literal(v)) as Quad);
  const w = new Writer({ format: 'Turtle', prefixes: { kpred: KPRED } });
  w.addQuads(keep);
  w.end((err, result: string) => {
    if (err) throw err;
    writeFileSync(STATE, `# GENERATED by scripts/agent/schedule.ts — do not hand-edit. Delete to reset.\n\n` + result);
  });
}

const journal = (e: object) => {
  try {
    appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  } catch {
    /* the graph is the record; the journal is a convenience */
  }
};

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`${B}Schedules${X} ${D}— ${GRAPH}${FORCE ? ' · FORCE' : ''}${X}\n`);
for (const s of schedules) {
  const due = isDue(s);
  const when = !s.enabled
    ? `${D}disabled${X}`
    : !s.command
      ? `${Y}no command${X}`
      : due
        ? `${G}DUE${X}`
        : `${D}in ${Math.ceil(((s.dueAt ?? now) - now) / 60000)}m${X}`;
  console.log(`  ${due ? G + '●' : D + '○'}${X} ${s.label.padEnd(34)} ${D}every ${s.every ?? '—'}${X}  ${when}`);
}
console.log('');

if (!RUN) {
  const dueCount = schedules.filter(isDue).length;
  console.log(`${D}${dueCount} due. Pass --run to run them.${X}`);
  process.exit(0);
}

// ── Run the due ones ───────────────────────────────────────────────────────
let ran = 0;
let failed = 0;
for (const s of schedules.filter(isDue)) {
  console.log(`${B}▶ ${s.label}${X}\n  ${D}$ ${s.command}${X}`);
  let ok = true;
  try {
    execSync(s.command!, { stdio: 'inherit', shell: '/bin/bash', timeout: 45 * 60 * 1000 });
  } catch {
    ok = false;
  }
  const interval = parseEvery(s.every);
  const facts: Record<string, string> = { 'last-run': String(now), 'last-outcome': ok ? 'ok' : 'nonzero-exit' };
  // Next due time from NOW, not from the scheduled time — drain, do not schedule.
  if (interval !== null) facts['due-at'] = String(now + interval);
  setState(s.iri, facts);
  journal({ event: ok ? 'ran' : 'nonzero', schedule: s.iri });
  console.log(`  ${ok ? G + '✓ ran' : Y + '⚠ exited non-zero (recorded, not fatal)'}${X}${interval ? D + ` · due again in ${s.every}` + X : ''}\n`);
  ran++;
  if (!ok) failed++;
}

console.log(`${B}══${X} ${ran} schedule(s) ran, ${failed ? R + failed + ' non-zero' + X : G + '0 failed' + X}.`);
process.exit(0);
