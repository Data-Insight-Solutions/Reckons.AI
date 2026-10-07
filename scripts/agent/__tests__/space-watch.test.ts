/** space-watch question answering: grounded by script, cites validated, no cites = left open. Mocked model. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processSpace, loadStatements, openQuestions, relevantStatements, type ModelFn } from '../space-watch.js';

const S = 'urn:kbase:concept/harbour-light-fund';
const TTL = `@prefix p: <urn:kbase:predicate/> .
<${S}> p:deadline "2027-03-15" ; p:funder "Harbour Light Foundation" .
<urn:kbase:concept/unrelated> p:colour "teal" .
`;
function space(question: object) {
  const dir = mkdtempSync(join(tmpdir(), 'space-watch-'));
  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ host: 'h', until: '2999-01-01T00:00:00Z' }));
  writeFileSync(join(dir, 'space.ttl'), TTL);
  writeFileSync(join(dir, 'knowledge.pending.jsonl'), JSON.stringify(question) + '\n');
  return dir;
}
const Q = { kb: 'demo', subject: S, predicate: 'urn:kbase:predicate/deadline', question: 'When is the deadline?', type: 'question' };
const run = (dir: string, call: ModelFn) => processSpace({ dir, host: 'h', model: 'mock', call });
const rows = (dir: string) => readFileSync(join(dir, 'host.pending.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('open questions', () => {
  it('only partial facts count; relevant statements are chosen by subject/predicate, not the whole space', () => {
    const dir = space(Q);
    // a row that already has an object is not a question
    writeFileSync(join(dir, 'knowledge.pending.jsonl'), readFileSync(join(dir, 'knowledge.pending.jsonl'), 'utf8')
      + JSON.stringify({ subject: S, predicate: 'urn:kbase:predicate/funder', object: 'x', kb: 'demo' }) + '\n');
    expect(openQuestions(dir)).toHaveLength(1);
    const rel = relevantStatements(Q, loadStatements(dir));
    expect(rel.map((s) => s.object).sort()).toEqual(['2027-03-15', 'Harbour Light Foundation']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a grounded answer with real cites is written to host.pending.jsonl with provenance; the app queue is untouched', async () => {
    const dir = space(Q);
    const target = loadStatements(dir).find((s) => s.object === '2027-03-15')!;
    const before = readFileSync(join(dir, 'knowledge.pending.jsonl'), 'utf8');
    let prompt = '';
    const r = await run(dir, async (p) => { prompt = p; return JSON.stringify({ answer: '2027-03-15', cites: [target.id, 'invented-id'] }); });
    expect(r.answers).toBe(1);
    expect(prompt).not.toContain('teal'); // the unrelated statement never reached the model
    const [row] = rows(dir);
    expect(row).toMatchObject({ kb: 'demo', subject: S, object: '2027-03-15', cites: [target.id], provenance: { host: 'h', model: 'mock', kind: 'answer' } });
    expect(readFileSync(join(dir, 'knowledge.pending.jsonl'), 'utf8')).toBe(before);
    expect((await run(dir, async () => { throw new Error('should not be called again'); })).answers).toBe(0);
    expect(rows(dir)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an answer citing nothing real is dropped and the question stays open', async () => {
    const dir = space(Q);
    const r = await run(dir, async () => JSON.stringify({ answer: 'March', cites: ['made-up'] }));
    expect(r).toMatchObject({ answers: 0, leftOpen: 1 });
    expect(existsSync(join(dir, 'host.pending.jsonl'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('no relevant statements: the model is not even called', async () => {
    const dir = space({ ...Q, subject: 'urn:kbase:concept/nothing', predicate: 'urn:kbase:predicate/none' });
    const r = await run(dir, async () => { throw new Error('must not be called'); });
    expect(r).toMatchObject({ answers: 0, leftOpen: 1 });
    rmSync(dir, { recursive: true, force: true });
  });
});
