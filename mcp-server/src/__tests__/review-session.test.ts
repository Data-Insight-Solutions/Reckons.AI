/**
 * The review procedure (F199) — grouping, ranking, and the refusals.
 *
 * MOST OF THESE TESTS ARE ABOUT WHAT THE PROCEDURE WILL NOT DO. Grouping rows and sorting them is
 * ordinary code; the part worth defending is that a terminal cannot quietly overrule a person,
 * cannot accept an ambiguous decision by picking the first claim, and cannot report success while
 * writing nothing. Each refusal below is a way a verdict could destroy something silently.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVerdict, decisionId, filterDecisions, groupDecisions, isMachineProposal, localName,
  MIN_SUBJECTS_FOR_FUNCTIONAL, predicateArity, recordVerdicts, renderDecision, renderQueue,
  renderVerdict, ReviewRefusal,
  rowId, settledIds, type Arity,
} from '../review-session.js';
import { currentActor } from '../actor.js';
import type { PendingRow } from '../review-links.js';

const actor = currentActor('cli', {} as NodeJS.ProcessEnv);

/**
 * `has-status` holds one value per subject; `principle` accumulates. Measured this way from the
 * real graph, and stated explicitly here so a test reads as the case it is testing.
 */
const ARITY: ReadonlyMap<string, Arity> = new Map<string, Arity>([
  ['has-status', 'functional'],
  ['principle', 'multi'],
]);

function row(over: Partial<PendingRow> & Record<string, unknown> = {}): PendingRow {
  return {
    subject: 'urn:kbase:concept/graph-publishing',
    predicate: 'urn:kbase:predicate/has-status',
    object: 'functional',
    kb: 'roadmap',
    agent: 'offline:graph-lint',
    priority: 'medium',
    type: 'suggestion',
    ...over,
  } as PendingRow;
}

describe('grouping rows into decisions', () => {
  it('makes ONE decision with competing claims when rows disagree about the object', () => {
    const decisions = groupDecisions([
      row({ object: 'functional', agent: 'offline:graph-lint' }),
      row({ object: 'planned', agent: 'offline:branch-align' }),
      row({ object: 'scaffolded', agent: 'offline:code-review' }),
    ], ARITY);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].claims.map((c) => c.object).sort()).toEqual(['functional', 'planned', 'scaffolded']);
    expect(decisions[0].contested).toBe(true);
  });

  it('collapses rows proposing the SAME object into one claim with several proposers', () => {
    const [d] = groupDecisions([
      row({ agent: 'offline:graph-lint' }),
      row({ agent: 'offline:branch-align' }),
      row({ agent: 'offline:graph-lint' }), // same job twice is not two witnesses
    ], ARITY);

    expect(d.claims).toHaveLength(1);
    expect(d.claims[0].proposers.sort()).toEqual(['offline:branch-align', 'offline:graph-lint']);
    expect(d.contested).toBe(false);
  });

  it('separates decisions across graphs even when the triple is identical', () => {
    const decisions = groupDecisions([
      row({ kb: 'roadmap' }),
      row({ kb: 'production' }),
    ], ARITY);
    expect(decisions).toHaveLength(2);
  });

  it('treats the partial-fact placeholder as an open question, not as a claim', () => {
    const [d] = groupDecisions([row({ object: '?', type: 'question' })], ARITY);
    expect(d.open).toBe(true);
    expect(d.claims).toHaveLength(0);
  });

  it('drops rows that name no fact — a row without a subject is a decision about nothing', () => {
    expect(groupDecisions([row({ subject: '' }), row({ predicate: '' })], ARITY)).toHaveLength(0);
  });

  it('gives a decision the same id across runs, so a listed id can be typed back', () => {
    const first = groupDecisions([row()], ARITY)[0].id;
    const second = groupDecisions([row({ agent: 'someone-else', priority: 'high' })], ARITY)[0].id;
    expect(first).toBe(second);
    expect(first).toBe(decisionId('roadmap', row().subject!, row().predicate!));
  });
});

