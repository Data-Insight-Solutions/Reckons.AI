/**
 * HUMAN RECHECK (F34.6). Matt, 2026-11-25: "One human validation in the past, does not mean a feature is validated
 * now. We will need certain things marked for human recheck, if there is a lack of testing available."
 *
 * Two predicates, on any entity in any static/*.ttl:
 *   kpred:human-checked        "YYYY-MM-DD: what a person checked, and who"   (a record, never a verdict on the future)
 *   kpred:needs-human-recheck  "YYYY-MM-DD: what a person must look at, and why no test covers it"
 * and the entity's own file links (kpred:touches-file, kpred:has-file, kpred:tested-by).
 *
 * Per entity it reports:
 *   OPEN     a recheck is asked for and no person has checked since it was asked
 *   STALE    a person checked it, then one of its files changed: the check no longer covers the code that runs
 *   CURRENT  the latest human check is newer than every change to its files
 * Script tier (F74.3): deterministic, zero tokens. It cannot tell whether a test covers the behavior a person
 * checked, so a STALE line is a prompt to look, not a verdict that something broke.
 *
 *   npx tsx scripts/offline/human-recheck.ts            the list (advisory, exits 0)
 *   npx tsx scripts/offline/human-recheck.ts --json
 *   npx tsx scripts/offline/human-recheck.ts --check    exits 1 when anything is OPEN or STALE
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Parser } from 'n3';

const P = 'urn:kbase:predicate/';
const FILE_PREDICATES = [P + 'touches-file', P + 'has-file', P + 'tested-by'];

export type Entity = { iri: string; label?: string; checked: string[]; asked: string[]; files: string[] };
export type Verdict = { iri: string; label?: string; state: 'OPEN' | 'STALE' | 'CURRENT'; why: string };

/** Pure: the leading ISO date of a dated literal, or null. */
export const dateOf = (s: string): string | null => /^(\d{4}-\d{2}-\d{2})\b/.exec(s.trim())?.[1] ?? null;

const latest = (dates: (string | null)[]): string | null =>
  dates.filter((d): d is string => d !== null).sort().at(-1) ?? null;

/** Pure: one entity's state, given the date each of its files last changed (null when unknown to git). */
export function assess(e: Entity, lastChange: (file: string) => string | null): Verdict | null {
  const checked = latest(e.checked.map(dateOf));
  const open = e.asked.filter((a) => { const d = dateOf(a); return checked === null || d === null || d >= checked; });
  const base = { iri: e.iri, label: e.label };
  if (open.length) return { ...base, state: 'OPEN', why: open.join(' | ') };
  if (checked === null) return null; // never asked, never checked: nothing to say
  let newest: { file: string; date: string } | null = null;
  for (const f of e.files) {
    const d = lastChange(f);
    if (d && d > checked && (!newest || d > newest.date)) newest = { file: f, date: d };
  }
  if (newest) return { ...base, state: 'STALE', why: `checked ${checked}; ${newest.file} changed ${newest.date}` };
  return { ...base, state: 'CURRENT', why: `checked ${checked}; no linked file changed since` };
}

/** Pure: entities with any human-check record or request, from parsed quads. */
export function readEntities(quads: { subject: { value: string }; predicate: { value: string }; object: { value: string } }[]): Entity[] {
  const by = new Map<string, Entity>();
  const get = (iri: string) => by.get(iri) ?? (by.set(iri, { iri, checked: [], asked: [], files: [] }), by.get(iri)!);
  for (const q of quads) {
    const p = q.predicate.value, s = q.subject.value, o = q.object.value;
    if (p === P + 'human-checked') get(s).checked.push(o);
    else if (p === P + 'needs-human-recheck') get(s).asked.push(o);
    else if (FILE_PREDICATES.includes(p)) get(s).files.push(o);
    else if (p === 'http://www.w3.org/2000/01/rdf-schema#label' && !get(s).label) get(s).label = o;
  }
  return [...by.values()].filter((e) => e.checked.length || e.asked.length);
}

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const args = process.argv.slice(2);
  const quads = readdirSync(path.join(root, 'static')).filter((f) => f.endsWith('.ttl')).flatMap((f) => {
    try { return new Parser().parse(readFileSync(path.join(root, 'static', f), 'utf8')); }
    catch { return []; } // graph-lint reports a TTL that does not parse; this check is about dates
  });
  const cache = new Map<string, string | null>();
  const lastChange = (file: string): string | null => {
    if (!cache.has(file)) {
      let d: string | null = null;
      try { d = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { cwd: root, encoding: 'utf8' }).trim() || null; } catch { d = null; }
      cache.set(file, d);
    }
    return cache.get(file)!;
  };
  const verdicts = readEntities(quads).map((e) => assess(e, lastChange)).filter((v): v is Verdict => v !== null);
  const order = { OPEN: 0, STALE: 1, CURRENT: 2 } as const;
  verdicts.sort((a, b) => order[a.state] - order[b.state] || a.iri.localeCompare(b.iri));
  if (args.includes('--json')) console.log(JSON.stringify(verdicts, null, 2));
  else {
    for (const v of verdicts) console.log(`${v.state.padEnd(7)} ${v.iri.replace('urn:kbase:concept/', 'kb:')}${v.label ? ` (${v.label})` : ''}\n        ${v.why}`);
    const n = (s: Verdict['state']) => verdicts.filter((v) => v.state === s).length;
    console.log(`\n${n('OPEN')} open, ${n('STALE')} stale, ${n('CURRENT')} current. A past human check is not a current one.`);
  }
  if (args.includes('--check') && verdicts.some((v) => v.state !== 'CURRENT')) process.exit(1);
}

if (process.argv[1]?.endsWith('human-recheck.ts')) main();
