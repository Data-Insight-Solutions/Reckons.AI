import { describe, it, expect } from 'vitest';
import { performAction, checkExpect, checkAll, StoryStepError, testIdOf, countEntitiesIn, standsIn, standingOf, JOB_KINDS, type StoryPage, type StatementRow } from '../story-ops';
import type { StepAction, StepExpect } from '../story-steps';

function fakePage(over: Partial<StoryPage> = {}): StoryPage & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    goto: async (p) => { log.push(`goto ${p}`); },
    click: async (t) => { log.push(`click ${t}`); },
    fill: async (t, x) => { log.push(`fill ${t}=${x}`); },
    press: async (k) => { log.push(`press ${k}`); },
    selectEntity: async (i) => { log.push(`select ${i}`); },
    expectVisible: async (t) => { log.push(`visible ${t}`); },
    ...over,
  };
}

const T = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ROWS: StatementRow[] = [
  { s: 'urn:kbase:concept/img-1', p: T, o: 'urn:kbase:type/Image', status: 'confirmed' },
  { s: 'urn:kbase:concept/img-2', p: T, o: 'urn:kbase:type/Image', status: 'refined' },
  { s: 'urn:kbase:concept/img-3', p: T, o: 'urn:kbase:type/Image', status: 'rejected' },
  { s: 'urn:kbase:concept/a', p: 'urn:kbase:predicate/brand', o: 'blue', status: 'confirmed' },
  { s: 'urn:kbase:concept/b', p: 'urn:kbase:predicate/brand', o: 'red', status: 'pending', proposalOption: 'opt-a' },
  { s: 'urn:kbase:concept/c', p: 'urn:kbase:predicate/needs-input', o: '?', status: 'pending', needsObject: true },
];

describe('story operations: the data probes', () => {
  it('counts distinct held entities of a type, by full IRI or last segment, ignoring rejected ones', () => {
    expect(countEntitiesIn(ROWS, 'Image')).toBe(2);
    expect(countEntitiesIn(ROWS, 'urn:kbase:type/Image')).toBe(2);
    expect(countEntitiesIn(ROWS, 'Video')).toBe(0);
  });
  it('tells held, pending, proposed and question apart', () => {
    expect(standingOf(ROWS[3])).toEqual(['held']);
    expect(standingOf(ROWS[4])).toEqual(['proposed', 'pending']);
    expect(standingOf(ROWS[5])).toEqual(['pending', 'question']);
    expect(standsIn(ROWS, { subject: 'b', predicate: 'brand', object: 'red', status: 'proposed' })).toBe(true);
    expect(standsIn(ROWS, { subject: 'b', predicate: 'brand', object: 'red' })).toBe(false);
    expect(standsIn(ROWS, { subject: 'c', predicate: 'needs-input', object: '?', status: 'question' })).toBe(true);
  });
  it('refuses a standing it does not know', () => {
    expect(() => standsIn(ROWS, { subject: 'a', predicate: 'brand', object: 'blue', status: 'maybe' })).toThrow(/unknown standing/);
  });
});

