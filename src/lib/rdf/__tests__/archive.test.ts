/**
 * Archive journal (F97.1).
 *
 * The dangerous failure here is not a lost snapshot — it is a lost EVENT. Losing the ability to
 * revert something is recoverable; losing the record that it ever happened is the silent-destruction
 * failure the whole feature exists to prevent. So these tests pin that retention never discards an
 * event, only its payload, and that milestones survive.
 */
import { describe, it, expect } from 'vitest';
import {
  archiveGraphName, isArchiveGraphName, parentGraphName,
  eventToStatements, statementsToEvents, applyRetention, snapshotFootprint,
  archiveEntities, restoreSnapshot, findArchivedReferences, detectChurn,
  type ArchiveEvent,
} from '../archive';
import type { Statement, NamedNode, Term } from '../types';

const iri = (value: string): NamedNode => ({ kind: 'iri', value });
const lit = (value: string): Term => ({ kind: 'literal', value });

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const ev = (over: Partial<ArchiveEvent> = {}): ArchiveEvent => ({
  id: 'e1', type: 'delete', at: T0, actor: 'human',
  entities: ['urn:a'], statementCount: 3, ...over,
});

describe('archive graph naming', () => {
  it('derives, detects, and reverses the archive name', () => {
    expect(archiveGraphName('Research')).toBe('Research (archives)');
    expect(isArchiveGraphName('Research (archives)')).toBe(true);
    expect(isArchiveGraphName('Research')).toBe(false);
    expect(parentGraphName('Research (archives)')).toBe('Research');
  });

  it('round-trips a name containing parentheses of its own', () => {
    const n = archiveGraphName('Q3 (draft)');
    expect(n).toBe('Q3 (draft) (archives)');
    expect(parentGraphName(n)).toBe('Q3 (draft)');
  });

  it('does not mistake a graph merely mentioning archives for an archive graph', () => {
    expect(isArchiveGraphName('Archives of Alexandria')).toBe(false);
  });
});

