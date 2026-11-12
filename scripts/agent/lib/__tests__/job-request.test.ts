/**
 * F74.14 request validation, over synthetic requests: a defined list of job names and a few
 * request objects with made-up ids, targets and args. Nothing here reads a request file, spawns
 * anything or reaches a shell — the point is that the API hands back an argument LIST and has no
 * path to a single command string.
 */
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_IN_ARG, toArgv, validateJobRequest } from '../job-request.js';

const DEFINED_JOBS = ['scan-room', 'describe-entities', 'term-senses:source'];

const good = {
  id: 'req-2026_11-11',
  job: 'scan-room',
  args: { limit: 10, verbose: true, tag: 'depth' },
  space: 'kb-a',
};

describe('validateJobRequest (F74.14 request file)', () => {
  it('accepts a well-formed request and returns its parts, args normalized', () => {
    expect(validateJobRequest(good, DEFINED_JOBS)).toEqual({
      ok: true,
      job: 'scan-room',
      args: { limit: 10, verbose: true, tag: 'depth' },
      space: 'kb-a',
    });
  });

  it('accepts a request with no args and normalizes them to an empty object', () => {
    const { args: _omit, ...noArgs } = good;
    expect(validateJobRequest(noArgs, DEFINED_JOBS)).toEqual({
      ok: true, job: 'scan-room', args: {}, space: 'kb-a',
    });
  });

  it('refuses a job name that is not in the defined list', () => {
    const r = validateJobRequest({ ...good, job: 'no-such-job' }, DEFINED_JOBS);
    expect(r.ok).toBe(false);
  });

  it('refuses a request that names no job at all', () => {
    const r = validateJobRequest({ id: 'x', space: 'kb-a' }, DEFINED_JOBS);
    expect(r.ok).toBe(false);
  });

  it('refuses a missing or empty target', () => {
    expect(validateJobRequest({ ...good, space: '' }, DEFINED_JOBS).ok).toBe(false);
    expect(validateJobRequest({ ...good, space: undefined }, DEFINED_JOBS).ok).toBe(false);
  });

  it('refuses an id that carries anything but letters, digits, dash and underscore', () => {
    for (const bad of ['', 'req 123', 'req/123', 'req.123', 'req:123', 'req$123', 'req*123', 'req\n123']) {
      expect(validateJobRequest({ ...good, id: bad }, DEFINED_JOBS).ok, `id ${JSON.stringify(bad)}`)
        .toBe(false);
    }
    expect(validateJobRequest({ ...good, id: 'A_b-9' }, DEFINED_JOBS).ok).toBe(true);
  });

  it('refuses args that are not a flat object of strings, numbers and booleans', () => {
    // a nested object
    expect(validateJobRequest({ ...good, args: { outer: { inner: 1 } } }, DEFINED_JOBS).ok).toBe(false);
    // a value that is an object
    expect(validateJobRequest({ ...good, args: { deep: { x: 1 } } }, DEFINED_JOBS).ok).toBe(false);
    // an array in place of an object
    expect(validateJobRequest({ ...good, args: ['a', 'b'] }, DEFINED_JOBS).ok).toBe(false);
    // null and a bare scalar
    expect(validateJobRequest({ ...good, args: null }, DEFINED_JOBS).ok).toBe(false);
    expect(validateJobRequest({ ...good, args: 5 }, DEFINED_JOBS).ok).toBe(false);
    // a nested array value
    expect(validateJobRequest({ ...good, args: { list: ['a'] } }, DEFINED_JOBS).ok).toBe(false);
  });

  it('refuses a string argument that carries any forbidden character', () => {
    for (const f of FORBIDDEN_IN_ARG) {
      const r = validateJobRequest({ ...good, args: { note: `before${f}after` } }, DEFINED_JOBS);
      expect(r, `forbidden ${JSON.stringify(f)}`).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  it('accepts a string argument that carries none of the forbidden characters', () => {
    // a space is not forbidden: it stays inside one argument and is not a command
    expect(validateJobRequest({ ...good, args: { prompt: 'warmer light' } }, DEFINED_JOBS).ok).toBe(true);
  });

  it('refuses a request whose whole body is not an object', () => {
    expect(validateJobRequest('scan-room' as unknown as Parameters<typeof validateJobRequest>[0], DEFINED_JOBS).ok)
      .toBe(false);
  });
});

describe('toArgv (F74.14: an argument list, never a command string)', () => {
  const validated = validateJobRequest(good, DEFINED_JOBS);

  it('returns one --key=value item per argument, in sorted key order', () => {
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(toArgv(validated)).toEqual(['--limit=10', '--tag=depth', '--verbose=true']);
  });

  it('returns an empty list when the request had no args', () => {
    const { args: _omit, ...noArgs } = good;
    const v = validateJobRequest(noArgs, DEFINED_JOBS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(toArgv(v)).toEqual([]);
  });

  it('keeps a value that contains a space as one item, not a joined command', () => {
    const v = validateJobRequest({ ...good, args: { prompt: 'warmer light' } }, DEFINED_JOBS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(toArgv(v)).toEqual(['--prompt=warmer light']);
  });

  it('never returns a single string that is a space-joined command', () => {
    const out = toArgv(validated);
    expect(Array.isArray(out)).toBe(true);
    // none of the items is the whole thing joined together with spaces
    const joined = out.join(' ');
    expect(out).not.toContain(joined);
    // and each item is exactly one --flag token, so no item is two flags glued together
    for (const item of out) {
      expect(typeof item).toBe('string');
      expect(item.startsWith('--')).toBe(true);
      expect(item.match(/--/g)).toHaveLength(1);
    }
  });
});
