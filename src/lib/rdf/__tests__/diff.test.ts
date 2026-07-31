import { describe, it, expect } from 'vitest';
import { computeDiff } from '../diff';
import type { Statement } from '../types';
import { iri, lit } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _id = 0;
function makeStatement(overrides: Partial<Statement> = {}): Statement {
  return {
    id: `stmt-${++_id}`,
    s: iri('urn:kbase:concept/alice'),
    p: iri('urn:kbase:predicate/knows'),
    o: iri('urn:kbase:concept/bob'),
    g: iri('urn:kbase:source/src1'),
    sourceId: 'src1',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

const SRC1 = iri('urn:kbase:source/src1');
const SRC2 = iri('urn:kbase:source/src2');
const ALICE = iri('urn:kbase:concept/alice');
const BOB   = iri('urn:kbase:concept/bob');
const CAROL = iri('urn:kbase:concept/carol');
const KNOWS = iri('urn:kbase:predicate/knows');
const AGE   = iri('urn:kbase:predicate/age');

// ── Basic classification ──────────────────────────────────────────────────────

describe('computeDiff — basic classification', () => {
  it('classifies a truly new triple as new', () => {
    const inc = makeStatement();
    const diff = computeDiff([inc], []);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe('new');
  });

  it('classifies exact same (s,p,o,g) as duplicate', () => {
    const st = makeStatement();
    const incoming = makeStatement({ ...st, id: 'different-id' });
    const diff = computeDiff([incoming], [st]);
    expect(diff.entries[0].kind).toBe('duplicate');
  });

  it('classifies same (s,p,o) from different source as reinforces', () => {
    const existing = makeStatement({ g: SRC1 });
    const incoming = makeStatement({ g: SRC2, id: 'inc-1' });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('reinforces');
  });

  it('classifies same (s,p) with different object as conflicts', () => {
    const existing = makeStatement({ o: BOB });
    const incoming = makeStatement({ o: CAROL, id: 'inc-1' });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('conflicts');
  });

  it('classifies a more specific literal as refines', () => {
    const existing = makeStatement({ o: lit('London') });
    const incoming = makeStatement({ o: lit('London, United Kingdom'), id: 'inc-1' });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('refines');
  });
});

// ── Summary counts ────────────────────────────────────────────────────────────

describe('computeDiff — summary counts', () => {
  it('increments new count', () => {
    const diff = computeDiff([makeStatement()], []);
    expect(diff.summary.new).toBe(1);
  });

  it('increments duplicate count', () => {
    const st = makeStatement();
    const diff = computeDiff([makeStatement({ ...st, id: 'x' })], [st]);
    expect(diff.summary.duplicate).toBe(1);
  });

  it('increments reinforces count', () => {
    const existing = makeStatement({ g: SRC1 });
    const incoming = makeStatement({ g: SRC2, id: 'y' });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.summary.reinforces).toBe(1);
  });

  it('increments conflicts count', () => {
    const existing = makeStatement({ o: BOB });
    const incoming = makeStatement({ o: CAROL, id: 'z' });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.summary.conflicts).toBe(1);
  });

  it('increments refines count', () => {
    const existing = makeStatement({ o: lit('London') });
    const incoming = makeStatement({ o: lit('London, United Kingdom'), id: 'r' });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.summary.refines).toBe(1);
  });

  it('handles multiple incoming with mixed results', () => {
    const base = makeStatement({ g: SRC1, o: BOB });
    const inc1 = makeStatement({ id: 'i1' });               // new (different s/p/o)
    const inc2 = makeStatement({ id: 'i2', s: ALICE, p: KNOWS, o: BOB, g: SRC2 }); // reinforces
    const inc3 = makeStatement({ id: 'i3', s: ALICE, p: KNOWS, o: CAROL });         // conflicts

    const diff = computeDiff([inc1, inc2, inc3], [base]);
    // inc1 is new (base has same s,p,o,g — wait, inc1 defaults same as base minus id)
    // Actually base has same s,p,o,g as the default makeStatement. inc2 has SRC2.
    // Let me think: base = { s:ALICE, p:KNOWS, o:BOB, g:SRC1 }
    // inc2 = same s,p,o but g=SRC2 → reinforces
    // inc3 = same s,p but o=CAROL → conflicts
    // inc1 = same as base with g=SRC1 → duplicate
    expect(diff.summary.duplicate + diff.summary.reinforces + diff.summary.conflicts).toBe(3);
  });

  it('initialises semantic summary fields to 0', () => {
    const diff = computeDiff([], []);
    expect(diff.summary.nearDuplicate).toBe(0);
    expect(diff.summary.synonymReinforces).toBe(0);
    expect(diff.summary.antonymConflicts).toBe(0);
  });
});

// ── Rejected / superseded exclusion ──────────────────────────────────────────

