/**
 * DOCS-EXPAND GATES (F74.3 / F74.9, SCRIPT tier) — deterministic checks a drafted paragraph must
 * clear before a person is asked to read it.
 *
 * WHY. 2026-11-13: a reviewer read 10 docs-expand drafts and accepted 1. The rejections were two
 * kinds of defect a rule can see: jargon a first-time reader cannot parse ("triples", ".ttl",
 * "content hashing", "Manifest V3", "roundtrip"), and details the graph never stated (a "countdown
 * timer" and "text-to-speech" on a story feature; "hands-free" on speech-to-text). Triage is the
 * cost of an agent-tier job (CLAUDE.md: offloading is not free), so these are caught here, at zero
 * tokens, and the draft never reaches the queue.
 *
 * Both gates are PURE: text in, verdict out. docs-expand.ts supplies the grounding.
 *
 * CALIBRATION (2026-11-13, reading local files only; numbers and the join method are recorded on
 * kb:job-backpressure in static/reckons-roadmap.ttl). Thresholds below were chosen so that drafts a
 * person ACCEPTED are almost never thrown out, and are NOT tuned to maximise rejections. Read the
 * roadmap line for the table before trusting a threshold. In short (2026-11-13, 22 accepted and 25 rejected
 * drafts): grounding gate kept 21 of 22 accepted and threw out 3 of 25 rejected; jargon gate kept 9 of 22
 * accepted (they said "triples"/"RDF"/"TTL" unexplained, the defect named that day) and threw out 12 of 25
 * rejected; the grounding gate barely separates the classes. Read the roadmap line for the rest: the sample is small (a few dozen judged
 * drafts) and about half of the rejections were a local panel's, not a person's.
 *
 * WEAKNESSES, said plainly. The grounding gate is a vocabulary check, not a truth check: a draft
 * can recombine grounded words into a false sentence and pass. The jargon gate knows only the terms
 * the graph lists, so a term nobody listed passes. Both are filters in front of a human, not a
 * substitute for one.
 */
import { Parser } from 'n3';
import { jargonPattern, readTermConfig } from '../ui-terms.js';

const KPRED = 'urn:kbase:predicate/';
const SCHEME = 'urn:kbase:vocabulary/terminology';

export type DocsJargon = { words: string[]; pattern: RegExp };

/**
 * Pure: the jargon a docs page may not use unexplained. The source is the terminology graph:
 * kpred:ui-jargon (words the UI must not show), the prefixed standards labels ui-terms derives, and
 * kpred:docs-jargon (extra terms that matter on a docs page but are NOT ratcheted on screen, so
 * adding one cannot fail the ui-terms check). File-extension tokens are matched by rule below.
 */
export function readDocsJargon(ttl: string): DocsJargon {
  const words = new Set<string>(readTermConfig(ttl).jargon.keys());
  for (const q of new Parser({ format: 'Turtle' }).parse(ttl)) {
    if (q.subject.value === SCHEME && q.predicate.value === `${KPRED}docs-jargon`) words.add(q.object.value);
  }
  return { words: [...words], pattern: jargonPattern(words) };
}

/** File formats are matched by rule, not listed: `.ttl`, `.jsonl` and friends are never plain speech. */
const FORMAT_TOKEN = /\.(?:ttl|jsonl|trig|nq|nt|owl|rdf|n3)\b/gi;

export type JargonHit = { term: string; explained: boolean };

