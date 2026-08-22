/**
 * WASM LLM Bench — Scoring utilities
 *
 * Compares WASM model outputs against golden (Claude Opus) outputs
 * for ingest (triple extraction) and chat (grounded responses).
 */

import type { ExtractedTriple } from '../../src/lib/integrations/llm/extractor';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IngestScore {
  /** How many golden triples were found in the output (0-1) */
  recall: number;
  /** How many output triples match a golden triple (0-1) */
  precision: number;
  /** Harmonic mean of precision and recall */
  f1: number;
  /** Number of output triples that matched a golden triple */
  matchedCount: number;
  /** Total golden triples */
  goldenCount: number;
  /** Total output triples */
  outputCount: number;
  /** Triples in output with no golden match (potential hallucinations or valid extras) */
  unmatchedOutput: string[];
  /** Golden triples not found in output */
  missedGolden: string[];
  /**
   * Recall counting a golden triple as found when the model connected the same SUBJECT to the same
   * OBJECT, whatever it called the relation. Always >= `recall`.
   */
  factRecall: number;
  /**
   * Of the golden triples the model found at fact level, the fraction where it ALSO used our
   * predicate. 1 means perfect agreement with our vocabulary; a low number next to a high
   * `factRecall` means the model is finding the right facts and calling them something else.
   * Null when nothing matched at fact level, because a ratio over zero says nothing.
   */
  vocabularyAgreement: number | null;
  /** Golden triples found at fact level but under a different predicate name. */
  vocabularyMismatches: Array<{ golden: string; outputPredicate: string }>;
}

export interface ChatTestCase {
  question: string;
  golden: string;
  maxWords: number;
  mustReference: string[];
  mustNotClaim: string[];
}

export interface ChatScore {
  question: string;
  /** Word count of the response */
  wordCount: number;
  /** Whether response exceeds maxWords */
  tooLong: boolean;
  /** Fraction of mustReference items found in response (0-1) */
  groundingScore: number;
  /** Which required references were found */
  foundReferences: string[];
  /** Which required references were missing */
  missingReferences: string[];
  /** Forbidden claims that appeared in the response (hallucinations) */
  hallucinatedClaims: string[];
  /** Simple repetition ratio: repeated sentences / total sentences */
  repetitionRatio: number;
  /** Overall score (0-1): weighted combo of grounding, conciseness, no-hallucination */
  overall: number;
}

export interface BenchReport {
  model: string;
  timestamp: string;
  ingest: IngestScore;
  chat: ChatScore[];
  /** Aggregate chat score (0-1) */
  chatOverall: number;
  /** Combined score: 50% ingest F1 + 50% chat overall */
  combined: number;
}

// ── Ingest scoring ───────────────────────────────────────────────────────────

