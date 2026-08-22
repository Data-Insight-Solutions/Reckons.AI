#!/usr/bin/env npx tsx
/**
 * Dead weight — a maintenance flag for ORPHANED and SUPERSEDED features.
 *
 * Bulk on disk, code nobody imports and plan entities pointing at files that no longer
 * exist are not separate problems. They are the SYMPTOMS a feature leaves behind when it
 * was quietly replaced by another one and nobody retired the original. This job looks for
 * that shape and reports the evidence, so the question a human answers is "is this feature
 * orphaned or superseded?" rather than "why is this folder big?".
 *
 * The 200MB kbs/button-crawl directory is the worked example: an artifact produced by a
 * job that is DISABLED in jobs.json. The bytes are the symptom; the disabled producer is
 * the finding.
 *
 * SCRIPT TIER (F74.3): deterministic, zero tokens, zero hallucination, zero triage cost
 * for the checks that are right by construction. Reuses loadGraphQuads/ownerOfFile from
 * lib/graph-grounding.ts rather than reimplementing graph lookup — reimplementing a
 * detector is precisely the sprawl this file exists to catch.
 *
 * Usage:
 *   npx tsx scripts/offline/dead-weight.ts            # report
 *   npx tsx scripts/offline/dead-weight.ts --json     # machine-readable
 *   npx tsx scripts/offline/dead-weight.ts --pending  # queue findings for human review
 *   npx tsx scripts/offline/dead-weight.ts --min-mb=50
 *
 * ADVISORY, NEVER BLOCKING, AND IT DELETES NOTHING. Every finding is a QUESTION for a
 * human: an artifact may be a deliberate cache, an unowned file may be three hours old,
 * and an export with no caller may be a published API. A detector that deletes on its own
 * judgement would be the most expensive kind of wrong.
 */
import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { loadGraphQuads, ownerOfFile } from './lib/graph-grounding.js';

const KPRED = 'urn:kbase:predicate/';
const KB = 'urn:kbase:concept/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const FILE_PREDS = new Set([`${KPRED}has-file`, `${KPRED}tested-by`, `${KPRED}touches-file`]);
const SHIPPED = new Set(['functional', 'production']);
const UNSHIPPED = new Set(['speculative', 'planned', 'scaffolded']);

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const JSON_OUT = args.includes('--json');
const PENDING_OUT = args.includes('--pending');
const MIN_MB = Number(flag('min-mb') ?? 25);
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

