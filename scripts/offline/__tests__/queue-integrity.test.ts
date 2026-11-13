import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyLine, contractOf, quarantineQueue, renderContract, scanQueue, splitForQuarantine } from '../queue-integrity';

const good = JSON.stringify({ subject: 's', predicate: 'p', object: 'o', type: 'question', addedAt: '2026-01-01T00:00:00Z' });

describe('classifyLine', () => {
  it('accepts a well-formed row, with or without a type', () => {
    expect(classifyLine(good)).toBe('ok');
    expect(classifyLine('{"subject":"s","predicate":"p"}')).toBe('ok');
  });
  it('recognises a tail fragment (head missing)', () => {
    expect(classifyLine('8-27T02:27:53.657Z","addedAt":"2026-08-27T02:27:53.657Z"}')).toBe('tail-fragment');
  });
  it('recognises a truncated head (tail missing)', () => {
    expect(classifyLine(good.slice(0, 30))).toBe('truncated-head');
  });
  it('flags other unparseable text', () => {
    expect(classifyLine('hello world')).toBe('unparseable');
  });
  it('flags non-objects', () => {
    for (const l of ['[1,2]', '"str"', '42', 'null']) expect(classifyLine(l)).toBe('non-object');
  });
  it('flags missing or blank subject and predicate', () => {
    expect(classifyLine('{"predicate":"p"}')).toBe('missing-subject');
    expect(classifyLine('{"subject":"  ","predicate":"p"}')).toBe('missing-subject');
    expect(classifyLine('{"subject":"s"}')).toBe('missing-predicate');
    expect(classifyLine('{"subject":"s","predicate":7}')).toBe('missing-predicate');
  });
  it('flags an unknown type but not an absent one', () => {
    expect(classifyLine('{"subject":"s","predicate":"p","type":"rant"}')).toBe('unknown-type');
  });
});

describe('scanQueue', () => {
  const text = [good, '', 'tail"}', good, '{"subject":"s"}', '[]'].join('\n') + '\n';
  it('counts non-empty lines and reports 0-based indexes as they sit in the file', () => {
    const r = scanQueue(text);
    expect(r.total).toBe(5);
    expect(r.counts.ok).toBe(2);
    expect(r.findings).toEqual([
      { index: 2, cls: 'tail-fragment' },
      { index: 4, cls: 'missing-predicate' },
      { index: 5, cls: 'non-object' },
    ]);
  });
  it('is clean on an empty or all-good queue', () => {
    expect(scanQueue('').findings).toEqual([]);
    expect(scanQueue(good + '\n').findings).toEqual([]);
  });
});

describe('splitForQuarantine', () => {
  it('keeps good lines in order and returns the rest', () => {
    const s = splitForQuarantine([good, 'x"}', good].join('\n'));
    expect(s.kept).toBe(good + '\n' + good + '\n');
    expect(s.bad).toEqual(['x"}']);
    expect(s.badIndexes).toEqual([1]);
  });
});

describe('quarantineQueue', () => {
  it('backs up, moves bad lines, and leaves a clean queue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qi-'));
    const q = join(dir, 'knowledge.pending.jsonl');
    const original = [good, 'frag"}', good].join('\n') + '\n';
    writeFileSync(q, original);
    const r = quarantineQueue(q, new Date('2026-10-28T00:00:00Z'));
    expect(r.moved).toBe(1);
    expect(readFileSync(q, 'utf8')).toBe(good + '\n' + good + '\n');
    expect(readFileSync(join(dir, 'knowledge.pending.quarantine.jsonl'), 'utf8')).toBe('frag"}\n');
    expect(readFileSync(r.backup!, 'utf8')).toBe(original);
    expect(readdirSync(dir).some((f) => f.includes('quarantine-backup-2026-10-28T00-00-00-000Z'))).toBe(true);
  });
  it('does nothing, and writes no backup, when the queue is clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qi-'));
    const q = join(dir, 'knowledge.pending.jsonl');
    writeFileSync(q, good + '\n');
    const r = quarantineQueue(q);
    expect(r.moved).toBe(0);
    expect(readdirSync(dir).filter((f) => f.includes('backup'))).toEqual([]);
  });
});

describe('the row contract audit (F89.4.1)', () => {
  const legacyNoRun = JSON.stringify({ subject: 's', predicate: 'p', object: 'o', kb: 'roadmap', agent: 'a', addedAt: '2026-11-10T10:00:00Z' });
  const legacyNoKb = JSON.stringify({ subject: 's', predicate: 'p', addedAt: '2026-01-01T00:00:00Z' });
  const legacyUndated = JSON.stringify({ subject: 's', predicate: 'p', kb: 'roadmap' });
  const ok = JSON.stringify({ subject: 's', predicate: 'p', kb: 'roadmap', run: 'jobrun:x-1', lane: 'claim', agent: 'a', origin: 'job', addedAt: '2026-11-12T00:00:00Z' });
  const note = JSON.stringify({ subject: 's', predicate: 'p', kb: 'roadmap', origin: 'note', addedAt: '2026-11-12T00:00:00Z' });

  it('reports legacy rows per missing field and does not fail them', () => {
    const c = contractOf([legacyNoRun, legacyNoKb, legacyUndated, ok].join('\n') + '\n');
    expect(c.legacy).toBe(3);
    expect(c.violations).toEqual([]);
    expect(c.legacyMissing).toMatchObject({ kb: 1, run: 3, lane: 3, agent: 2, addedAt: 1 });
    expect(renderContract(c)).toContain('legacy rows missing, by field (report only)');
  });
  it('a conforming machine row and a note with only its space pass', () => {
    expect(contractOf(ok + '\n' + note + '\n').violations).toEqual([]);
  });
  it('fails a row dated after the contract that lacks a run, a lane, a space or the stamp', () => {
    const base = { subject: 's', predicate: 'p', addedAt: '2026-11-12T00:00:00Z', origin: 'job', kb: 'roadmap', run: 'r', lane: 'claim' };
    const bad = [
      { ...base, run: undefined }, { ...base, lane: undefined }, { ...base, kb: undefined },
      { ...base, origin: undefined }, { ...base, origin: 'note', kb: undefined },
    ].map((r) => JSON.stringify(r));
    const c = contractOf(bad.join('\n') + '\n');
    expect(c.violations.map((v) => v.field)).toEqual(['run', 'lane', 'kb', 'origin', 'kb']);
  });
});
