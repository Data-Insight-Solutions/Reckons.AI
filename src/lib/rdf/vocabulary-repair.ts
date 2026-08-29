/**
 * Repairing a mis-heard name against the vocabulary the graph already holds.
 *
 * WHY THIS IS NOT entity-normalization AND NOT skos:altLabel. The project already has two ways
 * to decide that two names mean one thing, and NEITHER of them can catch a transcription error:
 *
 *   - `entityAnswersTo` (merge-aliases.ts) folds case and whitespace and then compares exactly.
 *     "recons" !== "reckons". It misses.
 *   - `normalizeEntities` (normalize-entities.ts) embeds both strings with BGE-small and asks for
 *     cosine >= 0.90. A misspelling has no semantics to embed — "Recons" is not a word, so its
 *     vector is whatever the tokeniser's word-pieces happen to average to. It misses too, and
 *     worse, it misses UNPREDICTABLY.
 *
 * Those two are SEMANTIC tools: they answer "do these two names mean the same thing". A dictated
 * "Recons" for "Reckons" is a LEXICAL accident — the words are one keystroke apart and sound
 * identical, while meaning nothing to each other. That is a third tier, and this is it.
 *
 * PROPOSALS ONLY, AND DELIBERATELY. This module never rewrites a transcript. It reports what the
 * heard term probably was, with a confidence and a stated reason, and the caller queues that as a
 * pending fact for review. A repair is a CLAIM ABOUT WHAT SOMEONE MEANT, which is exactly the
 * kind of claim kb:node-synonyms says must carry provenance and review status like any other.
 *
 * NEVER INVENTS. Every candidate is a name some entity in the graph already answers to. The
 * module cannot mint a new entity out of a misheard proper noun, which is the failure the capture
 * webhook avoids by deriving note subjects from timestamps rather than from text.
 *
 * Pure: no embeddings, no LLM, no I/O. Script tier — free to run, deterministic, and right by
 * construction rather than right on average.
 */

import type { Statement } from './types';
import { labelFromIRI } from './semantic-diff';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_ALT_LABEL = 'http://www.w3.org/2004/02/skos/core#altLabel';

/** Below this, two names are not close enough to be worth a human's attention. */
export const SUGGEST_FLOOR = 0.5;

/**
 * A phonetic key shorter than this is too weak to corroborate anything. "Ann" and "Anne" reduce
 * to the same two characters, and so do a great many unrelated short names — the key space is
 * simply too small to carry evidence. Long keys collide rarely, so agreement means something.
 */
const MIN_KEY_FOR_PHONETIC_EVIDENCE = 3;

/** How much an independent phonetic agreement adds to a lexical near-match. */
const PHONETIC_BONUS = 0.15;

/**
 * Matching only PART of a name is real evidence but not the whole of it, so it pays a small
 * penalty. People shorten proper nouns constantly — "Reckons" for the entity labelled
 * "Reckons.AI", "Matt" for "Matthew Roe" — and a matcher that only ever compares whole labels
 * will miss the most ordinary thing a speaker does.
 */
const PARTIAL_NAME_PENALTY = 0.05;

/** A token too short to be distinctive ("ai", "of", "the") must not carry a name match alone. */
const MIN_TOKEN_LENGTH = 3;

/** Nothing here ever reaches certainty: these are guesses about what a person said. */
const MAX_CONFIDENCE = 0.95;

export type RepairReason = 'exact' | 'alias' | 'phonetic' | 'lexical';

export type RepairCandidate = {
  /** The term as it was heard. */
  heard: string;
  /** The existing vocabulary entry it probably was. */
  match: string;
  /** The entity that answers to `match`. */
  iri: string;
  /** Whether `match` came from an rdfs:label or an accumulated skos:altLabel. */
  viaAlias: boolean;
  confidence: number;
  reason: RepairReason;
  /** Damerau-Levenshtein distance between heard and the part of `match` that matched. */
  distance: number;
  /**
   * The token actually compared, when the heard term matched only part of the name. Undefined
   * when the whole name matched. Surfaced so a review card can say WHICH part matched rather
   * than presenting unexplained recall — kb:node-synonyms' honest-note applied to repair.
   */
  matchedPart?: string;
};

export type VocabularyEntry = { name: string; iri: string; viaAlias: boolean };

/** Labels differing only by case or surrounding space are the same name, not a synonym. */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/**
 * A deliberately small phonetic key: enough to prove "Reckons" and "Recons" sound alike, and
 * honest about being a heuristic rather than full Double Metaphone.
 *
 * The rules collapse the English spellings that differ on the page and agree in the mouth —
 * ck/c/q -> k, ph -> f, and so on — then drop every vowel after the first, because vowels are
 * what dictation gets wrong and consonant skeletons are what survive being misheard.
 */
export function phoneticKey(value: string): string {
  let s = fold(value).replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s
    .replace(/ck/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/gh/g, 'f')
    .replace(/sh/g, 's')
    .replace(/ch/g, 'k')
    .replace(/th/g, 't')
    .replace(/wr/g, 'r')
    .replace(/kn/g, 'n')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/[wh]/g, '');
  const head = s[0];
  const tail = s.slice(1).replace(/[aeiou]/g, '');
  return (head + tail).replace(/(.)\1+/g, '$1');
}

