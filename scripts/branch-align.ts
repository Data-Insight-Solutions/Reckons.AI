#!/usr/bin/env npx tsx
/**
 * Branch Alignment (F33)
 *
 * Compares the release-pipeline claims in the graphs against real git state, so
 * the graph's view of "what's in dev / staging / production" stays honest.
 *
 * Reads environment nodes (ktype:Environment → kpred:git-branch / review-gate)
 * and features (kpred:feature-id + has-status + in-dev/in-staging/in-production +
 * dev-approved/stakeholder-approved) from static/reckons-roadmap.ttl and
 * reckons-production.ttl, then checks them against `git log origin/main..origin/<branch>`.
 *
 * Reports the pipeline per environment (with review-gate status) and flags drift.
 *
 * Usage: npm run branch-align   (or: npx tsx scripts/branch-align.ts)
 */
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import N3 from 'n3';

const KP = 'urn:kbase:predicate/';
const KT = 'urn:kbase:type/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const nocolor = !process.stdout.isTTY || process.env.NO_COLOR;
const col = (c: string, s: string) => (nocolor ? s : `${c}${s}${C.x}`);

type Q = N3.Quad;
function parse(file: string): Q[] {
  try { return new N3.Parser().parse(readFileSync(file, 'utf8')); } catch { return []; }
}
const quads = [...parse('static/reckons-roadmap.ttl'), ...parse('static/reckons-production.ttl')];

const bySubject = new Map<string, Q[]>();
for (const q of quads) {
  const arr = bySubject.get(q.subject.value) ?? [];
  arr.push(q); bySubject.set(q.subject.value, arr);
}
const one = (list: Q[], p: string) => list.find((q) => q.predicate.value === KP + p)?.object.value;
const label = (list: Q[], fallback: string) => list.find((q) => q.predicate.value === RDFS_LABEL)?.object.value ?? fallback;

// ── Environments ──────────────────────────────────────────────────────────────
interface Env { iri: string; label: string; branch?: string; gate?: string; }
const envs: Env[] = [];
for (const [s, list] of bySubject) {
  if (!list.some((q) => q.predicate.value === RDF_TYPE && q.object.value === KT + 'Environment')) continue;
  envs.push({ iri: s, label: label(list, s), branch: one(list, 'git-branch'), gate: one(list, 'review-gate') });
}
// order dev → staging → production
const order = ['dev', 'staging', 'main'];
envs.sort((a, b) => order.indexOf(a.branch ?? '') - order.indexOf(b.branch ?? ''));

// ── Features ──────────────────────────────────────────────────────────────────
interface Feat {
  iri: string; id: string; label: string; status?: string;
  inDev?: string; inStaging?: string; inProduction?: string;
  devApproved?: string; stakeholderApproved?: string;
}
const features: Feat[] = [];
for (const [s, list] of bySubject) {
  const id = one(list, 'feature-id');
  if (!id) continue;
  features.push({
    iri: s, id, label: label(list, s), status: one(list, 'has-status'),
    inDev: one(list, 'in-dev'), inStaging: one(list, 'in-staging'), inProduction: one(list, 'in-production'),
    devApproved: one(list, 'dev-approved'), stakeholderApproved: one(list, 'stakeholder-approved'),
  });
}
const inProd = (f: Feat) => !!f.inProduction || f.status === 'production';

// ── Git ───────────────────────────────────────────────────────────────────────
function branchExists(branch: string): boolean {
  try { execSync(`git rev-parse --verify --quiet origin/${branch}`, { stdio: 'pipe' }); return true; } catch { return false; }
}
function mergedPRs(branch: string, base = 'main'): string[] {
  if (branch === base || !branchExists(branch)) return [];
  try {
    return execSync(`git log origin/${base}..origin/${branch} --oneline`, { encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch { return []; }
}
try { execSync('git fetch -q origin', { stdio: 'pipe' }); } catch { /* offline — use local refs */ }

// ── Report ──────────────────────────────────────────────────────────────────
const drift: string[] = [];
console.log(`\n${col(C.b, '═'.repeat(70))}`);
console.log(col(C.b, 'BRANCH ALIGNMENT — release pipeline vs git'));
console.log(col(C.b, '═'.repeat(70)));

for (const env of envs) {
  const branch = env.branch ?? '?';
  const gateLabel = env.gate === 'developer' ? 'developer (technical) review'
    : env.gate === 'stakeholder' ? 'stakeholder (business) review'
    : env.gate === 'both' ? 'both approvals required' : env.gate ?? '';
  const exists = branch === 'main' || branchExists(branch);
  const prs = mergedPRs(branch);

  console.log(`\n${col(C.b, env.label)}  ${col(C.dim, `[branch: ${branch} · gate: ${gateLabel}]`)}`);
  if (!exists) { console.log(col(C.y, `  ⚠ branch origin/${branch} does not exist yet`)); }

  // features claimed in this env
  let claimed: Feat[] = [];
  if (branch === 'dev') claimed = features.filter((f) => f.inDev && !inProd(f));
  else if (branch === 'staging') claimed = features.filter((f) => f.inStaging && !inProd(f));
  else if (branch === 'main') claimed = features.filter(inProd);

  if (branch !== 'main') console.log(col(C.dim, `  git: ${prs.length} PR(s) merged origin/main..origin/${branch}`));

  if (claimed.length === 0) {
    console.log(col(C.dim, '  (no features tracked here)'));
  } else {
    for (const f of claimed) {
      let awaiting = '';
      if (branch === 'dev') awaiting = f.devApproved ? col(C.g, '✓ dev-approved') : col(C.y, '⏳ awaiting developer review');
      else if (branch === 'staging') awaiting = f.stakeholderApproved ? col(C.g, '✓ stakeholder-approved') : col(C.y, '⏳ awaiting stakeholder review');
      else awaiting = col(C.g, '✓ live');
      console.log(`  ${col(C.b, f.id)} ${f.label}  ${awaiting}`);
    }
  }
}

// ── Drift checks ──────────────────────────────────────────────────────────────
for (const f of features) {
  if (f.inDev && f.status === 'production')
    drift.push(`${f.id} is marked in-dev but has-status 'production' — contradiction.`);
  if (f.inProduction && f.status !== 'production')
    drift.push(`${f.id} is marked in-production but has-status '${f.status}' (expected 'production').`);
  if (f.status === 'functional' && !f.inDev && !f.inStaging && !f.inProduction)
    drift.push(`${f.id} '${f.label}' is 'functional' but not tracked in any environment (missing in-dev?).`);
  if (f.inStaging && !f.inDev)
    drift.push(`${f.id} is in-staging but never marked in-dev (skipped the developer gate?).`);
  if (f.inProduction && f.inDev && !f.stakeholderApproved && !f.devApproved)
    drift.push(`${f.id} reached production without recorded dev/stakeholder approvals.`);
}
// git changes on dev not reflected by any tracked feature
const devPRs = mergedPRs('dev');
const devFeatures = features.filter((f) => f.inDev && !inProd(f)).length;
if (devPRs.length > 0 && devFeatures === 0)
  drift.push(`origin/dev has ${devPRs.length} merged PR(s) but no feature is marked in-dev — untracked work.`);

console.log(`\n${col(C.b, '─'.repeat(70))}`);
if (drift.length === 0) {
  console.log(col(C.g, '✓ aligned — graph pipeline matches git state, no drift.'));
} else {
  console.log(col(C.r, `⚠ ${drift.length} drift warning(s):`));
  for (const d of drift) console.log(col(C.y, `  • ${d}`));
}
console.log('');
process.exit(drift.length > 0 ? 1 : 0);