/** Is the term at [start,end) glossed by the words right around it? Pure. */
function glossed(sentence: string, start: number, end: number): boolean {
  const before = sentence.slice(Math.max(0, start - 28), start);
  const after = sentence.slice(end, end + 40);
  // "called a triple", "known as an IRI", "short for ...", "the term 'triple'"
  if (/\b(?:called|known as|termed|named|short for|stands for|the (?:term|word))\s+(?:an?\s+|the\s+)?["'“‘(]?$/i.test(before)) return true;
  // "triple (a fact ...)", "triple, meaning ...", "triple, which ...", "triple means ...", "triple is a ...",
  // "triple: ...", "triple — ..."
  return /^["'”’]?\s*(?:\(|,\s*(?:meaning|which|that is|or|i\.e\.|a\b|an\b|the\b)|\s+(?:means|is an?\b|is the\b|are\b)|\s*[:—–-]\s)/i.test(after);
}

/**
 * Pure: every jargon term in the text, each marked explained or not. `own` lists words the page is
 * ABOUT (its label): a page on "IRI" must be allowed to say IRI, and its first mention is judged
 * the same way as any other, so naming the subject is exempt rather than the whole page.
 */
export function jargonHits(text: string, jargon: DocsJargon, own: readonly string[] = []): JargonHit[] {
  const ownLower = own.map((w) => w.toLowerCase());
  const hits: JargonHit[] = [];
  // Split only where the full stop is followed by a space, so ".ttl" and "v3.1" do not end a sentence.
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const found: Array<{ term: string; start: number; end: number }> = [];
    for (const m of sentence.matchAll(new RegExp(jargon.pattern.source, 'g'))) {
      found.push({ term: m[1], start: m.index! + m[0].indexOf(m[1]), end: m.index! + m[0].indexOf(m[1]) + m[1].length });
    }
    for (const m of sentence.matchAll(FORMAT_TOKEN)) found.push({ term: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length });
    for (const f of found) {
      const bare = f.term.toLowerCase().replace(/s$/, '');
      const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (ownLower.some((o) => o === f.term.toLowerCase() || new RegExp(`(?<![a-z])${esc}`).test(o))) continue;
      hits.push({ term: f.term, explained: glossed(sentence, f.start, f.end) });
    }
  }
  return hits;
}

/**
 * The unexplained jargon terms, deduplicated, in order of appearance. A term is explained once ANY of its
 * mentions in the draft is glossed (the first use usually carries the gloss and later ones lean on it).
 */
export function unexplainedJargon(text: string, jargon: DocsJargon, own: readonly string[] = []): string[] {
  const hits = jargonHits(text, jargon, own);
  const key = (t: string) => t.toLowerCase().replace(/s$/, '');
  const explained = new Set(hits.filter((h) => h.explained).map((h) => key(h.term)));
  return [...new Set(hits.filter((h) => !explained.has(key(h.term))).map((h) => h.term.toLowerCase()))];
}

// ── Grounding ────────────────────────────────────────────────────────────────

/**
 * Ordinary English words of five letters or more that a draft needs in order to be a sentence at all.
 * They are not "specific content", so they are never counted as unsupported. Deliberately a
 * closed list in code: a rule, not a judgement, and a test pins its behavior.
 */
const COMMON = new Set(`
about above after again against almost along already also although always among another around because
become becomes before behind being below between both bring brings called cannot cause causes certain
clear clearly close come comes could contain contains different doing during each either enough even ever
every example examples explain explains first found from gives given going great group helps here
however include includes including instead into itself keep keeps kind large later least less light like
likely little local made make makes many matter means might more most much must name named names need
needs never next often once only other others over page pages part parts people place point read reader
readers really result results right same says second see seem several should show shows simple simply since
small some something still such sure take takes than that their them then there these they thing things
think this those three through time times together under until upon used uses useful using value values very
want wants well were what when where whether which while whole will with within without work works would
write written years your yours across added adds along allow allows around based basic being better
built check checks choose common complete create created creates current different easy else ensure
exactly form forms from full further general generally given goes good hold holds idea ideas important
into just known knows lets level list look looks main makes manage manages matches might need often
open order point present process provides quickly rather reason refer refers related require requires
same seen single some someone start starts state still stored story structure support supports system
tells than their thing think those today understand understood unique update useful versions
which where world
`.split(/\s+/).filter(Boolean));

/** A light stem: enough that "stores"/"stored"/"storing" and "link"/"links" meet. Pure. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const [suffix, min] of [['ing', 4], ['edly', 4], ['ied', 3], ['ies', 3], ['ed', 4], ['es', 4], ['ly', 4], ['s', 4]] as const) {
    if (w.length - suffix.length >= min && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
  }
  return w.replace(/(?:e|y|i)$/, '');
}

/** The distinctive words of a text: lowercased, stemmed, five letters or more, not common English. Pure. */
export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z-]*[a-z]|[a-z]/g) ?? []) {
    for (const part of w.split('-')) {
      if (part.length < 5 || COMMON.has(part)) continue;
      out.add(stem(part));
    }
  }
  return out;
}

