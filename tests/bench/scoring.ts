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

  return {
    recall, precision, f1,
    matchedCount, goldenCount: golden.length, outputCount: output.length,
    unmatchedOutput, missedGolden
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