const B = '\x1b[1m', D = '\x1b[2m', Y = '\x1b[33m', C = '\x1b[36m', G = '\x1b[32m', X = '\x1b[0m';
const short = (iri: string) => iri.replace(KB, 'kb:').replace(KPRED, 'kpred:');
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)}MB`;

interface Finding { check: string; subject: string; msg: string; action: string; }
const findings: Finding[] = [];
const add = (check: string, subject: string, msg: string, action: string) =>
  findings.push({ check, subject, msg, action });

// ── The graph, once.
const quads = loadGraphQuads('static');
const label = new Map<string, string>();
const status = new Map<string, string>();
const filesOf = new Map<string, string[]>();
for (const q of quads) {
  const s = q.subject.value, p = q.predicate.value, o = q.object.value;
  if (p === RDFS_LABEL) label.set(s, o);
  else if (p === `${KPRED}has-status`) status.set(s, o);
  else if (FILE_PREDS.has(p)) (filesOf.get(s) ?? filesOf.set(s, []).get(s)!).push(o);
}
const name = (iri: string) => label.get(iri) ?? short(iri);

// ── 1. ORPHANED ARTIFACT — bulk on disk whose producing job is disabled or gone.
// The bytes are the symptom; a producer nobody runs is the finding.
{
  type Job = { name: string; enabled?: boolean; cmd?: string };
  let jobs: Job[] = [];
  try { jobs = JSON.parse(readFileSync('scripts/offline/jobs.json', 'utf8')).jobs ?? []; } catch { /* no jobs file */ }

  const dirSize = (dir: string): number => {
    let total = 0;
    const walk = (d: string) => {
      let entries: string[];
      try { entries = readdirSync(d); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p); else total += st.size;
      }
    };
    walk(dir);
    return total;
  };

  // Candidate artifact roots: generated/local data that is not source.
  // NOT build/, dist/, storybook-static/: those are expected, gitignored build output.
  // Big is normal there; big is only a SIGNAL in directories a job is supposed to own.
  const roots = ['kbs', 'tests/visual/results', 'tests/visual/screenshots', 'reckons-workspace/kbs'];
  const scriptSrc = new Map<string, string>();
  for (const f of readdirSync('scripts/offline').filter((x) => x.endsWith('.ts'))) {
    try { scriptSrc.set(`scripts/offline/${f}`, readFileSync(`scripts/offline/${f}`, 'utf8')); } catch { /* unreadable */ }
  }

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let children: string[];
    try { children = statSync(root).isDirectory() ? readdirSync(root) : []; } catch { continue; }
    for (const child of children) {
      const p = path.join(root, child);
      let st; try { st = statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      const size = dirSize(p);
      if (size < MIN_MB * 1e6) continue;

      // Who WRITES here? A script that merely MENTIONS the name is not the producer —
      // queue-dedupe.ts names button-crawl while button-crawl.ts is what creates it, and
      // treating a mention as authorship let an enabled job mask a disabled one.
      const producers = [...scriptSrc.entries()]
        .filter(([f, src]) => path.basename(f, '.ts') === child || src.includes(p) || src.includes(`${root}/${child}`))
        .map(([f]) => f);
      const producerJobs = producers
        .map((f) => jobs.find((j) => j.cmd?.includes(path.basename(f))))
        .filter((j): j is Job => !!j);
      const allDisabled = producerJobs.length > 0 && producerJobs.every((j) => j.enabled === false);

      if (allDisabled) {
        add('orphaned-artifact', p,
          `${mb(size)} produced by ${producerJobs.map((j) => j.name).join(', ')} — a job that is DISABLED in jobs.json. ` +
          `Nothing regenerates this, and nothing consumes it on a schedule.`,
          `Confirm the feature behind ${producerJobs.map((j) => j.name).join(', ')} is retired, then delete the directory. ` +
          `If the feature is only paused, say so on its graph entity so the bulk is explained rather than mysterious.`);
      } else if (producers.length === 0 && size >= MIN_MB * 1e6 * 2) {
        add('unclaimed-artifact', p,
          `${mb(size)} and NO script in scripts/offline writes to it — the producer was renamed, removed, or lives elsewhere.`,
          `Find what created it (git log, or the feature that mentions it). If nothing does, it is residue: delete it.`);
      }
    }
  }
}

// ── 2. GHOST FEATURE — every declared file is gone. The code was deleted; the plan survived.
// This is the sharpest ORPHANED signal in the graph: a feature describing files that no longer exist.
for (const [iri, files] of filesOf) {
  const declared = [...new Set(files)];
  const missing = declared.filter((f) => !existsSync(f));
  if (missing.length !== declared.length || declared.length === 0) continue;
  const st = status.get(iri) ?? 'unstated';
  add('ghost-feature', short(iri),
    `"${name(iri)}" (${st}) declares ${declared.length} file(s) and NONE exist: ${declared.slice(0, 3).join(', ')}${declared.length > 3 ? ' …' : ''}. ` +
    `The implementation is gone but the plan entity is still asserting it.`,
    `Was this superseded by another feature, or abandoned? Either retire the entity (status + a kpred:superseded-by ` +
    `pointing at whatever replaced it) or repoint the file links. Right now the graph is describing code that is not there.`);
}

// ── 3. SUPERSEDED CANDIDATE — an unshipped feature whose files are all owned by a SHIPPED one.
// Someone else built it under a different name and the original plan was never retired.
{
  const ownersOf = new Map<string, string[]>();
  for (const [iri, files] of filesOf) {
    for (const f of new Set(files)) (ownersOf.get(f) ?? ownersOf.set(f, []).get(f)!).push(iri);
  }
  for (const [iri, files] of filesOf) {
    const st = status.get(iri);
    if (!st || !UNSHIPPED.has(st)) continue;
    const declared = [...new Set(files)].filter((f) => existsSync(f));
    if (declared.length < 2) continue; // one shared file is coincidence, not takeover
    const rivals = new Map<string, number>();
    for (const f of declared) {
      for (const other of ownersOf.get(f) ?? []) {
        if (other === iri) continue;
        if (!SHIPPED.has(status.get(other) ?? '')) continue;
        rivals.set(other, (rivals.get(other) ?? 0) + 1);
      }
    }
    const [top, overlap] = [...rivals.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (top && overlap === declared.length) {
      add('superseded-candidate', short(iri),
        `"${name(iri)}" is ${st}, but ALL ${declared.length} of its files are also claimed by "${name(top)}" (${status.get(top)}). ` +
        `The work appears to have shipped under the other name.`,
        `If "${name(top)}" replaced it, retire this entity rather than leaving two plans over one implementation — ` +
        `a stale 'planned' entity invites someone to build it a second time.`);
    }
  }
}

// ── 4. DEAD EXPORT — an exported symbol nothing imports. Deliberately conservative:
// a name used ANYWHERE else in the repo counts as used, so collisions cause MISSES, not noise.
{
  const srcFiles: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === 'build') continue;
      const p = path.join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|svelte)$/.test(p)) srcFiles.push(p);
    }
  };
  for (const r of ['src', 'scripts', 'cli/src', 'mcp-server/src']) if (existsSync(r)) walk(r);

  const contents = new Map<string, string>();
  for (const f of srcFiles) { try { contents.set(f, readFileSync(f, 'utf8')); } catch { /* skip */ } }

  // Count every identifier occurrence once, across the whole repo.
  const uses = new Map<string, number>();
  for (const [, src] of contents) {
    for (const m of src.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) uses.set(m[0], (uses.get(m[0]) ?? 0) + 1);
  }

  const uncalled: { file: string; sym: string }[] = [];
  for (const [file, src] of contents) {
    // Only library modules — routes, tests, config and barrels are entry points by nature.
    if (!/^src\/lib\/.*\.ts$/.test(file)) continue;
    if (/__tests__|\.test\.ts$|index\.ts$|\.d\.ts$/.test(file)) continue;
    const selfUses = new Map<string, number>();
    for (const m of src.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) selfUses.set(m[0], (selfUses.get(m[0]) ?? 0) + 1);

    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
      const sym = m[1];
      if ((uses.get(sym) ?? 0) > (selfUses.get(sym) ?? 0)) continue; // imported somewhere else
      // TWO VERY DIFFERENT THINGS, separated because conflating them buried the real signal
      // in 112 findings. Appearing exactly ONCE means the definition itself is the only
      // mention — nothing calls it, anywhere, including its own file. That is a feature half
      // that was never wired up or was superseded. Appearing more than once means it IS used,
      // just not outside its module: the `export` is surplus, which is tidiness, not rot.
      const total = selfUses.get(sym) ?? 0;
      if (total <= 1) {
        uncalled.push({ file, sym });
      } else {
        add('over-exported', `${file}:${sym}`,
          `"${sym}" is used only inside its own file, so the \`export\` reaches nobody.`,
          `Drop the export keyword. Minor — this is tidiness, not an orphaned feature.`);
      }
    }
  }

  // ROLL UP TO THE FEATURE. One uncalled helper is a loose end; a MODULE of uncalled
  // exports is an orphaned or superseded feature, which is the question actually worth a
  // human's time. Grouping is what turns 46 nits into a handful of real decisions.
  const byOwner = new Map<string, { files: Set<string>; syms: string[] }>();
  for (const u of uncalled) {
    const owner = ownerOfFile(u.file, quads);
    const key = owner ? owner.iri : `unowned:${path.dirname(u.file)}`;
    const e = byOwner.get(key) ?? { files: new Set<string>(), syms: [] };
    e.files.add(u.file); e.syms.push(u.sym); byOwner.set(key, e);
  }
  for (const [key, e] of [...byOwner.entries()].sort((a, b) => b[1].syms.length - a[1].syms.length)) {
    const unowned = key.startsWith('unowned:');
    const st = unowned ? null : status.get(key);
    const who = unowned ? key.slice('unowned:'.length) : `"${name(key)}"${st ? ` (${st})` : ''}`;
    if (e.syms.length >= 3) {
      add('orphaned-feature', unowned ? key.slice('unowned:'.length) : short(key),
        `${who} has ${e.syms.length} symbols nothing ever calls across ${e.files.size} file(s): ` +
        `${e.syms.slice(0, 5).join(', ')}${e.syms.length > 5 ? ' …' : ''}. ` +
        (st && SHIPPED.has(st)
          ? `It is marked ${st}, which cannot be true of code with no callers.`
          : unowned
            ? `No graph feature claims these files, so nothing records why they exist.`
            : `A whole module with no entry point is either unfinished or replaced.`),
        st && SHIPPED.has(st)
          ? `Either the wiring is missing (then the status is wrong — kb:honest-status) or this was superseded and the status is stale. Decide which, and fix the one that is lying.`
          : `Decide: finish the wiring, or retire it. If something replaced it, record kpred:superseded-by so the next session does not rebuild it.`);
    } else {
      for (const sym of e.syms) {
        const f = [...e.files][0];
        add('uncalled-symbol', `${f}:${sym}`,
          `"${sym}" is defined and never called — not from another module, not even from its own file. Owner: ${who}.`,
          `A loose end rather than an orphaned feature. Wire it, or delete it.`);
      }
    }
  }
}

