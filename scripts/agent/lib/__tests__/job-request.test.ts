/**
 * F74.14 request validation over synthetic requests. The proof that request text cannot reach a
 * shell or change the command: the only free-form values a request can carry are checked against
 * a whitelist, so the argument list is the defined command plus values that cannot hold a space,
 * a quote or a metacharacter, and anything else is refused.
 */
import { describe, expect, it } from 'vitest';
import { CHANNEL_JOBS, toArgv, validateJobRequest, type ChannelJob } from '../job-request.js';

const JOBS: Record<string, ChannelJob> = {
  report: {
    does: 'a fixture job',
    argv: ['node', 'fixture.js'],
    gpu: false,
    ollama: false,
    params: {
      limit: { type: 'int', min: 1, max: 50, required: true },
      mode: { type: 'enum', values: ['fast', 'slow'] },
      tag: { type: 'word' },
      dry: { type: 'bool' },
    },
  },
};
const good = { id: 'req-1', job: 'report', space: 'demo-a', args: { limit: 10, mode: 'fast', tag: 'depth', dry: true } };
const check = (r: object, spaces?: string[]) => validateJobRequest(r as never, JOBS, { spaces });

describe('validateJobRequest', () => {
  it('accepts a well-formed request and keeps its parts', () => {
    expect(check(good)).toEqual({ ok: true, id: 'req-1', job: 'report', space: 'demo-a', args: good.args });
  });

  it('refuses an undefined job kind with a reason, including names that exist on every object', () => {
    for (const job of ['nope', 'constructor', '__proto__', 'toString', 7, undefined]) {
      const r = check({ ...good, job });
      expect(r.ok).toBe(false);
      expect((r as { reason: string }).reason).toContain('not one of the defined jobs');
    }
  });

  it('refuses a bad id or target', () => {
    for (const id of ['', 'a b', 'a/b', '../x', 'a;b', 'a\nb', 'x'.repeat(65), 5]) expect(check({ ...good, id }).ok, String(id)).toBe(false);
    for (const space of ['', undefined, 'a b', '../x', 'a$(b)']) expect(check({ ...good, space }).ok, String(space)).toBe(false);
  });

  it('refuses a target outside the workspace when the workspace lists its spaces', () => {
    expect(check(good, ['demo-a']).ok).toBe(true);
    const r = check(good, ['other-space']);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('not in this workspace');
  });

  it('refuses a parameter the job does not declare, and a missing required one', () => {
    expect(check({ ...good, args: { ...good.args, extra: 1 } }).ok).toBe(false);
    expect(check({ ...good, args: { ...good.args, __proto__x: 1 } }).ok).toBe(false);
    const { limit: _l, ...rest } = good.args;
    expect(check({ ...good, args: rest }).ok).toBe(false);
  });

  it('refuses wrong types and out-of-range values', () => {
    for (const limit of [0, 51, 1.5, '10', NaN, Infinity, null, [1], { a: 1 }]) {
      expect(check({ ...good, args: { limit } }).ok, JSON.stringify(limit)).toBe(false);
    }
    expect(check({ ...good, args: { limit: 5, mode: 'medium' } }).ok).toBe(false);
    expect(check({ ...good, args: { limit: 5, dry: 'yes' } }).ok).toBe(false);
    for (const args of [null, 5, 'x', ['limit']]) expect(check({ ...good, args }).ok).toBe(false);
  });

  it('refuses every shell metacharacter and whitespace in a word, so request text cannot carry one', () => {
    for (const bad of [';', '|', '&&', '`x`', '$(x)', '$X', '\n', ' ', '"', "'", '>', '<', '*', '\\', '../x', 'A', 'a b']) {
      expect(check({ ...good, args: { limit: 5, tag: `x${bad}` } }).ok, JSON.stringify(bad)).toBe(false);
    }
    for (const whole of ['', '--inject', '-rf', '1abc']) expect(check({ ...good, args: { limit: 5, tag: whole } }).ok, whole).toBe(false);
  });

  it('refuses a request that is not an object', () => {
    for (const r of [null, 'x', 5, [], undefined]) expect(validateJobRequest(r as never, JOBS).ok).toBe(false);
  });
});

describe('toArgv', () => {
  const ok = (r: object) => { const v = check(r); if (!v.ok) throw new Error(v.reason); return v; };

  it('is the defined command followed by typed flags, in the job order, as a list', () => {
    expect(toArgv(ok(good), JOBS)).toEqual(['node', 'fixture.js', '--limit=10', '--mode=fast', '--tag=depth', '--dry']);
    expect(toArgv(ok({ ...good, args: { limit: 3, dry: false } }), JOBS)).toEqual(['node', 'fixture.js', '--limit=3']);
  });

  it('never lets the request change the command, whatever the request carries', () => {
    const argv = toArgv(ok({ ...good, args: { limit: 7 }, command: 'rm -rf /', argv: ['sh'], cmd: 'sh -c x' }), JOBS);
    expect(argv.slice(0, 2)).toEqual(['node', 'fixture.js']);
    expect(argv).toEqual(['node', 'fixture.js', '--limit=7']);
  });

  it('puts no request-supplied character outside letters, digits, dash, equals and dot into any added item', () => {
    const argv = toArgv(ok(good), JOBS).slice(JOBS.report!.argv.length);
    for (const item of argv) expect(item).toMatch(/^--[a-z]+(=[a-z0-9-]+)?$/);
  });

  it('does not mutate the defined command, and refuses a kind that is not defined', () => {
    const before = [...JOBS.report!.argv];
    toArgv(ok(good), JOBS);
    expect(JOBS.report!.argv).toEqual(before);
    expect(() => toArgv({ ok: true, id: 'a', job: 'constructor', space: 's', args: {} }, JOBS)).toThrow();
  });
});

describe('CHANNEL_JOBS (the real table)', () => {
  it('holds only script-tier kinds whose command starts with a fixed tool and script', () => {
    for (const [name, j] of Object.entries(CHANNEL_JOBS)) {
      expect(j.gpu, name).toBe(false);
      expect(j.ollama, name).toBe(false);
      expect(j.argv.slice(0, 2), name).toEqual(['npx', 'tsx']);
      expect(j.argv[2], name).toMatch(/^scripts\/offline\/[a-z-]+\.ts$/);
    }
  });
});
