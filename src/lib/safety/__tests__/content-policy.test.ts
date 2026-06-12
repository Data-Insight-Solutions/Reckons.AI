import { describe, it, expect } from 'vitest';
import {
  classifyText,
  classifyStatement,
  filterBlockedStatements,
  scanForExportAdvisory,
  exportAdvisoryHeader,
  exportAdvisoryTriple,
  ETHICS_PREAMBLE,
  type ContentRating,
} from '../content-policy';
import type { Statement } from '../../rdf/types';

function makeStatement(overrides: Partial<Statement> = {}): Statement {
  return {
    id: 'test-1',
    s: { kind: 'iri', value: 'urn:kbase:concept/test' },
    p: { kind: 'iri', value: 'urn:kbase:predicate/has-property' },
    o: { kind: 'literal', value: 'test value' },
    g: { kind: 'iri', value: 'urn:kbase:source/test' },
    sourceId: 'src-1',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('ETHICS_PREAMBLE', () => {
  it('exists and is non-empty', () => {
    expect(ETHICS_PREAMBLE).toBeTruthy();
    expect(ETHICS_PREAMBLE.length).toBeGreaterThan(50);
  });

  it('mentions key ethical boundaries', () => {
    expect(ETHICS_PREAMBLE).toContain('violence');
    expect(ETHICS_PREAMBLE).toContain('minors');
    expect(ETHICS_PREAMBLE).toContain('slavery');
  });

  it('encourages academic discussion', () => {
    expect(ETHICS_PREAMBLE).toContain('Academic');
    expect(ETHICS_PREAMBLE).toContain('disagreement');
  });
});

describe('classifyText', () => {
  it('returns none for normal text', () => {
    expect(classifyText('Coffee beans are grown in tropical climates.')).toEqual({
      rating: 'none',
      flags: [],
    });
  });

  it('returns none for empty text', () => {
    expect(classifyText('')).toEqual({ rating: 'none', flags: [] });
  });

  it('returns none for academic/historical discussion', () => {
    // These should NOT be flagged — discourse is fine
    expect(classifyText('The genocide in Rwanda was a devastating event in 1994.').rating).toBe('none');
    expect(classifyText('World War II saw the use of chemical weapons.').rating).toBe('none');
    expect(classifyText('Slavery in the United States was abolished in 1865.').rating).toBe('none');
    expect(classifyText('The bomb shelter was built during the Cold War.').rating).toBe('none');
    expect(classifyText('This project aims to kill technical debt.').rating).toBe('none');
  });

  it('returns none for disagreement and debate', () => {
    expect(classifyText('I strongly disagree with this political group.').rating).toBe('none');
    expect(classifyText('This ideology is harmful and should be criticized.').rating).toBe('none');
  });

  it('blocks direct incitement to violence against groups', () => {
    const result = classifyText('We must exterminate all the immigrants');
    expect(result.rating).toBe('blocked');
    expect(result.flags).toContain('Incitement to violence against a protected group');
  });

  it('blocks CSAM references', () => {
    const result = classifyText('child pornography collection');
    expect(result.rating).toBe('blocked');
    expect(result.flags).toContain('Child sexual abuse material');
  });

  it('blocks WMD instructions', () => {
    const result = classifyText('how to make a bioweapon at home');
    expect(result.rating).toBe('blocked');
  });

  it('blocks planning specific violence', () => {
    const result = classifyText('I am planning to kill my neighbor');
    expect(result.rating).toBe('blocked');
    expect(result.flags).toContain('Planning specific acts of violence');
  });

  it('flags sexually explicit content as mature', () => {
    const result = classifyText('This contains sexually explicit descriptions');
    expect(result.rating).toBe('mature');
    expect(result.flags).toContain('Sexually explicit content');
  });

  it('flags graphic violence descriptions as mature', () => {
    const result = classifyText('A graphic depiction of murder in the novel');
    expect(result.rating).toBe('mature');
  });
});

describe('classifyStatement', () => {
  it('returns none for a clean statement', () => {
    const st = makeStatement({ gloss: 'Coffee is a popular beverage.' });
    expect(classifyStatement(st).rating).toBe('none');
  });

  it('checks gloss field', () => {
    const st = makeStatement({ gloss: 'kill all the jews' });
    expect(classifyStatement(st).rating).toBe('blocked');
  });

  it('checks excerpt field', () => {
    const st = makeStatement({ excerpt: 'planning to murder my boss' });
    expect(classifyStatement(st).rating).toBe('blocked');
  });

  it('checks literal object value', () => {
    const st = makeStatement({
      o: { kind: 'literal', value: 'child pornography' },
    });
    expect(classifyStatement(st).rating).toBe('blocked');
  });

  it('does not check IRI object values', () => {
    const st = makeStatement({
      o: { kind: 'iri', value: 'urn:kbase:concept/kill-bill-movie' },
    });
    expect(classifyStatement(st).rating).toBe('none');
  });
});

describe('filterBlockedStatements', () => {
  it('passes clean statements through', () => {
    const sts = [
      makeStatement({ id: '1', gloss: 'Coffee is great.' }),
      makeStatement({ id: '2', gloss: 'Tea is soothing.' }),
    ];
    const result = filterBlockedStatements(sts);
    expect(result.allowed).toHaveLength(2);
    expect(result.blocked).toHaveLength(0);
  });

  it('separates blocked statements', () => {
    const sts = [
      makeStatement({ id: '1', gloss: 'Coffee is great.' }),
      makeStatement({ id: '2', gloss: 'kill all the muslims' }),
      makeStatement({ id: '3', gloss: 'Tea is soothing.' }),
    ];
    const result = filterBlockedStatements(sts);
    expect(result.allowed).toHaveLength(2);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].id).toBe('2');
    expect(result.blockReasons['2']).toBeDefined();
  });

  it('allows mature content through (only blocks extreme)', () => {
    const sts = [
      makeStatement({ id: '1', gloss: 'This movie has graphic depiction of torture' }),
    ];
    const result = filterBlockedStatements(sts);
    expect(result.allowed).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });
});