// ── 5. UNUSED DEPENDENCY — declared, never imported.
{
  let pkg: any = {};
  try { pkg = JSON.parse(readFileSync('package.json', 'utf8')); } catch { /* none */ }
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length) {
    let haystack = '';
    const walk = (d: string) => {
      let entries: string[];
      try { entries = readdirSync(d); } catch { return; }
      for (const e of entries) {
        if (e === 'node_modules' || e === 'dist' || e === 'build') continue;
        const p = path.join(d, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(ts|js|svelte|mjs|cjs)$/.test(p)) { try { haystack += readFileSync(p, 'utf8'); } catch { /* skip */ } }
      }
    };
    for (const r of ['src', 'scripts', 'cli', 'mcp-server/src', 'tests']) if (existsSync(r)) walk(r);
    for (const f of ['vite.config.ts', 'svelte.config.js', 'playwright.config.ts', 'tailwind.config.ts']) {
      if (existsSync(f)) { try { haystack += readFileSync(f, 'utf8'); } catch { /* skip */ } }
    }
    for (const dep of deps) {
      if (haystack.includes(dep)) continue;
      add('unused-dependency', dep,
        `"${dep}" is a runtime dependency but its name never appears in any source file, test or config.`,
        `Confirm it is not loaded dynamically or by a plugin, then remove it — an unused dependency is install weight and attack surface.`);
    }
  }
}