describe('computeDiff — ignored statuses', () => {
  // These two previously asserted 'new', which is the bug: a settled decision came back as
  // news on every re-read. They now assert 'returned' — still kept out of the ACTIVE indexes
  // (never a duplicate/conflict/refinement of a live claim), but no longer forgotten.
  it('reports a rejected triple offered again as returned, not new', () => {
    const existing = makeStatement({ status: 'rejected' });
    const incoming = makeStatement({ id: 'inc', s: existing.s, p: existing.p, o: existing.o, g: existing.g });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('returned');
    expect(diff.summary.returned).toBe(1);
    expect(diff.summary.new).toBe(0);
    if (diff.entries[0].kind === 'returned') {
      expect(diff.entries[0].priorStatus).toBe('rejected');
      expect(diff.entries[0].existing).toEqual([existing]);
    }
  });

  it('reports a superseded triple offered again as returned, tagged superseded', () => {
    const existing = makeStatement({ status: 'superseded' });
    const incoming = makeStatement({ id: 'inc', s: existing.s, p: existing.p, o: existing.o, g: existing.g });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('returned');
    if (diff.entries[0].kind === 'returned') expect(diff.entries[0].priorStatus).toBe('superseded');
  });

  it('prefers rejected over superseded when a triple carries both histories', () => {
    const sup = makeStatement({ status: 'superseded' });
    const rej = makeStatement({ id: 'rej', s: sup.s, p: sup.p, o: sup.o, g: sup.g, status: 'rejected' });
    const incoming = makeStatement({ id: 'inc', s: sup.s, p: sup.p, o: sup.o, g: sup.g });
    const diff = computeDiff([incoming], [sup, rej]);
    expect(diff.entries[0].kind).toBe('returned');
    if (diff.entries[0].kind === 'returned') {
      expect(diff.entries[0].priorStatus).toBe('rejected');
      expect(diff.entries[0].existing).toEqual([rej]);
    }
  });

  it('does not let a rejection suppress a DIFFERENT object on the same predicate', () => {
    // Rejecting "alice age 30" says nothing about "alice age 31" — that may be the correction.
    const rejected = makeStatement({ p: AGE, o: lit('30'), status: 'rejected' });
    const incoming = makeStatement({ id: 'inc', p: AGE, o: lit('31') });
    const diff = computeDiff([incoming], [rejected]);
    expect(diff.entries[0].kind).toBe('new');
  });

  it('prefers a live claim over a settled one when both match exactly', () => {
    const rejected = makeStatement({ status: 'rejected' });
    const confirmed = makeStatement({ id: 'ok', s: rejected.s, p: rejected.p, o: rejected.o, g: rejected.g });
    const incoming = makeStatement({ id: 'inc', s: rejected.s, p: rejected.p, o: rejected.o, g: rejected.g });
    const diff = computeDiff([incoming], [rejected, confirmed]);
    expect(diff.entries[0].kind).toBe('duplicate');
  });

  it('does not re-propose a rejected fact on repeated polls of an unchanged source', () => {
    // The loop this fix exists for: a currents/source-refresh poll re-reads an UNCHANGED
    // source, so the extractor emits the identical triple every tick. Before the fix each
    // tick produced a fresh 'new' card for something the user had already thrown out.
    const store: Statement[] = [makeStatement({ status: 'rejected' })];
    const reRead = () => makeStatement({ id: `poll-${_id}`, s: store[0].s, p: store[0].p, o: store[0].o, g: store[0].g });

    for (let tick = 0; tick < 5; tick++) {
      const diff = computeDiff([reRead()], store);
      expect(diff.summary.new).toBe(0);
      expect(diff.summary.returned).toBe(1);
    }
  });

  it('does not ignore confirmed existing statements', () => {
    const existing = makeStatement({ status: 'confirmed' });
    const incoming = makeStatement({ id: 'inc', s: existing.s, p: existing.p, o: existing.o, g: existing.g });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('duplicate');
  });

  it('does not ignore pending existing statements', () => {
    const existing = makeStatement({ status: 'pending' });
    const incoming = makeStatement({ id: 'inc', s: existing.s, p: existing.p, o: existing.o, g: existing.g });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('duplicate');
  });
});

// ── Refinement edge cases ─────────────────────────────────────────────────────

describe('computeDiff — refinement detection', () => {
  it('does not treat identical literals as a refinement', () => {
    const existing = makeStatement({ o: lit('London') });
    const incoming = makeStatement({ id: 'i', o: lit('London'), g: SRC2 });
    // Same s,p,o but different g → reinforces, not refines
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('reinforces');
  });

  it('requires more than 4 extra chars to qualify as refinement', () => {
    // "London" (6) vs "London, UK" (10) → 4 extra chars — borderline
    const existing = makeStatement({ o: lit('London') });
    const inc4 = makeStatement({ id: 'i4', o: lit('London, UK') }); // 4 extra — should NOT refine
    const inc5 = makeStatement({ id: 'i5', o: lit('London, England') }); // 9 extra → refines
    const diff4 = computeDiff([inc4], [existing]);
    const diff5 = computeDiff([inc5], [existing]);
    expect(diff4.entries[0].kind).toBe('conflicts');
    expect(diff5.entries[0].kind).toBe('refines');
  });

  it('does not treat IRI objects as refinements', () => {
    const existing = makeStatement({ o: BOB });
    const incoming = makeStatement({ id: 'i', o: CAROL });
    const diff = computeDiff([incoming], [existing]);
    expect(diff.entries[0].kind).toBe('conflicts');
  });

  it('conflicts when some existing stmts refine and some do not', () => {
    // incoming refines stmt1 but conflicts stmt2 → should be conflicts overall
    const stmt1 = makeStatement({ id: 'e1', o: lit('Paris') });
    const stmt2 = makeStatement({ id: 'e2', o: lit('Madrid'), g: SRC2 });
    const incoming = makeStatement({ id: 'i', o: lit('Paris, France') });
    const diff = computeDiff([incoming], [stmt1, stmt2]);
    expect(diff.entries[0].kind).toBe('conflicts');
  });
});

// ── Empty cases ───────────────────────────────────────────────────────────────

describe('computeDiff — empty inputs', () => {
  it('returns empty diff for empty incoming', () => {
    const diff = computeDiff([], [makeStatement()]);
    expect(diff.entries).toHaveLength(0);
    expect(diff.summary.new).toBe(0);
  });

  it('returns empty diff for both empty', () => {
    const diff = computeDiff([], []);
    expect(diff.entries).toHaveLength(0);
  });

  it('treats all incoming as new when existing is empty', () => {
    const diff = computeDiff([makeStatement(), makeStatement()], []);
    expect(diff.summary.new).toBe(2);
  });
});
