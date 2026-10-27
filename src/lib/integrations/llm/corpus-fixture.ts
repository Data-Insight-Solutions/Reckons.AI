/**
 * Corpus notes the MOCK backend can read for real (F183.3).
 *
 * The mock extractor returns three placeholder facts whatever it is given, so a browser test could
 * show that the screens respond but never that a space is built and then CHANGED: there is no second
 * note whose facts disagree with the first. The notes corpus (tests/fixtures/notes-corpus) already
 * holds hand-checked ground truth for the extraction bench; an entry there that names a `mockMatch`
 * sentence and a `mock` triple per expected fact is returned here instead of placeholders. One ground
 * truth, three readers: the bench scores real models on it, the browser test drives it, and a person
 * runs the same notes through a real model by hand.
 *
 * Only the explicitly chosen mock backend calls this. The fallback after a real model fails to load
 * keeps the placeholders, so a failure can never look like a successful extraction.
 */
import type { ExtractedTriple } from './extractor';

type MockTriple = { s: string; p: string; o: string; literal?: boolean };
type CorpusEntry = { mockMatch?: string; expected?: { mock?: MockTriple }[] };

export async function corpusFixtureTriples(text: string): Promise<ExtractedTriple[] | null> {
  // Loaded only on this path, so the corpus is never part of the app's main bundle.
  const corpus = (await import('../../../../tests/fixtures/notes-corpus/expectations.json')).default as Record<string, CorpusEntry | string>;
  for (const entry of Object.values(corpus)) {
    if (typeof entry !== 'object' || !entry.mockMatch || !text.includes(entry.mockMatch)) continue;
    const triples = (entry.expected ?? []).flatMap(({ mock }) => mock ? [{
      subject: mock.s, predicate: mock.p, object: mock.o, objectIsLiteral: mock.literal === true,
      gloss: `${mock.s} ${mock.p} ${mock.o}`.replace(/-/g, ' '), confidence: 0.95,
    }] : []);
    if (triples.length) return triples;
  }
  return null;
}