describe('scanForExportAdvisory', () => {
  it('returns none for clean content', () => {
    const sts = [makeStatement({ gloss: 'The sky is blue.' })];
    const advisory = scanForExportAdvisory(sts);
    expect(advisory.rating).toBe('none');
    expect(advisory.flags).toHaveLength(0);
  });

  it('returns mature for flagged content', () => {
    const sts = [
      makeStatement({ gloss: 'The sky is blue.' }),
      makeStatement({ gloss: 'This film contains sexually explicit scenes' }),
    ];
    const advisory = scanForExportAdvisory(sts);
    expect(advisory.rating).toBe('mature');
    expect(advisory.matureCount).toBe(1);
  });

  it('deduplicates flags', () => {
    const sts = [
      makeStatement({ id: '1', gloss: 'sexually explicit content here' }),
      makeStatement({ id: '2', gloss: 'more sexually explicit material' }),
    ];
    const advisory = scanForExportAdvisory(sts);
    expect(advisory.flags).toHaveLength(1);
  });
});

describe('exportAdvisoryHeader', () => {
  it('returns empty for none rating', () => {
    expect(exportAdvisoryHeader({ rating: 'none', flags: [], matureCount: 0 })).toEqual([]);
  });

  it('returns advisory lines for mature content', () => {
    const lines = exportAdvisoryHeader({
      rating: 'mature',
      flags: ['Sexually explicit content'],
      matureCount: 3,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(l => l.includes('CONTENT ADVISORY'))).toBe(true);
    expect(lines.some(l => l.includes('discretion'))).toBe(true);
  });
});

describe('exportAdvisoryTriple', () => {
  it('returns empty string for none rating', () => {
    expect(exportAdvisoryTriple({ rating: 'none', flags: [], matureCount: 0 })).toBe('');
  });

  it('returns RDF triple for mature content', () => {
    const triple = exportAdvisoryTriple({
      rating: 'mature',
      flags: ['Graphic violence'],
      matureCount: 1,
    });
    expect(triple).toContain('urn:reckons:kb');
    expect(triple).toContain('contentAdvisory');
    expect(triple).toContain('mature');
  });
});