describe('ranking', () => {
  it('puts a contested decision above an uncontested high-priority one', () => {
    const decisions = groupDecisions([
      row({ subject: 'urn:kbase:concept/a', object: 'x', agent: 'offline:one' }),
      row({ subject: 'urn:kbase:concept/a', object: 'y', agent: 'offline:two' }),
      row({ subject: 'urn:kbase:concept/b', object: 'z', priority: 'high' }),
    ], ARITY);
    expect(decisions[0].subject).toBe('urn:kbase:concept/a');
    expect(decisions[0].because).toContain('claims disagree');
  });

  it('explains a decision that ranks last rather than leaving it unexplained', () => {
    const [d] = groupDecisions([row({ priority: 'low' })], ARITY);
    expect(d.because).toContain('ranked last on purpose');
  });

  it('caps corroboration so a chatty job cannot buy rank by repeating itself', () => {
    const many = Array.from({ length: 40 }, (_, i) => row({ agent: `offline:job-${i}` }));
    const [d] = groupDecisions(many, ARITY);
    const [quiet] = groupDecisions([row(), row({ agent: 'offline:other' })], ARITY);
    expect(d.score - quiet.score).toBeLessThanOrEqual(12);
  });
});

describe('human attestation', () => {
  it('reads offline jobs, model-bearing agents and unattributed rows as machine proposals', () => {
    expect(isMachineProposal(row({ agent: 'offline:layer-classify (qwen3:32b)' }))).toBe(true);
    expect(isMachineProposal(row({ agent: 'claude-code' }))).toBe(true);
    expect(isMachineProposal(row({ agent: 'opus:status-audit-2026-09-06' }))).toBe(true);
    expect(isMachineProposal(row({ agent: '' }))).toBe(true);
  });

  it('counts an UNRECOGNISED agent as human — the safe direction', () => {
    // Being wrong here costs one wasted trip to the app. Being wrong the other way lets a
    // terminal overrule two people with no Reckoning, which is the failure the scope rule exists
    // to prevent.
    expect(isMachineProposal(row({ agent: 'ios-shortcut' }))).toBe(false);
    expect(isMachineProposal(row({ agent: 'matt' }))).toBe(false);
  });
});

describe('refusals', () => {
  const contested = () => groupDecisions([
    row({ object: 'Bynder', agent: 'matt' }),
    row({ object: 'Aprimo', agent: 'ios-shortcut' }),
  ], ARITY)[0];

  it('escalates when both sides are human-attested, and REFUSES to settle it', () => {
    const d = contested();
    expect(d.escalate).toBe('stp');
    expect(() => buildVerdict({ decision: d, verdict: 'accept', claim: d.claims[0].id, actor }))
      .toThrow(ReviewRefusal);
    expect(() => buildVerdict({ decision: d, verdict: 'reject', actor })).toThrow(ReviewRefusal);
  });

  it('still allows DEFER on an escalation, so a person can record why they stopped', () => {
    const v = buildVerdict({ decision: contested(), verdict: 'defer', note: 'needs the meeting', actor });
    expect(v.verdict).toBe('defer');
  });

  it('does NOT escalate when a machine is on one side — that is an ordinary review', () => {
    const [d] = groupDecisions([
      row({ object: 'Bynder', agent: 'matt' }),
      row({ object: 'Aprimo', agent: 'offline:code-review' }),
    ], ARITY);
    expect(d.escalate).toBeNull();
    expect(buildVerdict({ decision: d, verdict: 'accept', claim: d.claims[0].id, actor }).verdict).toBe('accept');
  });

  it('refuses to accept an ambiguous decision without a named claim', () => {
    const [d] = groupDecisions([
      row({ object: 'a', agent: 'offline:one' }),
      row({ object: 'b', agent: 'offline:two' }),
    ], ARITY);
    expect(() => buildVerdict({ decision: d, verdict: 'accept', actor }))
      .toThrow(/competing claims and no claim id/);
  });

  it('accepts without a claim id when there is only one claim to accept', () => {
    const [d] = groupDecisions([row()], ARITY);
    expect(buildVerdict({ decision: d, verdict: 'accept', actor }).object).toBe('functional');
  });

  it('refuses an unknown claim id and lists the real ones', () => {
    const [d] = groupDecisions([row()], ARITY);
    expect(() => buildVerdict({ decision: d, verdict: 'accept', claim: 'nope', actor }))
      .toThrow(/Known claims/);
  });

  it('refuses to accept an open question — there is nothing to accept', () => {
    const [d] = groupDecisions([row({ object: '?', type: 'question' })], ARITY);
    expect(() => buildVerdict({ decision: d, verdict: 'accept', actor })).toThrow(/no claim to accept/);
  });
});

