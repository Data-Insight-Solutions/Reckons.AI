import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Parser } from 'n3';
import { iri, lit, type Statement } from '../types';
import {
  ACTION_STATUS, ACTION_STATUSES, validateProposal, isWellFormed, advanceProposal, canTransition,
  targetReached, closeIfReached, resolveCitations, flaggedCitations, type Proposal, type ProposalOption,
} from '../proposal';

type Quad = ReturnType<InstanceType<typeof Parser>['parse']>[number];

const fact = (id: string, s: string, p: string, o: string, status: Statement['status'] = 'confirmed', extra: Partial<Statement> = {}): Statement => ({
  id, sourceId: 'doc', s: iri(s), p: iri(p), o: iri(o), g: iri('urn:test:g'), confidence: 1, status, createdAt: 0, updatedAt: 0, ...extra,
});
const opt = (id: string, citations: string[] = ['f1']): ProposalOption => ({ id, label: `Option ${id}`, citations });
const target = { id: 'urn:t', requirements: [{ s: 'urn:a', p: 'urn:p', o: 'urn:b' }] };
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1', status: ACTION_STATUS.potential, targetShape: target, options: [opt('a'), opt('b')], recommendedId: 'a', ...over,
});
const codes = (p: Proposal) => validateProposal(p).map((i) => i.code);

describe('validateProposal', () => {
  it('accepts 2 to 4 options with one recommended and a target', () => {
    expect(codes(proposal())).toEqual([]);
    expect(codes(proposal({ options: [opt('a'), opt('b'), opt('c'), opt('d')] }))).toEqual([]);
  });
  it('names each way a proposal is malformed', () => {
    expect(codes(proposal({ options: [opt('a'), opt('b'), opt('c'), opt('d'), opt('e')] }))).toContain('too-many-options');
    expect(codes(proposal({ options: [opt('a')] }))).toContain('too-few-options');
    expect(codes(proposal({ options: [] }))).toContain('too-few-options');
    expect(codes(proposal({ recommendedId: null }))).toContain('no-recommended');
    expect(codes(proposal({ recommendedId: 'zzz' }))).toContain('recommended-not-an-option');
    expect(codes(proposal({ status: 'urn:made:up' }))).toContain('unknown-status');
    expect(codes(proposal({ targetShape: null }))).toContain('no-target-shape');
    expect(codes(proposal({ targetShape: { id: 'x', requirements: [] } }))).toContain('no-target-shape');
    expect(codes(proposal({ options: [opt('a'), opt('a')] }))).toContain('duplicate-option');
  });
  it('names an uncited option but does not call the proposal malformed', () => {
    const p = proposal({ options: [opt('a', []), opt('b')] });
    expect(codes(p)).toEqual(['option-without-citation']);
    expect(isWellFormed(p)).toBe(true);
  });
});

describe('lifecycle', () => {
  it('moves potential to active to completed, and nothing leaves a closed state', () => {
    const active = advanceProposal(proposal(), ACTION_STATUS.active);
    expect(active.ok && active.proposal.status).toBe(ACTION_STATUS.active);
    expect(canTransition(ACTION_STATUS.completed, ACTION_STATUS.active)).toBe(false);
    expect(canTransition(ACTION_STATUS.failed, ACTION_STATUS.potential)).toBe(false);
    expect(canTransition(ACTION_STATUS.potential, ACTION_STATUS.completed)).toBe(false);
  });
  it('does not crash on a target with no requirements list (local-model edge case)', () => {
    expect(codes(proposal({ targetShape: { id: 'x' } as never }))).toContain('no-target-shape');
  });
  it('refuses to activate a malformed proposal', () => {
    const r = advanceProposal(proposal({ options: [opt('a')] }), ACTION_STATUS.active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-well-formed');
  });
  it('does not let an agent settle its own proposal, but lets another actor', () => {
    const mine = proposal({ status: ACTION_STATUS.active, proposedBy: 'agent-1' });
    const own = advanceProposal(mine, ACTION_STATUS.completed, { agentId: 'agent-1' });
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.reason).toBe('self-settlement');
    expect(advanceProposal(mine, ACTION_STATUS.failed, { agentId: 'agent-1' }).ok).toBe(false);
    expect(advanceProposal(mine, ACTION_STATUS.completed, { agentId: 'agent-2' }).ok).toBe(true);
    expect(advanceProposal(mine, ACTION_STATUS.completed, { person: true }).ok).toBe(true);
    // Found by the local-model edge-case pass: an empty actor used to slip past the self-settlement rule.
    const anon = advanceProposal(mine, ACTION_STATUS.completed, {});
    expect(anon.ok).toBe(false);
    if (!anon.ok) expect(anon.reason).toBe('no-actor');
    expect(advanceProposal(mine, ACTION_STATUS.completed).ok).toBe(false);
  });
});

