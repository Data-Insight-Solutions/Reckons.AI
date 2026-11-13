import { describe, it, expect } from 'vitest';
import { connectView, explainConnectError, RUNNER_COMMAND } from '../connect-steps';

const base = { supported: true, workspace: 'none' as const, connecting: false, runnerReady: false, error: '' };

describe('connect popup steps (F166.1.3)', () => {
  it('not connected: asks for the folder first', () => {
    const v = connectView(base);
    expect(v.status).toBe('need-folder');
    expect(v.steps).toEqual({ start: 'active', folder: 'active', check: 'todo' });
  });
  it('folder chosen, no heartbeat yet: waiting, says what to check', () => {
    const v = connectView({ ...base, workspace: 'connected' });
    expect(v.status).toBe('waiting');
    expect(v.steps.folder).toBe('done');
    expect(v.fix).toMatch(/step 1/);
  });
  it('checking while the store connects', () => {
    expect(connectView({ ...base, workspace: 'connected', connecting: true }).status).toBe('checking');
  });
  it('connected once the heartbeat is read, whatever else is showing', () => {
    const v = connectView({ ...base, workspace: 'connected', runnerReady: true, error: 'old' });
    expect(v.status).toBe('connected');
    expect(v.steps).toEqual({ start: 'done', folder: 'done', check: 'done' });
  });
  it('failed: plain words and a fix', () => {
    const v = connectView({ ...base, workspace: 'connected', error: 'Connect the original generation workspace to resume these jobs.' });
    expect(v.status).toBe('failed');
    expect(v.message).toMatch(/different folder/);
    expect(v.fix).toMatch(/original/);
  });
  it('failed before any folder, e.g. permission refused', () => {
    expect(connectView({ ...base, error: 'NotAllowedError: permission denied' }).status).toBe('failed');
  });
  it("the store's 'connect your folder' prompt is not a failure", () => {
    expect(connectView({ ...base, error: 'Connect your workspace folder to run generation locally.' }).status).toBe('need-folder');
  });
  it('step 1: no bridge and nothing running offers the command; a bridge offers a button; a running runner skips it', () => {
    expect(connectView(base).start).toBe('command');
    expect(connectView({ ...base, bridge: { available: true, running: false } }).start).toBe('button');
    const running = connectView({ ...base, bridge: { available: true, running: true } });
    expect(running.start).toBe('running');
    expect(running.steps.start).toBe('done');
    expect(running.status).toBe('need-folder');
  });
  it('unsupported browser', () => {
    expect(connectView({ ...base, supported: false }).status).toBe('unsupported');
  });
  it('unknown errors are shown, not hidden', () => {
    expect(explainConnectError('boom').message).toBe('boom');
  });
  it('the command is the one in package.json', async () => {
    const pkg = (await import('../../../../package.json')).default as { scripts: Record<string, string> };
    expect(pkg.scripts['gen:serve']).toBeTruthy();
    expect(RUNNER_COMMAND.startsWith('npm run gen:serve')).toBe(true);
  });
});

import { probeBridge, startRunner } from '../runner-bridge';
describe('runner bridge client (F166.1.3)', () => {
  const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('no bridge (hosted site) reads as unavailable', async () => {
    expect(await probeBridge((async () => { throw new Error('x'); }) as unknown as typeof fetch)).toEqual({ available: false, running: false });
    expect(await probeBridge(ok({}, 404))).toEqual({ available: false, running: false });
  });
  it('reads running and its folder', async () => {
    expect(await probeBridge(ok({ running: true, worker: true, workspace: '/w' }))).toEqual({ available: true, running: true, workspace: '/w' });
    expect((await probeBridge(ok({ running: true, worker: false }))).running).toBe(false);
  });
  it('start reports a refused folder in plain words', async () => {
    expect(await startRunner('/w', false, ok({ error: 'bad' }, 400))).toMatch(/folder was not found/);
    expect(await startRunner('/w', false, ok({ running: true }, 202))).toBe('');
  });
});
