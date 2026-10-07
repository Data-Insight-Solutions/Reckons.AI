/**
 * Script inventory — which scripts nothing runs, which npm entries point at nothing, which scripts
 * overlap, and which npm names break their own namespace. Deterministic: no LLM, no network.
 *
 * WHY. package.json had grown past 200 entries and scripts/ past a hundred files, and nobody could
 * say which were live. This is the SCRIPT TIER of F74.8 (kb:script-consolidation): it measures the
 * sprawl; deciding what to merge or delete stays a human call, so findings are PROPOSALS only.
 *
 * "Referenced" means named by a package.json script, a scripts/offline/jobs.json cmd, or a
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

const SCRIPT_EXT = /\.(ts|mjs|js|sh)$/;
const GENERIC_STEMS = new Set(['index', 'main', 'types', 'util', 'utils', 'helpers', 'lib']);
const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'which', 'their', 'there', 'they', 'when', 'what', 'into', 'than', 'then', 'also', 'does', 'only', 'each', 'every', 'such', 'these', 'those', 'script', 'scripts', 'file', 'files', 'usage', 'npx', 'tsx']);

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

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

/** First doc block as a set of significant lowercase words. Empty when absent or too short to compare. */
export function docWords(source: string): Set<string> {
  const m = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!m) return new Set();
  const words = m[1].toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const set = new Set(words.filter((w) => !STOP.has(w)));
  return set.size >= 8 ? set : new Set();
}

export type ScriptInfo = { file: string; source: string };

const stripExt = (f: string) => f.replace(/\.(ts|mjs|js|sh)$/, '');

/** Files not reachable from `roots` directly or through one level of relative imports. */
export function findUnreferenced(infos: ScriptInfo[], roots: Set<string>): string[] {
  const byFile = new Map(infos.map((i) => [i.file, i]));
  const byStem = new Map(infos.map((i) => [stripExt(i.file), i.file]));
  const reached = new Set<string>();
  for (const r of roots) {
    const info = byFile.get(r);
    if (!info) continue;
    reached.add(r);
    if (r.endsWith('.sh')) {
      for (const ref of scriptRefs(info.source)) reached.add(ref);
    } else {
      for (const spec of relativeImports(info.source, r)) {
        const hit = byStem.get(spec);
        if (hit) reached.add(hit);
      }
    }
  }
  return infos.map((i) => i.file).filter((f) => !reached.has(f)).sort();
}

export type OverlapGroup = { files: string[]; reasons: string[] };

export function findOverlaps(infos: ScriptInfo[]): OverlapGroup[] {
  const parent = new Map<string, string>(infos.map((i) => [i.file, i.file]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
    return x;
  };
  const reasons = new Map<string, Set<string>>();
  const link = (a: string, b: string, why: string) => {
    parent.set(find(a), find(b));
    for (const f of [a, b]) { if (!reasons.has(f)) reasons.set(f, new Set()); reasons.get(f)!.add(why); }
  };
  const imports = new Map(infos.map((i) => [i.file, new Set(relativeImports(i.source, i.file))]));
  const words = new Map(infos.map((i) => [i.file, docWords(i.source)]));
  const stems = new Map<string, string[]>();
  for (const i of infos) {
    const stem = path.posix.basename(i.file).replace(SCRIPT_EXT, '');
    if (GENERIC_STEMS.has(stem)) continue;
    stems.set(stem, [...(stems.get(stem) ?? []), i.file]);
  }
  for (const [stem, files] of stems) {
    const dirs = new Set(files.map((f) => path.posix.dirname(f)));
    if (dirs.size > 1) for (const f of files.slice(1)) link(files[0], f, `same name stem "${stem}" in ${dirs.size} directories`);
  }
  for (let x = 0; x < infos.length; x++) {
    for (let y = x + 1; y < infos.length; y++) {
      const a = infos[x].file, b = infos[y].file;
      const ia = imports.get(a)!, ib = imports.get(b)!;
      if (ia.size >= 2 && ib.size >= 2) {
        const j = jaccard(ia, ib);
        if (j >= 0.5) link(a, b, `import-set Jaccard ${j.toFixed(2)}`);
      }
      const jw = jaccard(words.get(a)!, words.get(b)!);
      if (jw >= 0.5) link(a, b, `doc-comment word Jaccard ${jw.toFixed(2)}`);
    }
  }
  const groups = new Map<string, string[]>();
  for (const i of infos) groups.set(find(i.file), [...(groups.get(find(i.file)) ?? []), i.file]);
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((files) => ({ files: files.sort(), reasons: [...new Set(files.flatMap((f) => [...(reasons.get(f) ?? [])]))].sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.files[0].localeCompare(b.files[0]));
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
  const jobs: { name: string; cmd: string }[] = JSON.parse(readFileSync('scripts/offline/jobs.json', 'utf8')).jobs ?? [];
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
  for (const j of jobs) addRefs(j.cmd, `jobs.json:${j.name}`, true);
  for (const w of workflows) addRefs(w, 'workflow', false);

  const unreferenced = findUnreferenced(infos, roots);
  const overlaps = findOverlaps(infos);
  const prefixes = prefixReport(Object.keys(pkgScripts));

  console.log(`Script inventory (${infos.length} scripts, ${Object.keys(pkgScripts).length} npm entries, ${jobs.length} offline jobs)`);
  console.log(`\n1. Unreferenced scripts: ${unreferenced.length}`);
  for (const f of unreferenced) console.log(`   ${f}`);
  console.log(`\n2. Broken npm/job references: ${missing.length}`);
  for (const m of missing) console.log(`   ${m.source} -> ${m.ref}`);
  console.log(`\n3. Likely-overlap groups: ${overlaps.length}`);
  for (const g of overlaps) console.log(`   [${g.files.length}] ${g.files.join(', ')}\n       ${g.reasons.join('; ')}`);
  console.log(`\n4. npm prefix pattern: ${prefixes.counts.length} prefixes, ${prefixes.breaks.length} breaking entries`);
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
    ...overlaps.map((g) => mk(g.files.join('+'), 'overlapping-scripts', `Scripts that likely overlap (${g.reasons.join('; ')}): ${g.files.join(', ')}. Consider consolidating.`)),
    ...prefixes.breaks.map((b) => mk(b.name, 'npm-prefix-break', `npm entry "${b.name}" breaks the namespace pattern: ${b.reason}.`)),
  ];
  const res = queueFindings(findings, { agent: 'offline:script-inventory', path: pendingQueuePath(), recomputes: false, kb: 'roadmap' });
  console.log(`\n${res.queued} proposal(s) queued, ${res.skipped} duplicate(s) suppressed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
