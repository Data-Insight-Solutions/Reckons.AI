import { describe, it, expect } from 'vitest';
import { connectView, explainConnectError, serviceLines, RUNNER_COMMAND } from '../connect-steps';

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
  it('watcher present but nothing installed: needs install, not connected', () => {
    const v = connectView({ ...base, workspace: 'connected', runnerReady: true, services: [{ stage: 'image', available: false, reason: 'image: missing' }, { stage: 'splat', available: false }] });
    expect(v.status).toBe('needs-install');
  });
  it('per service lines: installed ones start on demand, missing ones say so, independently', () => {
    const lines = serviceLines([{ stage: 'image', available: true }, { stage: 'splat', available: false }]);
    expect(lines.map(l => `${l.label}: ${l.text}`)).toEqual(['image generation: installed, will start when needed', 'splat generation: not installed']);
    const v = connectView({ ...base, workspace: 'connected', runnerReady: true, services: [{ stage: 'image', available: true }, { stage: 'splat', available: false }] });
    expect(v.status).toBe('connected');
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
    expect(RUNNER_COMMAND).toBe('npm run agent:watch');
    expect(pkg.scripts['agent:watch']).toBeTruthy();
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

import { describeService, serviceLine, SERVICE_PURPOSES } from '../services';
describe('services as plugin-shaped records (F166.1.3)', () => {
  it('one typed record per service, separate ids, each its own install step', () => {
    const rows = SERVICE_PURPOSES.map(p => describeService(p, { available: p === 'image', active: false, idleSeconds: 600 }));
    expect(new Set(rows.map(r => r.id)).size).toBe(3);
    expect(rows.every(r => r.kind === 'local-service' && r.purposes.length === 1 && r.install.docs)).toBe(true);
    expect(rows.map(r => r.status)).toEqual(['idle', 'not-installed', 'not-installed']);
    expect(rows[0].install.perServiceInstaller).toBe(false);
  });
  it('running when a request for it is active', () => expect(describeService('splat', { available: true, active: true, idleSeconds: 1 }).status).toBe('running'));
  it('plain line', () => expect(serviceLine(describeService('video', { available: false, active: false, idleSeconds: 1 }))).toBe('video generation: not installed'));
});