/**
 * Damerau-Levenshtein: Levenshtein plus transposition, because a swapped pair ("Rekcons") is one
 * slip of the tongue or the decoder, not the two independent edits plain Levenshtein charges for.
 */
export function editDistance(a: string, b: string): number {
  const s = fold(a);
  const t = fold(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: t.length + 1 }, (_, j) => j);
  let cur: number[] = [];

  for (let i = 1; i <= s.length; i++) {
    cur = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[t.length];
}

/**
 * Every name the graph currently answers to, from rdfs:label, skos:altLabel, and the name implied
 * by an IRI. The IRI matters: a node created as `urn:kbase:concept/reckons-ai` carries a name in
 * its identifier whether or not anyone ever wrote a label for it.
 */
export function buildVocabulary(statements: Statement[]): VocabularyEntry[] {
  const byName = new Map<string, VocabularyEntry>();

  const add = (name: string, iri: string, viaAlias: boolean) => {
    const key = fold(name);
    if (!key) return;
    // A real label outranks a name merely inferred from an IRI, so never let the weaker
    // source overwrite the stronger one for the same spelling.
    const existing = byName.get(key);
    if (existing && !existing.viaAlias) return;
    byName.set(key, { name: name.trim(), iri, viaAlias });
  };

  const subjects = new Set<string>();
  for (const s of statements) {
    if (!isActive(s)) continue;
    if (s.s.kind === 'iri') subjects.add(s.s.value);
    if (s.o.kind === 'iri') subjects.add(s.o.value);
    if (
      s.s.kind === 'iri' &&
      s.o.kind === 'literal' &&
      (s.p.value === RDFS_LABEL || s.p.value === SKOS_ALT_LABEL)
    ) {
      add(s.o.value, s.s.value, s.p.value === SKOS_ALT_LABEL);
    }
  }
  for (const iri of subjects) add(labelFromIRI(iri), iri, true);

  return [...byName.values()];
}

/** The distinctive words inside a name, for matching a speaker's shortened form of it. */
function distinctiveTokens(name: string): string[] {
  const parts = fold(name).split(/[^a-z0-9]+/).filter(Boolean);
  // A single-word name has no shortened form to look for; comparing it to itself would only
  // re-enter the whole-name comparison and pay the partial penalty for nothing. The check is on
  // the RAW split, not the filtered one: "Reckons.AI" is two parts even though only one of them
  // ("reckons") is distinctive enough to match on.
  if (parts.length < 2) return [];
  return parts.filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

/**
 * Rank the vocabulary entries a heard term might actually have been.
 *
 * Confidence combines two INDEPENDENT signals, which is the whole point: lexical closeness alone
 * is a weak claim (edit distance 1 separates "Ann" from "Anne", who are different people), and a
 * phonetic key alone is weaker still. When both agree on a term long enough for the agreement to
 * be improbable, the claim is strong. When only one fires, it is a suggestion for a human.
 */
export function repairCandidates(
  heard: string,
  vocabulary: VocabularyEntry[],
  limit = 5,
): RepairCandidate[] {
  const target = fold(heard);
  if (!target) return [];
  const heardKey = phoneticKey(heard);
  const out: RepairCandidate[] = [];

  for (const entry of vocabulary) {
    const name = fold(entry.name);

    if (editDistance(target, name) === 0) {
      out.push({
        heard,
        match: entry.name,
        iri: entry.iri,
        viaAlias: entry.viaAlias,
        confidence: 1,
        reason: entry.viaAlias ? 'alias' : 'exact',
        distance: 0,
      });
      continue;
    }

    // Compare against the whole name AND each distinctive word in it, keeping whichever reads
    // as the better explanation of what was said.
    let best: { score: number; distance: number; phonetic: boolean; part?: string } | null = null;
    const variants: Array<{ text: string; part?: string }> = [
      { text: name },
      ...distinctiveTokens(entry.name).map((t) => ({ text: t, part: t })),
    ];

    for (const variant of variants) {
      const distance = editDistance(target, variant.text);
      const longest = Math.max(target.length, variant.text.length);
      const lexical = 1 - distance / longest;
      const key = phoneticKey(variant.text);
      const phonetic = key.length >= MIN_KEY_FOR_PHONETIC_EVIDENCE && key === heardKey;

      // A phonetic match still needs the words in the same neighbourhood; otherwise "Kent"
      // corroborates "Konda" and the bonus does real harm.
      if (!phonetic && lexical < SUGGEST_FLOOR) continue;

      const score =
        lexical + (phonetic ? PHONETIC_BONUS : 0) - (variant.part ? PARTIAL_NAME_PENALTY : 0);
      if (!best || score > best.score) {
        best = { score, distance, phonetic, part: variant.part };
      }
    }

    if (!best) continue;
    const confidence = Math.min(MAX_CONFIDENCE, best.score);
    if (confidence < SUGGEST_FLOOR) continue;

    out.push({
      heard,
      match: entry.name,
      iri: entry.iri,
      viaAlias: entry.viaAlias,
      confidence,
      reason: best.phonetic ? 'phonetic' : 'lexical',
      distance: best.distance,
      matchedPart: best.part,
    });
  }

  return out
    .sort((a, b) => b.confidence - a.confidence || a.distance - b.distance)
    .slice(0, limit);
}