/** Normalize for fuzzy matching: lowercase, hyphens→spaces, strip punctuation, collapse whitespace */
function norm(s: string): string {
  return s.toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Split into significant words (length > 2) for token-level matching */
function words(s: string): string[] {
  return norm(s).split(' ').filter(w => w.length > 2);
}

/** Jaccard-like token overlap: |intersection| / |smaller set| */
function tokenOverlap(a: string, b: string): number {
  const wa = words(a), wb = words(b);
  if (wa.length === 0 || wb.length === 0) return norm(a) === norm(b) ? 1 : 0;
  const setB = new Set(wb);
  const shared = wa.filter(w => setB.has(w)).length;
  return shared / Math.min(wa.length, wb.length);
}

/** Check if two triples are a fuzzy match (subject + predicate + object all overlap) */
function triplesMatch(a: ExtractedTriple, b: ExtractedTriple): boolean {
  const sA = norm(a.subject), sB = norm(b.subject);
  const pA = norm(a.predicate), pB = norm(b.predicate);
  const oA = norm(String(a.object)), oB = norm(String(b.object));

  // Exact normalized match on all three
  if (sA === sB && pA === pB && oA === oB) return true;

  // Token overlap: subject ≥ 0.5, predicate ≥ 0.5, object ≥ 0.5
  const subjectMatch = tokenOverlap(a.subject, b.subject) >= 0.5 || sA.includes(sB) || sB.includes(sA);
  const predicateMatch = tokenOverlap(a.predicate, b.predicate) >= 0.5 || pA.includes(pB) || pB.includes(pA);
  const objectMatch = tokenOverlap(String(a.object), String(b.object)) >= 0.5 || oA.includes(oB) || oB.includes(oA);

  return subjectMatch && predicateMatch && objectMatch;
}

function tripleLabel(t: ExtractedTriple): string {
  return `${t.subject} · ${t.predicate} · ${t.object}`;
}

/**
 * Subject and object match, predicate ignored — "did the model connect these two things at all,
 * whatever it called the relation".
 *
 * WHY THIS EXISTS. On 2026-08-15 qwen3.6 scored 42.9% ingest F1 on the octopus fixture, and a
 * chunk of the loss was `has-number-of-hearts 3` against a golden `has-heart-count 3`. The strict
 * matcher scored that ONCE as a missed golden triple and AGAIN as an unmatched output — penalised
 * twice for being right. The number that came out was not "extraction quality", it was agreement
 * with the predicate vocabulary Opus happened to use, and the two were indistinguishable.
 *
 * KNOWN WEAKNESS, stated rather than buried: ignoring the predicate lets genuinely different
 * relations between the same pair count as one fact. `octopus feeds-on crab` and
 * `octopus is-eaten-by crab` match here and mean opposite things. So factRecall is an UPPER bound
 * on extraction quality, not a measurement of it — it is only meaningful read next to
 * vocabularyAgreement, which is why they are reported together and never combined into one score.
 */
function factsMatch(a: ExtractedTriple, b: ExtractedTriple): boolean {
  const sA = norm(a.subject), sB = norm(b.subject);
  const oA = norm(String(a.object)), oB = norm(String(b.object));
  const subjectMatch = tokenOverlap(a.subject, b.subject) >= 0.5 || sA.includes(sB) || sB.includes(sA);
  const objectMatch = tokenOverlap(String(a.object), String(b.object)) >= 0.5 || oA.includes(oB) || oB.includes(oA);
  return subjectMatch && objectMatch;
}

function predicatesMatch(a: ExtractedTriple, b: ExtractedTriple): boolean {
  const pA = norm(a.predicate), pB = norm(b.predicate);
  return tokenOverlap(a.predicate, b.predicate) >= 0.5 || pA.includes(pB) || pB.includes(pA);
}

export function scoreIngest(output: ExtractedTriple[], golden: ExtractedTriple[]): IngestScore {
  const goldenMatched = new Set<number>();
  const outputMatched = new Set<number>();

  for (let oi = 0; oi < output.length; oi++) {
    for (let gi = 0; gi < golden.length; gi++) {
      if (goldenMatched.has(gi)) continue;
      if (triplesMatch(output[oi], golden[gi])) {
        outputMatched.add(oi);
        goldenMatched.add(gi);
        break;
      }
    }
  }

  const matchedCount = goldenMatched.size;
  const recall = golden.length > 0 ? matchedCount / golden.length : 0;
  const precision = output.length > 0 ? outputMatched.size / output.length : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

  const unmatchedOutput = output
    .filter((_, i) => !outputMatched.has(i))
    .map(tripleLabel);
  const missedGolden = golden
    .filter((_, i) => !goldenMatched.has(i))
    .map(tripleLabel);

  // ── Fact layer vs vocabulary layer ─────────────────────────────────────────
  // A second, independent pass: match on subject+object only, then ask separately whether the
  // predicate agreed. Run over ALL golden triples rather than only the strict misses, so
  // vocabularyAgreement is a property of the whole fixture and not of what the strict pass left
  // over.
  const factMatchedGolden = new Set<number>();
  const factMatchedOutput = new Set<number>();
  const vocabularyMismatches: Array<{ golden: string; outputPredicate: string }> = [];

  for (let gi = 0; gi < golden.length; gi++) {
    for (let oi = 0; oi < output.length; oi++) {
      if (factMatchedOutput.has(oi)) continue;
      if (!factsMatch(output[oi], golden[gi])) continue;
      factMatchedGolden.add(gi);
      factMatchedOutput.add(oi);
      if (!predicatesMatch(output[oi], golden[gi])) {
        vocabularyMismatches.push({
          golden: tripleLabel(golden[gi]),
          outputPredicate: output[oi].predicate,
        });
      }
      break;
    }
  }

  const factRecall = golden.length > 0 ? factMatchedGolden.size / golden.length : 0;
  const vocabularyAgreement = factMatchedGolden.size > 0
    ? (factMatchedGolden.size - vocabularyMismatches.length) / factMatchedGolden.size
    : null;

  return {
    recall, precision, f1,
    matchedCount, goldenCount: golden.length, outputCount: output.length,
    unmatchedOutput, missedGolden,
    factRecall, vocabularyAgreement, vocabularyMismatches
  };
}

// ── Chat scoring ─────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function detectRepetition(text: string): number {
  const sentences = text.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (sentences.length <= 1) return 0;
  const unique = new Set(sentences);
  return 1 - unique.size / sentences.length;
}

