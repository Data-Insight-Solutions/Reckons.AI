/**
 * Relation layers at the tool boundary (F194).
 *
 * What is worth testing here is not the grouping — it is the SAFETY DIRECTION. Because provenance
 * auto-confirms, every uncertain case must land on `claim`, the layer that still requires a
 * person. A test suite that only checked "does it group" would pass while the one property that
 * matters silently inverted.
 */
import { describe, expect, it } from 'vitest';
import { groupByLayer, layerOf, loadLayerMap, renderLayered, LAYER_PREDICATE } from '../layers.js';

const KP = 'urn:kbase:predicate/';
const t = (subject: string, predicate: string, object: string) =>
  ({ subject, predicate, object, objectIsLiteral: true });

const classify = (pred: string, layer: string) => t(`${KP}${pred}`, LAYER_PREDICATE, layer);

describe('loadLayerMap', () => {
  it('reads a classification given as a bare notation', () => {
    const map = loadLayerMap([classify('has-file', 'provenance')]);
    expect(map.declaredCount).toBe(1);
    expect(layerOf(`${KP}has-file`, map)).toBe('provenance');
  });

  it('reads a classification given as a klayer: IRI', () => {
    const map = loadLayerMap([t(`${KP}has-file`, LAYER_PREDICATE, 'urn:kbase:type/layer/provenance')]);
    expect(layerOf(`${KP}has-file`, map)).toBe('provenance');
  });

  it('ignores a value that is not a layer in the scheme', () => {
    // A typo must not create a fourth layer, and must not silently become provenance.
    const map = loadLayerMap([classify('has-file', 'provenence')]);
    expect(map.declaredCount).toBe(0);
    expect(layerOf(`${KP}has-file`, map)).toBe('claim');
  });

  it('counts only real classifications, so "nothing is classified" is knowable', () => {
    expect(loadLayerMap([t('a', `${KP}description`, 'x')]).declaredCount).toBe(0);
  });
});

describe('layerOf — the fail-safe direction', () => {
  const empty = loadLayerMap([]);

  it('defaults an unclassified predicate to claim, never provenance', () => {
    expect(layerOf(`${KP}anything-at-all`, empty)).toBe('claim');
  });

  it('does not infer provenance from a file-shaped NAME', () => {
    // The whole risk of this refactor is a predicate filed provenance that should not be. A name
    // is not evidence: has-file is provenance, has-status is a claim, and they read alike.
    expect(layerOf(`${KP}has-file`, empty)).toBe('claim');
    expect(layerOf(`${KP}repo-url`, empty)).toBe('claim');
    expect(layerOf(`${KP}git-commit`, empty)).toBe('claim');
  });

  it('treats meta and PROV namespaces as provenance by construction', () => {
    // Not a guess about meaning: these namespaces describe how a statement arrived and have no
    // other purpose.
    expect(layerOf('urn:kbase:meta/kbStableId', empty)).toBe('provenance');
    expect(layerOf('http://www.w3.org/ns/prov#wasDerivedFrom', empty)).toBe('provenance');
  });

  it('recognises the house question predicate without classification', () => {
    expect(layerOf(`${KP}open-question`, empty)).toBe('question');
  });

  it('does NOT treat kpred:remaining as a question', () => {
    // Matt, 2026-09-09: "plan isn't really a question." Its values are definitions of done.
    expect(layerOf(`${KP}remaining`, empty)).toBe('claim');
  });

  it('lets an explicit classification override the structural fallback', () => {
    const map = loadLayerMap([t('urn:kbase:meta/note', LAYER_PREDICATE, 'claim')]);
    expect(layerOf('urn:kbase:meta/note', map)).toBe('claim');
  });
});

describe('groupByLayer', () => {
  const map = loadLayerMap([
    classify('has-file', 'provenance'),
    classify('assumption', 'provenance'),
  ]);

  it('splits three ways and keeps input order inside each layer', () => {
    const g = groupByLayer([
      t('e', `${KP}description`, 'first'),
      t('e', `${KP}has-file`, 'a.ts'),
      t('e', `${KP}open-question`, 'which one?'),
      t('e', `${KP}principle`, 'second'),
      t('e', `${KP}assumption`, 'read "they" as Bynder'),
    ], map);

    expect(g.claim.map((x: { object: string }) => x.object)).toEqual(['first', 'second']);
    expect(g.question.map((x: { object: string }) => x.object)).toEqual(['which one?']);
    expect(g.provenance.map((x: { object: string }) => x.object)).toEqual(['a.ts', 'read "they" as Bynder']);
  });

  it('returns three empty layers for no input', () => {
    expect(groupByLayer([], map)).toEqual({ claim: [], question: [], provenance: [] });
  });
});

describe('renderLayered', () => {
  it('puts claims before questions before provenance', () => {
    const map = loadLayerMap([classify('has-file', 'provenance')]);
    const out = renderLayered([
      t('e', `${KP}has-file`, 'a.ts'),
      t('e', `${KP}open-question`, 'which one?'),
      t('e', `${KP}description`, 'a thing'),
    ], map).join('\n');

    expect(out.indexOf('CLAIMS')).toBeLessThan(out.indexOf('QUESTIONS'));
    expect(out.indexOf('QUESTIONS')).toBeLessThan(out.indexOf('PROVENANCE'));
  });

  it('omits a layer that has nothing in it', () => {
    const out = renderLayered([t('e', `${KP}description`, 'a thing')], loadLayerMap([])).join('\n');
    expect(out).toContain('CLAIMS');
    expect(out).not.toContain('QUESTIONS');
  });

  it('says so when nothing in the corpus is classified', () => {
    // "This entity has no provenance" and "nothing is classified yet" are different answers, and
    // an agent acting on the first when the second is true would be badly misled.
    const out = renderLayered([t('e', `${KP}description`, 'x')], loadLayerMap([])).join('\n');
    expect(out).toContain('no predicate in this corpus carries kpred:layer yet');
  });

  it('drops the note once classifications exist', () => {
    const map = loadLayerMap([classify('has-file', 'provenance')]);
    const out = renderLayered([t('e', `${KP}has-file`, 'a.ts')], map).join('\n');
    expect(out).not.toContain('no predicate in this corpus');
  });
});
