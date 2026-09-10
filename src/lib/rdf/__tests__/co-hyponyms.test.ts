/**
 * Co-hyponym inference — the stage that reads a shared name head as SIBLINGS rather than
 * duplicates, closing the seam measured on 2026-09-02 where vocabulary-repair was the only reader
 * of that signal and read it destructively.
 */
import { describe, it, expect } from 'vitest';
import { proposeCoHyponyms, coHyponymQuestion, coHyponymSummary } from '../co-hyponyms';
import type { Statement } from '../types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const KC = 'urn:kbase:concept/';
let n = 0;
function st(s: string, p: string, o: string, oKind: 'iri' | 'literal' = 'literal'): Statement {
  n += 1;
  return {
    id: `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: oKind, value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x', confidence: 1, status: 'pending', createdAt: n, updatedAt: n,
  } as Statement;
}
const labelled = (slug: string, label: string) => st(`${KC}${slug}`, RDFS_LABEL, label);

describe('proposeCoHyponyms', () => {
  it('groups five settings under the head they share', () => {
    const facts = ['width', 'height', 'quality', 'samples', 'format'].map((t) =>
      labelled(`render-setting-${t}`, `render setting ${t}`));
    const [group] = proposeCoHyponyms(facts);
    expect(group.head).toBe('render setting');
    expect(group.members).toHaveLength(5);
    expect(group.parentExists).toBe(false);
    expect(group.parentIri).toBe(`${KC}render-setting`);
  });

  it('reuses an existing parent instead of minting a second one', () => {
    const facts = [
      labelled('render-setting', 'render setting'),
      ...['width', 'height', 'quality'].map((t) => labelled(`render-setting-${t}`, `render setting ${t}`)),
    ];
    const [group] = proposeCoHyponyms(facts);
    expect(group.parentExists).toBe(true);
    expect(group.parentIri).toBe(`${KC}render-setting`);
  });

  it('sees entities that appear ONLY as objects', () => {
    // The defect the real corpus caught: all six node-attribute entities there are objects and
    // never subjects, so a subject-only pass found nothing at all.
    const facts = ['name', 'value', 'type'].map((t) =>
      st(`${KC}some-note`, 'urn:kbase:predicate/mentions', `${KC}node-attribute-${t}`, 'iri'));
    const [group] = proposeCoHyponyms(facts);
    expect(group?.head).toBe('node attribute');
    expect(group.members).toHaveLength(3);
  });

  it('refuses an identifier scheme — captures are a key space, not a vocabulary', () => {
    const facts = [
      'note-2026-09-02T09-15-04-100Z',
      'note-2026-09-02T09-17-22-431Z',
      'note-2026-09-02T11-02-58-007Z',
      'note-2026-09-02T11-40-13-902Z',
    ].map((idv) => labelled(idv, idv.replace(/-/g, ' ')));
    expect(proposeCoHyponyms(facts)).toEqual([]);
  });

  it('needs more than one shared word — a single common token means nothing', () => {
    const facts = ['data plan', 'data lake', 'data mesh'].map((l) => labelled(l.replace(' ', '-'), l));
    // Head would be just "data": one token, below MIN_HEAD_TOKENS.
    expect(proposeCoHyponyms(facts)).toEqual([]);
  });

  it('needs three siblings — two names sharing a head is a coincidence', () => {
    const facts = ['width', 'height'].map((t) => labelled(`render-setting-${t}`, `render setting ${t}`));
    expect(proposeCoHyponyms(facts)).toEqual([]);
  });

  it('claims a member for the MOST SPECIFIC head, never two groups', () => {
    const facts = [
      ...['high', 'medium', 'low'].map((t) => labelled(`render-setting-quality-${t}`, `render setting quality ${t}`)),
      ...['width', 'height', 'format'].map((t) => labelled(`render-setting-${t}`, `render setting ${t}`)),
    ];
    const groups = proposeCoHyponyms(facts);
    const heads = groups.map((g) => g.head);
    expect(heads).toContain('render setting quality');
    // A fact in two groups would let two answers place it in two parents.
    const all = groups.flatMap((g) => g.members);
    expect(new Set(all).size).toBe(all.length);
  });

  it('asks ONE answerable question per group, not one per edge', () => {
    const facts = ['width', 'height', 'quality'].map((t) => labelled(`render-setting-${t}`, `render setting ${t}`));
    const q = coHyponymQuestion(proposeCoHyponyms(facts)[0]);
    expect(q).toMatch(/^Are these 3 entities kinds of "render setting"\?/);
    expect(q).toContain('would be created as their parent');
  });

  it('summarizes honestly, and says nothing is applied', () => {
    const facts = ['width', 'height', 'quality'].map((t) => labelled(`render-setting-${t}`, `render setting ${t}`));
    const s = coHyponymSummary(proposeCoHyponyms(facts), 10);
    expect(s).toContain('3 of 10');
    expect(s).toContain('proposals only');
  });

  it('says so plainly when names carry no structure', () => {
    const facts = [labelled('alpha', 'alpha'), labelled('beta', 'beta'), labelled('gamma', 'gamma')];
    expect(coHyponymSummary(proposeCoHyponyms(facts), 3)).toContain('No shared-name groups');
  });
});
