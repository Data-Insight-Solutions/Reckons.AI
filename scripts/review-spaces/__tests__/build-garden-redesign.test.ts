import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';
import { parseRequest } from '../../../src/lib/generation/protocol';
import { readReckoning } from '../../../src/lib/rdf/reckoning-entity';
import { extractStories } from '../../../src/lib/rdf/story';
import { buildGarden, compareOutcomes, generationRequests, jobId, laterStatements, refuseTracked, validateStory } from '../build-garden-redesign';
import * as S from '../garden-redesign-story';

const dir = () => mkdtempSync(path.join(tmpdir(), 'garden-redesign-'));

describe('garden redesign review space', () => {
  it('validates: every quoted passage is in its source and every reference resolves', () => {
    expect(validateStory()).toEqual([]);
  });

  it('emits the open question as a partial fact that names what it blocks', async () => {
    const r = await buildGarden(dir());
    const q = r.statements.filter((s) => s.needsObject);
    expect(q).toHaveLength(1);
    expect(q[0].o.value).toBe('?');
    expect(q[0].question).toBe('Which layout fits the budget?');
    expect(q[0].blocks).toEqual(S.QUESTION.blocks.map((b) => S.CONCEPT + b));
  });

  it('gives the later note a repeat, a near-duplicate, two contradictions and a new fact, per the real comparison', () => {
    const kinds = compareOutcomes();
    const by = (e: S.Outcome) => kinds.filter((k) => k.fact.expect === e).length;
    expect([by('repeat'), by('near-duplicate'), by('contradiction'), by('new')]).toEqual([1, 1, 2, 1]);
    for (const { fact, kind } of kinds) {
      // computeDiff is structural: a near-duplicate arrives as a new fact about a differently named subject
      // (the app's semantic pass upgrades it); a repeat is a reinforcement from another source.
      const expected = { repeat: 'reinforces', 'near-duplicate': 'new', contradiction: 'conflicts', new: 'new' }[fact.expect];
      expect(kind, `${fact.s} ${fact.p}`).toBe(expected);
    }
    const near = S.LATER_FACTS.find((f) => f.expect === 'near-duplicate')!;
    expect(S.HELD.some((h) => h.p === near.p && h.s !== near.s && near.s.startsWith(h.s))).toBe(true);
  });

  it('keeps the later note pending and every held fact confirmed', async () => {
    const later = new Set(laterStatements().map((s) => s.id));
    const r = await buildGarden(dir());
    for (const s of r.statements.filter((x) => x.sourceId === S.LATER_NOTE.id)) expect(s.status).toBe('pending');
    expect(r.statements.filter((s) => later.has(s.id))).toHaveLength(S.LATER_FACTS.length);
    for (const f of S.HELD) expect(r.statements.find((s) => s.sourceId === f.source && s.p.value === S.PRED + f.p)?.status).toBe('confirmed');
  });

  it('writes two reckonings: one aimed at the question, one at an image', async () => {
    const r = await buildGarden(dir());
    const [a, b] = S.RECKONINGS.map((k) => readReckoning(r.statements, k.id)!);
    expect(a.statementIds).toHaveLength(4);
    expect(a.target.statementId).toBe(r.statements.find((s) => s.needsObject)!.id);
    expect(b.target.assetType).toBe('urn:kbase:type/Image');
    for (const id of [...a.statementIds, ...b.statementIds]) expect(r.statements.some((s) => s.id === id)).toBe(true);
  });

  it('has a story with one step per feature, each highlighting entities the space holds', async () => {
    const r = await buildGarden(dir());
    const [story] = extractStories(r.statements);
    expect(story.steps.map((s, i) => [s.order, S.WALK[i].feature])).toEqual(S.WALK.map((w, i) => [i + 1, w.feature]));
    for (const f of ['reckoning', 'compare', 'cad', 'hub-assets']) expect(S.WALK.filter((w) => w.feature === f)).toHaveLength(1);
    expect(story.steps.filter((s) => s.question).length).toBeGreaterThanOrEqual(2);
    const subjects = new Set(r.statements.map((s) => s.s.value));
    for (const step of story.steps) for (const h of step.highlights) expect(subjects.has(h), h).toBe(true);
  });

  it('writes Turtle that parses, with containment and dates', async () => {
    const r = await buildGarden(dir());
    const quads = new Parser({ format: 'text/turtle' }).parse(r.ttl);
    expect(quads.length).toBeGreaterThan(100);
    expect(r.ttl).toContain('Larkspur Lane');
    expect(r.statements.filter((s) => s.p.value.endsWith('broader')).length).toBeGreaterThan(10);
    expect(r.statements.filter((s) => /scheduled-at|due-at/.test(s.p.value)).length).toBe(S.ENTITIES.filter((e) => e.date).length);
  });

  it('requests a picture per slot and one splat chained from the garden picture, with stable valid ids', () => {
    const reqs = generationRequests();
    expect(reqs.filter((r) => r.stage === 'image')).toHaveLength(S.SLOTS.length);
    const splat = reqs.filter((r) => r.stage === 'splat');
    expect(splat).toHaveLength(1);
    expect(splat[0].parentId).toBe(jobId('garden/image'));
    expect(reqs.map((r) => parseRequest(r).id)).toEqual(generationRequests().map((r) => r.id));
    expect(new Set(reqs.map((r) => r.id)).size).toBe(reqs.length);
    for (const p of S.SLOTS.filter((x) => x.kind === 'portrait')) expect(p.prompt).toMatch(/not a real person/);
  });

  it('leaves unmade pictures empty instead of inventing a placeholder', async () => {
    const r = await buildGarden(dir());
    expect(r.empty).toContain('picture: garden');
    expect(r.statements.some((s) => s.p.value === 'urn:kbase:asset/preview')).toBe(false);
    expect(r.copies).toEqual([]);
  });

  it('refuses a workspace inside a tracked folder of the repository', () => {
    expect(() => refuseTracked(path.resolve(__dirname, '../../../static/x'))).toThrow(/never written under a tracked folder/);
    expect(() => refuseTracked(path.join(tmpdir(), 'ws'))).not.toThrow();
  });
});

