import { describe, expect, it } from 'vitest';
import { buildPrompt, checkDraft, excerptFor, readPlan, type PlanSource } from '../draft-sample-sources';

const src: PlanSource = {
  id: 's', kind: 'note', title: 'Sample', written: '2026-07-05T00:00:00Z', reviewer: 'Alex', style: 'notes',
  facts: [
    { fact: 'oh-ridge|nightly-rate|$23', say: 'Oh! Ridge costs $23 a night this season.', must: ['$23'] },
    { fact: 'oh-ridge|nightly-rate|$25', say: "$25 a night was last season's price.", must: ['$25'], status: 'superseded', why: "last season's price" },
    { fact: 'wx|summary|x', say: 'Clear, with light wind and mild nights.', must: ['light wind', 'mild nights'] },
  ],
};
const good = [
  '- Oh! Ridge sits by the lake. Sites are $23 a night this season. Last year it was $25.',
  '- Forecast says light wind and mild nights all weekend, which is a relief after the last trip up there.',
].join('\n');

describe('excerptFor', () => {
  it('takes the sentence holding every needle, not the whole line', () => {
    expect(excerptFor(good, ['$23'])).toBe('Sites are $23 a night this season.');
    expect(excerptFor(good, ['light wind', 'mild nights'])).toContain('light wind and mild nights');
    expect(excerptFor(good, ['$23', 'light wind'])).toBeUndefined();
  });
});

describe('checkDraft', () => {
  it('accepts a draft with every required string and one excerpt per fact, each found in the text', () => {
    const c = checkDraft(src, good);
    expect(c.problems).toEqual([]);
    for (const e of Object.values(c.excerpts)) expect(good).toContain(e);
    expect(Object.keys(c.excerpts)).toHaveLength(3);
  });
  it('names exactly what is missing, and rejects links', () => {
    const c = checkDraft(src, good.replace('$23', '23 dollars') + '\nBook at https://example.com');
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toContain('"$23"');
    expect(c.problems.join(' ')).toContain('URL');
  });
});

describe('the plan', () => {
  it('names every fact once, with words to find, and settles every non-pending fact with a time', () => {
    const plan = readPlan();
    const facts = plan.sources.flatMap((s) => s.facts);
    expect(new Set(facts.map((f) => f.fact)).size).toBe(facts.length);
    for (const f of facts) {
      expect(f.must.length).toBeGreaterThan(0);
      if (f.status !== 'pending') expect(f.at, f.fact).toBeTruthy();
    }
    expect(facts.filter((f) => f.status === 'pending')).toHaveLength(3); // the 2026-10-08 decision
  });
  it('gives the model each fact as a sentence with its exact words, and every say holds its words', () => {
    expect(buildPrompt(readPlan(), src)).toContain(`$25 a night was last season's price.  [use these words exactly: "$25"]`);
    for (const f of readPlan().sources.flatMap((s) => s.facts)) for (const m of f.must) expect(f.say, f.fact).toContain(m);
  });
  it('rejects figures the facts do not contain, and leaked prompt wording (the first drafts, 2026-10-09)', () => {
    const c = checkDraft(src, good + '\n- Drive time from SF is about 4.5 hours and we leave at 5pm.\n- It sits at state "7,644 ft".');
    expect(c.problems.join(' ')).toContain('"4.5 hours"');
    expect(c.problems.join(' ')).toContain('"5pm"');
    expect(c.problems.join(' ')).toContain('leaked');
  });
});
