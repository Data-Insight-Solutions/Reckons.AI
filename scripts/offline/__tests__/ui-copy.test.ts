/**
 * ui-copy (F203). It only rewrites by rule, so the rule's edges are pinned: what counts as text a
 * person sees, what is skipped as code, and the lowercase `kb` that is a field, not a word.
 */
import { describe, it, expect } from 'vitest';
import { applyKb, occurrencesIn, scriptOccurrences } from '../ui-copy';

const svelte = `<script>const msg = 'Your KB is ready';</script>
<div title="Open graph view" data-x="KB"><p>no other KBs found</p><code>kb_search KB</code>
<span>set kb.</span></div>`;

describe('occurrencesIn — visible text and spoken attributes only', () => {
  const occ = occurrencesIn('X.svelte', svelte);

  it('finds text and title, not data-* attributes, not <code>', () => {
    expect(occ.map((o) => [o.where, o.word])).toEqual([['attribute', 'graph'], ['text', 'KBs'], ['text', 'kb']]);
  });

  it('classifies uppercase KB for the rule and lowercase kb for judgment', () => {
    expect(occ.find((o) => o.word === 'KBs')!.kind).toBe('kb');
    expect(occ.find((o) => o.word === 'kb')!.kind).not.toBe('kb');
  });
});

describe('applyKb — the rule rewrites only uppercase KB in templates', () => {
  it('rewrites KBs to spaces and leaves the field name alone', () => {
    const out = applyKb(svelte, occurrencesIn('X.svelte', svelte));
    expect(out).toContain('no other spaces found');
    expect(out).toContain('<span>set kb.</span>');
    expect(out).toContain('<code>kb_search KB</code>');
    expect(out).toContain("'Your KB is ready'");
  });
});

describe('scriptOccurrences — prose strings, not console output or identifiers', () => {
  const code = "console.log('KB loaded fine'); const a = 'KB'; notify('Your KB was saved');";
  it('keeps the prose literal and skips console and single words', () => {
    expect(scriptOccurrences('x.ts', code, 0, code).map((o) => o.sentence)).toEqual(['Your KB was saved']);
  });
});
