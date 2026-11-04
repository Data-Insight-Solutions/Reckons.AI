/**
 * JOB BRIEF (F273 phase 0, SCRIPT tier) — a brief is built from a job spec, or not at all.
 *
 * "Define done before code": rewriting is the most expensive form of speed, and code written
 * before its done-test exists gets written twice. So a roadmap entity must carry
 *   kpred:done-test  the check that fails now and passes when the job is done
 *   kpred:evidence   the failure it fixes, dated
 *   kpred:extends    what it builds on (so no parallel mechanism)
 *   kpred:non-goal   what it will not do
 * and this refuses to produce a brief while any is missing, naming each one. Pure core: text in,
 * result out; the CLI is `npm run brief -- --entity=<iri|kb:slug|slug>`.
 *
 * HONEST LIMIT: it checks that the four fields are present and non-blank, not that they are good.
 * A done-test of "it works" passes this gate. Judging the spec is still a person's job.
 */
import { Parser } from 'n3';

const KPRED = 'urn:kbase:predicate/';
const KB = 'urn:kbase:concept/';
export const REQUIRED = ['done-test', 'evidence', 'extends', 'non-goal'] as const;

/** The rules every job brief carries, whoever writes the job. Each one was a recorded slip. */
export const INVARIANTS = [
  'Pull requests target base `dev`, never `main`. Never merge, never force-push. Verify the base with `gh pr view <n> --json baseRefName`.',
  'Do NOT run `npm ci` or `npm install` in a worktree whose node_modules is a symlink: it empties the main checkout (2026-10-20, 2026-10-28). The shared install is already there; just run the tests.',
  'Write the done-tests first and watch them fail, then implement until they pass. Do not change a test to fit the code.',
  'Commits made by an agent end with ONE trailer block, no blank line inside it: `Model: <id>`, `Intent: <the request>`, `Co-Authored-By: <model> <noreply@anthropic.com>`.',
  'STOP and report instead of pushing on when: CI fails twice, a done-test turns out wrong or unbuildable, or a step exceeds its stated budget. Ask; do not guess.',
  'Say what is not true: report failures as loudly as successes, and date any claim that can go stale.',
  'End the report with a final line `LOCAL-TIER LEDGER:` naming what ran on the script tier or a local model, or "none".',
];

export interface JobBrief {
  ok: boolean;
  /** `kpred:...` names of required fields absent or blank. */
  missing: string[];
  /** Set when the entity could not be found or the TTL did not parse. */
  error?: string;
  brief?: string;
}

const toIri = (id: string) => (id.startsWith('urn:') ? id : id.startsWith('kb:') ? KB + id.slice(3) : KB + id);

export function buildJobBrief(ttl: string, entity: string): JobBrief {
  const iri = toIri(entity);
  let quads;
  try {
    quads = new Parser().parse(ttl);
  } catch (e) {
    return { ok: false, missing: [], error: `TTL did not parse: ${(e as Error).message}` };
  }
  const mine = quads.filter((q) => q.subject.value === iri);
  if (mine.length === 0) return { ok: false, missing: [], error: `entity not found: ${iri}` };
  const all = (p: string) => mine.filter((q) => q.predicate.value === KPRED + p).map((q) => q.object.value.trim()).filter(Boolean);
  const missing = REQUIRED.filter((p) => all(p).length === 0).map((p) => `kpred:${p}`);
  if (missing.length) return { ok: false, missing };
  const label = mine.find((q) => q.predicate.value.endsWith('#label'))?.object.value ?? iri;
  const id = all('feature-id')[0];
  const section = (title: string, items: string[]) => `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n`;
  const brief = [
    `# JOB: ${id ? id + ' ' : ''}${label}`,
    `Entity: ${iri}. The graph defines this job; read the entity for the full text. Build exactly it.\n`,
    section('Done-tests (write these first; they must fail now)', all('done-test')),
    section('Evidence (the failure this fixes)', all('evidence')),
    section('Extends (build on these, add no parallel mechanism)', all('extends')),
    section('Non-goals (do not do these)', all('non-goal')),
    section('Invariants (every job)', INVARIANTS),
  ].join('\n');
  return { ok: true, missing: [], brief };
}
