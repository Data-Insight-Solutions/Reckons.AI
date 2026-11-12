import { describe, expect, it } from 'vitest';
import { buildContextSection, buildJobsSection, assembleSystemPrompt, parseActions } from '../turtle-chat';
import { GENERATION_ASK, validateJobPlan } from '$lib/generation/job-plan';
import type { KBContext } from '$lib/types/turtle-chat';

const ctx = (localJobs?: KBContext['localJobs']): KBContext => ({
  statementCount: 0, sourceCount: 0, typesPresent: [], untypedEntityCount: 0, manualStatementCount: 0, sampleEntities: [], localJobs,
});

describe("Shelly's local jobs section (F166.1.2)", () => {
  it('without a runner, says what is needed instead of claiming generation is impossible', () => {
    const text = buildJobsSection(ctx());
    expect(text).toContain('no local generation runner is connected');
    expect(text).toContain('"I cannot make images"');
    expect(text).toContain('any knowledge base');
    expect(text).toContain('never a review step, a refusal');
    expect(text).toContain('Connect control');
    // Still proposes the plan: the card waits behind the connect control instead of the request being dropped.
    expect(text).toContain('"type":"queue_jobs"');
  });
  it('the no-runner reply parses to a queue_jobs action that is refused until a runner connects', () => {
    const example = buildJobsSection(ctx()).match(/<kb-actions>[\s\S]*<\/kb-actions>/)![0];
    const { actions } = parseActions(`One sentence. ${example}`);
    expect(actions.map(a => a.type)).toEqual(['queue_jobs']);
    const refused = validateJobPlan((actions[0] as { jobs: unknown }).jobs, null);
    expect(refused.ok).toBe(false);
    expect(validateJobPlan((actions[0] as { jobs: unknown }).jobs, { version: 1, workspaceId: 'w', heartbeat: 0, stages: [{ stage: 'image', available: true }] } as never).ok).toBe(true);
  });
  it('recognises asset requests so the connect control can follow the reply', () => {
    for (const ok of ['Can you make me a picture of a lighthouse?', 'generate an image of a fox', 'create a 3D asset of a teapot', 'make a gaussian splat']) expect(GENERATION_ASK.test(ok), ok).toBe(true);
    for (const no of ['what types of entities do I have?', 'make a note about coffee', 'show me the islands']) expect(GENERATION_ASK.test(no), no).toBe(false);
  });
  it('offers only the stages the runner reports, and names what is missing', () => {
    const text = buildJobsSection(ctx({ stages: [{ stage: 'image', available: true }, { stage: 'video', available: false, reason: 'video model missing' }, { stage: 'splat', available: true }] }));
    expect(text).toContain('can make: image, splat');
    expect(text).toContain('video (video model missing)');
    expect(text).toContain('"type":"queue_jobs"');
  });
  it('with a runner that can do nothing, proposes nothing', () => {
    const text = buildJobsSection(ctx({ stages: [{ stage: 'image', available: false, reason: 'x' }] }));
    expect(text).toContain('nothing can run');
    expect(text).not.toContain('"type":"queue_jobs"');
  });
  it('a story (reviewSteps) still tells Shelly she can queue jobs, and that asking outranks the review', () => {
    const story: KBContext = { ...ctx({ stages: [{ stage: 'image', available: true }, { stage: 'splat', available: true }] }), reviewSteps: [{ iri: 'urn:x:step1', order: 1, title: 'Ask', assertion: null, result: null, page: null, hasScreenshot: false }] };
    const text = buildContextSection(story);
    expect(text).toContain('"type":"queue_jobs"');
    expect(text).toContain('VISUAL REVIEW');
    expect(assembleSystemPrompt({ kbContext: story })).toContain('that request outranks the review');
  });
  it('keeps the queue_jobs action when the model writes two action blocks', () => {
    const text = 'Step.\n<kb-actions>\n[{"type":"adjust_view","selectEntity":"urn:x:s"}]\n</kb-actions>\nQueueing:\n<kb-actions>\n[{"type":"queue_jobs","label":"x","jobs":[{"stage":"image","prompt":"a"}]}]\n</kb-actions>';
    const { actions, clean } = parseActions(text);
    expect(actions.map(a => a.type)).toEqual(['adjust_view', 'queue_jobs']);
    expect(clean).not.toContain('kb-actions');
    expect(parseActions('<kb-actions>not json</kb-actions><kb-actions>[{"type":"adjust_view"}]</kb-actions>').actions).toHaveLength(1);
  });
});
