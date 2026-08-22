/**
 * F139 distillation — turning a prose-only decision into options a person can weigh.
 *
 * The rule under test is the one that makes the agent tier safe here: AN OPTION MUST ALREADY BE
 * ON THE TABLE. Aggregation guards the recorded value; distillation guards the alternatives,
 * because an invented option is a course of action nobody proposed, shown to the human inside the
 * frame of their own material.
 */
import { describe, it, expect } from 'vitest';
import { validateProposedOptions } from '../review-tree';
import type { DistillationRequest, ProposedOptions } from '../review-tree';

const SUBJECT = 'urn:kbase:concept/the-weekend';

const request: DistillationRequest = {
  subjectIri: SUBJECT,
  question: 'Lake George or Oh! Ridge for the trip?',
  facts: [
    { id: 'j1', predicate: 'kpred:description', object: 'Lake George has the quieter campsites' },
    { id: 'j2', predicate: 'kpred:note', object: 'Oh! Ridge is a shorter drive' },
  ],
  sourceIds: ['j1', 'j2'],
  task: 'structure-options',
};

const propose = (options: ProposedOptions['options'], extra: Partial<ProposedOptions> = {}): ProposedOptions =>
  ({ subjectIri: SUBJECT, options, ...extra });

describe('validateProposedOptions — the model splits and phrases, it never adds a course of action', () => {
  it('accepts options drawn from the question and prices them with real fact ids', () => {
    const out = validateProposedOptions(
      propose([
        { label: 'Lake George', consequence: 'Quieter, longer drive', rulesOutIds: ['j2'] },
        { label: 'Oh! Ridge', consequence: 'Shorter drive', rulesOutIds: ['j1'] },
      ]),
      request,
    );
    expect(out.rejected).toEqual([]);
    expect(out.options.map((o) => o.label)).toEqual(['Lake George', 'Oh! Ridge']);
    expect(out.options[0].rulesOutIds).toEqual(['j2']);
  });

  it('REJECTS an option that appears nowhere in the question or the facts', () => {
    const out = validateProposedOptions(
      propose([
        { label: 'Lake George' },
        { label: 'Oh! Ridge' },
        { label: 'Yosemite valley floor' }, // nobody proposed this
      ]),
      request,
    );
    expect(out.options).toHaveLength(2);
    expect(out.rejected.join(' ')).toMatch(/Yosemite/);
    expect(out.rejected.join(' ')).toMatch(/nobody proposed/);
  });

  it('REJECTS invented fact ids rather than silently dropping them', () => {
    const out = validateProposedOptions(
      propose([
        { label: 'Lake George', rulesOutIds: ['j2'] },
        { label: 'Oh! Ridge', rulesOutIds: ['j99'] },
        // Grounded in j2's "shorter drive" — note that a plausible-sounding "Stay home" would
        // itself be rejected here, because those words appear nowhere in the source material.
        { label: 'The shorter drive', rulesOutIds: [] },
      ]),
      request,
    );
    expect(out.rejected.join(' ')).toMatch(/j99/);
    expect(out.options.map((o) => o.label)).toEqual(['Lake George', 'The shorter drive']);
  });

  it('collapses to nothing when rejecting an id leaves a single survivor', () => {
    const out = validateProposedOptions(
      propose([
        { label: 'Lake George', rulesOutIds: ['j2'] },
        { label: 'Oh! Ridge', rulesOutIds: ['j99'] },
      ]),
      request,
    );
    // The bad id is named AND the lone survivor is withheld: showing one alternative would
    // present a foregone conclusion as though it were a choice.
    expect(out.rejected.join(' ')).toMatch(/j99/);
    expect(out.options).toEqual([]);
    expect(out.rejected.join(' ')).toMatch(/not a decision/);
  });

  it('REJECTS duplicate labels that differ only in case or spacing', () => {
    const out = validateProposedOptions(
      propose([{ label: 'Lake George' }, { label: '  lake   george ' }]),
      request,
    );
    // One survives, and a lone survivor is not a decision.
    expect(out.options).toHaveLength(0);
    expect(out.rejected.join(' ')).toMatch(/duplicates an earlier option/);
    expect(out.rejected.join(' ')).toMatch(/single course of action/);
  });

  it('shows NOTHING when only one option survives — a single alternative is not a choice', () => {
    const out = validateProposedOptions(propose([{ label: 'Lake George' }]), request);
    expect(out.options).toEqual([]);
    expect(out.rejected.join(' ')).toMatch(/not a decision/);
  });

  it('REJECTS a paragraph masquerading as an option label', () => {
    const out = validateProposedOptions(
      propose([
        { label: 'Lake George' },
        { label: `Oh! Ridge ${'because the drive is shorter and '.repeat(6)}` },
      ]),
      request,
    );
    expect(out.rejected.join(' ')).toMatch(/paragraph, not an alternative/);
  });

  it('refuses a proposal aimed at a different decision entirely', () => {
    const out = validateProposedOptions(
      { subjectIri: 'urn:kbase:concept/something-else', options: [{ label: 'Lake George' }, { label: 'Oh! Ridge' }] },
      request,
    );
    expect(out.options).toEqual([]);
    expect(out.rejected.join(' ')).toMatch(/different decision/);
  });

  it('keeps a faithful restatement and rejects one that drifts off the question', () => {
    const faithful = validateProposedOptions(
      propose([{ label: 'Lake George' }, { label: 'Oh! Ridge' }], { restated: 'Lake George or Oh! Ridge?' }),
      request,
    );
    expect(faithful.restated).toBe('Lake George or Oh! Ridge?');

    const drifted = validateProposedOptions(
      propose([{ label: 'Lake George' }, { label: 'Oh! Ridge' }], {
        restated: 'Should we upgrade the database schema before shipping payments?',
      }),
      request,
    );
    expect(drifted.restated).toBeUndefined();
    expect(drifted.rejected.join(' ')).toMatch(/drifted off the question/);
  });

  it('reports every rejection reason rather than swallowing them — the rate is the measurement', () => {
    const out = validateProposedOptions(
      propose([
        { label: 'Lake George' },
        { label: 'Oh! Ridge' },
        { label: 'Yosemite valley floor' },
        { label: 'Lake George' },
      ]),
      request,
    );
    // Two distinct failures, both named. A silent drop would make a noisy model look clean.
    expect(out.rejected).toHaveLength(2);
    expect(out.options).toHaveLength(2);
  });
});

describe('an option price must discriminate', () => {
  it('drops prices that are identical across every option, and keeps the options', () => {
    // Observed on the first real run: three options all claiming to kill the same facts. A
    // cost column that cannot tell the options apart is worse than none — it looks like
    // graph-derived evidence while carrying no information.
    const out = validateProposedOptions(
      propose([
        { label: 'Lake George', rulesOutIds: ['j1', 'j2'] },
        { label: 'Oh! Ridge', rulesOutIds: ['j2', 'j1'] },
      ]),
      request,
    );
    expect(out.options.map((o) => o.label)).toEqual(['Lake George', 'Oh! Ridge']);
    expect(out.options.every((o) => o.rulesOutIds.length === 0)).toBe(true);
    expect(out.rejected.join(' ')).toMatch(/cannot distinguish them/);
  });

  it('keeps prices that genuinely differ', () => {
    const out = validateProposedOptions(
      propose([
        { label: 'Lake George', rulesOutIds: ['j2'] },
        { label: 'Oh! Ridge', rulesOutIds: ['j1'] },
      ]),
      request,
    );
    expect(out.rejected).toEqual([]);
    expect(out.options[0].rulesOutIds).toEqual(['j2']);
  });
});
