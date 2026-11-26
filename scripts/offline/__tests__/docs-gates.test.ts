import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentStems, groundingGate, houseVocabulary, jargonHits, readDocsJargon, shouldDraft, stem, unexplainedJargon } from '../lib/docs-gates';

// Fixtures are the shapes a reviewer rejected on 2026-11-13, rewritten generically (no personal data).
const TTL = `
  @prefix kpred: <urn:kbase:predicate/> .
  <urn:kbase:vocabulary/terminology> kpred:ui-jargon "triple", "IndexedDB" ;
    kpred:docs-jargon "TTL", "Turtle", "Manifest V3", "content hashing", "roundtrip" .
  <urn:kbase:concept/x> kpred:standards-label "rdf:Statement" .
`;
const J = readDocsJargon(TTL);

describe('jargon gate', () => {
  it('reads ui-jargon, prefixed standards labels and docs-jargon from the terminology graph', () => {
    expect(J.words).toEqual(expect.arrayContaining(['triple', 'IndexedDB', 'rdf:Statement', 'TTL', 'Manifest V3']));
  });
  it('reads the real terminology graph, where the rejected terms now live', () => {
    const real = readDocsJargon(readFileSync('static/reckons-terminology.ttl', 'utf8'));
    for (const w of ['triple', 'Manifest V3', 'content hashing', 'roundtrip', 'TTL', 'SPARQL']) expect(real.words).toContain(w);
  });
  it('catches the rejected drafts: triples, a .ttl file, Manifest V3, content hashing, roundtrip', () => {
    const draft = 'It writes your knowledge to a .ttl file as triples, using content hashing for an exact roundtrip. The extension is a Manifest V3 tool.';
    expect(unexplainedJargon(draft, J)).toEqual(expect.arrayContaining(['.ttl', 'triples', 'content hashing', 'roundtrip', 'manifest v3']));
  });
  it('passes plain prose', () => {
    expect(unexplainedJargon('It saves everything you have added to a file you can open on another computer, and loads it back unchanged.', J)).toEqual([]);
  });
  it('lets a term through when the same draft explains it', () => {
    expect(unexplainedJargon('Each fact is stored as a triple (a subject, a verb and an object).', J)).toEqual([]);
    expect(unexplainedJargon('Facts are stored as triples, meaning three-part statements.', J)).toEqual([]);
    expect(unexplainedJargon('A fact is called a triple.', J)).toEqual([]);
    expect(unexplainedJargon('A TTL (a plain text file of facts) is easy to read.', J)).toEqual([]);
  });
  it('lets one gloss cover the later mentions of the same term', () => {
    expect(unexplainedJargon('A triple (one fact) is small. Many triples make a space.', J)).toEqual([]);
  });
  it('does not let a mention in another sentence explain it', () => {
    expect(unexplainedJargon('Everything is kept as a triple. It is easy.', J)).toEqual(['triple']);
  });
  it('lets a page use the word it is about', () => {
    expect(unexplainedJargon('A triple holds one fact.', J, ['Triple'])).toEqual([]);
    expect(unexplainedJargon('A triple holds one fact.', J, ['Reification'])).toEqual(['triple']);
  });
  it('matches file extensions by rule, not by list', () => {
    expect(jargonHits('Open the notes.jsonl file or the export.TRIG file.', J).map((h) => h.term.toLowerCase())).toEqual(['.jsonl', '.trig']);
    expect(jargonHits('A sentence. Then another one.', J)).toEqual([]);
  });
});

describe('grounding gate', () => {
  const grounding = 'Entity: Voice Input\n kpred:definition → Speaks into the microphone and the words appear in the chat box.\nIt sits under: Shelly chat';
  it('stems lightly and ignores short and ordinary words', () => {
    expect(stem('stores')).toBe(stem('stored'));
    expect(stem('links')).toBe(stem('linking'));
    expect([...contentStems('This is the very common thing, and some other else about it.')]).toEqual([]);
  });
  it('keeps a draft built from the grounding', () => {
    const v = groundingGate('Speaking into the microphone makes the words appear in the chat box.', grounding, 2);
    expect(v.unsupported).toEqual([]);
    expect(v.ok).toBe(true);
  });
  it('throws out invented features and lists them (hands-free, no network, countdown timer)', () => {
    const draft = 'Voice input gives hands-free control without any network, with a countdown timer and spoken playback in the chat box.';
    const v = groundingGate(draft, grounding, 2);
    expect(v.unsupported).toEqual(expect.arrayContaining(['countdown', 'network', 'playback'.replace(/back$/, 'back')].map((w) => stem(w))));
    expect(v.ok).toBe(false);
  });
  it('is only as strict as its threshold, and counts every distinct unsupported word once', () => {
    const draft = 'Speaking into the microphone, using a countdown, countdown timer and countdown.';
    expect(groundingGate(draft, grounding, 1).count).toBe(2);
    expect(groundingGate(draft, grounding, 2).ok).toBe(true);
  });
  it('accepts words that are ordinary across the docs (house vocabulary) but not words used on one page', () => {
    const house = houseVocabulary(['clear simple consistent design', 'consistent naming', 'a countdown on one page only'], 2);
    expect(house.has(stem('consistent'))).toBe(true);
    expect(house.has(stem('countdown'))).toBe(false);
    expect(groundingGate('A consistent countdown.', grounding, 0, house).unsupported).toEqual([stem('countdown')]);
  });
});

describe('skip rule', () => {
  const plain = 'It keeps the pages you have read and lets you step back to an earlier one whenever you want to look again.';
  it('leaves a page that is long enough and reads plainly alone', () => {
    const v = shouldDraft(plain, 22, 45, J);
    expect(v.draft).toBe(false);
    expect(v.reason).toMatch(/reads plainly/);
  });
  it('drafts a page with almost nothing on it', () => {
    expect(shouldDraft('Voice input.', 2, 45, J).draft).toBe(true);
  });
  it('drafts a thin page whose existing text is jargon', () => {
    const v = shouldDraft('Stored as triples in a .ttl file for the whole space and kept in sync.', 20, 45, J);
    expect(v.draft).toBe(true);
    expect(v.reason).toMatch(/jargon/);
  });
  it('never drafts a page that is not thin', () => {
    expect(shouldDraft('x', 60, 45, J).draft).toBe(false);
  });
});

describe('docs-expand wiring', () => {
  it('rejectReason throws out an unexplained-jargon draft before the queue', async () => {
    const { rejectReason, subjects } = await import('../docs-expand');
    const subject = subjects[0];
    const draft = 'This page writes everything to a .ttl file as triples so that a roundtrip import restores it exactly the same way every single time you open the space again later on.';
    expect(rejectReason(draft, subject)).toMatch(/unexplained jargon/);
  });
});

describe('"Turtle" is jargon only as the file format (Shelly is a turtle)', () => {
  const ttl = readFileSync('static/reckons-terminology.ttl', 'utf8');
  const j = readDocsJargon(ttl);
  it('the creature passes', () => {
    expect(unexplainedJargon('Shelly the turtle points you to the next step.', j)).toEqual([]);
    expect(unexplainedJargon('Everything on the far side of the turtle was guessed.', j)).toEqual([]);
  });
  it('the file format fails unless explained', () => {
    expect(unexplainedJargon('Download your graph as Turtle and share it.', j)).toContain('turtle');
    expect(unexplainedJargon('Open the Turtle file in any editor.', j)).toContain('turtle');
  });
});