export type GroundingVerdict = { unsupported: string[]; count: number; ok: boolean };

/**
 * Pure: words the draft introduces that the grounding does not contain.
 *
 * `allowed` is extra text that is legitimately in scope (the prompt itself names the entity label, so
 * the label's words are grounded even when no triple repeats them). A word is supported when its
 * stem, or a stem of which it is a prefix or that is its prefix (length 5+), is in the grounding.
 */
export function groundingGate(draft: string, grounding: string, maxUnsupported: number, house: ReadonlySet<string> = new Set()): GroundingVerdict {
  const have = new Set([...contentStems(grounding), ...house]);
  const prefix = (s: string) => [...have].some((h) => h.length >= 5 && s.length >= 5 && (h.startsWith(s) || s.startsWith(h)));
  const unsupported = [...contentStems(draft)].filter((s) => !have.has(s) && !prefix(s)).sort();
  return { unsupported, count: unsupported.length, ok: unsupported.length <= maxUnsupported };
}

/**
 * Pure: the HOUSE vocabulary, the stems used on at least `minDocs` different docs entities. Words like
 * "ensure", "enable" and "consistent" are on most pages; a draft using them has invented nothing. A
 * hand list of such words kept growing (first calibration: accepted drafts carried 2 to 30 "unsupported"
 * words, nearly all of them this kind), so the corpus says which words are ordinary here. `perDoc`
 * is one text per entity. A word on only a few pages ("countdown", "hands-free") stays unsupported.
 */
export function houseVocabulary(perDoc: readonly string[], minDocs: number): Set<string> {
  const df = new Map<string, number>();
  for (const text of perDoc) for (const s of contentStems(text)) df.set(s, (df.get(s) ?? 0) + 1);
  return new Set([...df].filter(([, n]) => n >= minDocs).map(([s]) => s));
}

/** What a draft may be scored against. Chosen by calibration; see the header. */
export const MAX_UNSUPPORTED = 8;
/** A stem on this many different docs entities is house vocabulary, not a claim. */
export const HOUSE_MIN_DOCS = 2;

// ── Skip rule ────────────────────────────────────────────────────────────────

/**
 * Pure: should this entity be drafted for at all?
 *
 * An entity whose existing prose already reads plainly (no unexplained jargon) and is a real
 * sentence's worth is NOT drafted: the model restated such definitions with jargon added (2026-11-13
 * review), which turns a fine page into a worse one. It is drafted only when its prose is under
 * `wideMargin` words, i.e. far below the thin threshold, where there is genuinely nothing to read.
 */
export function shouldDraft(existingProse: string, existingWords: number, minWords: number, jargon: DocsJargon, own: readonly string[] = []): { draft: boolean; reason: string } {
  if (existingWords >= minWords) return { draft: false, reason: 'not thin' };
  const margin = Math.floor(minWords / 3);
  if (existingWords < margin) return { draft: true, reason: `only ${existingWords} words (under ${margin})` };
  const jargonLeft = unexplainedJargon(existingProse, jargon, own);
  if (jargonLeft.length) return { draft: true, reason: `thin and uses unexplained jargon (${jargonLeft.slice(0, 3).join(', ')})` };
  return { draft: false, reason: `already reads plainly (${existingWords} words, no unexplained jargon)` };
}
