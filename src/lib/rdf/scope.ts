/**
 * SCOPE AND SCOPE CREEP — the estimated work a design implies, and how it grows.
 *
 * Matt, 2026-08-14, correcting an earlier model that treated scope as a CATEGORY:
 *
 *   "scope should be the estimated work required for the implementation of the design.
 *    going over scope may be an unexpected dependency, or touching more files than expected.
 *    scope is the expectation, and scope creep is the gradual growing of that expectation,
 *    through deeper discovery or during implementation."
 *
 * So scope is a QUANTITY attached to a design, and creep is a SERIES — the expectation
 * growing as implementation reveals what the design did not say. A single before/after
 * verdict cannot express "gradual", which is why observations are recorded over time rather
 * than compared once at the end.
 *
 * WHY THIS BELONGS TO AGENT ORCHESTRATION (F87). "A task is a triple. Schedules,
 * dependencies, tiers, prompts and outcomes live in the graph, and any harness can drain the
 * queue." An estimate is one more fact on that task, and creep is the signal an orchestrator
 * needs in flight: a harness whose actual work is running away from the estimate is the same
 * runaway that plasma-ai/fractal bounds with hard caps on iterations, depth, children, cost
 * and wall-clock. The difference is that a cap stops the work, while creep EXPLAINS it —
 * naming the dependency or the file count the design failed to predict.
 *
 * WHAT CREEP MEANS, and it is not blame (Matt): "drift warnings are a soft, non-blocking
 * warning system that the initial graph was not refined enough. The design didn't account
 * for everything." Creep is therefore evidence about the DESIGN, not about the implementer.
 * The response is to refine the graph — which is why nothing here blocks, and why the
 * emitted finding is a drift warning rather than an error. Blocking on creep would make the
 * honest estimate the dangerous one and push every estimate upward until it meant nothing.
 */

/** The dimensions an estimate can speak to. Files and dependencies are the two Matt named. */
export type ScopeDimension = 'files' | 'dependencies' | 'features' | 'tests';

export const SCOPE_DIMENSIONS: ScopeDimension[] = ['files', 'dependencies', 'features', 'tests'];

/** What the design says the work is. Partial: an estimate may speak to only what it knows. */
export type ScopeEstimate = Partial<Record<ScopeDimension, number>>;

/**
 * One reading taken during implementation.
 *
 * A series of these is what makes creep GRADUAL rather than a single verdict: the point at
 * which the expectation grew, and what was discovered there, is the useful part.
 */
export type ScopeObservation = {
  at: number;
  actual: Partial<Record<ScopeDimension, number>>;
  /** What was discovered here — the sentence that should end up refining the design. */
  discovered?: string;
};

export type CreepReading = {
  dimension: ScopeDimension;
  estimated: number;
  actual: number;
  /** Positive when over the estimate; 0 when within it. */
  over: number;
  /** actual / estimated. Infinity when the design estimated zero and work happened anyway. */
  ratio: number;
};

/**
 * Compare one actual reading against the estimate.
 *
 * Dimensions the estimate is silent about are SKIPPED rather than treated as zero. An
 * estimate that never mentioned dependencies is not the claim that there would be none — it
 * is the absence of a claim, and scoring it as a breach would penalise partial estimates
 * into non-existence.
 */
export function measureCreep(
  estimate: ScopeEstimate,
  actual: Partial<Record<ScopeDimension, number>>,
): CreepReading[] {
  const out: CreepReading[] = [];
  for (const d of SCOPE_DIMENSIONS) {
    const est = estimate[d];
    const act = actual[d];
    if (est === undefined || act === undefined) continue;
    out.push({
      dimension: d,
      estimated: est,
      actual: act,
      over: Math.max(0, act - est),
      ratio: est === 0 ? (act === 0 ? 1 : Infinity) : act / est,
    });
  }
  return out;
}

/** The worst ratio across dimensions — the one that characterises the overrun. */
export function creepRatio(readings: CreepReading[]): number {
  if (readings.length === 0) return 1;
  return readings.reduce((m, r) => Math.max(m, r.ratio), 0);
}

/**
 * The growth of the expectation over time — creep as Matt defined it.
 *
 * Returns one entry per observation with the ratio AT that point, so "gradual" is visible:
 * an estimate exceeded steadily over six readings is a design that under-specified, while
 * one exceeded at a single step is usually one concrete surprise worth naming.
 */
export function creepSeries(
  estimate: ScopeEstimate,
  observations: readonly ScopeObservation[],
): Array<{ at: number; ratio: number; discovered?: string }> {
  return [...observations]
    .sort((a, b) => a.at - b.at)
    .map((o) => ({
      at: o.at,
      ratio: creepRatio(measureCreep(estimate, o.actual)),
      discovered: o.discovered,
    }));
}

/**
 * Is the growth gradual (accumulating across readings) or a single step?
 *
 * The distinction is the actionable one. GRADUAL means the design was systematically
 * under-refined and wants revisiting as a whole. A STEP means one specific thing was missed,
 * and naming that thing is the entire fix.
 */
export function creepShape(
  series: readonly { ratio: number }[],
): 'none' | 'step' | 'gradual' {
  if (series.length === 0) return 'none';
  const peak = series.reduce((m, s) => Math.max(m, s.ratio), 0);
  if (peak <= 1) return 'none';
  const increases = series.filter((s, i) => i > 0 && s.ratio > series[i - 1].ratio).length;
  return increases >= 2 ? 'gradual' : 'step';
}

/**
 * Should this creep be reported?
 *
 * SOFT AND NON-BLOCKING BY CONSTRUCTION — it returns a warning, never a failure. `tolerance`
 * exists because an estimate is an estimate: a design that said "about three files" and cost
 * four has not revealed anything, and reporting it would train people to ignore the signal.
 */
export function shouldWarnOnCreep(readings: CreepReading[], tolerance = 1.5): boolean {
  return readings.some((r) => r.ratio > tolerance);
}

/**
 * The finding to queue — phrased as a statement about the DESIGN, because that is what creep
 * is evidence about. Never phrased as a statement about the implementer.
 */
export function describeCreep(
  readings: CreepReading[],
  shape: 'none' | 'step' | 'gradual',
  discoveries: readonly string[] = [],
): string {
  const over = readings.filter((r) => r.over > 0);
  if (over.length === 0) return 'Implementation stayed within the estimated scope.';
  const parts = over.map((r) => `${r.dimension} ${r.actual} vs ${r.estimated} estimated`);
  const lead =
    shape === 'gradual'
      ? 'The design was systematically under-refined — the expectation grew across several readings'
      : 'The design missed one thing';
  const found = discoveries.length ? ` Discovered: ${discoveries.join('; ')}.` : '';
  return `${lead}: ${parts.join(', ')}.${found} This is a soft signal to refine the design, not a failure of the work.`;
}
