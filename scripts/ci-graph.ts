#!/usr/bin/env npx tsx
/**
 * CI AS A GRAPH (F33.2) — every check, what it runs, what it guards, and whether it can block a
 * merge, generated from the files GitHub actually executes.
 *
 * Matt, 2026-10-07: "Fine that yml is an external requirement." GitHub only runs YAML in
 * .github/workflows/, so the YAML stays the executable truth and this graph is generated FROM it,
 * never the other way: modelling step lists, shell and GitHub expressions as triples would mirror
 * GitHub's format one to one for no gain in what can be asked. What CAN be asked of the graph:
 *
 *   - what stops a bad merge to main? (kpred:required-by on the checks the ruleset names)
 *   - which checks are advisory only? (a check no ruleset requires)
 *   - does a required check enforce what the roadmap calls blocking? (kpred:enforces on the
 *     blocking jobs of jobs.json that the script-tier check runs)
 *   - which roadmap features does each check guard? (kpred:guards, through the scripts it runs and
 *     the kpred:has-file / kpred:tested-by links that already name them)
 *   - does the ruleset require a check that no workflow produces? (drift, reported, not hidden)
 *
 * NO YAML DEPENDENCY. The six workflows use a small, regular subset of YAML. readYamlSubset reads
 * exactly that subset and THROWS, with the line number, on anything else (anchors, aliases, merge
 * keys, multi-document files, complex keys, flow mappings, multi-line plain scalars), so a workflow
 * that outgrows it fails this check loudly instead of being half read. Adding a parser package is
 * a dependency decision; this keeps it from being made by accident.
 *
 * Usage: npx tsx scripts/ci-graph.ts [--check]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Parser } from 'n3';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
export const OUT = join(ROOT, 'static', 'reckons-ci.ttl');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const RULESETS = [join(ROOT, '.github', 'ruleset-main.json')];
const JOBS = join(ROOT, 'scripts', 'offline', 'jobs.json');
const ROADMAP_GRAPHS = ['reckons-roadmap.ttl', 'reckons-production.ttl'].map((f) => join(ROOT, 'static', f));

// ── YAML, the subset the workflows use ──────────────────────────────────────

type Y = string | null | Y[] | { [k: string]: Y };
type Line = { n: number; indent: number; text: string };

/** Strip a trailing comment: a `#` after whitespace, outside quotes. Pure. */
export function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[,{-]/.test(s[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function splitFlow(inner: string, n: number): string[] {
  const out: string[] = [];
  let cur = '', q: string | null = null;
  for (const c of inner) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') throw new Error(`line ${n}: nested flow collections are outside the supported YAML subset`);
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => unquote(x));
}

function scalar(raw: string, n: number): Y {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (/^[&*]/.test(v)) throw new Error(`line ${n}: anchors and aliases are outside the supported YAML subset`);
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new Error(`line ${n}: a flow sequence must close on its own line`);
    return splitFlow(v.slice(1, -1), n);
  }
  if (v.startsWith('{')) {
    if (v === '{}') return {};
    throw new Error(`line ${n}: flow mappings are outside the supported YAML subset`);
  }
  return unquote(v);
}

/** Split `key: value` at the first `: ` (or a trailing `:`) outside quotes. */
function splitKey(text: string): [string, string] | null {
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && i === 0) { q = c; continue; }
    if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return [unquote(text.slice(0, i)), text.slice(i + 1)];
  }
  return null;
}

