/**
 * DERIVING A SCOPE ESTIMATE FROM THE CODE GRAPH — instead of guessing it.
 *
 * Matt, 2026-08-14: "shouldn't the code graph have detailed connections for concepts, across
 * multiple files? I see that as a source for the estimates, not just a random guess."
 *
 * Correct, and the first three estimates written for F122/F123/F75 WERE guesses — numbers a
 * model picked with nothing behind them. Measured the same day: static/reckons-codebase.ttl
 * carries exactly two predicates, kpred:has-file (379) and kpred:tested-by (44), across 38
 * module concepts joined by skos:broader. It maps modules to files and files to parents, and
 * it links to NOTHING in the roadmap. So "which files will F122 touch" had no answer in the
 * graph, and the estimate had nowhere to come from but invention.
 *
 * The missing edge is one predicate: kpred:touches-module, from a DESIGN to the code concepts
 * it expects to work in. It goes on the roadmap side because the expectation belongs to the
 * design, and because the codebase graph is a structural map that should stay a description
 * of what IS rather than of what someone intends.
 *
 * WHAT DERIVATION HONESTLY GIVES YOU IS A BOUND, NOT A NUMBER. A module is not a file: naming
 * code:rdf names 24 files, and a feature touching that module will touch some of them. So the
 * graph yields an UPPER BOUND (every file in every named module) and, where the design names
 * specific files, a LOWER BOUND. A defensible estimate lies between, and — this is the part a
 * guess cannot do — an estimate ABOVE the upper bound is a contradiction the graph can catch:
 * you cannot touch more files than exist in the modules you named, so either the estimate is
 * wrong or the design has not named all the modules it will actually enter. Both are worth
 * knowing before the work starts, which is the whole point of estimating at all.
 */

export type ModuleFacts = {
  /** Module IRI, e.g. urn:reckons:code/rdf */
  iri: string;
  label?: string;
  files: string[];
};

export type DerivedScope = {
  /** Modules the design says it will work in. */
  modules: ModuleFacts[];
  /** Every distinct file across those modules. */
  fileUniverse: string[];
  /** You cannot touch more files than exist in the modules you named. */
  upperBound: number;
  /** Files the design named explicitly, if any. */
  namedFiles: string[];
  /** At least the files already named. */
  lowerBound: number;
};

export function deriveScope(
  modules: readonly ModuleFacts[],
  namedFiles: readonly string[] = [],
): DerivedScope {
  const universe = [...new Set(modules.flatMap((m) => m.files))];
  const named = [...new Set(namedFiles)];
  return {
    modules: [...modules],
    fileUniverse: universe,
    upperBound: universe.length,
    namedFiles: named,
    lowerBound: named.length,
  };
}

export type EstimateVerdict =
  /** Sits inside the bounds the graph implies — defensible. */
  | { kind: 'plausible'; upperBound: number; lowerBound: number }
  /** Above the upper bound: either the number is wrong or the design has not named every
   *  module it will enter. Both are findings, and the second is the more interesting. */
  | { kind: 'exceeds-universe'; estimate: number; upperBound: number; message: string }
  /** Below the files the design already names explicitly. */
  | { kind: 'below-named'; estimate: number; lowerBound: number; message: string }
  /** No modules named, so the graph cannot say anything — the estimate is still a guess. */
  | { kind: 'underivable'; message: string };

/**
 * Check a written estimate against what the graph implies.
 *
 * Deliberately reports `underivable` rather than passing silently when a design names no
 * modules: an unchecked estimate looking identical to a checked one is how a guess acquires
 * false authority.
 */
export function checkEstimate(estimate: number, derived: DerivedScope): EstimateVerdict {
  if (derived.modules.length === 0) {
    return {
      kind: 'underivable',
      message:
        'This design names no modules (kpred:touches-module), so the code graph cannot bound its estimate — the number is still a guess.',
    };
  }
  if (estimate > derived.upperBound) {
    return {
      kind: 'exceeds-universe',
      estimate,
      upperBound: derived.upperBound,
      message:
        `Estimate of ${estimate} exceeds the ${derived.upperBound} files in the modules named. ` +
        'Either the estimate is too high, or — more likely and more useful — the design has not yet named every module it will actually enter.',
    };
  }
  if (derived.lowerBound > 0 && estimate < derived.lowerBound) {
    return {
      kind: 'below-named',
      estimate,
      lowerBound: derived.lowerBound,
      message: `Estimate of ${estimate} is below the ${derived.lowerBound} file(s) the design already names explicitly.`,
    };
  }
  return { kind: 'plausible', upperBound: derived.upperBound, lowerBound: derived.lowerBound };
}

