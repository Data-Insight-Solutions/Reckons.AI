import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { readItems, decide, briefFor, stemOf } from '../agent/roadmap-scheduler';

const ttl = `@prefix kb: <urn:kbase:concept/> . @prefix kpred: <urn:kbase:predicate/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
kb:a rdfs:label "F1 — alpha" ; kpred:feature-id "F1" ; kpred:has-status "planned" ; kpred:priority "high" ; kpred:part-of kb:release-0-2-9 ;
  kpred:decided "MATT, 2026-11-25: build alpha" ; kpred:done-test "alpha works" .
kb:b rdfs:label "F2 — beta" ; kpred:feature-id "F2" ; kpred:has-status "planned" ; kpred:depends-on kb:c ;
  kpred:decided "MATT, 2026-11-25: beta after gamma" ; kpred:done-test "beta works" .
kb:c kpred:has-status "planned" .
kb:d rdfs:label "F3.1 — delta" ; kpred:feature-id "F3.1" ; kpred:has-status "in-progress" ; kpred:decided "MATT: delta" ; kpred:done-test "delta works" .
kb:e rdfs:label "F4 — no decision" ; kpred:feature-id "F4" ; kpred:has-status "planned" ; kpred:decided "Opus thought so" ; kpred:done-test "x" .
kb:f rdfs:label "F5 — done" ; kpred:feature-id "F5" ; kpred:has-status "functional" ; kpred:decided "MATT: f" ; kpred:done-test "f works" .`;
const items = readItems(new Parser().parse(ttl));
const statusOf = (iri: string) => ({ 'urn:kbase:concept/c': 'planned' } as Record<string, string>)[iri];

describe('roadmap scheduler', () => {
  it('reads only items Matt decided that have a done-test', () => {
    expect(items.map((i) => i.id).sort()).toEqual(['F1', 'F2', 'F3.1', 'F5']);
  });
  it('builds what nothing is under way for, highest priority first, and names blockers', () => {
    const acts = decide(items, { statusOf, branches: [], jobs: [] });
    expect(acts[0]).toMatchObject({ action: 'BUILD', item: { id: 'F1' }, priority: 7 });
    expect(acts.find((a) => a.item.id === 'F2')).toMatchObject({ action: 'BLOCKED' });
    expect(acts.find((a) => a.item.id === 'F5')).toMatchObject({ action: 'DONE' });
  });
  it('sees work under way on a branch named for it, on a branch whose commits name it, and in the queue', () => {
    const acts = decide(items, { statusOf, jobs: ['build-f1'],
      branches: [{ name: 'feat/f3-1-thing', subjects: [] }, { name: 'feat/other', subjects: ['F1: unrelated id F10 only'] }] });
    expect(acts.find((a) => a.item.id === 'F1')).toMatchObject({ action: 'QUEUED' });
    expect(acts.find((a) => a.item.id === 'F3.1')).toMatchObject({ action: 'BRANCH' });
    const byCommit = decide(items, { statusOf, jobs: [], branches: [{ name: 'feat/story-work', subjects: ['F3.1: the thing'] }] });
    expect(byCommit.find((a) => a.item.id === 'F3.1')).toMatchObject({ action: 'BRANCH' });
  });
  it('does not mistake F10 for F1, and a scaffolded dependency does not block', () => {
    const acts = decide(items, { statusOf: () => 'scaffolded', jobs: [], branches: [{ name: 'feat/x', subjects: ['F10 something'] }] });
    expect(acts.find((a) => a.item.id === 'F1')).toMatchObject({ action: 'BUILD' });
    expect(acts.find((a) => a.item.id === 'F2')).toMatchObject({ action: 'BUILD' });
    expect(decide(items, { statusOf, jobs: [], branches: [] }).find((a) => a.item.id === 'F3.1')).toMatchObject({ action: 'CONTINUE' });
  });
  it('a commit that only plans an item is not work under way on it', () => {
    const br = [{ name: 'feat/other', subjects: ['Plan F1: the plan only'] }];
    expect(decide(items, { statusOf, jobs: [], branches: br }).find((a) => a.item.id === 'F1')).toMatchObject({ action: 'BUILD' });
    const built = [{ name: 'feat/other', subjects: ['F1: built it'] }];
    expect(decide(items, { statusOf, jobs: [], branches: built }).find((a) => a.item.id === 'F1')).toMatchObject({ action: 'BRANCH' });
  });
  it('writes a brief from the item itself: Matt\'s words and the done-test', () => {
    const b = briefFor(items.find((i) => i.id === 'F1')!, '/w', 'feat/f1-scheduled');
    expect(b).toContain('MATT, 2026-11-25: build alpha');
    expect(b).toContain('alpha works');
    expect(briefFor({ ...items.find((i) => i.id === 'F1')!, constraints: ['NEVER A COMMAND'] }, '/w', 'b')).toContain('CONSTRAINTS (these bind you too):\n- NEVER A COMMAND');
    expect(stemOf('F58.9.19')).toBe('f58-9-19');
  });
});
