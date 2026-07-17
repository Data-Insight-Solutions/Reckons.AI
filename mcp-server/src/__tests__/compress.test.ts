/**
 * Context compression (F25).
 *
 * The headline claim was "~60-70% token reduction vs raw Turtle". It had NO test behind
 * it, because the function lived privately inside the server entrypoint — and the first
 * test ever written for it FALSIFIED the claim.
 *
 * Measured here: the FORMAT saves ~18% against grouped Turtle (what a real .ttl looks
 * like) and ~29% against flat one-triple-per-line Turtle. The 60-70% figure conflated the
 * encoding with SUBGRAPH SELECTION — returning a relevant slice instead of the whole
 * ~116k-token graph — which is where the large saving actually comes from. Selection is
 * the headline; the format is a modest, real win on top of it.
 *
 * The measurement test asserts BOTH a floor (catch a regression) and a ceiling (stop the
 * inflated claim creeping back). A measured claim with no measurement is exactly what
 * kb:honest-status exists to stop.
 */
import { describe, it, expect } from 'vitest';
import { compressTriples, estimateTokens, MAX_INBOUND_REFS } from '../compress.js';
import type { Triple } from '../kb-reader.js';

const KB = 'urn:kbase:concept/';
const KP = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const t = (subject: string, predicate: string, object: string, isLit = true): Triple =>
  ({ subject, predicate, object, objectIsLiteral: isLit }) as Triple;

/** The same facts rendered as raw Turtle — the baseline the claim is measured against. */
function asTurtle(triples: Triple[]): string {
  const lines = ['@prefix kb: <urn:kbase:concept/> .', '@prefix kpred: <urn:kbase:predicate/> .', ''];
  for (const x of triples) {
    const o = x.objectIsLiteral ? `"${x.object}"` : `kb:${x.object.replace(KB, '')}`;
    lines.push(`kb:${x.subject.replace(KB, '')} kpred:${x.predicate.replace(KP, '')} ${o} .`);
  }
  return lines.join('\n');
}

/** Grouped Turtle — what a real hand-authored .ttl actually looks like. Compressing
 *  against the FLAT form alone flatters the result, so the honest baseline is this one. */
function asGroupedTurtle(triples: Triple[]): string {
  const by = new Map<string, Triple[]>();
  for (const x of triples) {
    const a = by.get(x.subject) ?? [];
    a.push(x);
    by.set(x.subject, a);
  }
  const lines = ['@prefix kb: <urn:kbase:concept/> .', '@prefix kpred: <urn:kbase:predicate/> .', ''];
  for (const [subj, ts] of by) {
    lines.push(`kb:${subj.replace(KB, '')}`);
    ts.forEach((x, i) => {
      const o = x.objectIsLiteral ? `"${x.object}"` : `kb:${x.object.replace(KB, '')}`;
      lines.push(`    kpred:${x.predicate.replace(KP, '')} ${o}${i === ts.length - 1 ? ' .' : ' ;'}`);
    });
  }
  return lines.join('\n');
}

describe('estimateTokens', () => {
  it('counts ~1.33 tokens per word', () => {
    expect(estimateTokens('one two three')).toBe(4); // 3 * 1.33 = 3.99 -> 4
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n  ')).toBe(0);
  });
});

