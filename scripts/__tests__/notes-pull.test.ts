import { describe, expect, it } from 'vitest';
import { parseDrainRows } from '../notes-pull';

const validLine = JSON.stringify({
  subject: 'urn:kbase:concept/note-1',
  predicate: 'urn:kbase:predicate/note-text',
  object: 'Remember the grants call\nwithout breaking JSONL.',
  objectKind: 'literal',
  kb: 'personal-notes',
  type: 'observation',
});

describe('parseDrainRows', () => {
  it('accepts an empty successful drain', () => {
    expect(parseDrainRows({ ok: true })).toEqual([]);
  });

  it('validates remote rows and serializes only pending-entry fields', () => {
    const [row] = parseDrainRows({
      ok: true,
      rows: [{ id: 42, line: validLine.replace(/}$/, ',"unexpected":"drop me"}') }],
    });

    expect(JSON.parse(row.line)).toMatchObject({
      subject: 'urn:kbase:concept/note-1',
      object: 'Remember the grants call\nwithout breaking JSONL.',
      kb: 'personal-notes',
    });
    expect(JSON.parse(row.line)).not.toHaveProperty('unexpected');
    expect(row.line).not.toContain('\n');
  });

  it('refuses the whole batch when a row is malformed or unscoped', () => {
    expect(() => parseDrainRows({ ok: true, rows: [{ id: 1, line: '{bad' }] }))
      .toThrow(/unsafe: malformed-json/);
    expect(() => parseDrainRows({
      ok: true,
      rows: [{ id: 1, line: JSON.stringify({
        subject: 'urn:kbase:concept/note-1',
        predicate: 'urn:kbase:predicate/note-text',
        object: 'text',
      }) }],
    })).toThrow(/unsafe: missing-kb/);
  });

  it('refuses identifiers that are not safe acknowledgement tokens', () => {
    expect(() => parseDrainRows({ ok: true, rows: [{ id: '../other', line: validLine }] }))
      .toThrow(/invalid id/);
  });
});
