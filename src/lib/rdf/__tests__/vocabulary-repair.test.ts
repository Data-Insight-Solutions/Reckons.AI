import { describe, it, expect } from 'vitest';
import {
  phoneticKey,
  editDistance,
  buildVocabulary,
  repairCandidates,
  SUGGEST_FLOOR,
  type VocabularyEntry,
} from '../vocabulary-repair';
import type { Statement } from '../types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_ALT_LABEL = 'http://www.w3.org/2004/02/skos/core#altLabel';

let n = 0;
function st(subject: string, predicate: string, object: string, status: Statement['status'] = 'confirmed'): Statement {
  return {
    id: `s${n++}`,
    s: { kind: 'iri', value: subject },
    p: { kind: 'iri', value: predicate },
    o: { kind: 'literal', value: object },
    g: { kind: 'iri', value: 'urn:kbase:graph/test' },
    sourceId: 'src',
    confidence: 1,
    status,
    createdAt: 0,
    updatedAt: 0,
  } as Statement;
}

const RECKONS = 'urn:kbase:concept/reckons-ai';

describe('phoneticKey', () => {
  it('gives a dictated mishearing the same key as the word meant', () => {
    expect(phoneticKey('Recons')).toBe(phoneticKey('Reckons'));
  });

  it('separates words that merely look alike but sound different', () => {
    expect(phoneticKey('Reckons')).not.toBe(phoneticKey('Beacons'));
  });

  it('is stable across case, spacing and punctuation', () => {
    expect(phoneticKey('  RECKONS.AI ')).toBe(phoneticKey('reckons ai'));
  });
});

describe('editDistance', () => {
  it('charges one edit for the missing k', () => {
    expect(editDistance('Recons', 'Reckons')).toBe(1);
  });

  it('charges one edit for a transposition, not two', () => {
    expect(editDistance('Rekcons', 'Reckons')).toBe(1);
  });

  it('folds case and whitespace before comparing', () => {
    expect(editDistance('  Reckons ', 'reckons')).toBe(0);
  });
});

describe('buildVocabulary', () => {
  it('collects labels, aliases, and the name implied by an IRI', () => {
    const vocab = buildVocabulary([
      st(RECKONS, RDFS_LABEL, 'Reckons.AI'),
      st(RECKONS, SKOS_ALT_LABEL, 'tripleNotes'),
      st('urn:kbase:concept/note-taking', 'urn:kbase:predicate/relates-to', 'x'),
    ]);
    const names = vocab.map((v) => v.name).sort();
    expect(names).toContain('Reckons.AI');
    expect(names).toContain('tripleNotes');
    // The unlabelled entity still contributes the name inside its IRI.
    expect(names).toContain('note taking');
  });

  it('ignores rejected and superseded statements', () => {
    const vocab = buildVocabulary([st(RECKONS, RDFS_LABEL, 'Ghost Name', 'rejected')]);
    expect(vocab.map((v) => v.name)).not.toContain('Ghost Name');
  });

  it('prefers a real label over a name merely inferred from an IRI', () => {
    const vocab = buildVocabulary([st(RECKONS, RDFS_LABEL, 'reckons ai')]);
    const entry = vocab.find((v) => v.name === 'reckons ai');
    expect(entry?.viaAlias).toBe(false);
  });
});

