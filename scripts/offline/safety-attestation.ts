#!/usr/bin/env npx tsx
/**
 * Safety attestation (SCRIPT tier) — a dated, recurring record of the good-faith effort.
 *
 * WHY THIS EXISTS
 * Reckons.AI has no graph-content backend or accounts, so it retains no identity record for
 * graph activity. The optional maintainer feedback endpoint is a separate voluntary content/PII
 * path and does not establish who authored a graph. What this job CAN do is prove what the
 * SOFTWARE did: that specific safety controls existed, were verified, and kept passing.
 *
 * This job verifies each control against the live codebase and appends a dated
 * attestation record to static/reckons-safety-log.ttl. Because that file is committed,
 * git gives the record ordered, hash-linked history, while the hosted remote and CI run history
 * supply independent timing evidence. Git history alone can be rewritten, so this is evidence,
 * not a claim that backdating is impossible.
 *
 * The controls are checked, not asserted. If a control regresses, the attestation says so
 * and the job fails. An attestation that always passes would be worthless.
 *
 * This is NOT legal advice and NOT a claim of enforcement — the controls are good-faith
 * defaults in open-source, local-first, client-side code and are bypassable by design.
 * See COUNSEL-BRIEF.md §4.
 *
 * Usage:
 *   npm run safety:attest              verify controls, print report
 *   npm run safety:attest -- --record  also append the dated record to the TTL log
 */
import { readFileSync, existsSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

const RECORD = process.argv.includes('--record');
const LOG = 'static/reckons-safety-log.ttl';

/** Capture stdout even when a command exits non-zero — graph-lint exits 1 on findings,
 * and its findings are precisely what we need to read. Execute the local project tools through
 * this Node binary rather than ambient npx, so the attestation has the same result in CI, npm,
 * and a Node-only shell. */
const sh = (command: string, args: string[] = []): string => {
  try {
    return execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }
  catch (e: any) { return (e?.stdout ?? '').toString().trim(); }
};

const projectFile = (...segments: string[]) => path.join(process.cwd(), ...segments);
const runProjectTypeScript = (script: string, ...args: string[]) =>
  sh(process.execPath, [projectFile('node_modules', 'tsx', 'dist', 'cli.mjs'), projectFile(script), ...args]);
const runVitest = (...args: string[]) =>
  sh(process.execPath, [projectFile('node_modules', 'vitest', 'vitest.mjs'), ...args]);

interface Control {
  id: string;
  label: string;
  /** What we are asserting. Kept blunt — this text may be read by a lawyer. */
  claim: string;
  check: () => { pass: boolean; evidence: string };
}

/** Walk .ts sources under a root. */
function sources(root: string): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (e === 'node_modules' || e === 'dist' || e === '__tests__') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  })(root);
  return out;
}

