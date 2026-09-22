/**
 * Alignment scoring — does a code change match what the graph says was planned?
 *
 * REPLACES A SCORER THAT MEASURED SOMETHING ELSE. The previous implementation built ONE BM25
 * query by concatenating every path segment of every changed file, took the top 15 triples, and
 * computed all four dimensions over whatever entities those hits happened to name. With 157
 * changed files that is a keyword soup, so the entity set was effectively arbitrary — and three
 * further faults compounded it:
 *
 *   1. COVERAGE was fuzzy filename matching (`name.includes(slug) || slug.includes(name)`)
 *      against slug words longer than two characters, so `app.html` matched anything containing
 *      "app" and `transcript-dir.ts` matched nothing at all. The graph's real file links —
 *      kpred:has-file and kpred:path — were never consulted.
 *   2. SCOPE was `1 - (unmatched/changed) * 0.8`, which is a linear restatement of coverage.
 *      Two dimensions, 50% of the weight, one signal.
 *   3. DEPS multiplied 0.5 for EVERY unsatisfied dependency, unbounded, so three anywhere in the
 *      sample floored it at 0.125 and no amount of good work could move it.
 *
 * And the status ladder hardcoded FIVE values, omitting `in-progress`. AGENTS.md documents that
 * exact trap: 16 features carry that status, and each one fell through to `rank === undefined`,
 * scoring 0.5 with the reason "unknown status" rather than failing loudly. Ranks are now read
 * from static/reckons-vocabulary.ttl, where each klife:* concept carries skos:notation and
 * hnav:order, so the enum cannot drift from the authority again.
 *
 * Every dimension here is scoped to the change. A number that describes the whole graph is a
 * property of the repository, not a verdict on a commit, and cannot be improved by good work.
 */

export type Triple = { subject: string; predicate: string; object: string };

/** notation -> hnav:order, read from the FeatureLifecycle scheme rather than hardcoded. */
export type Ranks = Map<string, number>;

const p = (t: Triple, suffix: string) => t.predicate.endsWith(suffix);

/**
 * Read the lifecycle ladder from the vocabulary. Returns an empty map if the scheme is absent,
 * which callers must treat as "cannot score status" rather than "everything is rank 0".
 */
export function readLifecycleRanks(triples: Triple[]): Ranks {
  const notation = new Map<string, string>();
  const order = new Map<string, number>();
  for (const t of triples) {
    if (p(t, 'core#notation')) notation.set(t.subject, t.object);
    else if (p(t, 'nav/order') || p(t, '#order')) {
      const n = Number(t.object);
      if (Number.isFinite(n)) order.set(t.subject, n);
    }
  }
  const ranks: Ranks = new Map();
  for (const [subject, note] of notation) {
    // Only lifecycle concepts carry both a notation and an order in this vocabulary.
    if (subject.includes('lifecycle/') || subject.includes('klife')) {
      const o = order.get(subject);
      if (o !== undefined) ranks.set(note, o);
    }
  }
  return ranks;
}

/** repo-relative path -> the entity that owns it. */
export type FileIndex = Map<string, string>;

/**
 * Index every file the graph knows about, from both shapes the corpus uses:
 *   module  kpred:has-file "path"                  (reckons-codebase.ttl)
 *   file    kpred:path "path" ; skos:broader module (reckons-code-files.ttl)
 * The second is preferred when both exist, because it names the file entity precisely.
 */
export function buildFileIndex(triples: Triple[]): FileIndex {
  const index: FileIndex = new Map();
  const broader = new Map<string, string>();
  for (const t of triples) if (p(t, 'core#broader')) broader.set(t.subject, t.object);
  for (const t of triples) {
    if (p(t, '/has-file')) index.set(normalizePath(t.object), t.subject);
  }
  for (const t of triples) {
    if (p(t, '/path')) index.set(normalizePath(t.object), broader.get(t.subject) ?? t.subject);
  }
  return index;
}