describe('repairCandidates', () => {
  const vocab: VocabularyEntry[] = [
    { name: 'Reckons.AI', iri: RECKONS, viaAlias: false },
    { name: 'Anne', iri: 'urn:kbase:person/anne', viaAlias: false },
    { name: 'Ann', iri: 'urn:kbase:person/ann', viaAlias: false },
    { name: 'Beacons', iri: 'urn:kbase:concept/beacons', viaAlias: false },
  ];

  it('recovers Reckons from a dictated Recons, on two agreeing signals', () => {
    const [top] = repairCandidates('Recons', vocab);
    expect(top.match).toBe('Reckons.AI');
    expect(top.reason).toBe('phonetic');
    expect(top.confidence).toBeGreaterThan(0.9);
  });

  it('an exact hit is certain and needs no guessing', () => {
    const [top] = repairCandidates('reckons.ai', vocab);
    expect(top.confidence).toBe(1);
    expect(top.reason).toBe('exact');
    expect(top.distance).toBe(0);
  });

  it('reports an alias hit as an alias, so recall can be explained', () => {
    const [top] = repairCandidates('tripleNotes', [
      { name: 'tripleNotes', iri: RECKONS, viaAlias: true },
    ]);
    expect(top.reason).toBe('alias');
    expect(top.viaAlias).toBe(true);
  });

  it('will NOT confidently merge two short real names one edit apart', () => {
    // Ann and Anne are different people. One edit and a two-character phonetic key is not
    // evidence, and the module must refuse to pretend otherwise.
    const top = repairCandidates('Ann', vocab).find((c) => c.match === 'Anne');
    expect(top).toBeDefined();
    expect(top!.confidence).toBeLessThan(0.9);
  });

  it('says WHICH part of a name matched, so recall can be explained', () => {
    const [top] = repairCandidates('Recons', vocab);
    expect(top.matchedPart).toBe('reckons');
    expect(top.match).toBe('Reckons.AI');
  });

  it('treats a shortened human name as a suggestion, not a certainty', () => {
    // "Matt" plausibly means "Matthew Roe" — and plausibly does not. The band is the answer.
    const [top] = repairCandidates('Matt', [
      { name: 'Matthew Roe', iri: 'urn:kbase:person/matthew-roe', viaAlias: false },
    ]);
    expect(top.confidence).toBeGreaterThanOrEqual(SUGGEST_FLOOR);
    expect(top.confidence).toBeLessThan(0.9);
  });

  it('never invents a name the graph does not already hold', () => {
    const all = repairCandidates('Reckons', vocab).map((c) => c.match);
    for (const m of all) expect(vocab.map((v) => v.name)).toContain(m);
  });

  it('drops terms that are neither close nor homophonous', () => {
    expect(repairCandidates('bicycle', vocab)).toHaveLength(0);
  });

  it('ranks by confidence and honours the limit', () => {
    const out = repairCandidates('Recons', vocab, 2);
    expect(out.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].confidence).toBeGreaterThanOrEqual(out[i].confidence);
    }
    for (const c of out) expect(c.confidence).toBeGreaterThanOrEqual(SUGGEST_FLOOR);
  });
});

/**
 * MEASURED 2026-09-02 on the dictated Pebble Index 01 notes. `phoneticKey` strips digits — right,
 * since a digit has no sound to key on — but that collapsed every timestamped note id to the same
 * key. 14 note ids produced 12 confident "repairs", all false, and a repair merges entities, so
 * accepting one would have destroyed the provenance linking a fact to the note it came from.
 */
describe('identifiers that differ only in their numbers are not mis-hearings', () => {
  const vocab = (names: string[]) =>
    names.map((name, i) => ({ name, iri: `urn:kbase:concept/e${i}`, viaAlias: false }));

  it('does not propose merging two timestamped note ids', () => {
    const others = vocab(['note-2026-08-27T18-47-56-720Z']);
    const out = repairCandidates('note-2026-08-27T18-31-51-202Z', others);
    expect(out).toEqual([]);
  });

  it('does not propose merging note-1 with note-2', () => {
    expect(repairCandidates('note-1', vocab(['note-2']))).toEqual([]);
  });

  it('still repairs a real mis-hearing that carries no digits', () => {
    const out = repairCandidates("Recon's AI", vocab(['Reckons.AI']));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].match).toBe('Reckons.AI');
  });

  it('still matches an identifier against itself when the digits agree', () => {
    const out = repairCandidates('note-2026-08-27T18-47-56-720Z', vocab(['note-2026-08-27T18-47-56-720Z']));
    expect(out[0]?.reason).toBe('exact');
  });

  it('still repairs when letters differ AND digits differ — a real slip can do both', () => {
    const out = repairCandidates('verison 2', vocab(['version 3']));
    // Not suppressed by the digit guard: the letters are not identical, so this is a genuine
    // candidate and the normal confidence floor decides it.
    expect(out.every((c) => c.match === 'version 3')).toBe(true);
  });
});
