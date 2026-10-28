/**
 * Script inventory — which scripts nothing runs, which npm entries point at nothing, which scripts
 * and which npm names break their own namespace. Deterministic: no LLM, no network.
 *
 * WHY. package.json had grown past 200 entries and scripts/ past a hundred files, and nobody could
 * say which were live. This is the SCRIPT TIER of F74.8 (kb:script-consolidation): it measures the
 * sprawl; deciding what to merge or delete stays a human call, so findings are PROPOSALS only.
 *
 * "Referenced" means named by a package.json script, a static/reckons-jobs.ttl command, or a
 * .github/workflows file (CI-only scripts are not dead), directly or through a referenced file's
 * relative imports (one level). Weakness: a script run by hand from a doc, or via a dynamic path,
 * looks unreferenced here; treat "unreferenced" as "ask", not "delete".
 *
 * Usage: npx tsx scripts/offline/script-inventory.ts [--pending]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueFindings, type Finding } from './pending-queue.js';
import { pendingQueuePath } from './lib/main-workspace.js';
import { readJobs } from '../lib/jobs-graph-read.js';

const SCRIPT_EXT = /\.(ts|mjs|js|sh)$/;

/** Repo-relative script paths mentioned in a command line or workflow text. */
export function scriptRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\.\/)?(scripts\/[\w./@-]+?\.(?:ts|mjs|js|sh))(?![\w])/g)) out.add(m[1]);
  return [...out];
}

/** Relative import specifiers of a file, resolved to repo-relative paths with no extension. */
export function relativeImports(source: string, fromFile: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s*['"](\.[^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    out.push(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)).replace(/\.(js|mjs|ts)$/, ''));
  }
  return out;
}

export type ScriptInfo = { file: string; source: string };

const stripExt = (f: string) => f.replace(/\.(ts|mjs|js|sh)$/, '');

/**
 * Scripts launched by a bare filename string, e.g. spawn(tsx, [path.join(here, 'job-watch.ts')]).
 * scriptRefs only sees `scripts/...` paths, so a sibling started through path.join looked
 * unreferenced (job-watch.ts was the false positive). A literal counts only when it names a script
 * in the SAME directory as the file containing it, or a script whose basename is unique repo-wide.
 */
export function spawnedSiblings(source: string, fromFile: string, infos: ScriptInfo[]): string[] {
  const dir = path.posix.dirname(fromFile);
  const out = new Set<string>();
  for (const m of source.matchAll(/['"`]((?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|mjs|js|sh))['"`]/g)) {
    const lit = m[1];
    const sibling = path.posix.normalize(path.posix.join(dir, lit));
    const hit = infos.find((i) => i.file === sibling);
    if (hit) { out.add(hit.file); continue; }
    const base = path.posix.basename(lit);
    const same = infos.filter((i) => path.posix.basename(i.file) === base);
    if (same.length === 1) out.add(same[0].file);
  }
  out.delete(fromFile);
  return [...out];
}

/** Files not reachable from `roots` directly or through one level of relative imports. */
export function findUnreferenced(infos: ScriptInfo[], roots: Set<string>): string[] {
  const byFile = new Map(infos.map((i) => [i.file, i]));
  const byStem = new Map(infos.map((i) => [stripExt(i.file), i.file]));
  const reached = new Set<string>();
  for (const r of roots) {
    const info = byFile.get(r);
    if (!info) continue;
    reached.add(r);
    for (const sp of spawnedSiblings(info.source, r, infos)) reached.add(sp);
    if (r.endsWith('.sh')) {
      for (const ref of scriptRefs(info.source)) reached.add(ref);
    } else {
      for (const spec of relativeImports(info.source, r)) {
        const hit = byStem.get(spec);
        if (hit) {
          reached.add(hit);
          const hi = byFile.get(hit);
          if (hi) for (const sp of spawnedSiblings(hi.source, hit, infos)) reached.add(sp);
        }
      }
    }
  }
  return infos.map((i) => i.file).filter((f) => !reached.has(f)).sort();
}

export type PrefixReport = {
  counts: [string, number][];
  breaks: { name: string; reason: string }[];
};

/** Prefix = text before the first ':' (the namespace's own convention); names without ':' have none. */
export function prefixReport(names: string[]): PrefixReport {
  const counts = new Map<string, number>();
  for (const n of names) if (n.includes(':')) { const p = n.split(':')[0]; counts.set(p, (counts.get(p) ?? 0) + 1); }
  const breaks: { name: string; reason: string }[] = [];
  for (const n of names) {
    if (!n.includes(':')) {
      const head = n.split('-')[0];
      if (n.includes('-') && (counts.get(head) ?? 0) >= 2) breaks.push({ name: n, reason: `hyphenated, but siblings use "${head}:" (${counts.get(head)} entries)` });
      continue;
    }
    const p = n.split(':')[0];
    if (counts.get(p) === 1) {
      const dashHead = p.split('-')[0];
      if (dashHead !== p && (counts.get(dashHead) ?? 0) >= 2) breaks.push({ name: n, reason: `prefix "${p}" used once while siblings share "${dashHead}:" (${counts.get(dashHead)} entries)` });
    }
  }
  return { counts: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), breaks };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.posix.join(dir, e);
    if (e === '__tests__' || e === 'fixtures' || e === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SCRIPT_EXT.test(e)) out.push(p);
  }
  return out;
}

