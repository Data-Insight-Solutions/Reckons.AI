/**
 * THE ONE READER of the offline jobs (F216). static/reckons-jobs.ttl is the source; this returns
 * the shape scripts/offline/run-all.ts uses, in file order (hnav:order), so the run order and every
 * flag are exactly what the graph says. mcp-server/src/local-jobs.ts reads the same file with its
 * own N3 code because that package cannot import scripts/ (kept in step by its test).
 *
 * A job missing its label, tier or command throws: a silently skipped job is a check that stopped
 * running and nobody noticed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Parser } from 'n3';

const P = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';
const ORDER = 'urn:reckons:nav/order';
const OFFLINE_JOB = 'urn:kbase:type/OfflineJob';

export type JobTier = 'script' | 'agent';
export interface Job {
  name: string;
  cmd: string;
  desc?: string;
  enabled: boolean;
  tier: JobTier;
  /** Under --ci, a failure here fails the build. */
  blocking?: boolean;
  /** false = the command no longer writes to the review queue, so back-pressure must not hold it. */
  queues?: boolean;
}

export const jobsGraphPath = (root = process.cwd()): string => path.join(root, 'static', 'reckons-jobs.ttl');

export function parseJobs(ttl: string): Job[] {
  const by = new Map<string, Record<string, string>>();
  for (const q of new Parser().parse(ttl)) {
    const p = q.predicate.value;
    const key = p === RDF_TYPE ? 'type' : p === LABEL ? 'label' : p === DEFINITION ? 'desc' : p === ORDER ? 'order' : p.startsWith(P) ? p.slice(P.length) : '';
    if (!key) continue;
    const o = by.get(q.subject.value) ?? {};
    o[key] = q.object.value;
    by.set(q.subject.value, o);
  }
  const rows = [...by].filter(([, o]) => o.type === OFFLINE_JOB);
  const jobs = rows.map(([iri, o], i) => {
    const bad = (what: string) => new Error(`jobs graph: ${iri} has no ${what}`);
    if (!o.label) throw bad('rdfs:label');
    if (o['job-tier'] !== 'script' && o['job-tier'] !== 'agent') throw bad('kpred:job-tier of script or agent');
    if (!o.command) throw bad('kpred:command');
    const order = o.order !== undefined && Number.isFinite(Number(o.order)) ? Number(o.order) : 1e6 + i;
    const job: Job = {
      name: o.label, cmd: o.command, enabled: o['job-enabled'] !== 'false', tier: o['job-tier'],
      ...(o.desc ? { desc: o.desc } : {}),
      ...(o['job-blocking'] === 'true' ? { blocking: true } : {}),
      ...(o['job-queues'] === 'false' ? { queues: false } : {}),
    };
    return { job, order };
  });
  return jobs.sort((a, b) => a.order - b.order).map((x) => x.job);
}

export function readJobs(root = process.cwd()): Job[] {
  return parseJobs(readFileSync(jobsGraphPath(root), 'utf8'));
}
