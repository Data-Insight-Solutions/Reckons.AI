import { describe, expect, it } from 'vitest';
import {
  acknowledgePendingJsonl,
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

  it.each([
    ['subject', { subject: 'relative/entity' }, 'invalid-subject-iri'],
    ['predicate', { predicate: 'has-status' }, 'invalid-predicate-iri'],
    ['subject whitespace', { subject: 'urn:kbase:concept/bad value' }, 'invalid-subject-iri'],
    ['predicate escape', { predicate: 'urn:kbase:predicate/bad%zz' }, 'invalid-predicate-iri'],
  ])('rejects an invalid %s before it can become an RDF named node', (_label, change, code) => {
    expect(parsePendingEntryLine(row(change), { requireKb: true })).toMatchObject({ ok: false, code });
  });

  it('accepts absolute HTTP and URN term IRIs, including Unicode IRIs', () => {
    expect(parsePendingEntryLine(row({
      subject: 'https://example.test/people/José',
      predicate: 'urn:example:predicate/status',
      object: 'urn:example:status/planned',
      objectKind: 'iri',
    }), { requireKb: true }).ok).toBe(true);
  });

  it('rejects unknown object term kinds and malformed explicit or inferred IRI objects', () => {
    expect(parsePendingEntryLine(row({ objectKind: 'named-node' }), { requireKb: true }))
      .toMatchObject({ ok: false, code: 'invalid-object-kind' });
    expect(parsePendingEntryLine(row({ object: 'relative/entity', objectKind: 'iri' }), { requireKb: true }))
      .toMatchObject({ ok: false, code: 'invalid-object-iri' });
    expect(parsePendingEntryLine(row({ object: 'urn:bad value', objectKind: undefined }), { requireKb: true }))
      .toMatchObject({ ok: false, code: 'invalid-object-iri' });
    expect(parsePendingEntryLine(row({ object: 42, question: 'A numeric object must not hitchhike.' }), { requireKb: true }))
      .toMatchObject({ ok: false, code: 'invalid-object' });
  });

  it('allows URL-shaped literals but validates blocker entity IRIs', () => {
    expect(parsePendingEntryLine(row({ object: 'https://example.test/a b', objectKind: 'literal' })).ok)
      .toBe(true);
    expect(parsePendingEntryLine(row({ blocks: ['urn:kbase:concept/ok', 'relative-task'] })))
      .toMatchObject({ ok: false, code: 'invalid-block-iri' });
  });

  it('normalizes IRI whitespace without changing literal text', () => {
    const iri = parsePendingEntryLine(row({
      subject: ' urn:kbase:concept/example ',
      predicate: ' urn:kbase:predicate/has-status ',
      object: ' urn:kbase:concept/planned ',
      objectKind: 'iri',
      blocks: [' urn:kbase:concept/blocker '],
    }));
    expect(iri).toMatchObject({ ok: true, entry: {
      subject: 'urn:kbase:concept/example',
      predicate: 'urn:kbase:predicate/has-status',
      object: 'urn:kbase:concept/planned',
      blocks: ['urn:kbase:concept/blocker'],
    } });

    const literal = parsePendingEntryLine(row({ object: '  preserve me  ', objectKind: 'literal' }));
    expect(literal).toMatchObject({ ok: true, entry: { object: '  preserve me  ' } });
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

describe('acknowledgePendingJsonl', () => {
  it('removes only committed snapshot rows and preserves concurrent appends', () => {
    const consumed = row({ object: 'first' });
    const retained = row({ kb: 'another-graph', object: 'other' });
    const appended = row({ object: 'arrived-during-import' });

    expect(acknowledgePendingJsonl(
      [consumed, retained, appended].join('\n'),
      [consumed],
    )).toBe(`${retained}\n${appended}\n`);
  });

  it('subtracts duplicate rows by count instead of erasing a later identical append', () => {
    const duplicate = row({ object: 'same' });
    expect(acknowledgePendingJsonl(`${duplicate}\n${duplicate}\n`, [duplicate])).toBe(`${duplicate}\n`);
  });
});

describe('verification claims — advisory metadata, never authority', () => {
  it('preserves a legacy verifiedBy label for compatibility without authenticating it', () => {
    const r = row({ verifiedBy: 'script:queue-verify/roadmap-edge', object: 'urn:kbase:concept/b' });
    const { entries } = partitionPendingJsonl(r, ['roadmap']);
    expect(entries[0].verifiedBy).toBe('script:queue-verify/roadmap-edge');
  });

  it('preserves a new verificationClaim as a self-attested audit hint', () => {
    const r = row({ verificationClaim: 'script:queue-verify/roadmap-edge' });
    const { entries } = partitionPendingJsonl(r, ['roadmap']);
    expect(entries[0].verificationClaim).toBe('script:queue-verify/roadmap-edge');
  });

  it('leaves both labels absent on an ordinary proposal', () => {
    const { entries } = partitionPendingJsonl(row(), ['roadmap']);
    expect(entries[0].verifiedBy).toBeUndefined();
    expect(entries[0].verificationClaim).toBeUndefined();
  });
});