describe('the target state', () => {
  const held = fact('f1', 'urn:a', 'urn:p', 'urn:b');
  it('is reached only by reviewed facts', () => {
    expect(targetReached(target, [held]).reached).toBe(true);
    expect(targetReached(target, [{ ...held, status: 'refined' }]).reached).toBe(true);
    for (const status of ['pending', 'pending-removal', 'rejected', 'superseded'] as const) {
      const r = targetReached(target, [{ ...held, status }]);
      expect(r.reached).toBe(false);
      expect(r.missing).toHaveLength(1);
    }
  });
  it('matches the required object when one is given, and any object when not', () => {
    expect(targetReached(target, [fact('f', 'urn:a', 'urn:p', 'urn:other')]).reached).toBe(false);
    expect(targetReached({ id: 'x', requirements: [{ s: 'urn:a', p: 'urn:p' }] }, [fact('f', 'urn:a', 'urn:p', 'urn:other')]).reached).toBe(true);
    // A text value never satisfies an IRI requirement, and an IRI never satisfies a text one.
    expect(targetReached(target, [{ ...held, o: lit('urn:b') }]).reached).toBe(false);
    const wantsText = { id: 'x', requirements: [{ s: 'urn:a', p: 'urn:p', o: { literal: 'done' } }] };
    expect(targetReached(wantsText, [{ ...held, o: lit('done') }]).reached).toBe(true);
    expect(targetReached(wantsText, [{ ...held, o: iri('done') }]).reached).toBe(false);
  });
  it('completes an active proposal that has reached its target and leaves one that has not', () => {
    const active = proposal({ status: ACTION_STATUS.active });
    const done = closeIfReached(active, [held]);
    expect(done.ok && done.proposal.status).toBe(ACTION_STATUS.completed);
    const waiting = closeIfReached(active, [{ ...held, status: 'pending' }]);
    expect(waiting.ok && waiting.proposal.status).toBe(ACTION_STATUS.active);
    expect(closeIfReached(proposal(), [held]).ok).toBe(false); // not active yet
  });
});

describe('citations are shown, flagged, never hidden', () => {
  const text = 'The ferry leaves at noon. The other crossing is closed.';
  const quote = 'The ferry leaves at noon.';
  const anchored = fact('f1', 'urn:a', 'urn:p', 'urn:b', 'confirmed', {
    excerpt: quote, anchor: { chunk: 'urn:c', start: 0, end: quote.length, sourceHash: 'h1' },
  });
  it('keeps every citation in order and marks the one with no matching fact', () => {
    const r = resolveCitations(['f1', 'nope', 'f1'], [anchored]);
    expect(r.map((c) => c.statementId)).toEqual(['f1', 'nope', 'f1']);
    expect(r.map((c) => c.state)).toEqual(['resolved', 'unresolved', 'resolved']);
    expect(flaggedCitations(r)).toHaveLength(1);
  });
  it('checks a stored anchor through checkAnchor when the kept text is available', () => {
    expect(resolveCitations(['f1'], [anchored], () => ({ text, hash: 'h1' }))[0].state).toBe('anchored');
    expect(resolveCitations(['f1'], [anchored], () => ({ text, hash: 'other' }))[0].state).toBe('stale');
    expect(resolveCitations(['f1'], [anchored], () => ({ text: `X${text}`, hash: 'h1' }))[0].state).toBe('stale');
    expect(resolveCitations(['f1'], [anchored], () => null)[0].state).toBe('resolved');
  });
  it('a failing text lookup does not drop the citation (local-model edge case)', () => {
    const r = resolveCitations(['f1'], [anchored], () => { throw new Error('boom'); });
    expect(r).toEqual([{ statementId: 'f1', state: 'resolved' }]);
  });
  it('an empty citation list stays empty rather than being invented', () => {
    expect(resolveCitations([], [anchored])).toEqual([]);
  });
});

describe('agreement with the vocabulary file', () => {
  const SH = 'http://www.w3.org/ns/shacl#';
  const quads = new Parser().parse(readFileSync('static/reckons-vocabulary.ttl', 'utf8')) as Quad[];
  const shape = 'urn:kbase:shape/Proposal';
  const listOf = (head: string) => {
    const out: string[] = [];
    for (let n = head; n !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';) {
      out.push(quads.find((q) => q.subject.value === n && q.predicate.value.endsWith('#first'))!.object.value);
      n = quads.find((q) => q.subject.value === n && q.predicate.value.endsWith('#rest'))!.object.value;
    }
    return out;
  };
  const props = quads.filter((q) => q.subject.value === shape && q.predicate.value === `${SH}property`).map((q) => q.object.value);
  const prop = (path: string) => props.find((b) => quads.some((q) => q.subject.value === b && q.predicate.value === `${SH}path` && q.object.value === path))!;
  const val = (b: string, p: string) => quads.find((q) => q.subject.value === b && q.predicate.value === `${SH}${p}`)?.object.value;

  it('lists the same four action statuses as the code', () => {
    const inList = listOf(val(prop('https://schema.org/actionStatus'), 'in')!);
    expect([...inList].sort()).toEqual([...ACTION_STATUSES].sort());
  });
  it('requires 2 to 4 options and exactly one recommended, as the code does', () => {
    const options = prop('urn:kbase:predicate/has-option');
    expect([val(options, 'minCount'), val(options, 'maxCount')]).toEqual(['2', '4']);
    const rec = prop('urn:kbase:predicate/recommended-option');
    expect([val(rec, 'minCount'), val(rec, 'maxCount')]).toEqual(['1', '1']);
  });
});