export function scoreChat(response: string, testCase: ChatTestCase): ChatScore {
  const lower = response.toLowerCase();
  const wordCount = countWords(response);
  const tooLong = wordCount > testCase.maxWords;

  // Grounding: check mustReference items
  const foundReferences: string[] = [];
  const missingReferences: string[] = [];
  for (const ref of testCase.mustReference) {
    const refLower = ref.toLowerCase().replace(/-/g, ' ');
    const refKebab = ref.toLowerCase();
    if (lower.includes(refLower) || lower.includes(refKebab)) {
      foundReferences.push(ref);
    } else {
      missingReferences.push(ref);
    }
  }
  const groundingScore = testCase.mustReference.length > 0
    ? foundReferences.length / testCase.mustReference.length
    : 1;

  // Hallucination: check mustNotClaim items
  const hallucinatedClaims: string[] = [];
  for (const claim of testCase.mustNotClaim) {
    if (lower.includes(claim.toLowerCase())) {
      hallucinatedClaims.push(claim);
    }
  }

  const repetitionRatio = detectRepetition(response);

  // Overall: grounding (40%) + conciseness (30%) + no-hallucination (20%) + no-repetition (10%)
  const concisenessScore = tooLong ? Math.max(0, 1 - (wordCount - testCase.maxWords) / testCase.maxWords) : 1;
  const noHallucinationScore = testCase.mustNotClaim.length > 0
    ? 1 - hallucinatedClaims.length / testCase.mustNotClaim.length
    : 1;
  const noRepetitionScore = 1 - repetitionRatio;

  const overall = 0.4 * groundingScore + 0.3 * concisenessScore + 0.2 * noHallucinationScore + 0.1 * noRepetitionScore;

  return {
    question: testCase.question,
    wordCount, tooLong,
    groundingScore, foundReferences, missingReferences,
    hallucinatedClaims, repetitionRatio, overall
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

export function buildReport(
  model: string,
  ingestOutput: ExtractedTriple[],
  goldenIngest: ExtractedTriple[],
  chatResponses: string[],
  chatTestCases: ChatTestCase[]
): BenchReport {
  const ingest = scoreIngest(ingestOutput, goldenIngest);
  const chat = chatResponses.map((resp, i) => scoreChat(resp, chatTestCases[i]));
  const chatOverall = chat.length > 0 ? chat.reduce((sum, c) => sum + c.overall, 0) / chat.length : 0;
  const combined = 0.5 * ingest.f1 + 0.5 * chatOverall;

  return {
    model,
    timestamp: new Date().toISOString(),
    ingest, chat, chatOverall, combined
  };
}

// ── Pretty print ─────────────────────────────────────────────────────────────

export function formatReport(r: BenchReport): string {
  const lines: string[] = [];
  lines.push(`\n${'═'.repeat(60)}`);
  lines.push(`  WASM BENCH REPORT — ${r.model}`);
  lines.push(`  ${r.timestamp}`);
  lines.push(`${'═'.repeat(60)}`);

  lines.push(`\n── INGEST (Triple Extraction) ──`);
  lines.push(`  Precision: ${pct(r.ingest.precision)}  Recall: ${pct(r.ingest.recall)}  F1: ${pct(r.ingest.f1)}`);
  lines.push(`  Matched: ${r.ingest.matchedCount} / ${r.ingest.goldenCount} golden, ${r.ingest.outputCount} total output`);

  // Reported directly under F1 because F1 alone is ambiguous between two very different failures,
  // and reading it as "extraction quality" sent a previous session shopping for a better model
  // when the actual gap was vocabulary.
  lines.push(`\n  Decomposed —`);
  lines.push(`    Fact recall (subject+object, predicate ignored): ${pct(r.ingest.factRecall)}`);
  lines.push(`    Vocabulary agreement (of those, our predicate):  ${r.ingest.vocabularyAgreement === null ? 'n/a — nothing matched at fact level' : pct(r.ingest.vocabularyAgreement)}`);
  if (r.ingest.vocabularyMismatches.length) {
    lines.push(`    Right fact, different word:`);
    for (const m of r.ingest.vocabularyMismatches) {
      lines.push(`      - ${m.golden}   →  model said "${m.outputPredicate}"`);
    }
    lines.push(`    ↑ These are found facts, not misses. Strict F1 charges each of them twice.`);
  }
  if (r.ingest.missedGolden.length) {
    lines.push(`  Missed golden triples:`);
    for (const m of r.ingest.missedGolden) lines.push(`    - ${m}`);
  }
  if (r.ingest.unmatchedOutput.length) {
    lines.push(`  Unmatched output (extra or hallucinated):`);
    for (const u of r.ingest.unmatchedOutput) lines.push(`    - ${u}`);
  }

  lines.push(`\n── CHAT (Grounded Responses) ──`);
  for (const c of r.chat) {
    lines.push(`\n  Q: "${c.question}"`);
    lines.push(`  Words: ${c.wordCount}${c.tooLong ? ' (TOO LONG)' : ''}  Grounding: ${pct(c.groundingScore)}  Overall: ${pct(c.overall)}`);
    if (c.missingReferences.length) lines.push(`  Missing refs: ${c.missingReferences.join(', ')}`);
    if (c.hallucinatedClaims.length) lines.push(`  Hallucinations: ${c.hallucinatedClaims.join(', ')}`);
    if (c.repetitionRatio > 0.1) lines.push(`  Repetition: ${pct(c.repetitionRatio)}`);
  }

  lines.push(`\n── SUMMARY ──`);
  lines.push(`  Ingest F1:     ${pct(r.ingest.f1)}`);
  lines.push(`  Chat Overall:  ${pct(r.chatOverall)}`);
  lines.push(`  Combined:      ${pct(r.combined)}`);
  lines.push(`${'═'.repeat(60)}\n`);

  return lines.join('\n');
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
