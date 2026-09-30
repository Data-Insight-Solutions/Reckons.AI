/**
 * RELEASE NOTES FOR THE NEXT VERSION, AND THE DOCUMENTATION THEY OWE (F33.1, script tier).
 *
 * Matt, 2026-09-30: documentation comes after development and refinement but BEFORE a promotion to
 * main, so what hits staging needs a changelog that is regenerated continually, and that changelog
 * should point at the documentation. This reads a range of history — by default what staging has
 * that main does not — and writes, from git and the graphs alone:
 *
 *   1. the pull requests merged in the range;
 *   2. the roadmap features that are new or changed status, read by parsing the roadmap at both ends;
 *   3. for every feature that reached scaffolded, functional or production, the documentation page
 *      that describes it — a docs entity (static/docs-*.ttl) pointing at it with kpred:relates-to,
 *      mapped to its page by static/page-provenance.json — or UNDOCUMENTED.
 *
 * With --check-docs it exits 1 while anything is UNDOCUMENTED. CI runs that on pull requests into
 * main only: documentation is a promotion condition, not a development one.
 *
 * Usage:
 *   npx tsx scripts/offline/release-notes.ts [--base=origin/main] [--head=origin/staging] [--check-docs] [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Parser } from 'n3';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const SHIPPED = new Set(['scaffolded', 'functional', 'production']);

type Q = { subject: { value: string }; predicate: { value: string }; object: { value: string } };

export type PullRequest = { number: number; title: string; date: string };
export type FeatureState = { iri: string; featureId?: string; label: string; status?: string };
export type FeatureChange = FeatureState & { from?: string; docs: { entity: string; path?: string }[] };

/** Merge commits in a range that record a pull request, in either wording this repository uses. */
export function parsePullRequests(log: string): PullRequest[] {
  const out = new Map<number, PullRequest>();
  for (const line of log.split('\n')) {
    const [subject = '', body = '', date = ''] = line.split('\x1f');
    let m = subject.match(/^Merge PR #(\d+):\s*(.*)$/);
    if (!m) {
      const gh = subject.match(/^Merge pull request #(\d+) from \S+/);
      if (gh) m = [gh[0], gh[1], body.trim()] as unknown as RegExpMatchArray;
    }
    if (m) {
      const number = Number(m[1]);
      if (!out.has(number)) out.set(number, { number, title: (m[2] || '').trim() || '(untitled)', date: date.trim() });
    }
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

/** Feature-like entities of a roadmap graph: anything with a feature id or a status. */
export function featureStates(ttl: string): Map<string, FeatureState> {
  const quads = new Parser().parse(ttl) as Q[];
  const out = new Map<string, FeatureState>();
  const get = (iri: string) => out.get(iri) ?? { iri, label: iri.split(/[/#]/).pop() ?? iri };
  for (const q of quads) {
    const p = q.predicate.value;
    if (p === `${KPRED}feature-id`) out.set(q.subject.value, { ...get(q.subject.value), featureId: q.object.value });
    else if (p === `${KPRED}has-status`) out.set(q.subject.value, { ...get(q.subject.value), status: q.object.value });
  }
  for (const q of quads) {
    if (q.predicate.value === RDFS_LABEL && out.has(q.subject.value)) out.get(q.subject.value)!.label = q.object.value;
  }
  return out;
}

/** New features, and features whose status moved, between two versions of the roadmap. */
export function featureChanges(before: Map<string, FeatureState>, after: Map<string, FeatureState>): Omit<FeatureChange, 'docs'>[] {
  const out: Omit<FeatureChange, 'docs'>[] = [];
  for (const [iri, now] of after) {
    const then = before.get(iri);
    if (!then) out.push({ ...now, from: undefined });
    else if (then.status !== now.status) out.push({ ...now, from: then.status });
  }
  return out.sort((a, b) => (a.featureId ?? '~').localeCompare(b.featureId ?? '~', 'en', { numeric: true }));
}

/** Docs entities that point at a roadmap entity with kpred:relates-to. */
export function docsLinks(docsTtl: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ttl of docsTtl) {
    for (const q of new Parser().parse(ttl) as Q[]) {
      if (q.predicate.value !== `${KPRED}relates-to`) continue;
      out.set(q.object.value, [...(out.get(q.object.value) ?? []), q.subject.value]);
    }
  }
  return out;
}

export function renderMarkdown(r: { base: string; head: string; prs: PullRequest[]; changes: FeatureChange[] }): string {
  const shipped = r.changes.filter((c) => c.status && SHIPPED.has(c.status));
  const undocumented = shipped.filter((c) => c.docs.length === 0);
  const lines = [
    `# Next version — ${r.head} ahead of ${r.base}`,
    '',
    `${r.prs.length} pull request(s) · ${r.changes.length} roadmap change(s) · ${shipped.length} feature(s) reached scaffolded or beyond · **${undocumented.length} undocumented**`,
    '',
    '## Features',
    '',
    '| Feature | Status | Documentation |',
    '|---|---|---|',
  ];
  for (const c of r.changes) {
    const status = c.from ? `${c.from} → ${c.status ?? '—'}` : `new, ${c.status ?? 'no status'}`;
    const needsDocs = c.status && SHIPPED.has(c.status);
    const docs = c.docs.length
      ? c.docs.map((d) => (d.path ? `[${d.path}](/docs/${d.path})` : d.entity)).join(', ')
      : needsDocs ? '**UNDOCUMENTED**' : '—';
    lines.push(`| ${c.featureId ? `${c.featureId} ` : ''}${c.label.replace(/\|/g, '\\|')} | ${status} | ${docs} |`);
  }
  lines.push('', '## Pull requests', '');
  for (const pr of r.prs) lines.push(`- #${pr.number} ${pr.title}${pr.date ? ` (${pr.date})` : ''}`);
  if (undocumented.length) {
    lines.push('', `## Documentation owed before promotion to main`, '', 'Each of these reached scaffolded or beyond with no docs entity pointing at it (`kpred:relates-to`). Write the page, or link an existing one.', '');
    for (const c of undocumented) lines.push(`- ${c.featureId ? `${c.featureId} ` : ''}${c.label} (\`${c.iri}\`)`);
  }
  return lines.join('\n') + '\n';
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const base = flag('base') ?? 'origin/main';
  const head = flag('head') ?? 'origin/staging';
  let log: string;
  let before: string;
  let after: string;
  try {
    log = git(['log', '--merges', '--format=%s%x1f%b%x1f%cs', `${base}..${head}`]).replace(/\x1f([^\x1f]*)\x1f/g, (_, b) => `\x1f${String(b).split('\n')[0]}\x1f`);
    before = git(['show', `${base}:static/reckons-roadmap.ttl`]);
    after = git(['show', `${head}:static/reckons-roadmap.ttl`]);
  } catch (e) {
    console.error(`release-notes: cannot read ${base}..${head} — ${(e as Error).message.split('\n')[0]}. Fetch both refs first.`);
    process.exit(2);
  }
  const docsFiles = readdirSync(join(ROOT, 'static')).filter((f) => /^docs-.*\.ttl$/.test(f));
  const links = docsLinks(docsFiles.map((f) => readFileSync(join(ROOT, 'static', f), 'utf8')));
  let pathOf = new Map<string, string>();
  try {
    const prov = JSON.parse(readFileSync(join(ROOT, 'static/page-provenance.json'), 'utf8')) as { pages: { path: string; entity: string }[] };
    pathOf = new Map(prov.pages.map((p) => [p.entity, p.path]));
  } catch {
    /* no provenance: docs are listed by entity */
  }
  const changes: FeatureChange[] = featureChanges(featureStates(before), featureStates(after)).map((c) => ({
    ...c,
    docs: (links.get(c.iri) ?? []).map((entity) => ({ entity, path: pathOf.get(entity) })),
  }));
  const report = { base, head, prs: parsePullRequests(log), changes };
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(renderMarkdown(report));
  if (argv.includes('--check-docs')) {
    const owed = changes.filter((c) => c.status && SHIPPED.has(c.status) && c.docs.length === 0);
    if (owed.length) {
      console.error(`\nrelease-notes: ${owed.length} feature(s) reached scaffolded or beyond without documentation — promotion to main is blocked until each has a docs entity (kpred:relates-to).`);
      process.exit(1);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('release-notes.ts')) main();