describe('compressTriples', () => {
  it('groups facts under one entity header', () => {
    const { text, stats } = compressTriples(
      [
        t(`${KB}reckons`, RDF_TYPE, `${KB}App`, false),
        t(`${KB}reckons`, `${KP}has-status`, 'production'),
        t(`${KB}reckons`, `${KP}description`, 'a local-first knowledge graph'),
      ],
      [`${KB}reckons`],
      2000,
    );
    expect(text).toContain('# reckons');
    expect(text).toContain('.a App');                    // rdf:type collapses to `a`
    expect(text).toContain('.has-status production');    // single word: unquoted
    expect(text).toContain('.description "a local-first knowledge graph"'); // spaces: quoted
    expect(stats.entities).toBe(1);
    expect(stats.facts).toBe(3);
  });

  it('records inbound references and caps them', () => {
    const triples: Triple[] = [];
    for (let i = 0; i < MAX_INBOUND_REFS + 3; i++) {
      triples.push(t(`${KB}dep${i}`, `${KP}depends-on`, `${KB}core`, false));
    }
    triples.push(t(`${KB}core`, `${KP}has-status`, 'production'));

    const { text } = compressTriples(triples, [`${KB}core`], 5000);
    const coreBlock = text.split('# ').find((b) => b.startsWith('core'))!;
    expect(coreBlock).toContain('< dep0 .depends-on');
    // A hub node must not swamp the budget: the overflow is summarised, not listed.
    expect(coreBlock).toContain('(+3 more refs)');
  });

  it('honours the token budget by dropping whole entities', () => {
    const triples: Triple[] = [];
    for (let i = 0; i < 40; i++) {
      triples.push(t(`${KB}e${i}`, `${KP}description`, 'a fairly wordy description of this entity'));
    }
    const { stats } = compressTriples(triples, [], 60);
    expect(stats.tokens).toBeLessThanOrEqual(80); // budget respected (last block may straddle)
    expect(stats.entities).toBeGreaterThan(0);
    expect(stats.entities).toBeLessThan(40);      // and it really did drop some
  });

  it('always emits at least one entity, even if it alone busts the budget', () => {
    // An empty context is useless — the caller asked about *something*.
    const big = t(`${KB}huge`, `${KP}description`, 'word '.repeat(500).trim());
    const { text, stats } = compressTriples([big], [`${KB}huge`], 10);
    expect(stats.entities).toBe(1);
    expect(text).toContain('# huge');
  });

  it('does NOT count facts from an entity the budget dropped (stats.facts was over-reporting)', () => {
    // Regression: factCount used to be incremented while BUILDING each block, but the
    // budget check `break`s after — so a dropped entity's facts were still counted.
    const triples: Triple[] = [];
    for (let i = 0; i < 10; i++) {
      triples.push(t(`${KB}e${i}`, `${KP}a`, 'some reasonably long value here to burn tokens'));
      triples.push(t(`${KB}e${i}`, `${KP}b`, 'another reasonably long value here to burn tokens'));
    }
    const { text, stats } = compressTriples(triples, [], 40);

    // The invariant: every counted fact must actually appear in the emitted text.
    const emittedFactLines = text.split('\n').filter((l) => l.trim().startsWith('.')).length;
    expect(stats.facts).toBe(emittedFactLines);
    expect(stats.entities).toBeLessThan(10); // the budget really did drop entities
  });

  it('deduplicates identical predicate+object pairs', () => {
    const { stats } = compressTriples(
      [
        t(`${KB}x`, `${KP}tag`, 'alpha'),
        t(`${KB}x`, `${KP}tag`, 'alpha'), // exact duplicate
        t(`${KB}x`, `${KP}tag`, 'beta'),
      ],
      [`${KB}x`],
      2000,
    );
    expect(stats.facts).toBe(2);
  });

  it('MEASURES the real format reduction — and falsifies the old ~60-70% claim', () => {
    // 12 entities x 5 facts — a realistic subgraph, not a toy.
    const triples: Triple[] = [];
    for (let i = 0; i < 12; i++) {
      const e = `${KB}feature-${i}`;
      triples.push(t(e, RDF_TYPE, `${KB}Feature`, false));
      triples.push(t(e, `${KP}has-status`, 'production'));
      triples.push(t(e, `${KP}description`, 'this feature does a useful thing for the user'));
      triples.push(t(e, `${KP}depends-on`, `${KB}core`, false));
      triples.push(t(e, `${KP}tested-by`, 'src/lib/thing.test.ts'));
    }

    const flat = estimateTokens(asTurtle(triples));
    const grouped = estimateTokens(asGroupedTurtle(triples));
    const { stats } = compressTriples(triples, [], 100_000); // no budget pressure

    const vsFlat = 1 - stats.tokens / flat;
    const vsGrouped = 1 - stats.tokens / grouped;

    // The docs claimed ~60-70%. They were WRONG for the FORMAT: that figure conflated the
    // encoding with SUBGRAPH SELECTION (returning a relevant slice of a ~116k-token graph
    // rather than the whole thing), which is where the big saving actually lives.
    //
    // Measured reality, asserted as a floor so a regression is caught rather than a lucky
    // number pinned: the format is a modest, real win — not a headline one.
    expect(vsGrouped).toBeGreaterThan(0.15); // ~18% vs a realistic .ttl
    expect(vsFlat).toBeGreaterThan(0.25);    // ~29% vs one-triple-per-line
    expect(vsGrouped).toBeLessThan(0.6);     // and it is NOT 60-70% — hold the line honest
  });
});