function main() {
  const pending = process.argv.includes('--pending');
  const infos: ScriptInfo[] = walk('scripts').sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const pkgScripts: Record<string, string> = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};
  const jobs: { name: string; cmd: string }[] = readJobs();
  const wfDir = '.github/workflows';
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).map((f) => readFileSync(path.join(wfDir, f), 'utf8')) : [];

  const roots = new Set<string>();
  const missing: { source: string; ref: string }[] = [];
  const addRefs = (text: string, source: string, reportMissing: boolean) => {
    for (const r of scriptRefs(text)) {
      roots.add(r);
      if (reportMissing && !existsSync(r)) missing.push({ source, ref: r });
    }
  };
  for (const [k, v] of Object.entries(pkgScripts)) addRefs(v, `package.json:${k}`, true);
  for (const j of jobs) addRefs(j.cmd, `reckons-jobs.ttl:${j.name}`, true);
  for (const w of workflows) addRefs(w, 'workflow', false);

  const unreferenced = findUnreferenced(infos, roots);
  const prefixes = prefixReport(Object.keys(pkgScripts));

  console.log(`Script inventory (${infos.length} scripts, ${Object.keys(pkgScripts).length} npm entries, ${jobs.length} offline jobs)`);
  console.log(`\n1. Unreferenced scripts: ${unreferenced.length}`);
  for (const f of unreferenced) console.log(`   ${f}`);
  console.log(`\n2. Broken npm/job references: ${missing.length}`);
  for (const m of missing) console.log(`   ${m.source} -> ${m.ref}`);
  console.log(`\n3. npm prefix pattern: ${prefixes.counts.length} prefixes, ${prefixes.breaks.length} breaking entries`);
  console.log(`   ${prefixes.counts.map(([p, n]) => `${p}:${n}`).join(' ')}`);
  for (const b of prefixes.breaks) console.log(`   ${b.name} — ${b.reason}`);

  if (!pending) return;
  const mk = (id: string, predicate: string, text: string): Finding => ({
    subject: `urn:sweep:script-inventory/${id.replace(/[^a-z0-9]+/gi, '-')}`,
    predicate: `urn:sweep:pred/${predicate}`,
    question: `[script inventory] ${text}`.slice(0, 600),
    kb: 'roadmap',
    type: 'suggestion',
    priority: 'low',
  });
  const findings: Finding[] = [
    ...unreferenced.map((f) => mk(f, 'unreferenced-script', `${f} is referenced by no package.json script, offline job or workflow (or their one-level imports). Delete, wire up, or document why it is manual.`)),
    ...missing.map((m) => mk(`${m.source}-${m.ref}`, 'broken-script-reference', `${m.source} points at ${m.ref}, which does not exist.`)),
    ...prefixes.breaks.map((b) => mk(b.name, 'npm-prefix-break', `npm entry "${b.name}" breaks the namespace pattern: ${b.reason}.`)),
  ];
  const res = queueFindings(findings, { agent: 'offline:script-inventory', path: pendingQueuePath(), recomputes: false, kb: 'roadmap' });
  console.log(`\n${res.queued} proposal(s) queued, ${res.skipped} duplicate(s) suppressed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
