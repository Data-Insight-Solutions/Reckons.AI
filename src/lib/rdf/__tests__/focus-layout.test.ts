import { describe, it, expect } from 'vitest';
import { focusPlacement, toPlane, type FocusEdge } from '../focus-layout';

const e = (a: string, predicate: string, b: string): FocusEdge => ({ a, b, predicate });
const TWO_PI = Math.PI * 2;
/** Smallest angle between two directions, so 359° and 1° are 2° apart rather than 358°. */
const arcBetween = (x: number, y: number) => {
  const d = Math.abs(((x - y) % TWO_PI + TWO_PI) % TWO_PI);
  return Math.min(d, TWO_PI - d);
};

describe('focus placement', () => {
  it('is empty with nothing selected — not a ring around the origin', () => {
    const { placement } = focusPlacement([e('a', 'p', 'b')], ['a', 'b'], null);
    expect(placement.size).toBe(0);
  });

  it('puts the selection at hop 0 and its neighbours at hop 1', () => {
    const { placement, maxHop } = focusPlacement(
      [e('me', 'knows', 'x'), e('me', 'knows', 'y')], ['me', 'x', 'y'], 'me',
    );
    expect(placement.get('me')!.hop).toBe(0);
    expect(placement.get('x')!.hop).toBe(1);
    expect(placement.get('y')!.hop).toBe(1);
    expect(maxHop).toBe(1);
  });

  /**
   * DIRECTION IS READABLE FROM POSITION, which is the reason for the two arcs. An arrowhead is a
   * few pixels; which half of the ring a node sits in is visible at any zoom.
   */
  it('separates what the selection points AT from what points AT IT', () => {
    const { placement } = focusPlacement(
      [e('me', 'owns', 'out1'), e('me', 'owns', 'out2'), e('in1', 'cites', 'me'), e('in2', 'cites', 'me')],
      ['me', 'out1', 'out2', 'in1', 'in2'], 'me',
    );
    const outs = ['out1', 'out2'].map((k) => placement.get(k)!.angle);
    const ins = ['in1', 'in2'].map((k) => placement.get(k)!.angle);
    // every outgoing node is nearer every other outgoing node than it is to any incoming one
    for (const o of outs) for (const i of ins) {
      expect(arcBetween(o, i)).toBeGreaterThan(arcBetween(outs[0], outs[1]));
    }
  });

  it('gives the whole circle to one side when the other is empty', () => {
    const { placement } = focusPlacement(
      [e('me', 'p', 'a'), e('me', 'p', 'b'), e('me', 'p', 'c')], ['me', 'a', 'b', 'c'], 'me',
    );
    const angles = ['a', 'b', 'c'].map((k) => placement.get(k)!.angle).sort((x, y) => x - y);
    // three nodes over a full circle sit roughly 120° apart; a squeezed arc would be far tighter
    expect(arcBetween(angles[0], angles[1])).toBeGreaterThan(Math.PI * 0.5);
  });

  /** A branch that scatters its children round the ring is unreadable; this is what stops it. */
  it('keeps a branch together — hop 2 fans around its parent', () => {
    const { placement } = focusPlacement(
      [e('me', 'p', 'parent'), e('parent', 'q', 'kid1'), e('parent', 'q', 'kid2')],
      ['me', 'parent', 'kid1', 'kid2'], 'me',
    );
    const parent = placement.get('parent')!.angle;
    for (const kid of ['kid1', 'kid2']) {
      expect(placement.get(kid)!.hop).toBe(2);
      expect(arcBetween(placement.get(kid)!.angle, parent)).toBeLessThan(Math.PI * 0.4);
    }
  });

  /**
   * A node with no path to the selection is still IN THE GRAPH. Dropping it makes the graph look
   * smaller than it is — the same rule map-layout applies to nodes with no coordinates.
   */
  it('places unreachable nodes beyond the last hop rather than dropping them', () => {
    const { placement, maxHop } = focusPlacement(
      [e('me', 'p', 'near')], ['me', 'near', 'island1', 'island2'], 'me',
    );
    for (const k of ['island1', 'island2']) {
      expect(placement.has(k)).toBe(true);
      expect(placement.get(k)!.unreachable).toBe(true);
      expect(placement.get(k)!.hop).toBeGreaterThan(maxHop);
    }
    expect(placement.get('near')!.unreachable).toBe(false);
  });

  it('does not stack two unreachable nodes on the same spot', () => {
    const { placement } = focusPlacement([], ['me', 'a', 'b', 'c'], 'me');
    const angles = ['a', 'b', 'c'].map((k) => placement.get(k)!.angle);
    expect(new Set(angles).size).toBe(3);
  });

  it('survives a cycle without looping forever', () => {
    const { placement, maxHop } = focusPlacement(
      [e('a', 'p', 'b'), e('b', 'p', 'c'), e('c', 'p', 'a')], ['a', 'b', 'c'], 'a',
    );
    expect(placement.size).toBe(3);
    expect(maxHop).toBe(1); // b and c are both one hop from a in an undirected reading
  });

  it('projects to a plane with radius growing by hop', () => {
    const { placement } = focusPlacement(
      [e('me', 'p', 'one'), e('one', 'p', 'two')], ['me', 'one', 'two'], 'me',
    );
    const r = (k: string) => Math.hypot(toPlane(placement.get(k)!, 4).x, toPlane(placement.get(k)!, 4).y);
    expect(r('me')).toBeCloseTo(0, 6);
    expect(r('one')).toBeCloseTo(4, 6);
    expect(r('two')).toBeCloseTo(8, 6);
  });
});
