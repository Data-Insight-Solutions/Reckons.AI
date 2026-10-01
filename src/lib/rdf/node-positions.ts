/**
 * Where a person put a node in the free layout, remembered in the space's own Turtle.
 *
 * Matt, 2026-09-30: "make the layout mode 'free' actually let you move the nodes position, and it
 * remembers the last position within the TTL." Free is the force layout: it computes positions, so
 * a dragged node would drift back as soon as the simulation moved. A drag now PINS the node, and the
 * pin is stored as two facts about the entity, hnav:x and hnav:y — the navigation namespace that
 * already holds view-only facts like hnav:order, hidden from the graph by isMetaPredicate. They are
 * written confirmed under the manual source, like a set the person makes: a view the person chose,
 * not a claim anyone needs to review. Only the free layout reads them; every other layout computes
 * its own positions. Only entity (IRI) nodes are stored — a literal is not a thing with a place.
 */
import { v4 as uuid } from 'uuid';
import { NAV_PREFIX, type Statement } from './types';

export const NAV_X = `${NAV_PREFIX}x`;
export const NAV_Y = `${NAV_PREFIX}y`;

const ACTIVE = (s: Statement) => s.status !== 'rejected' && s.status !== 'superseded';

/** Stored free-layout positions, by entity IRI. A node with only one coordinate is not placed. */
export function positionsFrom(statements: readonly Statement[]): Map<string, { x: number; y: number }> {
  const x = new Map<string, number>();
  const y = new Map<string, number>();
  for (const st of statements) {
    if (!ACTIVE(st) || st.s.kind !== 'iri' || st.o.kind !== 'literal') continue;
    if (st.p.value !== NAV_X && st.p.value !== NAV_Y) continue;
    const v = Number(st.o.value);
    if (!Number.isFinite(v)) continue;
    (st.p.value === NAV_X ? x : y).set(st.s.value, v);
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [iri, vx] of x) {
    const vy = y.get(iri);
    if (vy !== undefined) out.set(iri, { x: vx, y: vy });
  }
  return out;
}

/** One decimal place: a drag is not more precise than that, and every digit is churn in the file. */
const round = (v: number) => String(Math.round(v * 10) / 10);

export type PositionWrite = { updates: { id: string; value: string }[]; adds: Statement[] };

/**
 * What to write to remember `iri` at (x, y): update the existing coordinate statements in place
 * when there are any, so repeated drags change two facts rather than piling up new ones.
 */
export function positionWrites(iri: string, x: number, y: number, statements: readonly Statement[], now = Date.now()): PositionWrite {
  const updates: PositionWrite['updates'] = [];
  const adds: Statement[] = [];
  for (const [pred, value] of [[NAV_X, round(x)], [NAV_Y, round(y)]] as const) {
    const existing = statements.find((st) => ACTIVE(st) && st.s.kind === 'iri' && st.s.value === iri && st.p.value === pred);
    if (existing) {
      if (existing.o.value !== value) updates.push({ id: existing.id, value });
    } else {
      adds.push({
        id: uuid(),
        s: { kind: 'iri', value: iri },
        p: { kind: 'iri', value: pred },
        o: { kind: 'literal', value, datatype: 'http://www.w3.org/2001/XMLSchema#decimal' },
        g: { kind: 'iri', value: 'urn:kbase:source/manual' },
        sourceId: 'manual',
        confidence: 1,
        status: 'confirmed',
        createdAt: now,
        updatedAt: now,
      } as Statement);
    }
  }
  return { updates, adds };
}