describe('journal serialization', () => {
  it('round-trips an event through statements', () => {
    const original = ev({
      id: 'abc', type: 'merge', actor: 'agent', entities: ['urn:b', 'urn:a'],
      statementCount: 12, parentStableId: 'stable-1', note: 'merged duplicates', milestone: true,
    });
    const [back] = statementsToEvents(eventToStatements(original));
    expect(back.id).toBe('abc');
    expect(back.type).toBe('merge');
    expect(back.actor).toBe('agent');
    expect(back.statementCount).toBe(12);
    expect(back.parentStableId).toBe('stable-1');
    expect(back.note).toBe('merged duplicates');
    expect(back.milestone).toBe(true);
    expect(back.entities).toEqual(['urn:a', 'urn:b']); // sorted
  });

  it('is deterministic — the same event serializes identically every time', () => {
    const e = ev({ entities: ['urn:z', 'urn:a', 'urn:m'] });
    expect(eventToStatements(e)).toEqual(eventToStatements(e));
  });

  it('ignores statements that are not journal entries', () => {
    const noise: Statement = {
      id: 'n1', s: iri('urn:something'), p: iri('urn:p'), o: lit('v'), g: iri('urn:g'),
      sourceId: 'x', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0,
    };
    const events = statementsToEvents([...eventToStatements(ev()), noise]);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('e1');
  });

  it('reads multiple events back newest-first', () => {
    const stmts = [
      ...eventToStatements(ev({ id: 'old', at: T0 })),
      ...eventToStatements(ev({ id: 'new', at: T0 + DAY })),
    ];
    expect(statementsToEvents(stmts).map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('skips rejected and superseded journal statements', () => {
    const stmts = eventToStatements(ev()).map((s) => ({ ...s, status: 'rejected' as const }));
    expect(statementsToEvents(stmts)).toEqual([]);
  });
});

describe('retention', () => {
  // 30 daily events, newest last.
  const many = Array.from({ length: 30 }, (_, i) =>
    ev({ id: `e${i}`, at: T0 + i * DAY, statementCount: 5 }));
  const now = T0 + 30 * DAY;

  it('never drops the EVENT, only its snapshot', () => {
    const { keep, dropSnapshots } = applyRetention(many, { keepLast: 5 }, now);
    // Every event is accounted for in one bucket or the other — none vanishes.
    expect(keep.length + dropSnapshots.length).toBe(many.length);
  });

  it('always keeps the most recent snapshots', () => {
    const { keep } = applyRetention(many, { keepLast: 5, thinToOnePer: 365 * DAY }, now);
    const newest = [...many].sort((a, b) => b.at - a.at).slice(0, 5).map((e) => e.id);
    for (const id of newest) expect(keep.map((k) => k.id)).toContain(id);
  });

  it('always keeps milestones, however old', () => {
    const withMilestone = [...many, ev({ id: 'ancient', at: T0 - 400 * DAY, milestone: true })];
    const { keep, dropSnapshots } = applyRetention(withMilestone, { keepLast: 2, thinToOnePer: DAY }, now);
    expect(keep.map((k) => k.id)).toContain('ancient');
    expect(dropSnapshots.map((k) => k.id)).not.toContain('ancient');
  });

  it('thins beyond the recent window to one per period', () => {
    // Ten events inside a single hour, well outside keepLast.
    const burst = Array.from({ length: 10 }, (_, i) =>
      ev({ id: `b${i}`, at: T0 + i * 60_000, statementCount: 2 }));
    const recent = Array.from({ length: 3 }, (_, i) =>
      ev({ id: `r${i}`, at: T0 + 10 * DAY + i * DAY, statementCount: 2 }));
    const { keep } = applyRetention([...burst, ...recent], { keepLast: 3, thinToOnePer: DAY }, now);
    const keptBurst = keep.filter((k) => k.id.startsWith('b'));
    expect(keptBurst).toHaveLength(1);
  });

  it('drops snapshots past maxAge even when recent-by-rank', () => {
    const old = [ev({ id: 'stale', at: T0 - 100 * DAY })];
    const { keep, dropSnapshots } = applyRetention(old, { keepLast: 10, maxAgeMs: 30 * DAY }, now);
    expect(keep).toEqual([]);
    expect(dropSnapshots.map((e) => e.id)).toEqual(['stale']);
  });

  it('maxAge overrides milestone — an explicit cutoff is the user\'s decision', () => {
    const old = [ev({ id: 'stale', at: T0 - 100 * DAY, milestone: true })];
    const { dropSnapshots } = applyRetention(old, { maxAgeMs: 30 * DAY }, now);
    expect(dropSnapshots.map((e) => e.id)).toEqual(['stale']);
  });

  it('handles an empty journal', () => {
    expect(applyRetention([], {}, now)).toEqual({ keep: [], dropSnapshots: [] });
  });
});

describe('archiveEntities — the move', () => {
  const st = (s: string, p: string, o: Term, id = `${s}|${p}`): Statement => ({
    id, s: iri(s), p: iri(p), o, g: iri('urn:g'),
    sourceId: 'x', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0,
  });
  const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
  const graph = [
    st('urn:keep', LABEL, lit('Keeper')),
    st('urn:keep', 'urn:p/rel', iri('urn:other')),
    st('urn:gone', LABEL, lit('Goner')),
    st('urn:gone', 'urn:p/rel', iri('urn:other')),
    st('urn:other', 'urn:p/points-at', iri('urn:gone')), // inbound edge to the archived node
  ];

  const move = (entities: string[]) => archiveEntities({
    statements: graph, entities, type: 'delete', actor: 'human',
    at: T0, eventId: 'mv1',
  });

  it('moves statements where the entity is the SUBJECT', () => {
    const { archived } = move(['urn:gone']);
    expect(archived.map((s) => s.id)).toContain('urn:gone|http://www.w3.org/2000/01/rdf-schema#label');
  });

  it('moves inbound edges too, so no arrow points into empty space', () => {
    const { archived, kept } = move(['urn:gone']);
    expect(archived.map((s) => s.id)).toContain('urn:other|urn:p/points-at');
    expect(kept.map((s) => s.id)).not.toContain('urn:other|urn:p/points-at');
  });

  it('loses nothing — kept plus archived is the whole graph', () => {
    const { kept, archived } = move(['urn:gone']);
    expect(kept.length + archived.length).toBe(graph.length);
    expect([...kept, ...archived].map((s) => s.id).sort()).toEqual(graph.map((s) => s.id).sort());
  });

  it('leaves untouched entities alone', () => {
    const { kept } = move(['urn:gone']);
    expect(kept.map((s) => s.id)).toContain('urn:keep|http://www.w3.org/2000/01/rdf-schema#label');
  });

  it('snapshots the PRE-operation graph, which is what revert needs', () => {
    const { event } = move(['urn:gone']);
    expect(event.snapshot).toEqual(graph);
    expect(event.statementCount).toBe(3);
  });

  it('archiving nothing is a no-op that still journals honestly', () => {
    const { kept, archived, event } = move([]);
    expect(kept).toEqual(graph);
    expect(archived).toEqual([]);
    expect(event.statementCount).toBe(0);
  });

  it('mutates neither the input array nor its statements', () => {
    const before = JSON.stringify(graph);
    move(['urn:gone']);
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe('restoreSnapshot — revert', () => {
  const mk = (id: string): Statement => ({
    id, s: iri(`urn:${id}`), p: iri('urn:p'), o: lit('v'), g: iri('urn:g'),
    sourceId: 'x', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0,
  });
  const snapshot = [mk('a'), mk('b')];
  const current = [mk('a')];

  it('restores the graph exactly as it was', () => {
    const { restored } = restoreSnapshot(current, snapshot, { eventId: 'r1', at: T0, actor: 'human' });
    expect(restored).toEqual(snapshot);
  });

  it('journals the revert itself so it can be undone', () => {
    const { event } = restoreSnapshot(current, snapshot, { eventId: 'r1', at: T0, actor: 'human' });
    expect(event.type).toBe('revert');
    // The revert's own snapshot is the PRE-revert state — that is what makes redo possible.
    expect(event.snapshot).toEqual(current);
  });

  it('a revert of a revert returns to the original state', () => {
    const first = restoreSnapshot(current, snapshot, { eventId: 'r1', at: T0, actor: 'human' });
    const second = restoreSnapshot(first.restored, first.event.snapshot!, { eventId: 'r2', at: T0 + 1, actor: 'human' });
    expect(second.restored).toEqual(current);
  });
});

describe('findArchivedReferences (F97.3) — no silent duplicates', () => {
  const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
  const mk = (s: string, p: string, o: Term, id = `${s}|${p}|${o.value}`): Statement => ({
    id, s: iri(s), p: iri(p), o, g: iri('urn:g'),
    sourceId: 'x', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0,
  });
  const archived = [
    mk('urn:acme', LABEL, lit('Acme Corp')),
    mk('urn:acme', 'urn:p/industry', lit('battery')),
  ];

  it('catches a direct IRI reference to an archived entity', () => {
    const incoming = [mk('urn:acme', 'urn:p/employees', lit('50'))];
    const refs = findArchivedReferences(incoming, archived);
    expect(refs).toHaveLength(1);
    expect(refs[0].entity).toBe('urn:acme');
    expect(refs[0].label).toBe('Acme Corp');
  });

  it('catches a NEW node reusing an archived label — the duplicate that would otherwise be minted', () => {
    const incoming = [mk('urn:new-node', LABEL, lit('acme  corp'))];
    const refs = findArchivedReferences(incoming, archived);
    expect(refs).toHaveLength(1);
    expect(refs[0].entity).toBe('urn:acme');
  });

  it('catches an inbound edge pointing at an archived entity', () => {
    const incoming = [mk('urn:beta', 'urn:p/competes-with', iri('urn:acme'))];
    expect(findArchivedReferences(incoming, archived)).toHaveLength(1);
  });

  it('does not flag unrelated incoming facts', () => {
    const incoming = [mk('urn:zeta', LABEL, lit('Completely Different'))];
    expect(findArchivedReferences(incoming, archived)).toEqual([]);
  });

  it('does not flag an entity as a duplicate of itself', () => {
    const incoming = [mk('urn:acme', LABEL, lit('Acme Corp'))];
    const refs = findArchivedReferences(incoming, archived);
    // It IS a direct IRI hit (restore it), but not a label-collision duplicate.
    expect(refs.map((r) => r.entity)).toEqual(['urn:acme']);
    expect(refs[0].incoming).toHaveLength(1);
  });

  it('ranks the most-referenced archived entity first', () => {
    const other = [...archived, mk('urn:solo', LABEL, lit('Solo'))];
    const incoming = [
      mk('urn:acme', 'urn:p/a', lit('1'), 'i1'),
      mk('urn:acme', 'urn:p/b', lit('2'), 'i2'),
      mk('urn:solo', 'urn:p/c', lit('3'), 'i3'),
    ];
    expect(findArchivedReferences(incoming, other)[0].entity).toBe('urn:acme');
  });

  it('handles an empty archive', () => {
    expect(findArchivedReferences([mk('urn:a', 'urn:p', lit('v'))], [])).toEqual([]);
  });
});

describe('detectChurn (F97.6)', () => {
  it('flags an entity archived repeatedly', () => {
    const events = [
      ev({ id: '1', at: T0, entities: ['urn:noisy'] }),
      ev({ id: '2', at: T0 + DAY, entities: ['urn:noisy'] }),
      ev({ id: '3', at: T0 + 2 * DAY, entities: ['urn:noisy', 'urn:calm'] }),
    ];
    const scores = detectChurn(events);
    const noisy = scores.find((s) => s.entity === 'urn:noisy')!;
    expect(noisy.archivedCount).toBe(3);
    expect(noisy.churning).toBe(true);
    expect(noisy.lastArchivedAt).toBe(T0 + 2 * DAY);
    expect(scores.find((s) => s.entity === 'urn:calm')!.churning).toBe(false);
  });

  it('does not count a revert as churn — a revert is the cure, not the disease', () => {
    const events = [
      ev({ id: '1', at: T0, entities: ['urn:x'] }),
      ev({ id: '2', at: T0 + 1, type: 'revert', entities: ['urn:x'] }),
      ev({ id: '3', at: T0 + 2, type: 'revert', entities: ['urn:x'] }),
    ];
    expect(detectChurn(events)[0].archivedCount).toBe(1);
  });

  it('respects a caller-supplied threshold', () => {
    const events = [ev({ id: '1', entities: ['urn:x'] }), ev({ id: '2', at: T0 + 1, entities: ['urn:x'] })];
    expect(detectChurn(events, 2)[0].churning).toBe(true);
    expect(detectChurn(events, 5)[0].churning).toBe(false);
  });

  it('handles an empty journal', () => {
    expect(detectChurn([])).toEqual([]);
  });
});

describe('snapshotFootprint', () => {
  it('reports the storage cost so it never becomes a surprise', () => {
    const events = [ev({ statementCount: 100 }), ev({ id: 'e2', statementCount: 250 })];
    expect(snapshotFootprint(events)).toBe(350);
  });

  it('prefers the real snapshot length over the recorded count when present', () => {
    const snapshot = Array.from({ length: 4 }, (_, i) => ({
      id: `s${i}`, s: iri('urn:a'), p: iri('urn:p'), o: lit('v'), g: iri('urn:g'),
      sourceId: 'x', confidence: 1, status: 'confirmed' as const, createdAt: 0, updatedAt: 0,
    }));
    expect(snapshotFootprint([ev({ statementCount: 999, snapshot })])).toBe(4);
  });
});
