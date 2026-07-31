import { describe, it, expect } from 'vitest';
import {
  SOURCE_CACHE_MAX_BYTES,
  classifyChange,
  describeDecision,
  hashSourceText,
  makeBaseline,
  sourceTextBytes,
  withinSizeCap,
  type ChangeReason
} from '../source-cache';

const NOW = 1_700_000_000_000;

describe('hashSourceText', () => {
  it('is stable for identical text and differs for changed text', async () => {
    const a = await hashSourceText('the same document');
    const b = await hashSourceText('the same document');
    const c = await hashSourceText('the same document.');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not collapse whitespace-only differences — they are real changes to the text', async () => {
    expect(await hashSourceText('a b')).not.toBe(await hashSourceText('a  b'));
  });
});

describe('sourceTextBytes', () => {
  it('counts bytes, not characters, because the cap is on storage', () => {
    expect(sourceTextBytes('abc')).toBe(3);
    // Four-byte astral character: one JS "character" pair, four bytes on disk.
    expect(sourceTextBytes('𝄞')).toBe(4);
  });

  it('applies the cap against the byte count', () => {
    expect(withinSizeCap('x'.repeat(10), 10)).toBe(true);
    expect(withinSizeCap('x'.repeat(11), 10)).toBe(false);
    expect(withinSizeCap('𝄞'.repeat(3), 10)).toBe(false); // 12 bytes, not 3
  });
});

describe('makeBaseline', () => {
  it('retains the text when it fits under the cap', async () => {
    const b = await makeBaseline('src1', 'small enough', NOW);
    expect(b.text).toBe('small enough');
    expect(b.bytes).toBe(12);
    expect(b.reviewedAt).toBe(NOW);
  });

  it('keeps the hash and drops the body when over the cap', async () => {
    const big = 'x'.repeat(50);
    const b = await makeBaseline('src1', big, NOW, 10);
    expect(b.text).toBeNull();
    expect(b.bytes).toBe(50);
    expect(b.hash).toBe(await hashSourceText(big));
  });

  it('treats exactly-at-the-cap as retainable', async () => {
    const b = await makeBaseline('src1', 'x'.repeat(10), NOW, 10);
    expect(b.text).not.toBeNull();
  });

  it('defaults to a cap that is real, not unbounded', () => {
    expect(SOURCE_CACHE_MAX_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(SOURCE_CACHE_MAX_BYTES)).toBe(true);
  });
});

describe('classifyChange', () => {
  it('treats a first sighting as changed with no baseline', () => {
    const d = classifyChange(null, 'abc');
    expect(d).toEqual({ changed: true, reason: 'no-baseline', canDiffText: false });
  });

  it('short-circuits an unchanged document', async () => {
    const baseline = await makeBaseline('src1', 'unchanged body', NOW);
    const d = classifyChange(baseline, baseline.hash, 'unchanged body');
    expect(d.changed).toBe(false);
    expect(d.reason).toBe('unchanged');
  });

  it('reports a changed document and allows a text diff when both sides are retained', async () => {
    const baseline = await makeBaseline('src1', 'version one', NOW);
    const d = classifyChange(baseline, await hashSourceText('version two'), 'version two');
    expect(d.changed).toBe(true);
    expect(d.reason).toBe('changed');
    expect(d.canDiffText).toBe(true);
  });

  it('cannot offer a text diff when the incoming text was not supplied', async () => {
    const baseline = await makeBaseline('src1', 'version one', NOW);
    const d = classifyChange(baseline, await hashSourceText('version two'));
    expect(d.canDiffText).toBe(false);
  });

  it('degrades honestly when the baseline was too large to retain', async () => {
    const baseline = await makeBaseline('src1', 'x'.repeat(50), NOW, 10);
    expect(baseline.text).toBeNull();
    const d = classifyChange(baseline, await hashSourceText('y'.repeat(50)), 'y'.repeat(50));
    expect(d.changed).toBe(true);
    expect(d.reason).toBe('changed-unretained');
    // The whole point of the separate reason: never claim a precise diff we cannot produce.
    expect(d.canDiffText).toBe(false);
  });

  it('still short-circuits an unchanged hash-only source', async () => {
    const baseline = await makeBaseline('src1', 'x'.repeat(50), NOW, 10);
    const d = classifyChange(baseline, baseline.hash);
    expect(d.changed).toBe(false);
    expect(d.reason).toBe('unchanged');
  });

  it('does not re-extract across repeated polls of an unchanged source', async () => {
    // The behaviour F122 exists for: a quiet source costs a hash comparison and nothing else,
    // however many times it is polled.
    const baseline = await makeBaseline('src1', 'a post that has not changed', NOW);
    const incomingHash = await hashSourceText('a post that has not changed');
    for (let tick = 0; tick < 10; tick++) {
      expect(classifyChange(baseline, incomingHash).changed).toBe(false);
    }
  });
});

describe('describeDecision', () => {
  it('says out loud when a diff is imprecise rather than implying it is exact', () => {
    const msg = describeDecision({ changed: true, reason: 'changed-unretained', canDiffText: false });
    expect(msg).toMatch(/not what changed/i);
  });

  it('has a description for every reason', () => {
    const reasons: ChangeReason[] = ['no-baseline', 'unchanged', 'changed', 'changed-unretained'];
    for (const reason of reasons) {
      const msg = describeDecision({ changed: reason !== 'unchanged', reason, canDiffText: false });
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});
