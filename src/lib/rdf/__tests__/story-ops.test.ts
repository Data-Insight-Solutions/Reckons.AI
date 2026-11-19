import { describe, it, expect } from 'vitest';
import { performAction, checkExpect, checkAll, StoryStepError, testIdOf, type StoryPage } from '../story-ops';
import type { StepAction, StepExpect } from '../story-steps';

function fakePage(over: Partial<StoryPage> = {}): StoryPage & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    goto: async (p) => { log.push(`goto ${p}`); },
    click: async (t) => { log.push(`click ${t}`); },
    fill: async (t, x) => { log.push(`fill ${t}=${x}`); },
    selectEntity: async (i) => { log.push(`select ${i}`); },
    expectVisible: async (t) => { log.push(`visible ${t}`); },
    ...over,
  };
}

describe('story operations: actions', () => {
  it('maps each action kind to one page operation', async () => {
    const p = fakePage();
    await performAction(p, { kind: 'open-page', path: '/about' });
    await performAction(p, { kind: 'click', target: 'starter-card-x' });
    await performAction(p, { kind: 'type', target: 'box', text: 'hi' });
    await performAction(p, { kind: 'select', entities: ['urn:a', 'urn:b'] });
    expect(p.log).toEqual(['goto /about', 'click starter-card-x', 'fill box=hi', 'select urn:a', 'select urn:b']);
  });
  it('fails loudly, by name, on an unknown action kind', async () => {
    const bad = { kind: 'teleport' } as unknown as StepAction;
    await expect(performAction(fakePage(), bad)).rejects.toThrow(/teleport/);
    await expect(performAction(fakePage(), bad)).rejects.toBeInstanceOf(StoryStepError);
  });
  it('fails loudly on run-job, which no page operation performs', async () => {
    await expect(performAction(fakePage(), { kind: 'run-job', job: 'gen-image', params: {} })).rejects.toThrow(/run-job.*gen-image/);
  });
  it('refuses a target that is not a data-testid reference', async () => {
    await expect(performAction(fakePage(), { kind: 'click', target: 'the enlarged picture' })).rejects.toThrow(/not a data-testid/);
    expect(() => testIdOf('asset-large', 'x')).not.toThrow();
  });
});

describe('story operations: expectations', () => {
  it('passes a true expectation and reports it as checked', async () => {
    expect(await checkExpect(fakePage(), { kind: 'visible', target: 'asset-large' })).toEqual({ kind: 'visible', status: 'checked' });
  });
  it('fails a false expectation', async () => {
    const p = fakePage({ expectVisible: async () => { throw new Error('element not found\nmore'); } });
    await expect(checkExpect(p, { kind: 'visible', target: 'asset-large' })).rejects.toThrow(/asset-large.*not visible/);
  });
  it('checks count and standing against the probes, and fails when they disagree', async () => {
    const p = fakePage({ countEntities: async () => 3, hasStanding: async () => false });
    expect((await checkExpect(p, { kind: 'count', type: 'Image', n: 3 })).status).toBe('checked');
    await expect(checkExpect(p, { kind: 'count', type: 'Image', n: 2 })).rejects.toThrow(/expected 2.*found 3/);
    await expect(checkExpect(p, { kind: 'standing', subject: 's', predicate: 'p', object: 'o' })).rejects.toThrow(/does not stand/);
  });
  it('fails, rather than passes, when the page has no probe', async () => {
    await expect(checkExpect(fakePage(), { kind: 'count', type: 'Image', n: 1 })).rejects.toThrow(/no way to count/);
    await expect(checkExpect(fakePage(), { kind: 'standing', subject: 's', predicate: 'p', object: 'o' })).rejects.toThrow(/no way to look up/);
  });
  it('names a note as human-judged instead of silently skipping it', async () => {
    expect(await checkExpect(fakePage(), { kind: 'note', text: 'looks right' })).toEqual({ kind: 'note', status: 'human', text: 'looks right' });
  });
  it('fails loudly, by name, on an unknown expectation kind', async () => {
    await expect(checkExpect(fakePage(), { kind: 'vibes' } as unknown as StepExpect)).rejects.toThrow(/vibes/);
  });
  it('stops at the first failure', async () => {
    const p = fakePage({ expectVisible: async (t) => { if (t === 'b') throw new Error('no'); } });
    await expect(checkAll(p, [{ kind: 'visible', target: 'a' }, { kind: 'visible', target: 'b' }, { kind: 'visible', target: 'c' }])).rejects.toThrow(/"b"/);
  });
});