/**
 * A starting estimate when a human has not written one.
 *
 * A FRACTION of the universe, not the whole of it, because a feature touching a module almost
 * never touches every file in it — and it is offered as a STARTING POINT for a human to
 * correct rather than as an answer. Rounded up so a small module never suggests zero work.
 * The fraction is a stated convention, not a measurement: with no history of estimate-versus-
 * actual yet (0 designs carry both), there is nothing to calibrate it against, and pretending
 * otherwise would dress a convention up as evidence.
 */
export const SUGGESTED_FRACTION = 0.3;

export function suggestEstimate(derived: DerivedScope): number | null {
  if (derived.modules.length === 0) return null;
  return Math.max(derived.lowerBound, Math.ceil(derived.upperBound * SUGGESTED_FRACTION));
}

/* ────────────────────────────────────────────────────────────────────────────
 * FILE-GRANULAR ESTIMATE — named files plus what depends on them.
 *
 * Matt, 2026-08-14: "we need that file granularity, in the code graph, to achieve a clear
 * scope estimate." Module granularity can only produce a RANGE — somewhere between 1 and the
 * 24 files in code:rdf — and a range is not an estimate. Naming the files a design will
 * change, and asking the import graph what depends on them, produces a number the code
 * entails rather than one a convention apportions.
 * ──────────────────────────────────────────────────────────────────────────── */

/** file path -> the files that import it. Built from the generated file graph. */
export type ImportIndex = ReadonlyMap<string, ReadonlySet<string>>;

export type BlastRadius = {
  /** The files the design says it will change. */
  seed: string[];
  /** Files importing a seed file directly. */
  direct: string[];
  /** Everything reachable upward, direct included. */
  transitive: string[];
};

/**
 * Who is affected by changing these files?
 *
 * Walks the importedBy index upward. Seeds are excluded from the result so "affected" means
 * "other than what I am already changing" — otherwise every estimate double-counts its own
 * starting point.
 */
export function blastRadius(seed: readonly string[], importedBy: ImportIndex): BlastRadius {
  const seedSet = new Set(seed);
  const direct = new Set<string>();
  for (const s of seed) for (const d of importedBy.get(s) ?? []) if (!seedSet.has(d)) direct.add(d);

  const transitive = new Set(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const up of importedBy.get(cur) ?? []) {
      if (!seedSet.has(up) && !transitive.has(up)) {
        transitive.add(up);
        queue.push(up);
      }
    }
  }
  return { seed: [...seed], direct: [...direct], transitive: [...transitive] };
}

export type FileEstimate = {
  /** Files the design named — the floor, because it intends to change them. */
  floor: number;
  /** Floor plus files that import them directly. */
  likely: number;
  /** Floor plus everything transitively reachable — the worst case, rarely the real one. */
  ceiling: number;
  radius: BlastRadius;
};

/**
 * Turn named files into a floor / likely / ceiling.
 *
 * `likely` uses only DIRECT dependents on purpose. A change usually stops at the first ring —
 * the callers that must adapt — while the transitive closure through a hub like
 * src/lib/rdf/types.ts reaches 226 files and would make every estimate meaningless. The
 * ceiling is kept because it is the honest worst case and it is the number that says
 * "this file is dangerous to touch"; it is just not a plan.
 */
export function estimateFromFiles(seed: readonly string[], importedBy: ImportIndex): FileEstimate {
  const radius = blastRadius(seed, importedBy);
  return {
    floor: seed.length,
    likely: seed.length + radius.direct.length,
    ceiling: seed.length + radius.transitive.length,
    radius,
  };
}

/** Files whose blast radius is large enough that changing them warrants saying so. */
export function highBlastFiles(importedBy: ImportIndex, threshold = 40): Array<{ file: string; dependents: number }> {
  return [...importedBy.entries()]
    .map(([file, deps]) => ({ file, dependents: deps.size }))
    .filter((r) => r.dependents >= threshold)
    .sort((a, b) => b.dependents - a.dependents);
}