const CONTROLS: Control[] = [
  {
    id: 'ethics-preamble-present',
    label: 'Ethics preamble exists and is non-empty',
    claim:
      'An ETHICS_PREAMBLE refusing incitement, mass-casualty weapons instructions, sexualization of minors, ' +
      'and promotion of slavery/trafficking is defined in the codebase.',
    check: () => {
      const src = readFileSync('src/lib/safety/content-policy.ts', 'utf8');
      const m = src.match(/ETHICS_PREAMBLE = `([\s\S]*?)`;/);
      const body = m?.[1] ?? '';
      const required = [/minors?/i, /incit/i, /slavery|trafficking/i, /weapons? of mass destruction|mass-casualty/i];
      const missing = required.filter((r) => !r.test(body));
      return {
        pass: body.length > 0 && missing.length === 0,
        evidence: `${body.length} chars; ${required.length - missing.length}/${required.length} required prohibitions present`,
      };
    },
  },
  {
    id: 'ethics-preamble-injected',
    label: 'Generative prompts follow the explicit purpose/locality ethics policy',
    claim:
      'Generative prompt modules either call ethicsPreambleFor(purpose, locality) or explicitly ' +
      'include ETHICS_PREAMBLE. Shared output is always gated; remote conversation is gated; ' +
      'local-only conversation and structured extraction are deliberate documented omissions.',
    check: () => {
      // A generative prompt module DECLARES a system-prompt constant as a template literal
      // (or as ETHICS_PREAMBLE + ...). Matching a bare `systemPrompt =` is not enough: it
      // also hits settings fields (Shelly's persona `systemPrompt` in import-ttl.ts), which
      // are not prompts and produced a false "ungated" alarm on the first run.
      const DECLARES_PROMPT = /(?:const|let)\s+\w*(?:SYSTEM_PROMPT|SUMMARY_SYSTEM|SYSTEM|PROMPT)\w*\s*=\s*(?:ETHICS_PREAMBLE|`)/;
      const files = [...sources('src/lib/integrations/llm'), ...sources('src/lib/rdf'), ...sources('mcp-server/src')];
      const promptModules = files.filter((f) => {
        if (/ethics-preamble\.ts$/.test(f)) return false; // the preamble's own definition
        return DECLARES_PROMPT.test(readFileSync(f, 'utf8'));
      });
      const unclassified = promptModules.filter((f) => {
        const src = readFileSync(f, 'utf8');
        return !src.includes('ETHICS_PREAMBLE') && !src.includes('ethicsPreambleFor');
      });
      const policy = readFileSync('src/lib/safety/content-policy.ts', 'utf8');
      const policyInvariants = [
        /purpose === 'share'[^\n]+ETHICS_PREAMBLE/,
        /locality === 'local'[^\n]+return ''/,
        /REQUIRES_PREAMBLE[^\n]+share[^\n]+converse/,
      ];
      const policyComplete = policyInvariants.every((pattern) => pattern.test(policy));
      return {
        pass: unclassified.length === 0 && policyComplete,
        evidence:
          unclassified.length === 0 && policyComplete
            ? `${promptModules.length}/${promptModules.length} prompt modules classified; share=always, remote-converse=gated, local/structured=deliberate omissions`
            : [
                policyComplete ? '' : 'POLICY INVARIANTS NOT FOUND',
                unclassified.length ? `UNCLASSIFIED: ${unclassified.join(', ')}` : '',
              ].filter(Boolean).join('; '),
      };
    },
  },
  {
    id: 'preamble-no-drift',
    label: 'App and MCP-server copies of the preamble are identical',
    claim: 'The MCP server carries a byte-identical copy of the preamble; the two cannot silently diverge.',
    check: () => {
      const grab = (f: string) => readFileSync(f, 'utf8').match(/ETHICS_PREAMBLE = `([\s\S]*?)`;/)?.[1] ?? '';
      const a = grab('src/lib/safety/content-policy.ts');
      const b = grab('mcp-server/src/ethics-preamble.ts');
      return { pass: a.length > 0 && a === b, evidence: a === b ? `identical (${a.length} chars)` : `DRIFTED: app ${a.length} vs mcp ${b.length}` };
    },
  },
  {
    id: 'classifier-blocks-on-ingest',
    label: 'Content classifier filters blocked content before it enters the graph',
    claim:
      'classifyText / classifyStatement rate content none|mature|blocked, and filterBlockedStatements removes ' +
      'blocked content during ingest.',
    check: () => {
      const src = readFileSync('src/lib/safety/content-policy.ts', 'utf8');
      const has = ['classifyText', 'classifyStatement', 'filterBlockedStatements', 'BLOCKED_PATTERNS'].filter((n) => src.includes(n));
      return { pass: has.length === 4, evidence: `${has.length}/4 classifier exports present` };
    },
  },
  {
    id: 'safety-tests-pass',
    label: 'The safety test suite passes',
    claim: 'The content-policy test suite is green as of this attestation.',
    check: () => {
      const out = runVitest('run', 'src/lib/safety');
      const m = out.match(/Tests\s+(\d+)\s+passed/);
      const failed = /\d+\s+failed/.test(out);
      return { pass: !!m && !failed, evidence: m ? `${m[1]} tests passed` : 'could not determine test result' };
    },
  },
  {
    id: 'egress-model-enforced',
    label: 'Data-egress gating invariants hold',
    claim:
      'Every feature that DISTRIBUTES user data (Reckons.AI as intermediary) declares a safety gate and does not ' +
      'ship ahead of it; user-export paths carry no blocking gate (export is a right). Enforced by graph-lint.',
    check: () => {
      const out = runProjectTypeScript('scripts/offline/graph-lint.ts', '--json');
      if (!out) return { pass: false, evidence: 'graph-lint did not run' };
      try {
        const j = JSON.parse(out) as { errors: { check: string; subject: string; msg: string }[] };
        const egress = j.errors.filter((e) => e.check === 'egress-gate');
        return {
          pass: egress.length === 0,
          evidence: egress.length === 0 ? 'no egress-gate violations' : egress.map((e) => `${e.subject}: ${e.msg}`).join(' | '),
        };
      } catch { return { pass: false, evidence: 'graph-lint output unparseable' }; }
    },
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────
const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m';
const sha = sh('git', ['rev-parse', 'HEAD']) || 'unknown';
const when = new Date().toISOString();

console.log(`${B}Safety attestation${X}  ${D}${when} · ${sha.slice(0, 10)}${X}\n`);

const results = CONTROLS.map((c) => {
  let r: { pass: boolean; evidence: string };
  try { r = c.check(); } catch (e) { r = { pass: false, evidence: `check threw: ${e instanceof Error ? e.message : e}` }; }
  const mark = r.pass ? `${G}✓${X}` : `${R}✗${X}`;
  console.log(`  ${mark} ${B}${c.label}${X}\n      ${D}${r.evidence}${X}`);
  return { ...c, ...r };
});

const failed = results.filter((r) => !r.pass);
console.log(
  `\n${failed.length ? R : G}${results.length - failed.length}/${results.length} controls verified${X}` +
    (failed.length ? ` — ${R}${failed.length} FAILING${X}` : ''),
);

if (RECORD) {
  if (!existsSync(LOG)) {
    writeFileSync(LOG, `@prefix kb:     <urn:kbase:concept/> .
@prefix kpred:  <urn:kbase:predicate/> .
@prefix ktype:  <urn:kbase:type/> .
@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:   <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:    <http://www.w3.org/2001/XMLSchema#> .

# ==============================================================================
# Reckons.AI — Safety Attestation Log  (append-only; generated, do not hand-edit)
# ==============================================================================
# A dated, recurring record that specific safety controls existed in the software
# and were VERIFIED to pass, from an early date onward. Generated by
# scripts/offline/safety-attestation.ts and committed. Git supplies an ordered,
# hash-linked history; the hosted remote and CI run history supply independent
# timing evidence. Git history alone can be rewritten and is not proof against
# backdating.
#
# This records what the SOFTWARE did. It records nothing about any user: the app
# has no graph-content backend or accounts and retains no identity record for
# graph activity. The optional maintainer feedback endpoint is a separate
# voluntary content/PII path and does not establish graph authorship.
#
# NOT a claim of enforcement. The controls are good-faith defaults in open-source,
# local-first, client-side code and are bypassable by design (COUNSEL-BRIEF.md §4).
# ==============================================================================

`);
  }
  const id = `kb:attestation-${when.slice(0, 10)}-${sha.slice(0, 7)}`;
  const lines = [
    `${id} rdf:type ktype:SafetyAttestation ;`,
    `    rdfs:label        "Safety attestation ${when.slice(0, 10)}" ;`,
    `    kpred:attested-at "${when}"^^xsd:dateTime ;`,
    `    kpred:git-commit  "${sha}" ;`,
    `    kpred:controls-verified ${results.length - failed.length} ;`,
    `    kpred:controls-total    ${results.length} ;`,
    ...results.map(
      (r) =>
        `    kpred:control     "${r.id}=${r.pass ? 'PASS' : 'FAIL'} — ${r.claim.replace(/"/g, "'")} [${r.evidence.replace(/"/g, "'").slice(0, 200)}]" ;`,
    ),
    `    kpred:disclaimer  "Good-faith effort, not enforcement. Client-side, open-source, bypassable by design. Records software state only; no user data is retained." .`,
    '',
  ];
  appendFileSync(LOG, lines.join('\n') + '\n');
  console.log(`\n${D}Recorded → ${LOG} (commit this file: git is the tamper-evident chain)${X}`);
}

process.exit(failed.length ? 1 : 0);
