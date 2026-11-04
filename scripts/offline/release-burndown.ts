#!/usr/bin/env npx tsx
/**
 * RELEASE BURNDOWN (script tier) — how much of this release's scope is actually built?
 *
 * WHY IT EXISTS. On 2026-10-13, day 5 of the 0.2.6 sprint, the architect found that none of the
 * release's headline items had started, and the scope had to be cut by hand. The scope was already
 * in the graph (kpred:has-part on the ktype:Release), but nothing read it back against the
 * calendar. This does, deterministically and for free.
 *
 * READS (never writes TTL): the ktype:Release matching package.json's version (as version-align
 * does) or --release=X.Y.Z; its kpred:has-part entities and their kpred:has-status; kpred:headline
 * parts; and kpred:starts / kpred:cut / kpred:ends date literals. Status order comes from
 * static/reckons-vocabulary.ttl (skos:notation + hnav:order), like graph-lint.
 *
 * LIMITS, stated where they bite: "last change" is the newest leading YYYY-MM-DD in a part's
 * progress / measured / decided / remaining literals, so a part nobody wrote a dated note on looks
 * untouched even if code moved. A part with no kpred:has-status (a Concept) is counted as
 * "no status" and never as built. The verdict counts statuses; it does not test anything.
 *
 *   npm run release:burndown                      current release, report
 *   npm run release:burndown -- --release=0.2.6
 *   npm run release:burndown -- --pending         queue a status-update proposal if parts are stale
 *   npm run release:burndown -- --measure         print a ready-to-paste kpred:measured line
 *   --stale-days=N (default 4)   --today=YYYY-MM-DD (for tests)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { appendQueueText } from './pending-queue.js';
import { Parser, type Quad } from 'n3';

const KPRED = 'urn:kbase:predicate/';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const HNAV_ORDER = 'urn:reckons:nav/order';
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const DAY = 86_400_000;

export interface Part { iri: string; id: string; label: string; status: string | null; headline: boolean; lastChange: string | null; }
export interface Burndown {
  release: string; version: string; start: string | null; cut: string | null; end: string | null;
  elapsed: number | null; remaining: number | null; total: number | null; cutIn: number | null;
  parts: Part[]; counts: Record<string, number>; built: number; headlineNotStarted: Part[]; stale: Part[]; verdict: string;
}

const short = (iri: string) => iri.replace(/^urn:kbase:concept\//, 'kb:');
const objs = (qs: Quad[], s: string, p: string) => qs.filter((q) => q.subject.value === s && q.predicate.value === p).map((q) => q.object.value);

/** status notation -> rank, read from the vocabulary graph (not hardcoded). */
export function loadRanks(vocab: Quad[]): Record<string, number> {
  const rank: Record<string, number> = {};
  for (const q of vocab) {
    if (q.predicate.value !== `${SKOS}notation`) continue;
    const order = objs(vocab, q.subject.value, HNAV_ORDER)[0];
    const scheme = objs(vocab, q.subject.value, `${SKOS}inScheme`)[0];
    if (order !== undefined && scheme === 'urn:kbase:type/FeatureLifecycle') rank[q.object.value] = Number(order);
  }
  return rank;
}

const isoDay = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

/** newest leading ISO date in the part's dated notes. */
export function lastChange(qs: Quad[], iri: string): string | null {
  let best: string | null = null;
  for (const p of ['progress', 'measured', 'decided', 'remaining', 'evidence']) {
    for (const o of objs(qs, iri, KPRED + p)) {
      const m = /^(?:MATT, )?(\d{4}-\d{2}-\d{2})/.exec(o.trim());
      if (m && (!best || m[1] > best)) best = m[1];
    }
  }
  return best;
}

export function findRelease(qs: Quad[], version: string): string | null {
  return qs.find((q) => q.predicate.value === KPRED + 'version' && q.object.value === version)?.subject.value ?? null;
}

