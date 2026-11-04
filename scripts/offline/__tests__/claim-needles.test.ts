import { describe, it, expect } from 'vitest';
import { unbuiltNeedles } from '../lib/claim-needles';

const UNBUILT = new Set(['planned', 'speculative']);
const graph = (rows: [string, string, string][]) => ({
  labelOf: new Map(rows.map(([iri, label]) => [iri, label])),
  statusOf: new Map(rows.map(([iri, , status]) => [iri, status])),
});

describe('claim-audit needles', () => {
  it('looks for an unbuilt feature by the leading clause of its label', () => {
    const { labelOf, statusOf } = graph([['a', 'Deep space telemetry — phase 2', 'planned']]);
    expect(unbuiltNeedles(labelOf, statusOf, UNBUILT).map((n) => n.needle)).toEqual(['deep space telemetry']);
  });
  it('does not treat a built feature’s name as a claim about its planned sub-parts', () => {
    const { labelOf, statusOf } = graph([
      ['built', 'Triple Check — continuous statement evidence', 'in-progress'],
      ['sub', 'Triple Check — mark checked entities on the canvas', 'planned'],
      ['other', 'Unrelated planned feature — later', 'planned'],
    ]);
    expect(unbuiltNeedles(labelOf, statusOf, UNBUILT).map((n) => n.iri)).toEqual(['other']);
  });
  it('skips needles too short to be specific', () => {
    const { labelOf, statusOf } = graph([['a', 'Export — CSV', 'planned']]);
    expect(unbuiltNeedles(labelOf, statusOf, UNBUILT)).toEqual([]);
  });
});