// ── Report.
if (JSON_OUT) {
  console.log(JSON.stringify({ findings, counts: findings.reduce((a, f) => ({ ...a, [f.check]: (a as any)[f.check] + 1 || 1 }), {}) }, null, 2));
  process.exit(0);
}

const ORDER = ['orphaned-artifact', 'unclaimed-artifact', 'ghost-feature', 'orphaned-feature', 'superseded-candidate', 'uncalled-symbol', 'unused-dependency', 'over-exported'];
console.log(`\n${B}Dead weight — orphaned and superseded feature flags${X}`);
console.log(`${D}Advisory. Nothing is deleted. Each finding is a question for a human.${X}\n`);

for (const check of ORDER) {
  const group = findings.filter((f) => f.check === check);
  if (!group.length) continue;
  console.log(`${Y}${B}${check}${X} (${group.length})`);
  if (check === 'over-exported') {
    // Deliberately not enumerated: it is a lint-grade nit, and printing 100 of them is
    // exactly how a useful report becomes one nobody reads.
    console.log(`  ${D}${group.length} surplus export keyword(s) — tidiness only, not orphaned features. --json to list.${X}\n`);
    continue;
  }
  for (const f of group.slice(0, 12)) {
    console.log(`  ${C}${f.subject}${X}`);
    console.log(`    ${f.msg}`);
    console.log(`    ${D}→ ${f.action}${X}`);
  }
  if (group.length > 12) console.log(`  ${D}… ${group.length - 12} more (--json for all)${X}`);
  console.log('');
}

if (!findings.length) console.log(`${G}No dead weight found.${X}\n`);
else console.log(`${B}${findings.length} finding(s).${X} ${D}Read as "is this feature orphaned or superseded?", not "delete this".${X}\n`);

if (PENDING_OUT && findings.length) {
  const now = new Date().toISOString();
  const existing = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';
  let queued = 0;
  for (const f of findings) {
    if (f.check === 'over-exported') continue; // never worth a human's review slot
    const question = `[dead-weight/${f.check}] ${f.subject} — ${f.msg} ${f.action}`;
    if (existing.includes(JSON.stringify(question).slice(1, -1))) continue; // idempotent re-runs
    appendFileSync(PENDING, JSON.stringify({
      subject: f.subject,
      predicate: `urn:sweep:pred/dead-weight`,
      question,
      type: 'question',
      agent: 'offline:dead-weight',
      priority: ['orphaned-artifact', 'ghost-feature', 'orphaned-feature'].includes(f.check) ? 'high' : 'medium',
      addedAt: now,
      addedByMcp: true,
    }) + '\n');
    queued++;
  }
  console.log(`${queued} finding(s) queued → ${PENDING} (review in Reckons.AI).\n`);
}

// Advisory: a maintenance flag that fails the build would get switched off, and then it protects nothing.
process.exit(0);
