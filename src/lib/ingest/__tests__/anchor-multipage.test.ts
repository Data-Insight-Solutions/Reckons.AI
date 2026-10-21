/**
 * F122.1 DONE WHEN, part 1 — a rotated multi-page fixture yields STABLE anchors.
 *
 * HONEST SCOPE (2026-10-21): the shipped anchor is a TEXT SPAN (EvidenceSpan: chunk, start, end,
 * sourceHash). There is no page index, bbox or DocumentIR in the code, so "page and geometry survive
 * rotation" cannot be tested and is marked it.todo below rather than faked. What IS tested: a
 * synthetic three-page document (page rotations 0/90/270 recorded as metadata, text joined page by
 * page the way a text extractor emits it) yields anchors that slice back to their quotes, land in
 * page order, and are identical on re-extraction.
 */
import { describe, it, expect } from 'vitest';
import { anchorFor, attachAnchors } from '../source-chunks';
import { checkAnchor } from '../statement-evidence';
import type { EvidenceSpan, Source } from '../../rdf/types';

type Page = { n: number; rotation: 0 | 90 | 180 | 270; text: string };
const PAGES: Page[] = [
  { n: 1, rotation: 0, text: 'Page one. The quay opened in 1890. ' + 'Cargo notes continue here. '.repeat(40) },
  { n: 2, rotation: 90, text: 'Page two, scanned sideways. Tonnage doubled by 1910. ' + 'Ledger rows continue here. '.repeat(40) },
  { n: 3, rotation: 270, text: 'Page three, upside down. The quay closed in 1975. ' + 'Closing remarks continue here. '.repeat(40) },
];
/** Re-extraction: a fresh run over the same pages. Pure, so two calls model two extractions. */
const extract = (pages: Page[]) => pages.map((p) => p.text).join('\f');
const hashOf = (t: string) => {
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
};
const sourceFor = (text: string): Source => ({ id: 'scan1', title: 'Quay ledger', uri: 'file://q', kind: 'document', ingestedAt: 1, hash: hashOf(text) } as Source);
const QUOTES = ['The quay opened in 1890', 'Tonnage doubled by 1910', 'The quay closed in 1975'];

describe('rotated multi-page fixture: anchors are stable (text-span level)', () => {
  it('each quote is anchored, slices back exactly, and the spans fall in page order', () => {
    const text = extract(PAGES);
    const src = sourceFor(text);
    const anchors = QUOTES.map((q) => anchorFor(src, text, q)!);
    anchors.forEach((a, i) => { expect(a).toBeTruthy(); expect(text.slice(a.start, a.end)).toBe(QUOTES[i]); });
    expect(anchors[0].start).toBeLessThan(anchors[1].start);
    expect(anchors[1].start).toBeLessThan(anchors[2].start);
    // each span lies inside its own page's slice of the text
    let offset = 0;
    PAGES.forEach((p, i) => {
      expect(anchors[i].start).toBeGreaterThanOrEqual(offset);
      expect(anchors[i].end).toBeLessThanOrEqual(offset + p.text.length);
      offset += p.text.length + 1;
    });
  });

  it('re-extraction of the same pages gives identical anchors (deep equal, including chunk IRI and hash)', () => {
    const run = () => { const t = extract(PAGES); return QUOTES.map((q) => anchorFor(sourceFor(t), t, q)); };
    expect(run()).toEqual(run());
  });

  it('page rotation metadata does not enter the text, so it cannot move a span', () => {
    const upright = PAGES.map((p) => ({ ...p, rotation: 0 as const }));
    const t0 = extract(upright);
    const t1 = extract(PAGES);
    expect(t1).toBe(t0);
    expect(QUOTES.map((q) => anchorFor(sourceFor(t1), t1, q))).toEqual(QUOTES.map((q) => anchorFor(sourceFor(t0), t0, q)));
  });

  it('attachAnchors on a batch gives the same result as anchoring one by one, and is repeatable', () => {
    const text = extract(PAGES);
    const src = sourceFor(text);
    const facts: { excerpt: string; grounded: boolean; anchor?: EvidenceSpan }[] = QUOTES.map((q) => ({ excerpt: q, grounded: true }));
    const a = attachAnchors(facts, src, text);
    expect(a.map((f) => f.anchor)).toEqual(QUOTES.map((q) => anchorFor(src, text, q)));
    expect(attachAnchors(facts, src, text)).toEqual(a);
  });

  it('a stored anchor still checks out against the unchanged text, and fails once a page is edited before it', () => {
    const text = extract(PAGES);
    const src = sourceFor(text);
    const a = anchorFor(src, text, QUOTES[2])!;
    expect(checkAnchor(a, text, QUOTES[2], src.hash).ok).toBe(true);
    const edited = extract([{ ...PAGES[0], text: 'An inserted sentence. ' + PAGES[0].text }, PAGES[1], PAGES[2]]);
    const r = checkAnchor(a, edited, QUOTES[2], hashOf(edited));
    expect(r.ok).toBe(false);
  });

  // NOT IMPLEMENTED — do not turn these green by asserting on text offsets. Needs the DocumentIR /
  // EvidenceAnchor page+bbox contract that kb:document-evidence-anchors decided and nothing builds yet.
  it.todo('an anchor carries a one-based page index that survives page rotation (EvidenceAnchor.page does not exist yet)');
  it.todo('an anchor carries bbox x/y/width/height in 0..1 normalized to the UPRIGHT page, identical for rotation 0/90/180/270 (no geometry exists yet)');
  it.todo('selecting a proposed fact opens the retained page and highlights the bbox (the UI has only passage text highlighting)');
});
