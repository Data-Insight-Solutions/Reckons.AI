import { describe, expect, it } from 'vitest';
import { appPath, localOrigin, parseAction, parseReview, parseStreams } from '../contract.js';
import examples from '../examples.json';

describe('visual stream input boundaries', () => {
  it('loads the scripted, goal-driven and freeform examples', () => {
    const streams = parseStreams(examples);
    expect(streams.map(s => s.mode)).toEqual(['scripted', 'explore', 'explore']);
    expect(streams[2].assertions).toEqual([]);
  });
  it.each(['https://example.com', 'http://localhost.evil.test', 'file:///tmp/app', 'http://user:pass@localhost', 'http://localhost/path'])('refuses nonlocal or ambiguous origins: %s', url => {
    expect(() => localOrigin(url)).toThrow();
  });
  it.each(['//example.com', '/\\example.com', 'https://example.com', '/\n/evil'])('refuses escaping paths: %s', path => {
    expect(() => appPath(path)).toThrow();
  });
  it('refuses invented controls, arbitrary code, extra fields, prose and invalid budgets', () => {
    for (const raw of [
      '{"action":"click","target":2,"reason":"click"}',
      '{"action":"eval","code":"alert(1)","reason":"test"}',
      '{"action":"click","target":1,"reason":"click","url":"https://example.com"}',
      'I think this works', '{"action":"press","key":"Control+L","reason":"leave"}',
      '{"action":"scroll","delta":100000,"reason":"scroll"}',
    ]) expect(() => parseAction(raw, [1])).toThrow();
    expect(() => parseStreams({ version: 1, streams: [{ ...examples.streams[1], maxSteps: 0 }] })).toThrow();
    expect(() => parseStreams({ version: 1, streams: [{ ...examples.streams[1], typo: true }] })).toThrow();
    expect(() => parseStreams({ version: 1, streams: [{ ...examples.streams[0], maxSteps: 1 }] })).toThrow('exceed maxSteps');
  });
  it('does not interpret missing or malformed verdicts as success', () => {
    for (const raw of ['{}', 'YES', '{"verdict":"pass","detail":"fine"}', '{"verdict":"ok","detail":""}']) {
      expect(() => parseReview(raw)).toThrow();
    }
    expect(parseReview('{"verdict":"uncertain","detail":"Text too small to read"}').verdict).toBe('uncertain');
  });
});