describe('story operations: actions', () => {
  it('maps each action kind to one page operation', async () => {
    const p = fakePage();
    await performAction(p, { kind: 'open-page', path: '/about' });
    await performAction(p, { kind: 'click', target: 'starter-card-x' });
    await performAction(p, { kind: 'type', target: 'box', text: 'hi' });
    await performAction(p, { kind: 'select', entities: ['urn:a', 'urn:b'] });
    await performAction(p, { kind: 'press', key: 'Escape' });
    expect(p.log).toEqual(['goto /about', 'click starter-card-x', 'fill box=hi', 'select urn:a', 'select urn:b', 'press Escape']);
  });
  it('fails loudly, by name, on an unknown action kind', async () => {
    const bad = { kind: 'teleport' } as unknown as StepAction;
    await expect(performAction(fakePage(), bad)).rejects.toThrow(/teleport/);
    await expect(performAction(fakePage(), bad)).rejects.toBeInstanceOf(StoryStepError);
  });
  it('runs a defined job kind as its generation stage, with typed parameters', async () => {
    const ran: string[] = [];
    const p = fakePage({ runJob: async (stage, params) => { ran.push(`${stage} ${JSON.stringify(params)}`); } });
    await performAction(p, { kind: 'run-job', job: 'generate-image', params: { prompt: 'a lighthouse' } });
    await performAction(p, { kind: 'run-job', job: 'generate-splat', params: {} });
    expect(ran).toEqual(['image {"prompt":"a lighthouse"}', 'splat {}']);
    expect(Object.keys(JOB_KINDS)).toEqual(['generate-image', 'generate-video', 'generate-splat']);
  });
  it('refuses run-job for an undefined job kind, an extra, a missing or a mistyped parameter, and a page with no runner', async () => {
    const p = fakePage({ runJob: async () => { throw new Error('must not run'); } });
    await expect(performAction(p, { kind: 'run-job', job: 'rm-rf', params: {} })).rejects.toThrow(/not a defined job kind/);
    await expect(performAction(p, { kind: 'run-job', job: 'generate-image', params: { prompt: 'x', cmd: 'ls' } })).rejects.toThrow(/takes no parameter "cmd"/);
    await expect(performAction(p, { kind: 'run-job', job: 'generate-image', params: {} })).rejects.toThrow(/needs the parameter "prompt"/);
    await expect(performAction(p, { kind: 'run-job', job: 'generate-image', params: { prompt: 3 } })).rejects.toThrow(/must be a string/);
    await expect(performAction(fakePage(), { kind: 'run-job', job: 'generate-image', params: { prompt: 'x' } })).rejects.toThrow(/no job runner is connected/);
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
  it('checks count and standing against the rows the page reports, and fails when they disagree', async () => {
    const p = fakePage({ statementRows: async () => ROWS });
    expect((await checkExpect(p, { kind: 'count', type: 'Image', n: 2 })).status).toBe('checked');
    await expect(checkExpect(p, { kind: 'count', type: 'Image', n: 3 })).rejects.toThrow(/expected 3.*found 2/);
    expect((await checkExpect(p, { kind: 'standing', subject: 'a', predicate: 'brand', object: 'blue' })).status).toBe('checked');
    await expect(checkExpect(p, { kind: 'standing', subject: 'a', predicate: 'brand', object: 'green' })).rejects.toThrow(/does not stand/);
    await expect(checkExpect(p, { kind: 'standing', subject: 'a', predicate: 'brand', object: 'blue', status: 'pending' })).rejects.toThrow(/does not stand as pending/);
  });
  it('fails, rather than passes, when the page has no probe', async () => {
    await expect(checkExpect(fakePage(), { kind: 'count', type: 'Image', n: 1 })).rejects.toThrow(/no way to count/);
    await expect(checkExpect(fakePage(), { kind: 'standing', subject: 's', predicate: 'p', object: 'o' })).rejects.toThrow(/no way to look up/);
    await expect(checkExpect(fakePage(), { kind: 'text', target: 'x', contains: 'y' })).rejects.toThrow(/cannot read the text/);
    await expect(checkExpect(fakePage(), { kind: 'attr', target: 'x', name: 'a', value: 'b' })).rejects.toThrow(/cannot read the attribute/);
    await expect(checkExpect(fakePage(), { kind: 'elements', target: 'x', n: 1 })).rejects.toThrow(/cannot count elements/);
  });
  it('checks a receipt, a media width, and waits for a value that settles within the page patience', async () => {
    const good = { generated: true, accepted: true, matches: true, licenses: ['MIT', 'Apache-2.0'] };
    const p = fakePage({ receiptOf: async () => good, mediaWidth: async () => 768 });
    expect((await checkExpect(p, { kind: 'receipt', slug: 'x', stage: 'image' })).status).toBe('checked');
    for (const bad of [{ generated: false }, { accepted: false }, { matches: false }, { licenses: ['GPL-3.0'] }]) {
      const q = fakePage({ receiptOf: async () => ({ ...good, ...bad }) });
      await expect(checkExpect(q, { kind: 'receipt', slug: 'x', stage: 'image' })).rejects.toThrow(/receipt|check|file|license/);
    }
    expect((await checkExpect(p, { kind: 'media', target: 'img', width: 768 })).status).toBe('checked');
    await expect(checkExpect(p, { kind: 'media', target: 'img', width: 512 })).rejects.toThrow(/768 pixels wide, expected 512/);
    let calls = 0;
    const slow = fakePage({ patience: 2000, mediaWidth: async () => (++calls < 3 ? 0 : 768) });
    expect((await checkExpect(slow, { kind: 'media', target: 'img', width: 768 })).status).toBe('checked');
    expect(calls).toBe(3);
    const never = fakePage({ patience: 300, mediaWidth: async () => 0 });
    await expect(checkExpect(never, { kind: 'media', target: 'img', width: 768 })).rejects.toThrow(/0 pixels wide/);
  });
  it('checks text, attribute and element counts, and fails when they differ', async () => {
    const p = fakePage({
      textOf: async () => '1 repeat, 1 new',
      attrOf: async (_t, n) => (n === 'data-splat-status' ? 'ready' : null),
      countElements: async (_t, w) => (w ? 1 : 4),
    });
    expect((await checkExpect(p, { kind: 'text', target: 'chips', contains: '1 repeat' })).status).toBe('checked');
    await expect(checkExpect(p, { kind: 'text', target: 'chips', contains: '2 repeats' })).rejects.toThrow(/does not contain "2 repeats"/);
    expect((await checkExpect(p, { kind: 'attr', target: 'v', name: 'data-splat-status', value: 'ready' })).status).toBe('checked');
    await expect(checkExpect(p, { kind: 'attr', target: 'v', name: 'data-splat-status', value: 'failed' })).rejects.toThrow(/is "ready", expected "failed"/);
    await expect(checkExpect(p, { kind: 'attr', target: 'v', name: 'missing', value: 'x' })).rejects.toThrow(/is absent/);
    expect((await checkExpect(p, { kind: 'elements', target: 'e', n: 4 })).status).toBe('checked');
    expect((await checkExpect(p, { kind: 'elements', target: 'e', n: 1, attr: 'data-kind', is: 'new' })).status).toBe('checked');
    await expect(checkExpect(p, { kind: 'elements', target: 'e', n: 5 })).rejects.toThrow(/expected 5.*found 4/);
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
