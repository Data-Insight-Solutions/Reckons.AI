import { describe, it, expect } from 'vitest';
import { decide, GenWatch, watchedFolders, type Deps, type PendingRequest, type ServiceStage } from '../gen-watch-core';

const req = (stage: ServiceStage, id = `id-${stage}`): PendingRequest => ({ id, stage });

describe('decide (on-demand rules, F166.1.3)', () => {
  const base = { pending: [], installed: ['image'] as ServiceStage[], runnerOn: false, idleMs: 0, idleLimitMs: 1000 };
  it('does nothing with no request', () => expect(decide(base)).toEqual({ start: false, stop: false, needInstall: [] }));
  it('starts when a request needs an installed service', () => expect(decide({ ...base, pending: [req('image')] }).start).toBe(true));
  it('does not start for a service that is not installed, and names it', () => {
    const d = decide({ ...base, pending: [req('splat')] });
    expect(d.start).toBe(false);
    expect(d.needInstall).toEqual(['splat']);
  });
  it('a picture request never needs the splat service', () => expect(decide({ ...base, pending: [req('image')] }).needInstall).toEqual([]));
  it('mixed: starts for the installed one and still reports the missing one', () => {
    const d = decide({ ...base, pending: [req('image'), req('splat')] });
    expect(d.start).toBe(true);
    expect(d.needInstall).toEqual(['splat']);
  });
  it('stops only after the idle limit, and never with work pending', () => {
    expect(decide({ ...base, runnerOn: true, idleMs: 999 }).stop).toBe(false);
    expect(decide({ ...base, runnerOn: true, idleMs: 1000 }).stop).toBe(true);
    expect(decide({ ...base, runnerOn: true, idleMs: 5000, pending: [req('image')] }).stop).toBe(false);
  });
});

describe('watchedFolders', () => {
  const exists = (p: string) => p !== '/gone';
  it('default, config and env, only existing, with the idle default', () => {
    const r = watchedFolders({ home: '/h', env: { RECKONS_GEN_FOLDERS: '/e1:/gone' }, config: { folders: ['/c1', 'relative'] }, exists });
    expect(r.folders).toEqual(['/h/Documents/reckons-assets', '/c1', '/e1']);
    expect(r.idleSeconds).toBe(600);
  });
  it('idleSeconds is a setting, with a floor', () => {
    expect(watchedFolders({ home: '/h', env: {}, config: { idleSeconds: 120 }, exists }).idleSeconds).toBe(120);
    expect(watchedFolders({ home: '/h', env: {}, config: { idleSeconds: 1 }, exists }).idleSeconds).toBe(600);
  });
});

describe('GenWatch with fakes', () => {
  function rig(installed: ServiceStage[], pending: PendingRequest[]) {
    let t = 0; const log: string[] = []; let written: any; let queue = pending; let runnerFails = false;
    const deps: Deps = {
      now: () => t, availability: s => installed.includes(s) ? { available: true } : { available: false, reason: `${s}: missing` },
      makeRunner: () => { if (runnerFails) throw new Error('locked'); log.push('start'); return { tick: () => false, close: () => log.push('stop') }; },
      pending: () => queue, fail: (_f, id, m) => { log.push(`fail:${id}:${m}`); queue = queue.filter(q => q.id !== id); },
      workspaceId: () => 'w', write: (_f, v) => { written = v; },
    };
    const w = new GenWatch('/f', deps, 1000);
    return { w, log, at: (ms: number) => { t = ms; }, set: (q: PendingRequest[]) => { queue = q; }, written: () => written, lock: () => { runnerFails = true; } };
  }
  it('installed: starts on a request, idles, stops after the idle limit, restarts on the next', () => {
    const r = rig(['image'], [req('image')]);
    r.w.tick(); expect(r.log).toEqual(['start']); expect(r.written().services.find((s: any) => s.purposes[0] === 'image').status).toBe('running');
    r.set([]); r.at(500); r.w.tick(); expect(r.log).toEqual(['start']);
    r.at(1600); r.w.tick(); expect(r.log).toEqual(['start', 'stop']); expect(r.written().runner).toBe('stopped');
    r.set([req('image', 'b')]); r.at(1700); r.w.tick(); expect(r.log).toEqual(['start', 'stop', 'start']);
  });
  it('not installed: answers the request with a needs-install message and never starts', () => {
    const r = rig([], [req('splat')]);
    r.w.tick();
    expect(r.log).toHaveLength(1);
    expect(r.log[0]).toMatch(/^fail:id-splat:Needs install: splat generation is not installed/);
    expect(r.written().services.find((s: any) => s.purposes[0] === 'splat').status).toBe('not-installed');
    expect(r.written().stages.every((s: any) => !s.available)).toBe(true);
  });
  it('only the needed service is touched: a picture request leaves splat not installed and untouched', () => {
    const r = rig(['image'], [req('image')]);
    r.w.tick();
    expect(r.log.filter(l => l.startsWith('fail'))).toEqual([]);
  });
  it('a folder another runner already serves is reported external, not an error', () => {
    const r = rig(['image'], [req('image')]); r.lock(); r.w.tick();
    expect(r.written().runner).toBe('external');
  });
});
