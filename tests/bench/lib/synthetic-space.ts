/**
 * Synthetic spaces for the space-size benches (F107.10). Generated words only, seeded, so every
 * run measures the same bytes. Shared by the Node bench and the browser bench.
 */
import { toTurtleFull } from '../../../src/lib/rdf/serialize';
import { chunkText, chunksToTurtle } from '../../../src/lib/ingest/source-chunks';
import { iri, lit, type ReviewStatus, type Source, type Statement } from '../../../src/lib/rdf/types';

export type Profile = { key: string; statements: number; sources: number; textCharsPerSource: number };

// Text per source ~ a 6-page document. The xl/xxl rows exist to find where it stops being usable.
export const PROFILES: Profile[] = [
  { key: 's', statements: 1_000, sources: 10, textCharsPerSource: 20_000 },
  { key: 'm', statements: 10_000, sources: 100, textCharsPerSource: 20_000 },
  { key: 'l', statements: 50_000, sources: 500, textCharsPerSource: 20_000 },
  { key: 'xl', statements: 100_000, sources: 1_000, textCharsPerSource: 20_000 },
  { key: 'xxl', statements: 250_000, sources: 2_500, textCharsPerSource: 20_000 },
];


// ── deterministic synthetic data ─────────────────────────────────────────────────────────────
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const WORDS = 'harbor ferry schedule route crossing tide pier ticket season weekday morning evening vessel captain deck cargo passenger island mainland weather notice delay timetable fare dock'.split(' ');
const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');
const prose = (chars: number) => {
  const paras: string[] = [];
  let len = 0;
  while (len < chars) { const p = `${words(60)}.`.replace(/^./, (c) => c.toUpperCase()); paras.push(p); len += p.length + 2; }
  return paras.join('\n\n');
};
const STATUSES: ReviewStatus[] = ['confirmed', 'confirmed', 'confirmed', 'pending', 'refined', 'rejected'];
const PREDICATES = Array.from({ length: 24 }, (_, i) => `urn:kbase:predicate/p${i}`);

export function buildSpace(p: Profile) {
  seed = 42;
  const at = Date.UTC(2026, 9, 6);
  const texts: string[] = [];
  const sources: Source[] = Array.from({ length: p.sources }, (_, i) => {
    texts.push(prose(p.textCharsPerSource));
    return { id: `src-${i}`, title: `Synthetic source ${i}`, uri: `https://example.test/src-${i}`, ingestedAt: at - i * 1000, hash: `h${i}`, kind: 'document' as const };
  });
  const entities = Math.max(10, Math.floor(p.statements / 4));
  const statements: Statement[] = Array.from({ length: p.statements }, (_, i) => {
    const sourceIndex = i % p.sources;
    const text = texts[sourceIndex];
    const start = Math.floor(rand() * Math.max(1, text.length - 80));
    const objectIsEntity = rand() < 0.4;
    return {
      id: `st-${i}`,
      s: iri(`urn:bench/e${Math.floor(rand() * entities)}`),
      p: iri(PREDICATES[i % PREDICATES.length]),
      o: objectIsEntity ? iri(`urn:bench/e${Math.floor(rand() * entities)}`) : lit(words(6)),
      g: iri(`urn:kbase:source/src-${sourceIndex}`),
      sourceId: `src-${sourceIndex}`, confidence: 0.8, status: STATUSES[i % STATUSES.length],
      excerpt: text.slice(start, start + 80), grounded: true, createdAt: at, updatedAt: at,
    } as Statement;
  });
  return { statements, sources, texts };
}

/** The space file as the app exports it, with every source's chunks appended when `folded`. */
export function renderSpace(p: Profile, folded: boolean): { ttl: string; chunkBytes: number } {
  const { statements, sources, texts } = buildSpace(p);
  const generatedAt = new Date(Date.UTC(2026, 9, 6)).toISOString();
  const ttl = toTurtleFull(statements, sources, { kbStableId: `bench-space-${p.key}` });
  if (!folded) return { ttl, chunkBytes: 0 };
  const chunkTtl = sources.map((s, i) => chunksToTurtle({ sourceId: s.id, title: s.title, sha256: s.hash!, chunks: chunkText(texts[i]), generatedAt })).join('\n');
  return { ttl: `${ttl}\n${chunkTtl}`, chunkBytes: Buffer.byteLength(chunkTtl) };
}
