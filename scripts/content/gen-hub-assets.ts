#!/usr/bin/env npx tsx
/**
 * F278: queue default assets for the hubs of a bundled example space.
 *
 *   npm run assets:hubs -- --space=<example id | starter file> [--limit=N] [--dry-run]
 *
 * Dry run prints the plan (which hubs, the grounded prompt, the facts it came from) and writes
 * nothing. A real run writes one typed request per image and per splat into a PRIVATE generation
 * folder (outside the checkout: $XDG_STATE_HOME/reckons/hub-assets/<space>), then adds ONE chained
 * pair of jobs per hub to the shared local queue (scripts/agent/queue.ts): the splat job lists its
 * image job in --after, so a failed image never reaches the GPU twice for the splat. It never runs
 * generation inline and never touches a space: results come back through the app's own attach path
 * as PENDING assets (attach.ts) that a person keeps or rejects.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Parser } from 'n3';
import { EXAMPLE_KBS } from '../../src/lib/storage/example-kbs';
import type { Statement, Term } from '../../src/lib/rdf/types';
import { addJobs, newJob } from '../agent/session-queue.js';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';
import { planHubAssets, type HubAssetPlan } from './hub-assets';
import { atomic, queueJobName } from './generation-runner';
import { GENERATION_DIR } from '../../src/lib/generation/protocol';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** A bundled TTL as confirmed statements: bundled examples are the author's own, so they load confirmed. */
export function statementsFromTtl(ttl: string): Statement[] {
  const term = (t: { termType: string; value: string; datatype?: { value: string }; language?: string }): Term =>
    t.termType === 'Literal' ? { kind: 'literal', value: t.value, ...(t.language ? { lang: t.language } : {}) } as Term
      : t.termType === 'BlankNode' ? { kind: 'bnode', value: t.value } as Term : { kind: 'iri', value: t.value };
  return new Parser().parse(ttl).map((q, i) => ({
    id: `b${i}`, s: term(q.subject), p: term(q.predicate), o: term(q.object), g: { kind: 'iri', value: 'urn:hub-assets' },
    sourceId: 'bundled', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0,
  }) as unknown as Statement);
}

export function resolveSpaceFile(id: string): string | undefined {
  const listed = EXAMPLE_KBS.find((e) => e.id === id);
  const candidates = [listed?.file.replace(/^\//, ''), `starter-${id}.ttl`, `${id}.ttl`].filter((x): x is string => !!x);
  return candidates.map((f) => path.join(ROOT, 'static', f)).find((f) => existsSync(f));
}

export function printPlan(id: string, plan: HubAssetPlan): string {
  const lines = [`SPACE ${id}: ${plan.items.length} hub(s) planned, ${plan.refused.length} refused, ${plan.skippedHavingAssets} already have an asset`];
  for (const item of plan.items) {
    lines.push(`  ${item.label}${item.person ? ' (person: neutral portrait)' : ''}`,
      `    image ${item.image.id.slice(0, 8)}  prompt: ${item.image.prompt}`,
      `    splat ${item.splat.id.slice(0, 8)}  waits for image ${item.image.id.slice(0, 8)}`);
  }
  for (const r of plan.refused.slice(0, 10)) lines.push(`  REFUSED ${r.hub}: ${r.reason}`);
  if (plan.refused.length > 10) lines.push(`  ... and ${plan.refused.length - 10} more refused`);
  return lines.join('\n');
}

function main() {
  const flag = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const space = flag('space');
  const limit = flag('limit') !== undefined ? Number(flag('limit')) : undefined;
  const dry = process.argv.includes('--dry-run');
  if (!space || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) {
    console.error('Usage: assets:hubs --space=<bundled example id> [--limit=N] [--dry-run]');
    process.exit(2);
  }
  const file = resolveSpaceFile(space);
  if (!file) { console.error(`No bundled space "${space}" (looked in EXAMPLE_KBS and static/starter-*.ttl).`); process.exit(2); }
  const plan = planHubAssets(statementsFromTtl(readFileSync(file, 'utf8')), { spaceId: space, limit });
  console.log(printPlan(space, plan));
  if (dry || plan.items.length === 0) { console.log(dry ? 'DRY RUN: nothing written, nothing queued.' : 'Nothing to queue.'); return; }

  const state = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  const jobs = path.join(state, 'reckons', 'hub-assets', space, GENERATION_DIR, 'jobs');
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  // The jobs run the main checkout's runner (this worktree may be gone by the time the GPU is free).
  const main = mainCheckoutRoot();
  const runner = path.join(main, 'scripts', 'content', 'generation-runner.ts');
  const queued: string[] = [];
  for (const item of plan.items) {
    const names: string[] = [];
    for (const request of [item.image, item.splat]) {
      const dir = path.join(jobs, request.id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      atomic(path.join(dir, 'request.json'), request);
      // Marked as queued so a gen:serve runner on this folder never adds a second copy.
      atomic(path.join(dir, 'enqueued.json'), { name: queueJobName(request), at: new Date().toISOString() });
      const after = request.stage === 'splat' ? [queueJobName(item.image)] : undefined;
      const job = newJob(queueJobName(request), main, [process.execPath, '--import', 'tsx', runner, `--job=${dir}`], undefined, true, after, undefined, false);
      const r = addJobs([job]);
      queued.push(`${request.stage} ${item.label}: ${r.add[0]?.id ?? '(already queued)'} (${queueJobName(request)})`);
      names.push(queueJobName(request));
    }
  }
  console.log(`QUEUED ${queued.length} job(s) from ${jobs}`);
  for (const q of queued) console.log(`  ${q}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main();