describe('the verdict record', () => {
  it('names every competing claim as superseded rather than dropping them silently', () => {
    const [d] = groupDecisions([
      row({ object: 'a', agent: 'offline:one' }),
      row({ object: 'b', agent: 'offline:two' }),
    ], ARITY);
    const v = buildVerdict({ decision: d, verdict: 'accept', claim: d.claims[0].id, actor });
    const text = renderVerdict(v, d);
    expect(text).toContain('superseded, not deleted');
    expect(text).toContain('NOTHING HAS CHANGED IN THE GRAPH YET');
  });

  it('carries observed identity, and the caller cannot supply a name', () => {
    const [d] = groupDecisions([row()], ARITY);
    const v = buildVerdict({ decision: d, verdict: 'accept', actor });
    expect(v.actor.user).toBe(actor.user);
    expect(v.actor.route).toBe('cli');
    expect(v.actor.attestation).toMatch(/person|agent|MCP|keyboard/);
    expect(v).not.toHaveProperty('by');
  });

  it('round-trips through the journal and is then treated as settled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reckons-review-'));
    const file = join(dir, 'knowledge.decisions.jsonl');
    const [d] = groupDecisions([row()], ARITY);
    recordVerdicts(file, [buildVerdict({ decision: d, verdict: 'accept', actor })]);

    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(settledIds(file).has(d.id)).toBe(true);
  });

  it('does NOT treat defer as settled — a deferred decision comes back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reckons-review-'));
    const file = join(dir, 'knowledge.decisions.jsonl');
    const [d] = groupDecisions([row()], ARITY);
    recordVerdicts(file, [buildVerdict({ decision: d, verdict: 'defer', note: 'later', actor })]);
    expect(settledIds(file).has(d.id)).toBe(false);
  });

  it('survives a torn line in the journal rather than reporting nothing settled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reckons-review-'));
    const file = join(dir, 'knowledge.decisions.jsonl');
    const [d] = groupDecisions([row()], ARITY);
    recordVerdicts(file, [buildVerdict({ decision: d, verdict: 'accept', actor })]);
    writeFileSync(file, '{"decision":"trunc' + '\n' + readFileSync(file, 'utf8'));
    expect(settledIds(file).has(d.id)).toBe(true);
  });
});

describe('rendering', () => {
  it('distinguishes an empty queue from an empty FILTER from an ALREADY-RULED one', () => {
    // Three causes, three messages. Reporting "the queue is empty" while the same screen says
    // "from 4 queue rows" is the defect the 2026-09-09 review-tab commit fixed; it must not come
    // back through this door.
    expect(renderQueue([], 0)).toContain('nothing is waiting on a person');
    expect(renderQueue([], 12)).toContain('narrow view, not an empty queue');
    expect(renderQueue([], 0, 10, 2)).toContain("waiting on the app's next drain");
  });

  it('says the tail is ranked lowest rather than hiding it', () => {
    const decisions = groupDecisions(
      Array.from({ length: 15 }, (_, i) => row({ subject: `urn:kbase:concept/e${i}` })),
      ARITY,
    );
    expect(renderQueue(decisions, 15, 10)).toContain('and 5 more');
  });

  it('tells a reader an escalation is refused HERE and where to go', () => {
    const [d] = groupDecisions([
      row({ object: 'Bynder', agent: 'matt' }),
      row({ object: 'Aprimo', agent: 'ios-shortcut' }),
    ], ARITY);
    const text = renderDecision(d);
    expect(text).toContain('REFUSED HERE');
    expect(text).toContain('Reckoning');
  });

  it('labels each claim as attested or a machine proposal, so they do not read alike', () => {
    const [d] = groupDecisions([
      row({ object: 'a', agent: 'matt' }),
      row({ object: 'b', agent: 'offline:code-review' }),
    ], ARITY);
    const text = renderDecision(d);
    expect(text).toContain('attested by a person');
    expect(text).toContain('a machine proposal, ungated');
  });
});

