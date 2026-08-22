import { describe, expect, it } from 'vitest';
import {
  inspectPendingJsonl,
  parsePendingEntryLine,
  partitionPendingJsonl,
} from '../pending-entry';

const row = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    subject: 'urn:kbase:concept/example',
    predicate: 'urn:kbase:predicate/has-status',
    object: 'planned',
    kb: 'roadmap',
    type: 'suggestion',
    priority: 'normal',
    ...extra,
  });

describe('parsePendingEntryLine', () => {
  it('accepts a valid targeted entry', () => {
    const parsed = parsePendingEntryLine(row(), { requireKb: true });
    expect(parsed).toMatchObject({ ok: true, entry: { kb: 'roadmap', priority: 'normal' } });
  });

  it('accepts the producer legacy priority medium and normalizes it', () => {
    const parsed = parsePendingEntryLine(row({ priority: 'medium' }), { requireKb: true });
    expect(parsed).toMatchObject({ ok: true, entry: { priority: 'normal' } });
  });

  it('rejects an unrecognized proposal type instead of silently dropping its semantics', () => {
    const parsed = parsePendingEntryLine(row({ type: 'high' }), { requireKb: true });
    expect(parsed).toMatchObject({ ok: false, code: 'invalid-type' });
  });

  it('requires content but permits a partial fact with a question and no object', () => {
    const partial = parsePendingEntryLine(
      row({ object: undefined, question: 'Which status is correct?' }),
      { requireKb: true },
    );
    expect(partial.ok).toBe(true);

    const empty = parsePendingEntryLine(row({ object: undefined, note: undefined }), { requireKb: true });
    expect(empty).toMatchObject({ ok: false, code: 'missing-content' });
  });
});

describe('partitionPendingJsonl', () => {
  it('consumes only rows explicitly addressed to the active graph', () => {
    const roadmap = row();
    const other = row({ kb: 'production', object: 'production' });
    const unscoped = row({ kb: undefined, object: 'legacy' });

    const result = partitionPendingJsonl([roadmap, other, unscoped].join('\n'), 'Roadmap');

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].object).toBe('planned');
    expect(result.retainedLines).toEqual([other, unscoped]);
    expect(result.issues).toMatchObject([{ line: 3, code: 'missing-kb' }]);
  });

  it('matches a graph display name to its folder-style target without fuzzy matching', () => {
    const targeted = row({ kb: 'default-graph' });
    expect(partitionPendingJsonl(targeted, 'Default Graph').entries).toHaveLength(1);
    expect(partitionPendingJsonl(targeted, 'Default Notes').entries).toHaveLength(0);
  });

  it('matches any supplied alias, so a ?kb=<id> graph absent from the registry still drains', () => {
    // The regression: a `?kb=roadmap` tab reports its NAME as 'Default Graph' (no registry entry),
    // so name-only matching silently delivered nothing while reporting a successful drain.
    const targeted = row({ kb: 'roadmap' });

    expect(partitionPendingJsonl(targeted, 'Default Graph').entries).toHaveLength(0);
    expect(partitionPendingJsonl(targeted, ['Default Graph', 'roadmap']).entries).toHaveLength(1);
  });

  it('does not widen matching to unrelated graphs when several aliases are supplied', () => {
    const production = row({ kb: 'production' });
    const result = partitionPendingJsonl(production, ['Default Graph', 'roadmap']);

    expect(result.entries).toHaveLength(0);
    expect(result.retainedLines).toEqual([production]);
  });

  it('ignores blank and duplicate aliases rather than matching everything', () => {
    const targeted = row({ kb: 'roadmap' });

    expect(partitionPendingJsonl(targeted, ['roadmap', 'roadmap']).entries).toHaveLength(1);
    expect(partitionPendingJsonl(targeted, ['', '   ']).entries).toHaveLength(0);
  });

  it('retains malformed and invalid rows verbatim while draining valid rows', () => {
    const malformed = '{"subject":';
    const invalid = row({ type: 'normal' });
    const valid = row();

    const result = partitionPendingJsonl([malformed, invalid, valid].join('\n'), 'roadmap');

    expect(result.entries).toHaveLength(1);
    expect(result.retainedLines).toEqual([malformed, invalid]);
    expect(result.issues.map((issue) => issue.code)).toEqual(['malformed-json', 'invalid-type']);
  });
});

describe('inspectPendingJsonl', () => {
  it('reports total, malformed, invalid, and untargeted rows separately', () => {
    const result = inspectPendingJsonl([
      row(),
      row({ kb: undefined, priority: 'medium' }),
      row({ type: 'normal' }),
      'not json',
    ].join('\n'));

    expect(result).toMatchObject({
      total: 4,
      valid: 2,
      malformed: 1,
      invalid: 1,
      untargeted: 1,
    });
  });
});

describe('verifiedBy — the machine lane, and its boundary', () => {
  it('survives parsing so the drain can act on it', () => {
    const r = row({ verifiedBy: 'script:queue-verify/roadmap-edge', object: 'urn:kbase:concept/b' });
    const { entries } = partitionPendingJsonl(r, ['roadmap']);
    expect(entries[0].verifiedBy).toBe('script:queue-verify/roadmap-edge');
  });

  it('is absent on an ordinary proposal, so nothing is auto-accepted by default', () => {
    const { entries } = partitionPendingJsonl(row(), ['roadmap']);
    expect(entries[0].verifiedBy).toBeUndefined();
  });
});