export function analyze(qs: Quad[], vocab: Quad[], version: string, today: string, staleDays = 4): Burndown | null {
  const rel = findRelease(qs, version);
  if (!rel) return null;
  const rank = loadRanks(vocab);
  const functionalRank = rank['functional'] ?? 4;
  const headline = new Set(objs(qs, rel, KPRED + 'headline'));
  const iris = [...new Set(objs(qs, rel, KPRED + 'has-part'))];
  const parts: Part[] = iris.map((iri) => ({
    iri,
    id: objs(qs, iri, KPRED + 'feature-id')[0] ?? '',
    label: objs(qs, iri, 'http://www.w3.org/2000/01/rdf-schema#label')[0] ?? short(iri),
    status: objs(qs, iri, KPRED + 'has-status')[0] ?? null,
    headline: headline.has(iri),
    lastChange: lastChange(qs, iri),
  }));
  const counts: Record<string, number> = {};
  for (const p of parts) counts[p.status ?? 'no status'] = (counts[p.status ?? 'no status'] ?? 0) + 1;
  const built = parts.filter((p) => p.status !== null && (rank[p.status] ?? -1) >= functionalRank).length;
  const notStarted = (p: Part) => p.status === null || (rank[p.status] ?? -1) <= (rank['planned'] ?? 1);
  const headlineNotStarted = parts.filter((p) => p.headline && notStarted(p));
  const [start, cut, end] = ['starts', 'cut', 'ends'].map((k) => objs(qs, rel, KPRED + k)[0] ?? null);
  const days = (a: string, b: string) => Math.round((isoDay(b) - isoDay(a)) / DAY);
  const elapsed = start ? Math.max(0, days(start, today)) : null;
  const remaining = end ? days(today, end) : null;
  const total = start && end ? days(start, end) : null;
  const cutIn = cut ? days(today, cut) : null;
  const stale = parts.filter((p) => {
    if (p.status !== null && (rank[p.status] ?? -1) >= functionalRank) return false;
    return p.lastChange === null || days(p.lastChange, today) >= staleDays;
  });
  const verdict = `${built} of ${parts.length} parts functional or better; ${headlineNotStarted.length} headline part${headlineNotStarted.length === 1 ? '' : 's'} not started`;
  return { release: rel, version, start, cut, end, elapsed, remaining, total, cutIn, parts, counts, built, headlineNotStarted, stale, verdict };
}

export function render(b: Burndown): string {
  const L: string[] = [];
  L.push(`${C.b}Release burndown v${b.version}${C.x}${C.d} — ${short(b.release)}${C.x}`);
  if (b.start && b.end) {
    L.push(`  dates ${b.start} .. ${b.end}${b.cut ? `, cut ${b.cut}` : ''}: day ${b.elapsed} of ${b.total}, ${b.remaining} day(s) remaining${b.cutIn !== null ? `, ${b.cutIn} to the cut` : ''}`);
  } else L.push(`  ${C.y}no kpred:starts / kpred:ends recorded on the release${C.x}`);
  L.push('  by status: ' + Object.entries(b.counts).map(([k, v]) => `${k} ${v}`).join(', '));
  for (const p of b.parts) {
    const flag = p.headline ? `${C.y}*${C.x}` : ' ';
    L.push(`  ${flag} ${(p.status ?? 'no status').padEnd(12)} ${(p.id || '-').padEnd(8)} ${p.label.slice(0, 80)}${C.d} (${p.lastChange ?? 'undated'})${C.x}`);
  }
  L.push(`  ${C.d}* = headline part${C.x}`);
  L.push(`${b.headlineNotStarted.length ? C.r : C.g}${b.verdict}${C.x}`);
  return L.join('\n');
}

export function measureLine(b: Burndown, today: string): string {
  const by = Object.entries(b.counts).map(([k, v]) => `${v} ${k}`).join(', ');
  return `kpred:measured "${today}, BURNDOWN (scripts/offline/release-burndown.ts): ${b.verdict}. ${b.parts.length} parts: ${by}.${b.remaining !== null ? ` ${b.remaining} day(s) to ${b.end}.` : ''}" ;`;
}

function loadQuads(file: string): Quad[] {
  return new Parser().parse(readFileSync(file, 'utf8'));
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const version = arg('release') ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
  const today = arg('today') ?? new Date().toISOString().slice(0, 10);
  const staleDays = Number(arg('stale-days') ?? 4);
  const qs = readdirSync('static').filter((f) => /^reckons-.*\.ttl$/.test(f) && f !== 'reckons-vocabulary.ttl')
    .flatMap((f) => loadQuads(`static/${f}`));
  const b = analyze(qs, loadQuads('static/reckons-vocabulary.ttl'), version, today, staleDays);
  if (!b) { console.error(`no ktype:Release with kpred:version "${version}" in static/reckons-roadmap.ttl`); process.exit(1); }
  console.log(render(b));
  if (b.stale.length) {
    console.log(`${C.y}${b.stale.length} part(s) below functional with no dated note in ${staleDays}+ days: ${b.stale.map((p) => p.id || short(p.iri)).join(', ')}${C.x}`);
  }
  if (argv.includes('--measure')) console.log(`\n${measureLine(b, today)}`);
  if (argv.includes('--pending') && b.stale.length) {
    const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
    const note = `[release-burndown] v${version}: ${b.verdict}; ${b.stale.length} part(s) stale ${staleDays}+ days (${b.stale.map((p) => p.id || short(p.iri)).join(', ')}). Move them, start them or record progress.`;
    const existing = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';
    if (!existing.includes(JSON.stringify(note).slice(1, -1))) {
      appendQueueText(PENDING, JSON.stringify({
        subject: b.release, predicate: 'urn:sweep:pred/release-burndown', question: note, type: 'status-update',
        kb: 'roadmap', agent: 'offline:release-burndown', priority: 'medium', addedAt: new Date().toISOString(),
      }) + '\n');
      console.log(`queued 1 proposal → ${PENDING}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
