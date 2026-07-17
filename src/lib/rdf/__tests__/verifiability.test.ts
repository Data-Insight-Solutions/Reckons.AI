/**
 * Verifiability + gating (F88).
 *
 * These tests guard a SAFETY property, not a feature: they decide what may be approved
 * WITHOUT the user. Get this wrong in the permissive direction and the graph starts
 * accepting facts nobody competent ever looked at — quietly, at machine speed. So the
 * defaults are asserted as hard as the happy paths.
 */
import { describe, it, expect } from 'vitest';
import {
  competentGate,
  gateFor,
  inferVerifiability,
  isMachineSettleable,
  looksLikePath,
  requiresUserAuthority,
} from '../verifiability';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';

function stmt(p: string, o: string, extra: Partial<Statement> = {}): Statement {
  return {
    id: 'x',
    s: { kind: 'iri', value: 'urn:kbase:concept/thing' },
    p: { kind: 'iri', value: p },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'src',
    confidence: 1,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as Statement;
}

describe('inferVerifiability', () => {
  it('a repo path under a path predicate is code — a script opens it or it does not', () => {
    expect(inferVerifiability(stmt(`${KPRED}has-file`, 'src/lib/rdf/types.ts'))).toBe('code');
    expect(inferVerifiability(stmt(`${KPRED}tested-by`, 'src/lib/rdf/__tests__/diff.test.ts'))).toBe('code');
  });

  it('does NOT call prose "code" just because the predicate usually holds a path', () => {
    // Guessing `code` here would hand the fact to a machine gate that cannot settle it —
    // worse than admitting we do not know.
    expect(inferVerifiability(stmt(`${KPRED}has-file`, 'the main graph component'))).toBe('unknown');
    expect(inferVerifiability(stmt(`${KPRED}has-file`, 'https://example.com/a.ts'))).toBe('unknown');
  });

  it('a grounded excerpt is source-backed', () => {
    expect(inferVerifiability(stmt(`${KPRED}says`, 'x', { grounded: true, excerpt: 'a real quote' }))).toBe('source');
  });

  it('an UNGROUNDED excerpt is not source-backed — a forged citation is not provenance', () => {
    expect(inferVerifiability(stmt(`${KPRED}says`, 'x', { grounded: false, excerpt: 'made up' }))).not.toBe('source');
  });

  it('hand-entered with no source behind it is the user\'s own word: attested', () => {
    expect(inferVerifiability(stmt(`${KPRED}likes`, 'coffee', { sourceId: 'manual' }))).toBe('user');
  });

  it('a partial fact is unsettled — that is the honest label, not a failure', () => {
    expect(inferVerifiability(stmt(`${KPRED}blocks`, '?', { needsObject: true }))).toBe('unknown');
  });
});

describe('competentGate — who may approve this', () => {
  it('code and test do not reach the user: a script settles them', () => {
    expect(competentGate('code')).toBe('machine');
    expect(competentGate('test')).toBe('machine');
    expect(isMachineSettleable('code')).toBe(true);
  });

  it('a cited passage is judged by an agent (did the source actually say this?)', () => {
    expect(competentGate('source')).toBe('agent');
  });

  it('user and unknown route to the user — only they can settle it', () => {
    expect(competentGate('user')).toBe('user');
    expect(competentGate('unknown')).toBe('user');
  });

  it('UNCLASSIFIED FAILS TOWARD THE HUMAN — never auto-approve what nobody classified', () => {
    expect(competentGate(undefined)).toBe('user');
    expect(isMachineSettleable(undefined)).toBe(false);
  });
});

describe('authority overrides verifiability — checkable is not the same as approvable', () => {
  it('a core principle is the user\'s to decide, however checkable it is', () => {
    const principle = stmt(`${KPRED}principle`, 'The user is the bottleneck.');
    expect(requiresUserAuthority(principle)).toBe(true);
    expect(gateFor(principle)).toBe('user');
  });

  it('minting a feature or shaping the plan is authorship, not observation', () => {
    expect(gateFor(stmt(`${KPRED}feature-id`, 'F99'))).toBe('user');
    expect(gateFor(stmt(`${KPRED}depends-on`, 'urn:kbase:concept/other'))).toBe('user');
    expect(gateFor(stmt(`${KPRED}remaining`, 'build the thing'))).toBe('user');
  });

  it('every fact about a Tenet is reserved, whatever its predicate', () => {
    const onATenet = stmt(`${KPRED}has-file`, 'src/lib/rdf/types.ts');
    // Same statement, but the subject is a Tenet — the spine of the product.
    expect(gateFor(onATenet, 'urn:kbase:type/Tenet')).toBe('user');
    // …and without that, it is an ordinary code fact a script can settle.
    expect(gateFor(onATenet)).toBe('machine');
  });

  it('a Decision is reserved too', () => {
    expect(gateFor(stmt(`${KPRED}has-status`, 'planned'), 'urn:kbase:type/Decision')).toBe('user');
  });

  it('but has-status on an ordinary feature is a claim ABOUT THE CODE — a machine should check it', () => {
    // This is the point of the split: "is the code actually functional?" is not a matter of
    // opinion, and putting it to the user invites them to rubber-stamp their own wishes.
    const st = stmt(`${KPRED}tested-by`, 'src/lib/safety/__tests__/content-policy.test.ts');
    expect(gateFor(st)).toBe('machine');
  });
});

describe('looksLikePath', () => {
  it('accepts repo-relative source paths', () => {
    expect(looksLikePath('src/lib/rdf/types.ts')).toBe(true);
    expect(looksLikePath('scripts/offline/graph-lint.ts')).toBe(true);
  });
  it('rejects prose, URLs, and bare words', () => {
    expect(looksLikePath('the graph component')).toBe(false);
    expect(looksLikePath('https://example.com/x.ts')).toBe(false);
    expect(looksLikePath('types.ts')).toBe(false); // no directory — too weak to act on
    expect(looksLikePath('')).toBe(false);
  });
});
