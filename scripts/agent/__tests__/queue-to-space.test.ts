import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRecords, buildSpaceText, type JobRecord } from '../queue-to-space.js';
import { importTurtleFull } from '../../../src/lib/rdf/import-ttl.js';

/**
 * The job-plan space, end to end: synthetic queue files in a TEMP dir (never the live queue),
 * the pure writer, and a round-trip through the app's real importer to prove the app renders
 * every job with its status, the type declaration, the source, and the after-edges.
 */

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const JOB_TYPE = 'urn:kbase:type/Job';
const ENTITY_TYPE = 'urn:kbase:type/EntityType';
const P = 'urn:kbase:predicate/';

let dir: string;
let logPath: string;

// The git stub keeps branch/head deterministic and hermetic (the temp dir is not a repo).
const git = (cwd: string, args: string[]): string =>
  args.includes('--show-current') ? 'agent/test' : args.includes('HEAD') ? 'abc1234' : '';
// Only this pid is "alive": the beta job is running, the zeta job is a stale entry.
const alive = (pid: number): boolean => pid === 424242;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'queue-to-space-'));
  logPath = path.join(dir, 'beta-2026-11-04T11-00-00-000Z.log');

  writeFileSync(path.join(dir, 'queue.jsonl'), [
    `{"id":"aaa111","name":"alpha","cwd":"/tmp/proj","addedAt":"2026-11-04T10:00:00.000Z","priority":2,"after":["beta"]}`,
    `{"id":"bbb222","name":"beta","cwd":"/tmp/proj","addedAt":"2026-11-04T10:05:00.000Z"}`,
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, 'current.json'), JSON.stringify([
    { name: 'beta', pid: 424242, started: '2026-11-04T11:00:00.000Z', attempt: 1, maxAttempts: 3 },
    { name: 'zeta', pid: 1, started: '2026-11-04T11:00:00.000Z', attempt: 1, maxAttempts: 3 },
  ]));

  writeFileSync(path.join(dir, 'queue.done.jsonl'), [
    `{"id":"ccc333","name":"gamma","cwd":"/tmp/proj","addedAt":"2026-11-04T09:00:00.000Z","finishedAt":"2026-11-04T09:30:00.000Z","outcome":"passed","exitCode":0}`,
    `{"id":"ddd444","name":"delta","cwd":"/tmp/proj","addedAt":"2026-11-04T08:00:00.000Z","finishedAt":"2026-11-04T08:30:00.000Z","outcome":"refused","exitCode":3}`,
    `{"id":"eee555","name":"epsilon","cwd":"/tmp/proj","finishedAt":"2026-11-01T00:00:00.000Z","outcome":"passed"}`,
  ].join('\n'));

  writeFileSync(logPath, 'beta ran\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const records = (): JobRecord[] => buildRecords(dir, NOW, { git, alive });

const strip = (t: string): string => t.split('\n').filter((l) => !l.startsWith('# generated')).join('\n');

describe('buildRecords (the three queue files)', () => {
  it('reads queued, running and the last-48h finished, and drops a stale running pid', () => {
    const recs = records().sort((a, b) => a.name.localeCompare(b.name));
    expect(recs.map((r) => r.name)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    const by = new Map(recs.map((r) => [r.name, r]));
    expect(by.get('alpha')?.status).toBe('queued');
    expect(by.get('beta')?.status).toBe('running');
    expect(by.get('beta')?.started).toBe('2026-11-04T11:00:00.000Z');
    expect(by.get('gamma')?.status).toBe('passed');
    expect(by.get('delta')?.status).toBe('blocked'); // refused maps to the app's 'blocked'
    expect(by.get('alpha')?.after).toEqual(['beta']);
    // branch/head come from git in the job's cwd; log is the newest matching file.
    expect(by.get('alpha')?.branch).toBe('agent/test');
    expect(by.get('alpha')?.head).toBe('abc1234');
    expect(by.get('beta')?.log).toBe(logPath);
  });
});

describe('the space, through the app importer', () => {
  it('imports every job with its status, the type, the source, and the after-edge', async () => {
    const text = buildSpaceText(records(), NOW);
    const result = await importTurtleFull(text);

    const has = (s: string, p: string, o: string): boolean =>
      result.statements.some((st) => st.s.value === s && st.p.value === p && (st.o as { value: string }).value === o);

    // Every job, with its status.
    expect(has('urn:kbase:concept/job-aaa111', `${P}status`, 'queued')).toBe(true);
    expect(has('urn:kbase:concept/job-bbb222', `${P}status`, 'running')).toBe(true);
    expect(has('urn:kbase:concept/job-ccc333', `${P}status`, 'passed')).toBe(true);
    expect(has('urn:kbase:concept/job-ddd444', `${P}status`, 'blocked')).toBe(true);

    // Typed as the Job entity type, labelled, and the Job type is declared as an EntityType.
    expect(has('urn:kbase:concept/job-aaa111', RDF_TYPE, JOB_TYPE)).toBe(true);
    expect(has('urn:kbase:concept/job-aaa111', RDFS_LABEL, 'alpha')).toBe(true);
    expect(has(JOB_TYPE, RDF_TYPE, ENTITY_TYPE)).toBe(true);
    expect(has(JOB_TYPE, RDFS_LABEL, 'Job')).toBe(true);

    // An 'after' field becomes a job-after edge to the resolved job node.
    expect(has('urn:kbase:concept/job-aaa111', `${P}job-after`, 'urn:kbase:concept/job-bbb222')).toBe(true);

    // The Job type carries a shape and a colour.
    expect(has(JOB_TYPE, `${P}icon`, 'box')).toBe(true);
    expect(has(JOB_TYPE, `${P}color`, '#5b2a86')).toBe(true);

    // The source is declared and imported by title.
    expect(result.sources.some((src) => src.id === 'local-job-queue' && src.title === 'Local job queue')).toBe(true);

    // Every imported fact is confirmed, full-confidence, and derived from the source.
    expect(result.statements.length).toBeGreaterThan(0);
    for (const st of result.statements) {
      expect(st.status).toBe('confirmed');
      expect(st.confidence).toBe(1);
      expect((st.g as { value: string }).value).toBe('urn:kbase:source/local-job-queue');
    }

    // The header's statement count agrees with what actually imported.
    const n = Number(text.match(/# (\d+) statements/)?.[1]);
    expect(result.statements.length).toBe(n);
  });

  it('is deterministic: two runs over the same input differ only in the generated-at line', () => {
    const recs = records();
    const t1 = buildSpaceText(recs, NOW);
    const t2 = buildSpaceText(recs, NOW + 60_000);
    expect(t1.split('\n')[0]).not.toBe(t2.split('\n')[0]); // the only variable line moves
    expect(strip(t1)).toBe(strip(t2)); // everything else is byte-identical
  });
});