export const normalizePath = (s: string) => s.replace(/^\.\//, '').replace(/^\/+/, '').trim();

/**
 * Files that are generated from the graph, or are not source at all. Scoring a change against
 * these punishes regenerating what the graph itself produced, which is backwards.
 */
export function isDerived(path: string): boolean {
  return /^(content|build|\.svelte-kit|node_modules|test-results|playwright-report)\//.test(path)
    || /\.(bak|lock|snap|png|jpe?g|gif|webm|glb|woff2?)$/i.test(path)
    || /(package-lock\.json|docs-search-index\.json|page-provenance\.json)$/.test(path);
}

/**
 * `applicable: false` means the dimension has nothing to judge — no feature owns the changed
 * files, or no dependencies are declared. Such a dimension is DROPPED and the remaining weights
 * are renormalised, rather than scored 1.0. Awarding full marks for an absent signal inflates
 * every tooling change; scoring it 0 double-punishes what coverage already counted. Neither is
 * a measurement.
 */
export type Dimension = { score: number; detail: string; applicable?: boolean };

/** Fraction of changed source files the graph actually knows about, by exact path. */
export function scoreCoverage(changedSource: string[], index: FileIndex): Dimension & { unknown: string[] } {
  if (changedSource.length === 0) {
    return { score: 0, detail: 'no source files changed — not scored', applicable: false, unknown: [] };
  }
  const unknown = changedSource.filter(f => !index.has(normalizePath(f)));
  const covered = changedSource.length - unknown.length;
  return {
    score: covered / changedSource.length,
    detail: `${covered}/${changedSource.length} changed source files linked in the graph`,
    unknown
  };
}

/**
 * Is each touched feature at a status consistent with having its code changed?
 *
 * THE OLD SCORER HAD THIS BACKWARDS: it gave `speculative` and `planned` a full 1.0, so writing
 * code for something the graph says "nobody has committed to" scored as perfect alignment. That
 * is the definition of unplanned work. Building against planned, in-progress or scaffolded is
 * the aligned case; maintaining functional or production code is legitimate but is not
 * advancing the plan; changing speculative code is the one that should cost something.
 */
export function scoreStatus(statuses: string[], ranks: Ranks): Dimension {
  if (statuses.length === 0) {
    return { score: 0, detail: 'no planned feature owns the changed files — not scored', applicable: false };
  }
  if (ranks.size === 0) return { score: 0, detail: 'lifecycle vocabulary missing — cannot score status' };
  let sum = 0;
  const unknown: string[] = [];
  for (const s of statuses) {
    const r = ranks.get(s);
    if (r === undefined) { unknown.push(s); continue; }
    const max = Math.max(...ranks.values());
    if (r === 0) sum += 0.3;                    // speculative — code for uncommitted work
    else if (r >= 1 && r <= max - 2) sum += 1;  // planned / in-progress / scaffolded — advancing
    else sum += 0.8;                            // functional / production — maintenance
  }
  const scored = statuses.length - unknown.length;
  const detail = unknown.length
    ? `${scored}/${statuses.length} scored; NOT IN VOCABULARY: ${[...new Set(unknown)].join(', ')}`
    : `${statuses.length} touched feature(s)`;
  // An unknown status is a graph defect, so it counts against the score instead of vanishing.
  return { score: scored === 0 ? 0 : sum / statuses.length, detail };
}

/**
 * Of the touched features' dependencies, what fraction is satisfied? A RATIO, not a product,
 * and scoped to the change.
 *
 * Depending on work that is not yet built is only a violation when the DEPENDENT has overtaken
 * it. A planned feature may depend on planned work — that is a roadmap. A functional feature
 * resting on something speculative is the real defect, and is what this should catch.
 */
export function scoreDeps(
  edges: Array<{ from: string; fromStatus: string; to: string; toStatus: string | undefined }>,
  ranks: Ranks
): Dimension & { violations: string[] } {
  if (edges.length === 0) {
    return { score: 0, detail: 'touched features declare no dependencies — not scored', applicable: false, violations: [] };
  }
  const violations: string[] = [];
  for (const e of edges) {
    const from = ranks.get(e.fromStatus);
    const to = e.toStatus === undefined ? undefined : ranks.get(e.toStatus);
    if (from === undefined) continue;
    if (to === undefined) { violations.push(`${e.from} -> ${e.to} (dependency has no status)`); continue; }
    if (to < from) violations.push(`${e.from} [${e.fromStatus}] -> ${e.to} [${e.toStatus}]`);
  }
  const met = edges.length - violations.length;
  return {
    score: met / edges.length,
    detail: `${met}/${edges.length} dependencies at or ahead of the feature that needs them`,
    violations
  };
}

/**
 * Scope discipline — is the change concentrated, or scattered across unrelated modules?
 *
 * Independent of coverage by construction: it reads the DISTRIBUTION of changed files across
 * owning entities, not how many were matched. Measured as the share landing in the three
 * busiest modules, so a focused change scores high and a sprawling one does not. A deliberate
 * wide refactor scores low and should — that is the signal, not a false negative.
 */
export function scoreScope(changedSource: string[], index: FileIndex): Dimension {
  const owners = changedSource.map(f => index.get(normalizePath(f))).filter((x): x is string => !!x);
  if (owners.length === 0) {
    return { score: 0, detail: 'no linked files to measure concentration over — not scored', applicable: false };
  }
  const counts = new Map<string, number>();
  for (const o of owners) counts.set(o, (counts.get(o) ?? 0) + 1);
  const top = [...counts.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  return {
    score: top / owners.length,
    detail: `${top}/${owners.length} linked files in the ${Math.min(3, counts.size)} busiest module(s) of ${counts.size}`
  };
}

export const WEIGHTS = { coverage: 0.3, status: 0.3, deps: 0.2, scope: 0.2 } as const;

export function grade(composite: number): string {
  return composite >= 0.85 ? 'EXCELLENT' : composite >= 0.7 ? 'GOOD' : composite >= 0.5 ? 'FAIR' : 'POOR';
}

/**
 * Weighted mean over the APPLICABLE dimensions only, renormalised so the weights still sum to 1.
 * Returns null when nothing could be measured, which callers must report as "not scored" rather
 * than printing a zero that reads like a failing grade.
 */
export function composite(dims: Record<keyof typeof WEIGHTS, Dimension>): number | null {
  let sum = 0;
  let weight = 0;
  for (const key of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) {
    if (dims[key].applicable === false) continue;
    sum += dims[key].score * WEIGHTS[key];
    weight += WEIGHTS[key];
  }
  return weight === 0 ? null : sum / weight;
}

/** A feature the change actually touches, with the evidence for why we think so. */
export type TouchedFeature = { iri: string; status: string; via: string };

/**
 * Which planned features does this change touch?
 *
 * Two routes, both from links the graph already maintains, and NEITHER from string similarity:
 *   direct    feature kpred:tested-by "path"                    (283 edges)
 *   indirect  feature kpred:touches-module M, and M owns "path"  (75 edges, via FileIndex)
 *
 * Returning an empty set is a real answer — "this change touches nothing the roadmap describes"
 * — and callers must report it rather than substituting a keyword search, which is how the
 * previous implementation turned "unknown" into fifteen arbitrary entities.
 */
export function resolveTouchedFeatures(
  changedSource: string[],
  triples: Triple[],
  index: FileIndex
): TouchedFeature[] {
  const status = new Map<string, string>();
  const testedBy = new Map<string, string[]>();
  const touches = new Map<string, string[]>();
  for (const t of triples) {
    if (p(t, '/has-status')) status.set(t.subject, t.object);
    else if (p(t, '/tested-by')) push(testedBy, normalizePath(t.object), t.subject);
    else if (p(t, '/touches-module')) push(touches, t.object, t.subject);
  }

  const found = new Map<string, TouchedFeature>();
  for (const raw of changedSource) {
    const path = normalizePath(raw);
    for (const iri of testedBy.get(path) ?? []) {
      const s = status.get(iri);
      if (s) found.set(iri, { iri, status: s, via: `tested-by ${path}` });
    }
    const module = index.get(path);
    if (module) {
      for (const iri of touches.get(module) ?? []) {
        const s = status.get(iri);
        if (s && !found.has(iri)) found.set(iri, { iri, status: s, via: `touches-module ${module}` });
      }
    }
  }
  return [...found.values()];
}

/** Dependency edges declared by the touched features, with both ends' statuses resolved. */
export function dependencyEdges(
  touched: TouchedFeature[],
  triples: Triple[]
): Array<{ from: string; fromStatus: string; to: string; toStatus: string | undefined }> {
  const status = new Map<string, string>();
  const deps = new Map<string, string[]>();
  for (const t of triples) {
    if (p(t, '/has-status')) status.set(t.subject, t.object);
    else if (p(t, '/depends-on')) push(deps, t.subject, t.object);
  }
  const edges = [];
  for (const f of touched) {
    for (const to of deps.get(f.iri) ?? []) {
      edges.push({ from: f.iri, fromStatus: f.status, to, toStatus: status.get(to) });
    }
  }
  return edges;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const cur = m.get(k);
  if (cur) cur.push(v); else m.set(k, [v]);
}
