#!/usr/bin/env node
/**
 * AUDIT GATE (script tier, CI) — `npm audit` at a severity level, with named, dated exceptions.
 *
 * WHY IT EXISTS. `npm audit --audit-level` has no way to accept one advisory and keep blocking the
 * rest. On 2026-11-17 a high SvelteKit advisory (GHSA-3r8g-jcqq-3p5j, a form-data DoS in remote
 * functions) appeared that only the SvelteKit 3 major fixes, and it blocked every PR. Reckons.AI is
 * a static build with no remote functions, so the advisory cannot be reached, but lowering the
 * whole gate would also let through the next advisory that CAN be reached. Matt chose a named
 * exception plus the migration (2026-11-17). This is that exception, kept narrow:
 *
 *   - an exception names ONE advisory id AND the package it is filed against;
 *   - it carries a reason, the decision that allowed it, and an expiry date — an expired exception
 *     blocks again, so an exception cannot quietly become permanent;
 *   - anything malformed (an npm error report, an exception with no reason) FAILS the gate.
 *
 * WHAT IT DOES NOT DO: decide reachability. The reason in each exception is a human claim; this
 * script only checks that the claim exists, is dated and has not expired.
 *
 * No imports beyond the standard library: the workflow audits the lockfile without installing.
 *
 *   npm audit --package-lock-only --json | node scripts/offline/audit-gate.mjs \
 *     --level=moderate --exceptions=.github/audit-exceptions.json
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The GHSA id inside an advisory URL, lowercased after the prefix (as GitHub prints it). */
export function advisoryId(url) {
  const m = /GHSA-([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})/i.exec(String(url ?? ''));
  return m ? `GHSA-${m[1].toLowerCase()}` : null;
}

/** Check the exceptions file. Returns problems; an empty list means every entry is usable. */
export function validateExceptions(doc) {
  const problems = [];
  const list = doc?.exceptions;
  if (!Array.isArray(list)) return ['exceptions file has no "exceptions" array'];
  list.forEach((e, i) => {
    const at = `exception ${i}`;
    if (!e || typeof e !== 'object') { problems.push(`${at}: not an object`); return; }
    if (!advisoryId(e.id) || advisoryId(e.id) !== e.id) problems.push(`${at}: id must be a GHSA id like GHSA-xxxx-xxxx-xxxx`);
    for (const k of ['package', 'reason', 'decided']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) problems.push(`${at} (${e.id ?? '?'}): "${k}" is required`);
    }
    if (typeof e.expires !== 'string' || !DATE.test(e.expires)) problems.push(`${at} (${e.id ?? '?'}): "expires" must be YYYY-MM-DD`);
  });
  return problems;
}

/**
 * Evaluate an `npm audit --json` (auditReportVersion 2) report against a level and exceptions.
 * Throws on a report that is not a complete audit, so a registry failure never reads as clean.
 */
export function evaluateAudit(report, exceptionsDoc, { level = 'moderate', today }) {
  if (!(level in RANK)) throw new Error(`unknown level "${level}"`);
  if (!today || !DATE.test(today)) throw new Error('today must be YYYY-MM-DD');
  if (!report || report.error || report.auditReportVersion !== 2 ||
      !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw new Error(`incomplete npm audit report${report?.error ? `: ${report.error.summary ?? report.error.code ?? 'error'}` : ''}`);
  }
  const problems = validateExceptions(exceptionsDoc);
  const exceptions = Array.isArray(exceptionsDoc?.exceptions) ? exceptionsDoc.exceptions : [];

  // One row per (advisory, package). A vulnerability whose `via` is only another package's name is
  // inherited: that package's own entry carries the advisory, so it is counted there.
  const seen = new Map();
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    for (const via of Array.isArray(v?.via) ? v.via : []) {
      if (!via || typeof via !== 'object') continue;
      const pkg = String(via.name ?? name);
      const id = advisoryId(via.url) ?? `advisory-${via.source ?? 'unknown'}`;
      const severity = String(via.severity ?? v.severity ?? 'unknown');
      const key = `${id}|${pkg}`;
      if (!seen.has(key)) seen.set(key, { id, package: pkg, severity, title: String(via.title ?? ''), url: String(via.url ?? '') });
    }
  }

  const blocking = [], excepted = [], below = [];
  const used = new Set();
  for (const a of seen.values()) {
    const rank = RANK[a.severity];
    if (rank === undefined) { blocking.push({ ...a, why: `unknown severity "${a.severity}"` }); continue; }
    if (rank < RANK[level]) { below.push(a); continue; }
    const ex = exceptions.find((e) => e?.id === a.id && e?.package === a.package);
    if (!ex) { blocking.push({ ...a, why: 'no exception' }); continue; }
    used.add(ex);
    if (ex.expires < today) { blocking.push({ ...a, why: `exception expired ${ex.expires}` }); continue; }
    excepted.push({ ...a, expires: ex.expires, reason: ex.reason });
  }
  const unused = exceptions.filter((e) => !used.has(e)).map((e) => e?.id ?? '?');
  return { level, blocking, excepted, below, unused, problems, pass: blocking.length === 0 && problems.length === 0 };
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const level = arg('level') ?? 'moderate';
  const exceptionsPath = arg('exceptions');
  const today = arg('today') ?? new Date().toISOString().slice(0, 10);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let report;
  try { report = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { console.error('audit-gate: stdin is not JSON (pipe `npm audit --json` into it)'); process.exit(1); }
  let doc = { exceptions: [] };
  if (exceptionsPath) {
    try { doc = JSON.parse(readFileSync(exceptionsPath, 'utf8')); }
    catch (e) { console.error(`audit-gate: cannot read exceptions ${exceptionsPath}: ${e.message}`); process.exit(1); }
  }
  let r;
  try { r = evaluateAudit(report, doc, { level, today }); }
  catch (e) { console.error(`audit-gate: ${e.message}`); process.exit(1); }

  const line = (a) => `  ${a.severity.padEnd(8)} ${a.package}  ${a.id}  ${a.title}`;
  console.log(`audit-gate — level ${level}, ${today}`);
  if (r.blocking.length) { console.log(`BLOCKING (${r.blocking.length}):`); r.blocking.forEach((a) => console.log(`${line(a)}  [${a.why}]`)); }
  if (r.excepted.length) { console.log(`EXCEPTED (${r.excepted.length}) — still present, allowed until the date shown:`); r.excepted.forEach((a) => console.log(`${line(a)}  [until ${a.expires}] ${a.reason}`)); }
  if (r.below.length) { console.log(`below ${level}, not blocking (${r.below.length}):`); r.below.forEach((a) => console.log(line(a))); }
  // The file is shared by every lockfile the workflow audits, so 'not matched here' is not 'stale'.
  if (r.unused.length) console.log(`exceptions not matched by this lockfile: ${r.unused.join(', ')} (remove one only when no audited lockfile matches it)`);
  r.problems.forEach((p) => console.log(`EXCEPTIONS FILE: ${p}`));
  console.log(r.pass ? 'PASS' : 'FAIL');
  process.exit(r.pass ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
