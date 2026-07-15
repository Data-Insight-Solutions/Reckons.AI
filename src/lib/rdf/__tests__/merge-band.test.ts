/**
 * The merge band (Matt, 2026-07-15) — one rule for merge, link, predicate-sameness.
 * Boundaries are the whole point: >=0.90 auto, [0.50, 0.90) suggest, <0.50 nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyMerge,
  isAutoMerge,
  isSuggestMerge,
  MERGE_AUTO_THRESHOLD,
  MERGE_SUGGEST_FLOOR,
  MERGE_VERDICT_LABEL,
} from '../merge-band';

describe('classifyMerge — the decided band', () => {
  it('matches the graph thresholds (0.9 / 0.5)', () => {
    expect(MERGE_AUTO_THRESHOLD).toBe(0.9);
    expect(MERGE_SUGGEST_FLOOR).toBe(0.5);
  });

  it('>= 0.90 is auto', () => {
    expect(classifyMerge(0.9)).toBe('auto'); // boundary is inclusive
    expect(classifyMerge(0.95)).toBe('auto');
    expect(classifyMerge(1)).toBe('auto');
  });

  it('[0.50, 0.90) is suggest — never acts, only surfaces', () => {
    expect(classifyMerge(0.5)).toBe('suggest'); // floor inclusive
    expect(classifyMerge(0.7)).toBe('suggest');
    expect(classifyMerge(0.8999)).toBe('suggest'); // just under auto
  });

  it('< 0.50 is none — a forced link is worse than an orphan', () => {
    expect(classifyMerge(0.4999)).toBe('none');
    expect(classifyMerge(0.2)).toBe('none');
    expect(classifyMerge(0)).toBe('none');
  });

  it('an untrusted score (NaN / Infinity / negative) fails safe to none', () => {
    expect(classifyMerge(NaN)).toBe('none');
    expect(classifyMerge(Infinity)).toBe('none');
    expect(classifyMerge(-1)).toBe('none');
  });

  it('the convenience predicates agree with classifyMerge', () => {
    expect(isAutoMerge(0.9)).toBe(true);
    expect(isAutoMerge(0.89)).toBe(false);
    expect(isSuggestMerge(0.6)).toBe(true);
    expect(isSuggestMerge(0.9)).toBe(false); // auto is not "suggest"
    expect(isSuggestMerge(0.4)).toBe(false);
  });

  it('every verdict has a label', () => {
    expect(MERGE_VERDICT_LABEL.auto).toContain('auto-merge');
    expect(MERGE_VERDICT_LABEL.suggest).toContain('review');
    expect(MERGE_VERDICT_LABEL.none).toContain('orphan');
  });
});

describe('the code mirrors the graph — no silent drift (kb:auto-merge is the source of truth)', () => {
  // The graph decided these thresholds; merge-band.ts is the executable COPY. If the graph
  // changes and the code does not follow, this fails — so the decision cannot drift out from
  // under the code that acts on it. (Determinism buys "the rule fired"; this is that rule.)
  // Vitest runs from the repo root, so the cwd-relative path is reliable.
  const roadmap = readFileSync('static/reckons-roadmap.ttl', 'utf8');

  const graphValue = (predicate: string): number => {
    const m = roadmap.match(new RegExp(`kpred:${predicate}\\s+"([0-9.]+)"`));
    if (!m) throw new Error(`kpred:${predicate} not found in the roadmap graph`);
    return Number(m[1]);
  };

  it('MERGE_AUTO_THRESHOLD matches kb:auto-merge kpred:auto-merge-threshold', () => {
    expect(MERGE_AUTO_THRESHOLD).toBe(graphValue('auto-merge-threshold'));
  });

  it('MERGE_SUGGEST_FLOOR matches kb:auto-merge kpred:suggest-merge-floor', () => {
    expect(MERGE_SUGGEST_FLOOR).toBe(graphValue('suggest-merge-floor'));
  });
});
