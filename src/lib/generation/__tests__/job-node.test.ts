import { describe, expect, it } from 'vitest';
import { JOB_TYPE, jobEntity, jobStatements, jobStateRowId, producedStatement } from '../job-node';
import { validateJobPlan, describePlan, MAX_PLAN_STEPS } from '../job-plan';
import { parseTasks } from '$lib/rdf/agent-task';
import { isMetaPredicate } from '$lib/rdf/types';
import { BUILT_IN_TYPES } from '$lib/rdf/entity-types';
import type { GenerationCapabilities, GenerationRequest } from '../protocol';

const image: GenerationRequest = { version: 1, id: 'd67cf353-5af2-404b-b93d-41d10ffb6f15', spaceId: 'synthetic-kb', stage: 'image', prompt: 'A synthetic brass lantern', seed: 7 };
const splat: GenerationRequest = { ...image, id: '6c6da8a8-1574-46bb-97fd-453db308379d', stage: 'splat', parentId: image.id };
const at = Date.parse('2026-10-23T12:00:00Z');
const value = (rows: ReturnType<typeof jobStatements>, p: string) => rows.find(r => r.p.value.endsWith(p))?.o.value;

describe('Job entities (F166.1.2)', () => {
  it('records a queued job as a typed, confirmed entity with stable row ids', () => {
    const rows = jobStatements(image, 'shelly', at);
    expect(rows.every(r => r.s.value === jobEntity(image.id) && r.status === 'confirmed')).toBe(true);
    expect(value(rows, '#type')).toBe(JOB_TYPE);
    expect(value(rows, 'job-state')).toBe('queued');
    expect(value(rows, 'job-stage')).toBe('image');
    expect(value(rows, 'requested-by')).toBe('Shelly, approved by you');
    expect(rows.find(r => r.p.value.endsWith('job-state'))?.id).toBe(jobStateRowId(image.id));
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
    expect(jobStatements(image, 'shelly', at).map(r => r.id)).toEqual(rows.map(r => r.id));
  });
  it('links a derivation to the job it waits for, and a finished job to what it produced', () => {
    const rows = jobStatements(splat, 'story', at);
    expect(value(rows, 'waits-for')).toBe(jobEntity(image.id));
    expect(producedStatement(splat, at).o.value).toBe(`urn:kbase:concept/generated-${splat.id}`);
  });
  it('adds the failure reason only when the job failed', () => {
    expect(value(jobStatements(image, 'story', at, { request: image, state: 'running' }), 'job-error')).toBeUndefined();
    const failed = jobStatements(image, 'story', at, { request: image, state: 'failed', error: 'tool missing' });
    expect(value(failed, 'job-state')).toBe('failed');
    expect(value(failed, 'job-error')).toBe('tool missing');
  });
  it('is never an executable task: no command, and the task runner does not see it', () => {
    const rows = jobStatements(splat, 'shelly', at);
    expect(rows.some(r => r.p.value.endsWith('/command'))).toBe(false);
    expect(parseTasks(rows)).toEqual([]);
  });
  it('is a built-in type whose literals are attributes, while the chain stays visible edges', () => {
    expect(BUILT_IN_TYPES.some(t => t.iri === JOB_TYPE)).toBe(true);
    for (const p of ['job-state', 'job-stage', 'job-error', 'requested-by', 'queued-at']) expect(isMetaPredicate(`urn:kbase:predicate/${p}`)).toBe(true);
    for (const p of ['waits-for', 'produced']) expect(isMetaPredicate(`urn:kbase:predicate/${p}`)).toBe(false);
  });
});

const caps = (missing: string[] = []): GenerationCapabilities => ({
  version: 1, workspaceId: image.id, heartbeat: Date.now(),
  stages: (['image', 'video', 'splat'] as const).map(stage => missing.includes(stage) ? { stage, available: false, reason: `${stage} model missing` } : { stage, available: true }),
});

describe('Shelly job plans', () => {
  it('turns "three images and a splat for each" into six items with parents', () => {
    const steps = [0, 1, 2].flatMap(i => [{ stage: 'image', prompt: `synthetic object ${i}` }, { stage: 'splat', from: i * 2 }]);
    const plan = validateJobPlan(steps, caps());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items.map(i => [i.stage, i.parent])).toEqual([['image', undefined], ['splat', 0], ['image', undefined], ['splat', 2], ['image', undefined], ['splat', 4]]);
    expect(plan.items[3].prompt).toBe('synthetic object 1'); // a splat is made from its picture's prompt
    expect(describePlan(plan.items)[1]).toBe('2. Gaussian splat from image 1');
  });
  it('refuses the whole plan when any step is impossible, saying which and why', () => {
    expect(validateJobPlan([{ stage: 'image', prompt: 'x' }, { stage: 'splat', from: 0 }], caps(['splat']))).toEqual({ ok: false, error: 'Job 2 (Gaussian splat) is unavailable: splat model missing' });
    expect(validateJobPlan([{ stage: 'image', prompt: 'x' }], null).ok).toBe(false);
    expect(validateJobPlan([{ stage: 'splat', from: 0 }], caps()).ok).toBe(false); // no earlier image
    expect(validateJobPlan([{ stage: 'image', prompt: 'x' }, { stage: 'splat', from: 1 }], caps()).ok).toBe(false); // self
    expect(validateJobPlan([{ stage: 'image', prompt: 'a' }, { stage: 'video', from: 0 }, { stage: 'splat', from: 1 }], caps()).ok).toBe(false); // from a video
    expect(validateJobPlan([{ stage: 'image', prompt: '  ' }], caps()).ok).toBe(false);
    expect(validateJobPlan([{ stage: 'shell', prompt: 'rm -rf /' }], caps()).ok).toBe(false);
    expect(validateJobPlan(Array.from({ length: MAX_PLAN_STEPS + 1 }, () => ({ stage: 'image', prompt: 'x' })), caps()).ok).toBe(false);
    expect(validateJobPlan([], caps()).ok).toBe(false);
  });
  it('lets a video carry its own motion prompt', () => {
    const plan = validateJobPlan([{ stage: 'image', prompt: 'a lantern' }, { stage: 'video', from: 0, prompt: 'slow orbit' }], caps());
    expect(plan.ok && plan.items[1].prompt).toBe('slow orbit');
  });
});
