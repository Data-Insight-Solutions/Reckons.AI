import { describe, it, expect } from 'vitest';
import type { Statement } from '../types';
import { targetReached } from '../proposal';
import {
  RECKONING_PREDICATES, reckoningStatements, readReckoning, questionTargets, targetShapeFor, targetAssetEntity,
  NO_TARGET, type ReckoningTarget,
} from '../reckoning-entity';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const st = (id: string, o: string, extra: Partial<Statement> = {}): Statement => ({
  id, s: { kind: 'iri', value: 'urn:kbase:concept/vendor' }, p: { kind: 'iri', value: 'urn:kbase:predicate/price' },
  o: { kind: 'literal', value: o }, g: { kind: 'iri', value: 'urn:kbase:source/a' },
  sourceId: 'a', status: 'confirmed', confidence: 1, createdAt: 1, updatedAt: 1, ...extra,
});
const question = st('q1', '?', { status: 'pending', needsObject: true, question: 'What does the vendor charge?' });
const withTarget = (target: Partial<ReckoningTarget>) => {
  const t = { ...NO_TARGET, ...target };
  return readReckoning(reckoningStatements('r1', ['a'], 'x', 1, t), 'r1')!;
};
const label = (iri: string) => iri.split('/').pop()!;

describe('reckoning target', () => {
  it('writes and reads a question target, an asset target and a written outcome', () => {
    expect(withTarget({ statementId: 'q1' }).target).toEqual({ statementId: 'q1', assetType: null, note: '' });
    expect(withTarget({ assetType: 'urn:kbase:type/Image', note: 'A logo' }).target)
      .toEqual({ statementId: null, assetType: 'urn:kbase:type/Image', note: 'A logo' });
    expect(withTarget({ note: ' Pick one ' }).target).toEqual({ statementId: null, assetType: null, note: 'Pick one' });
    expect(withTarget({}).target).toEqual(NO_TARGET);
  });
  it('keeps only the question when both a question and an asset are given, and writes confirmed rows', () => {
    const rows = reckoningStatements('r1', ['a'], '', 1, { statementId: 'q1', assetType: 'urn:kbase:type/Image', note: '' });
    expect(rows.some((r) => r.p.value === RECKONING_PREDICATES.targetAsset)).toBe(false);
    expect(rows.find((r) => r.p.value === RECKONING_PREDICATES.targetStatement)?.status).toBe('confirmed');
  });
  it('a question target needs its missing object filled: not reached while open, reached once answered', () => {
    const shape = targetShapeFor(withTarget({ statementId: 'q1' }), [question])!;
    expect(shape.requirements).toEqual([{ s: 'urn:kbase:concept/vendor', p: 'urn:kbase:predicate/price' }]);
    expect(targetReached(shape, [question]).reached).toBe(false);
    expect(targetReached(shape, [st('a1', '40 dollars')]).reached).toBe(true);
    expect(targetReached(shape, [st('a2', '40 dollars', { status: 'pending' })]).reached).toBe(false);
  });
  it('an asset target needs the asset to exist with the chosen type', () => {
    const r = withTarget({ assetType: 'urn:kbase:type/Model3D' });
    const shape = targetShapeFor(r, [])!;
    expect(shape.requirements).toEqual([{ s: targetAssetEntity('r1'), p: RDF_TYPE, o: 'urn:kbase:type/Model3D' }]);
    expect(targetReached(shape, []).reached).toBe(false);
    const asset = (type: string): Statement => ({ ...st('x', type), s: { kind: 'iri', value: targetAssetEntity('r1') }, p: { kind: 'iri', value: RDF_TYPE }, o: { kind: 'iri', value: type } });
    expect(targetReached(shape, [asset('urn:kbase:type/Image')]).reached).toBe(false);
    expect(targetReached(shape, [asset('urn:kbase:type/Model3D')]).reached).toBe(true);
  });
  it('has no shape for free text only, or for a question that is gone', () => {
    expect(targetShapeFor(withTarget({ note: 'Choose well' }), [])).toBeNull();
    expect(targetShapeFor(withTarget({ statementId: 'gone' }), [question])).toBeNull();
  });
  it('lists open questions, filtered by search, and nothing held', () => {
    const all = [question, st('h1', '40')];
    expect(questionTargets(all, '', label).map((s) => s.id)).toEqual(['q1']);
    expect(questionTargets(all, 'charge', label)).toHaveLength(1);
    expect(questionTargets(all, 'zebra', label)).toHaveLength(0);
  });
});