/** Read the YAML subset GitHub workflows here use. Throws, with a line number, on anything else. */
export function readYamlSubset(src: string): Y {
  const raw = src.split('\n');
  const lines: Line[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i].replace(/\t/g, '    ');
    if (/^---\s*$|^\.\.\.\s*$/.test(r)) {
      if (lines.length === 0 && /^---/.test(r)) continue;
      throw new Error(`line ${i + 1}: multi-document files are outside the supported YAML subset`);
    }
    const text = stripComment(r);
    if (!text.trim()) continue;
    lines.push({ n: i + 1, indent: text.length - text.trimStart().length, text: text.trim() });
  }
  let pos = 0;

  function blockScalar(parentIndent: number, style: string): string {
    const body: string[] = [];
    // Block scalars keep comment-looking lines, so read them from the raw source.
    const start = lines[pos]?.n ?? raw.length + 1;
    let i = start - 1;
    let indent = -1;
    for (; i < raw.length; i++) {
      const r = raw[i];
      if (!r.trim()) { body.push(''); continue; }
      const ind = r.length - r.trimStart().length;
      if (ind <= parentIndent) break;
      if (indent < 0) indent = ind;
      body.push(r.slice(indent));
    }
    while (pos < lines.length && lines[pos].n <= i) pos++;
    while (body.length && body[body.length - 1] === '') body.pop();
    return style.startsWith('>') ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n');
  }

  function value(rest: string, n: number, indent: number): Y {
    const v = rest.trim();
    if (/^[|>][+-]?$/.test(v)) return blockScalar(indent, v);
    if (v === '') {
      if (pos < lines.length && lines[pos].indent > indent) return block(lines[pos].indent);
      if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) return block(indent);
      return null;
    }
    if (pos < lines.length && lines[pos].indent > indent && !lines[pos].text.startsWith('- '))
      throw new Error(`line ${lines[pos].n}: multi-line plain scalars are outside the supported YAML subset`);
    return scalar(v, n);
  }

  function block(indent: number): Y {
    const first = lines[pos];
    if (first.text.startsWith('- ') || first.text === '-') {
      const seq: Y[] = [];
      while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
        const line = lines[pos];
        const item = line.text === '-' ? '' : line.text.slice(2);
        pos++;
        if (item.trim() === '') { seq.push(pos < lines.length && lines[pos].indent > indent ? block(lines[pos].indent) : null); continue; }
        const kv = splitKey(item);
        if (kv && !item.startsWith('"') && !item.startsWith("'")) {
          // `- key: value` opens a mapping whose other keys sit two columns in.
          const inner = indent + 2;
          const map: Record<string, Y> = {};
          map[kv[0]] = value(kv[1], line.n, inner);
          if (pos < lines.length && lines[pos].indent === inner && !lines[pos].text.startsWith('- ')) Object.assign(map, mapping(inner));
          seq.push(map);
        } else seq.push(value(item, line.n, indent));
      }
      return seq;
    }
    return mapping(indent);
  }

  function mapping(indent: number): Record<string, Y> {
    const map: Record<string, Y> = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
      const line = lines[pos];
      if (/^(\?|<<\s*:)/.test(line.text)) throw new Error(`line ${line.n}: complex keys and merge keys are outside the supported YAML subset`);
      const kv = splitKey(line.text);
      if (!kv) throw new Error(`line ${line.n}: expected "key: value", found ${JSON.stringify(line.text.slice(0, 40))}`);
      pos++;
      map[kv[0]] = value(kv[1], line.n, indent);
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new Error(`line ${lines[pos].n}: unexpected indentation`);
    return map;
  }

  if (!lines.length) return null;
  const doc = block(lines[0].indent);
  if (pos < lines.length) throw new Error(`line ${lines[pos].n}: unexpected content after the document`);
  return doc;
}

// ── From workflows to checks ────────────────────────────────────────────────

export type Check = {
  workflowFile: string; workflowName: string; jobId: string; context: string;
  needs: string[]; when?: string; scripts: string[]; npmScripts: string[];
};
export type Workflow = { file: string; name: string; triggers: { event: string; branches: string[] }[]; checks: Check[] };

const asMap = (y: Y | undefined): Record<string, Y> => (y && typeof y === 'object' && !Array.isArray(y) ? y : {});
const asList = (y: Y | undefined): string[] => (Array.isArray(y) ? y.filter((x): x is string => typeof x === 'string') : typeof y === 'string' ? [y] : []);

/** Expand `${{ matrix.key }}` in a job name over the job's matrix values, as GitHub names the checks. */
export function expandMatrix(name: string, matrix: Record<string, Y>): string[] {
  const keys = [...name.matchAll(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g)].map((m) => m[1]);
  if (!keys.length) return [name];
  let names = [name];
  for (const k of new Set(keys)) {
    const vals = asList(matrix[k]);
    if (!vals.length) return [name];
    names = names.flatMap((nm) => vals.map((v) => nm.replace(new RegExp(`\\$\\{\\{\\s*matrix\\.${k}\\s*\\}\\}`, 'g'), v)));
  }
  return names;
}