describe('filtering', () => {
  const decisions = () => groupDecisions([
    row({ subject: 'urn:kbase:concept/a', object: 'x', agent: 'offline:one', priority: 'high' }),
    row({ subject: 'urn:kbase:concept/a', object: 'y', agent: 'offline:two' }),
    row({ subject: 'urn:kbase:concept/b', object: 'z', agent: 'offline:three', priority: 'low' }),
  ], ARITY);

  it('narrows to contested, to high priority, and to a proposing agent', () => {
    expect(filterDecisions(decisions(), { contested: true })).toHaveLength(1);
    expect(filterDecisions(decisions(), { high: true })).toHaveLength(1);
    expect(filterDecisions(decisions(), { agent: 'three' })).toHaveLength(1);
    expect(filterDecisions(decisions(), { agent: 'nobody' })).toHaveLength(0);
  });
});

describe('row identity', () => {
  it('is stable and ignores fields that are not part of the fact', () => {
    expect(rowId(row({ priority: 'high' }))).toBe(rowId(row({ priority: 'low' })));
  });

  it('separates rows that differ in the fact itself', () => {
    expect(rowId(row({ object: 'a' }))).not.toBe(rowId(row({ object: 'b' })));
    expect(rowId(row({ kb: 'roadmap' }))).not.toBe(rowId(row({ kb: 'production' })));
  });
});

/**
 * THE BUG THIS SECTION EXISTS FOR, found by running the procedure against the real queue on
 * 2026-09-10. The top-ranked "decision" was `kb:journey-docs kpred:unexplained-term` with NINETY-
 * FOUR competing claims. They were not competing: they were 94 different unexplained terms, all
 * true at once. Accepting one would have superseded 93 correct observations and reported it as
 * settling a decision. Grouping was right; treating every group as a CHOICE was not.
 */
describe('choice versus batch — whether accepting one kills the others', () => {
  const rows = (predicate: string) => [
    row({ predicate, object: 'a', agent: 'offline:one' }),
    row({ predicate, object: 'b', agent: 'offline:two' }),
    row({ predicate, object: 'c', agent: 'offline:three' }),
  ];

  it('a FUNCTIONAL predicate makes a choice: the claims compete and the losers are superseded', () => {
    const [d] = groupDecisions(rows('urn:kbase:predicate/has-status'), ARITY);
    expect(d.kind).toBe('choice');
    expect(d.contested).toBe(true);
    const v = buildVerdict({ decision: d, verdict: 'accept', claim: d.claims[0].id, actor });
    expect(v.supersedes).toHaveLength(2);
  });

  it('a MULTI-VALUED predicate makes a batch: accepting one supersedes NOTHING', () => {
    const [d] = groupDecisions(rows('urn:kbase:predicate/principle'), ARITY);
    expect(d.kind).toBe('batch');
    expect(d.contested).toBe(false);
    const v = buildVerdict({ decision: d, verdict: 'accept', claim: d.claims[0].id, actor });
    expect(v.supersedes).toEqual([]);
    expect(renderVerdict(v, d)).toContain('untouched and still awaiting review');
  });

  it('an UNKNOWN predicate is a batch — unknown must never supersede', () => {
    const [d] = groupDecisions(rows('urn:kbase:predicate/never-seen-before'), ARITY);
    expect(d.kind).toBe('batch');
    expect(buildVerdict({ decision: d, verdict: 'accept', claim: d.claims[0].id, actor }).supersedes).toEqual([]);
  });

  it('ranks a batch BELOW a genuine choice, however large the batch is', () => {
    const big = Array.from({ length: 94 }, (_, i) =>
      row({ subject: 'urn:kbase:concept/journey-docs', predicate: 'urn:kbase:predicate/principle', object: `term-${i}`, agent: 'offline:docs-review' }));
    const decisions = groupDecisions([...big, ...rows('urn:kbase:predicate/has-status')], ARITY);
    expect(decisions[0].kind).toBe('choice');
    expect(decisions[decisions.length - 1].claims).toHaveLength(94);
  });

  it('accepts a whole batch with `all`, and refuses `all` on a choice', () => {
    const [batch] = groupDecisions(rows('urn:kbase:predicate/principle'), ARITY);
    const v = buildVerdict({ decision: batch, verdict: 'accept', claim: 'all', actor });
    expect(v.objects).toEqual(['a', 'b', 'c']);
    expect(v.supersedes).toEqual([]);

    const [choice] = groupDecisions(rows('urn:kbase:predicate/has-status'), ARITY);
    expect(() => buildVerdict({ decision: choice, verdict: 'accept', claim: 'all', actor }))
      .toThrow(/cannot all be true/);
  });

  it('a batch never escalates, however human its proposers are', () => {
    const [d] = groupDecisions([
      row({ predicate: 'urn:kbase:predicate/principle', object: 'a', agent: 'matt' }),
      row({ predicate: 'urn:kbase:predicate/principle', object: 'b', agent: 'ios-shortcut' }),
    ], ARITY);
    expect(d.escalate).toBeNull();
  });

  it('tells the reader in words that a batch does not compete', () => {
    const [d] = groupDecisions(rows('urn:kbase:predicate/principle'), ARITY);
    expect(renderDecision(d)).toContain('this predicate accumulates, so they do not compete');
  });
});

