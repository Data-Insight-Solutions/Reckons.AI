/**
 * Rule-gates-model routing for dictated notes.
 *
 * `readIntent` is the script tier: free, instant, deterministic, and it cannot hallucinate. It is
 * also PERFECT on plain imperatives and plain statements — measured 10/10 on that slice
 * (tests/bench/run-decision-bench.ts, 2026-09-22). Sending those to a model would cost ~8s each
 * and buy nothing, which is the whole argument for gating rather than replacing.
 *
 * WHAT THIS FIXES, AND WHAT IT DOES NOT. The rule scores 2/9 on the hard slice, and those misses
 * are two different animals:
 *
 *   HEDGED  score lands in [AMBIGUOUS_THRESHOLD, TASK_THRESHOLD) and the rule says so. Three of
 *           the nine: an imperative whose object carries relative clauses full of finite verbs
 *           ("Pull together the suppliers who we have used before...", 0.50), a hesitant dictation
 *           with fillers (0.35), an imperative governing an embedded question (0.50). THIS MODULE
 *           FIXES THESE.
 *   CONFIDENT AND WRONG  the rule commits at 0.00, 0.75 or 0.90 and is mistaken anyway — mostly
 *           noun phrases colliding with imperative openers ("Order of service for the fifteenth."
 *           scores 0.75 because "Order" opens it). A confidence gate CANNOT catch these, because
 *           there is no hedge to trigger on. THIS MODULE DOES NOT FIX THEM, and pretending
 *           otherwise would be the overclaim kb:honest-status exists to stop.
 *
 * So the honest expectation is roughly half the hard slice, not all of it. The other half needs
 * either better rules for the noun/verb collision or unconditional escalation, and unconditional
 * escalation costs eight seconds on every sentence.
 *
 * THE BENEFIT IS NOT ONLY ACCURACY. readNote deliberately sends an ambiguous sentence down BOTH
 * paths, so it appears in `tasks` AND in `factText` and a human gets two pending proposals for
 * one sentence. Every ambiguous reading resolved is one fewer double-proposal to triage, which is
 * review burden removed whether or not the routing was going to be wrong.
 *
 * FAIL-SAFE BY CONSTRUCTION. Any error, timeout or unusable answer keeps the rule's reading and
 * records why in `signals`. A downed model degrades this to exactly today's behaviour; it never
 * blocks a note and never silently drops one.
 */
import { AMBIGUOUS_THRESHOLD, TASK_THRESHOLD, type IntentReading, type NoteIntent, type NoteReading } from './note-intent';

/** The bounded decision a backend is asked to make. Ollama today; a System One model would fit. */
export type DecideIntent = (
  sentence: string,
  options: readonly NoteIntent[]
) => Promise<{ choice: NoteIntent; confidence: number | null }>;

export const INTENT_OPTIONS: readonly NoteIntent[] = ['task', 'ambiguous', 'assertion'];

/**
 * Only the hedge band is worth paying for. `intent === 'ambiguous'` is exactly
 * score >= AMBIGUOUS_THRESHOLD && score < TASK_THRESHOLD, but it is tested against the thresholds
 * rather than the label so that retuning them cannot silently change what gets escalated.
 */
export function needsEscalation(r: IntentReading): boolean {
  return r.score >= AMBIGUOUS_THRESHOLD && r.score < TASK_THRESHOLD;
}

/** How many model calls a note would cost, so a caller can decide before spending them. */
export function escalationCost(reading: NoteReading): number {
  return reading.readings.filter(needsEscalation).length;
}

/** A model may only resolve a hedge, never overturn a confident reading or invent an option. */
function acceptable(choice: unknown): choice is NoteIntent {
  return typeof choice === 'string' && (INTENT_OPTIONS as readonly string[]).includes(choice);
}

/**
 * Re-decide only the hedged readings, then rebuild the note the same way readNote does.
 *
 * The derived fields are recomputed here rather than imported, because readNote takes raw text
 * and we already hold parsed readings. The two must agree: a test pins them against each other.
 */
export async function escalateNote(
  reading: NoteReading,
  decide: DecideIntent,
  opts: { timeoutMs?: number } = {}
): Promise<NoteReading> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const readings = await Promise.all(
    reading.readings.map(async (r) => {
      if (!needsEscalation(r)) return r;
      try {
        const verdict = await withTimeout(decide(r.sentence, INTENT_OPTIONS), timeoutMs);
        if (!acceptable(verdict.choice)) {
          return withSignal(r, `escalation returned an unusable answer — keeping the rule's reading`);
        }
        if (verdict.choice === r.intent) {
          return withSignal(r, 'escalated: the model agreed the sentence is genuinely unclear');
        }
        return {
          ...r,
          intent: verdict.choice,
          // The rule's score described the rule's reading; it no longer describes this one.
          score: verdict.confidence ?? r.score,
          signals: [...r.signals, `escalated: rule hedged at ${r.score.toFixed(2)}, model chose "${verdict.choice}"`]
        };
      } catch (e) {
        return withSignal(r, `escalation unavailable (${(e as Error).message}) — keeping the rule's reading`);
      }
    })
  );

  return {
    readings,
    tasks: readings.filter((r) => r.intent !== 'assertion'),
    factText: readings
      .filter((r) => r.intent !== 'task')
      .map((r) => r.sentence)
      .join(' ')
      .trim()
  };
}

const withSignal = (r: IntentReading, s: string): IntentReading => ({ ...r, signals: [...r.signals, s] });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))
  ]);
}
