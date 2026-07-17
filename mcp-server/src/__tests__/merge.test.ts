/**
 * kb_merge (F89 phase 2).
 *
 * The dangerous outcome here is not a missed addition — it is a CONFLICT that gets merged
 * silently. Two agents asserting different objects for the same subject and predicate are
 * disagreeing about the world, and picking a winner without a decision is how a knowledge
 * graph quietly becomes wrong. So the conflict cases are tested hardest.
 */
import { describe, it, expect } from 'vitest';
import { mergeGraphs, mergeToPending, type MergeTriple } from '../merge.js';

const t = (s: string, p: string, o: string): MergeTriple => ({ subject: s, predicate: p, object: o });
const KP = 'urn:kbase:predicate/';
const E = 'urn:kbase:concept/feature-x';

describe('mergeGraphs', () => {
  it('a triple the trunk does not have is an addition', () => {
    const r = mergeGraphs([t(E, `${KP}has-status`, 'functional')], []);
    expect(r.summary).toEqual({ add: 1, conflict: 0, reinforce: 0 });
  });

  it('an identical triple is a REINFORCEMENT, not a duplicate to be thrown away', () => {
    // An independent agent arriving at a fact we already hold is evidence.
    const trunk = [t(E, `${KP}has-status`, 'functional')];
    const r = mergeGraphs([t(E, `${KP}has-status`, 'functional')], trunk);
    expect(r.summary.reinforce).toBe(1);
    expect(r.summary.add).toBe(0);
  });

  it('SAME subject + predicate, DIFFERENT object = conflict, never a silent merge', () => {
    const trunk = [t(E, `${KP}has-status`, 'planned')];
    const r = mergeGraphs([t(E, `${KP}has-status`, 'functional')], trunk);

    expect(r.summary.conflict).toBe(1);
    expect(r.summary.add).toBe(0);
    expect(r.proposals[0].existing).toEqual(['planned']);
    expect(r.proposals[0].note).toMatch(/must not be merged in either direction/);
  });

  it('a MULTI-VALUED predicate is not a conflict — a feature may have many files', () => {
    const trunk = [t(E, `${KP}has-file`, 'src/a.ts')];
    const r = mergeGraphs([t(E, `${KP}has-file`, 'src/b.ts')], trunk);
    expect(r.summary.conflict).toBe(0);
    expect(r.summary.add).toBe(1);
  });

  it('the sub-agent saying the same thing twice is one fact, not two', () => {
    const r = mergeGraphs([t(E, `${KP}goal`, 'x'), t(E, `${KP}goal`, 'x')], []);
    expect(r.proposals).toHaveLength(1);
  });

  it('CONFLICTS COME FIRST — burying them under additions is how a merge becomes a rubber stamp', () => {
    const trunk = [t(E, `${KP}has-status`, 'planned')];
    const incoming = [
      t(E, `${KP}a`, '1'),
      t(E, `${KP}b`, '2'),
      t(E, `${KP}has-status`, 'functional'), // the conflict, last in the input
      t(E, `${KP}c`, '3'),
    ];
    const r = mergeGraphs(incoming, trunk);
    expect(r.proposals[0].kind).toBe('conflict');
  });
});

describe('mergeToPending — proposals only, never a write', () => {
  it('emits conflicts as high-priority drift warnings', () => {
    const trunk = [t(E, `${KP}has-status`, 'planned')];
    const r = mergeGraphs([t(E, `${KP}has-status`, 'functional')], trunk);
    const lines = mergeToPending(r, { sourceGraph: 'agent-7', agent: 'opus' }).map((l: string) => JSON.parse(l));

    expect(lines[0].type).toBe('drift-warning');
    expect(lines[0].priority).toBe('high');
    expect(lines[0].note).toMatch(/CONFLICT/);
  });

  it('does not queue reinforcements — they need no decision', () => {
    const trunk = [t(E, `${KP}has-status`, 'functional')];
    const r = mergeGraphs([t(E, `${KP}has-status`, 'functional')], trunk);
    expect(mergeToPending(r, { sourceGraph: 'g', agent: 'a' })).toHaveLength(0);
  });
});