describe('measuring arity from a graph', () => {
  // Enough subjects to clear MIN_SUBJECTS_FOR_FUNCTIONAL — below it, "never plural" is not yet a
  // finding, and the two tests below would be asserting that thin evidence counts.
  const graph = [
    ...Array.from({ length: MIN_SUBJECTS_FOR_FUNCTIONAL }, (_, i) => ({
      subject: `F${i}`, predicate: 'urn:kbase:predicate/has-status', object: 'planned',
    })),
    { subject: 'F1', predicate: 'urn:kbase:predicate/principle', object: 'one' },
    { subject: 'F1', predicate: 'urn:kbase:predicate/principle', object: 'two' },
  ];

  it('reads a predicate that never doubles up as functional, and one that does as multi', () => {
    const arity = predicateArity(graph);
    expect(arity.get('has-status')).toBe('functional');
    expect(arity.get('principle')).toBe('multi');
    expect(arity.get('never-mentioned')).toBeUndefined();
  });

  it('does not count a repeated identical value as plural — that is one fact stated twice', () => {
    const stated_twice = Array.from({ length: MIN_SUBJECTS_FOR_FUNCTIONAL }, (_, i) => [
      { subject: `F${i}`, predicate: 'p', object: 'same' },
      { subject: `F${i}`, predicate: 'p', object: 'same' },
    ]).flat();
    expect(predicateArity(stated_twice).get('p')).toBe('functional');
  });

  it('compares on the local name, because the queue and the graph spell predicates differently', () => {
    expect(localName('urn:kbase:predicate/has-status')).toBe('has-status');
    expect(localName('kpred:has-status')).toBe('has-status');
    expect(localName('server-health')).toBe('server-health');
  });
});

/**
 * THIN EVIDENCE IS NOT EVIDENCE — the second destructive bug, found the same afternoon.
 *
 * `kpred:server-health` appeared on a couple of subjects in the real graph and never twice, so it
 * was read as functional. The procedure then offered `n8n: kernel` and `n8n: reboot` as competing
 * claims and would have superseded one on accepting the other. Both are true. "Never plural over
 * two subjects" is indistinguishable from "not plural yet".
 */
describe('how much evidence before functionality is believed', () => {
  const oneEach = (n: number) => Array.from({ length: n }, (_, i) => ({
    subject: `S${i}`, predicate: 'urn:kbase:predicate/server-health', object: `v${i}`,
  }));

  it('refuses to call a predicate functional on too few subjects', () => {
    expect(predicateArity(oneEach(MIN_SUBJECTS_FOR_FUNCTIONAL - 1)).get('server-health')).toBe('multi');
  });

  it('believes it once enough subjects have used it without ever doubling up', () => {
    expect(predicateArity(oneEach(MIN_SUBJECTS_FOR_FUNCTIONAL)).get('server-health')).toBe('functional');
  });

  it('so a thinly-evidenced predicate becomes a batch, and accepting supersedes nothing', () => {
    const arity = predicateArity(oneEach(2));
    const [d] = groupDecisions([
      row({ predicate: 'urn:kbase:predicate/server-health', object: 'kernel', agent: 'offline:server-health' }),
      row({ predicate: 'urn:kbase:predicate/server-health', object: 'reboot', agent: 'offline:server-health' }),
    ], arity);
    expect(d.kind).toBe('batch');
    expect(buildVerdict({ decision: d, verdict: 'accept', claim: d.claims[0].id, actor }).supersedes).toEqual([]);
  });
});