/** Repository scripts a run block executes, and the npm scripts it calls. Pure. */
export function scriptsIn(run: string): { scripts: string[]; npm: string[] } {
  const scripts = [...run.matchAll(/(?:^|[\s"'=(])((?:scripts|tests|mcp-server\/scripts)\/[\w./-]+\.(?:ts|mjs|js|sh|py))\b/g)].map((m) => m[1]);
  const npm = [...run.matchAll(/\bnpm run ([\w:.-]+)/g)].map((m) => m[1]);
  return { scripts: [...new Set(scripts)], npm: [...new Set(npm)] };
}

export function readWorkflow(file: string, src: string): Workflow {
  const doc = asMap(readYamlSubset(src));
  const name = typeof doc.name === 'string' ? doc.name : file;
  const on = doc.on ?? doc.true; // a bare `on:` key, however a reader spells it
  const triggers: Workflow['triggers'] = [];
  if (typeof on === 'string') triggers.push({ event: on, branches: [] });
  else if (Array.isArray(on)) for (const e of asList(on)) triggers.push({ event: e, branches: [] });
  else for (const [event, cfg] of Object.entries(asMap(on))) triggers.push({ event, branches: asList(asMap(cfg).branches) });
  const checks: Check[] = [];
  for (const [jobId, jobY] of Object.entries(asMap(doc.jobs))) {
    const job = asMap(jobY);
    const runs = (Array.isArray(job.steps) ? job.steps : []).map((s) => asMap(s).run).filter((r): r is string => typeof r === 'string');
    const found = runs.map(scriptsIn);
    const contexts = expandMatrix(typeof job.name === 'string' ? job.name : jobId, asMap(asMap(job.strategy).matrix));
    for (const context of contexts) checks.push({
      workflowFile: file, workflowName: name, jobId, context,
      needs: asList(job.needs), when: typeof job.if === 'string' ? job.if : undefined,
      scripts: [...new Set(found.flatMap((f) => f.scripts))].sort(), npmScripts: [...new Set(found.flatMap((f) => f.npm))].sort(),
    });
  }
  return { file, name, triggers, checks };
}

// ── The graph ───────────────────────────────────────────────────────────────

export type Ruleset = { file: string; name: string; branches: string[]; required: string[]; enforcement: string };

export function readRuleset(file: string, json: string): Ruleset {
  const r = JSON.parse(json) as { name: string; enforcement: string; conditions?: { ref_name?: { include?: string[] } }; rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[] };
  return {
    file, name: r.name, enforcement: r.enforcement,
    branches: (r.conditions?.ref_name?.include ?? []).map((b) => b.replace(/^refs\/heads\//, '')),
    required: r.rules.flatMap((x) => x.type === 'required_status_checks' ? (x.parameters?.required_status_checks ?? []).map((c) => c.context) : []),
  };
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').trim();
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export type Inputs = {
  workflows: Workflow[]; rulesets: Ruleset[];
  /** jobs.json: the blocking jobs the script-tier runner fails on with --ci. */
  blockingJobs: { name: string; cmd: string }[];
  /** repo path → roadmap entities naming it with kpred:has-file or kpred:tested-by. */
  guardsByPath: Map<string, string[]>;
  /** npm script name → its command, so `npm run x` resolves to the files it runs. */
  npmScripts: Record<string, string>;
};

export function build(inp: Inputs): { ttl: string; drift: string[] } {
  const L: string[] = [
    '@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix rdfs:   <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix skos:   <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix ktype:  <urn:kbase:type/> .',
    '@prefix kpred:  <urn:kbase:predicate/> .',
    '@prefix kb:     <urn:kbase:concept/> .',
    '@prefix ci:     <urn:reckons:ci/> .',
    '@prefix job:    <urn:reckons:job/> .',
    '',
    '## ---------------------------------------------------------------------------',
    '## GENERATED by scripts/ci-graph.ts from .github/workflows/*.yml, .github/ruleset-main.json,',
    '## scripts/offline/jobs.json and the has-file / tested-by links in the roadmap and production',
    '## graphs. Do not hand-edit: run `npx tsx scripts/ci-graph.ts`. The script tier checks it.',
    '##',
    '## The YAML is what GitHub executes; this is what can be ASKED of it (F33.2): what stops a',
    '## bad merge to main, which checks only advise, and which roadmap features each check guards.',
    '## ---------------------------------------------------------------------------',
    '',
    '<urn:reckons:kb> <urn:reckons:meta/kbStableId> "a1b2c3d4-e5f6-4a0f-b00f-000000000015" .',
    '',
  ];
  const drift: string[] = [];
  const allChecks = inp.workflows.flatMap((w) => w.checks);
  const checkIri = (c: Check) => `ci:check-${slug(c.context)}`;
  const byContext = new Map(allChecks.map((c) => [c.context, c]));
  const requiredBy = new Map<string, Ruleset[]>();
  for (const rs of inp.rulesets) for (const ctx of rs.required) {
    if (!byContext.has(ctx)) drift.push(`${rs.file} requires "${ctx}", which no workflow produces: a merge to ${rs.branches.join(', ')} waits on a check that never reports`);
    requiredBy.set(ctx, [...(requiredBy.get(ctx) ?? []), rs]);
  }
  const filesRun = (c: Check): string[] => {
    const viaNpm = c.npmScripts.flatMap((s) => scriptsIn(inp.npmScripts[s] ?? '').scripts);
    return [...new Set([...c.scripts, ...viaNpm])].sort();
  };

  for (const w of [...inp.workflows].sort((a, b) => a.file.localeCompare(b.file))) {
    const iri = `ci:workflow-${slug(w.file.replace(/\.ya?ml$/, ''))}`;
    L.push(`${iri} rdf:type ktype:CiWorkflow ;`);
    L.push(`    rdfs:label "${esc(w.name)}" ;`);
    L.push(`    kpred:has-file ".github/workflows/${esc(w.file)}" ;`);
    for (const t of w.triggers) L.push(`    kpred:runs-on-event "${esc(t.event)}${t.branches.length ? ` (${t.branches.join(', ')})` : ''}" ;`);
    L.push(`    kpred:check-count "${w.checks.length}" .`);
    L.push('');
  }

  for (const c of [...allChecks].sort((a, b) => a.context.localeCompare(b.context))) {
    const req = requiredBy.get(c.context) ?? [];
    const files = filesRun(c);
    const enforces = files.includes('scripts/offline/run-all.ts') ? inp.blockingJobs : [];
    // A check guards what its own scripts are linked to, and what the blocking jobs it enforces run.
    const guardedFiles = [...files, ...enforces.flatMap((j) => scriptsIn(j.cmd).scripts)];
    const guards = [...new Set(guardedFiles.flatMap((f) => inp.guardsByPath.get(f) ?? []))].sort();
    L.push(`${checkIri(c)} rdf:type ktype:CiCheck ;`);
    L.push(`    rdfs:label "${esc(c.context)}" ;`);
    L.push(`    kpred:part-of ci:workflow-${slug(c.workflowFile.replace(/\.ya?ml$/, ''))} ;`);
    L.push(`    kpred:job-id "${esc(c.jobId)}" ;`);
    L.push(`    kpred:can-block-merge "${req.length ? 'true' : 'false'}" ;`);
    for (const rs of req) L.push(`    kpred:required-by ci:ruleset-${slug(rs.name)} ;`);
    for (const n of c.needs) {
      const dep = allChecks.find((x) => x.workflowFile === c.workflowFile && x.jobId === n);
      if (dep) L.push(`    kpred:depends-on ${checkIri(dep)} ;`);
    }
    if (c.when) L.push(`    kpred:runs-when "${esc(c.when)}" ;`);
    for (const f of files) L.push(`    kpred:runs-script "${esc(f)}" ;`);
    for (const j of enforces) L.push(`    kpred:enforces job:${slug(j.name)} ;`);
    for (const g of guards) L.push(`    kpred:guards ${g} ;`);
    L.push(`    skos:definition "${esc(req.length
      ? `Required by ${req.map((r) => r.name).join(', ')}: a merge to ${[...new Set(req.flatMap((r) => r.branches))].join(', ')} waits for it to pass.`
      : 'Advisory: no ruleset requires it, so it reports but cannot stop a merge.')}" .`);
    L.push('');
  }

  for (const rs of inp.rulesets) {
    L.push(`ci:ruleset-${slug(rs.name)} rdf:type ktype:CiRuleset ;`);
    L.push(`    rdfs:label "${esc(rs.name)}" ;`);
    L.push(`    kpred:has-file "${esc(rs.file)}" ;`);
    L.push(`    kpred:enforcement "${esc(rs.enforcement)}" ;`);
    for (const b of rs.branches) L.push(`    kpred:protects-branch "${esc(b)}" ;`);
    L.push(`    kpred:required-check-count "${rs.required.length}" .`);
    L.push('');
  }

  const required = allChecks.filter((c) => requiredBy.has(c.context));
  const advisory = allChecks.filter((c) => !requiredBy.has(c.context));
  L.push('ci:required rdf:type skos:Collection ;');
  L.push('    skos:prefLabel "Checks that can stop a merge" ;');
  L.push(`    skos:definition "${required.length} of ${allChecks.length} checks are required by a ruleset. Only branches a ruleset names are protected: ${[...new Set(inp.rulesets.flatMap((r) => r.branches))].join(', ') || 'none'}." ;`);
  L.push(`    skos:member ${required.map(checkIri).sort().join(', ') || 'ci:none'} .`);
  L.push('');
  L.push('ci:advisory rdf:type skos:Collection ;');
  L.push('    skos:prefLabel "Checks that only advise" ;');
  L.push(`    skos:definition "${advisory.length} checks run and report, but no ruleset requires them, so a failure cannot stop a merge." ;`);
  L.push(`    skos:member ${advisory.map(checkIri).sort().join(', ') || 'ci:none'} .`);
  L.push('');
  return { ttl: L.join('\n'), drift };
}

// ── Inputs from the repository ──────────────────────────────────────────────

export function guardsFromGraphs(ttls: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const KP = 'urn:kbase:predicate/';
  for (const ttl of ttls) {
    for (const q of new Parser().parse(ttl)) {
      if (q.predicate.value !== `${KP}has-file` && q.predicate.value !== `${KP}tested-by`) continue;
      if (!q.subject.value.startsWith('urn:kbase:concept/')) continue;
      const iri = `kb:${q.subject.value.slice('urn:kbase:concept/'.length)}`;
      out.set(q.object.value, [...new Set([...(out.get(q.object.value) ?? []), iri])]);
    }
  }
  return out;
}

export function readInputs(): Inputs {
  const workflows = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((f) => readWorkflow(f, readFileSync(join(WORKFLOWS, f), 'utf8')));
  const rulesets = RULESETS.map((p) => readRuleset(p.slice(ROOT.length + 1), readFileSync(p, 'utf8')));
  const jobsRaw = JSON.parse(readFileSync(JOBS, 'utf8')) as { jobs: { name: string; cmd: string; blocking?: boolean; enabled: boolean; tier: string }[] };
  const blockingJobs = jobsRaw.jobs.filter((j) => j.blocking && j.enabled && j.tier === 'script').map((j) => ({ name: j.name, cmd: j.cmd }));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  return { workflows, rulesets, blockingJobs, guardsByPath: guardsFromGraphs(ROADMAP_GRAPHS.map((p) => readFileSync(p, 'utf8'))), npmScripts: pkg.scripts };
}

function main(): void {
  const { ttl, drift } = build(readInputs());
  for (const d of drift) console.error(`  ! drift: ${d}`);
  if (process.argv.includes('--check')) {
    const existing = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return ''; } })();
    if (existing !== ttl) { console.error('✗ static/reckons-ci.ttl is stale. Run: npx tsx scripts/ci-graph.ts'); process.exit(1); }
    console.log(`✓ CI graph matches the workflows${drift.length ? ` (${drift.length} drift finding(s) above)` : ''}`);
    return;
  }
  writeFileSync(OUT, ttl, 'utf8');
  const n = (ttl.match(/rdf:type ktype:CiCheck/g) ?? []).length;
  const req = (ttl.match(/kpred:can-block-merge "true"/g) ?? []).length;
  console.log(`✓ ${n} check(s) written to static/reckons-ci.ttl — ${req} can block a merge, ${n - req} only advise`);
}

if (process.argv[1] && process.argv[1].endsWith('ci-graph.ts')) main();
