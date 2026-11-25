/**
 * THE COMPARE LAYOUT (F306.2, kb:split-canvas) — a comparison of two provenances, drawn as a
 * VENN DIAGRAM on the one shared canvas. Statements only the first holds sit in the left lobe
 * (blue by default), only the second in the right lobe (red), and statements BOTH hold sit at the
 * centre of the overlap
 * (purple). Matt, 2026-11-23: "I imagine it as a layout, venn diagram shaped" and, for shared,
 * "center of the venn diagram shape".
 *
 * THIS MODULE IS A PRESENTATION OF STATEMENTS THAT ALREADY EXIST. It reads the knowledge base's
 * statements
 * and returns categories, anchor positions and counts. It writes nothing, and it never draws.
 * Both renderers (KnowledgeGraph2D, KnowledgeGraph) and the legend read the same result, so the
 * numbers in the legend are the numbers the canvas is coloured by (the F264.2 discipline).
 *
 * SHARED MEANS BOTH SIDES HOLD THE CLAIM, and "hold the claim" is not string identity. Two
 * statements match when subject, predicate and object each match, where a part matches if it is
 * the identical term OR the two labels embed within the thresholds the diff already uses for
 * near-duplicate subjects and synonym predicates (semantic-diff.ts). A predicate and its antonym
 * never match. When no embedder is available only identical statements are shared, and the
 * caller is told so through `matchedBy`, so the legend never claims agreement the model did not
 * ground.
 *
 * AN ENTITY TOUCHED BY SEVERAL CATEGORIES — the rule, decided here and used by both renderers:
 *   - touched only by A-only statements          -> 'a'
 *   - touched only by B-only statements          -> 'b'
 *   - touched by any shared statement, OR by both an A-only and a B-only statement -> 'shared'
 * Reason: an entity both sides mention belongs in the overlap even when each says something
 * different about it, and an entity cannot be in two lobes at once. The edges keep their own colour,
 * so the difference between what each side says about that entity is still drawn.
 *
 * COUNTS: `a` and `b` count statements only one side holds. `shared` counts CLAIMS: matched
 * statements are merged into one group (a claim A states once and B states twice is one claim),
 * and `sharedStatements` counts the underlying statements, both sides. Statements from any other
 * provenance are `outside` and are not part of the picture.
 */
import { termKey, isMetaPredicate, type Statement, type Term } from './types';
// Why the neighbouring files changed (F306.2): semantic-diff.ts only makes the two thresholds
// below importable, so matching by meaning here follows the same numbers the rest of the app
// already uses instead of duplicating magic values; db.ts gains the compare layout's three colours
// as a persisted user setting (SettingsRecord.compareColors, allow-listed in saveSettings).
import {
  arePredicateLabelsOpposed,
  labelFromIRI,
  PREDICATE_SYNONYM_THRESHOLD,
  SUBJECT_NEAR_DUPLICATE_THRESHOLD,
} from './semantic-diff';

export type CompareCategory = 'a' | 'b' | 'shared';

export interface CompareColors { a: string; b: string; shared: string }

/**
 * Defaults, chosen to read on both the light and the dark canvas: mid-saturation, away from the
 * house orange of an ordinary edge, and distinct from each other (blue / red / violet).
 */
export const DEFAULT_COMPARE_COLORS: CompareColors = { a: '#2f80ed', b: '#e5484d', shared: '#a855f7' };

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Fill any missing or malformed colour from the defaults, so a bad saved value cannot blank the canvas. */
export function resolveCompareColors(saved?: Partial<CompareColors> | null): CompareColors {
  const pick = (k: keyof CompareColors) => (saved && typeof saved[k] === 'string' && HEX.test(saved[k]!) ? saved[k]! : DEFAULT_COMPARE_COLORS[k]);
  return { a: pick('a'), b: pick('b'), shared: pick('shared') };
}

/** A pair of statement ids the matcher judged to be the same claim: [id in A, id in B]. */
export type SharedPair = readonly [string, string];

export type MatchMode = 'meaning' | 'identical';

export interface CompareModel {
  sourceA: string;
  sourceB: string;
  /** Category of every counted statement, by statement id. Statements outside both sides are absent. */
  statementCategory: Map<string, CompareCategory>;
  /** Category of every entity (termKey) touched by a counted statement. See the rule above. */
  entityCategory: Map<string, CompareCategory>;
  counts: { a: number; b: number; shared: number; sharedStatements: number; outside: number };
  /** How "shared" was decided, so the legend can say so. */
  matchedBy: MatchMode;
}

const live = (st: Statement) => st.status !== 'rejected' && st.status !== 'superseded' && !isMetaPredicate(st.p.value);

/** Statements the layout considers: not rejected or superseded, and from one of the two sides. */
export function compareStatements(statements: readonly Statement[], a: string, b: string) {
  const inA: Statement[] = [], inB: Statement[] = [];
  for (const st of statements) {
    if (!live(st)) continue;
    if (st.sourceId === a) inA.push(st);
    else if (st.sourceId === b) inB.push(st);
  }
  return { inA, inB };
}

function termText(t: Term): string {
  return t.kind === 'iri' ? labelFromIRI(t.value) : t.value;
}

const spoKey = (st: Statement) => `${termKey(st.s)}\u0001${st.p.value}\u0001${termKey(st.o)}`;

export interface MatchOptions {
  /** Embeds texts to unit vectors. Omit to match identical statements only. */
  embedMany?: (texts: string[]) => Promise<Float32Array[]>;
}

/**
 * Find statements the two sides both hold. Identical statements always match; with an embedder,
 * statements whose subject, predicate and object each match by meaning match too.
 */
export async function findSharedPairs(
  statements: readonly Statement[], a: string, b: string, opts: MatchOptions = {},
): Promise<{ pairs: SharedPair[]; matchedBy: MatchMode }> {
  const { inA, inB } = compareStatements(statements, a, b);
  const pairs: SharedPair[] = [];
  const seen = new Set<string>();
  const add = (x: string, y: string) => { const k = `${x}\u0002${y}`; if (!seen.has(k)) { seen.add(k); pairs.push([x, y]); } };

  const bByKey = new Map<string, Statement[]>();
  for (const st of inB) { const k = spoKey(st); (bByKey.get(k) ?? bByKey.set(k, []).get(k)!).push(st); }
  const aOpen: Statement[] = [];
  for (const st of inA) {
    const hit = bByKey.get(spoKey(st));
    if (hit) for (const m of hit) add(st.id, m.id); else aOpen.push(st);
  }
  const matchedB = new Set(pairs.map((p) => p[1]));
  const bOpen = inB.filter((st) => !matchedB.has(st.id));

  if (!opts.embedMany || aOpen.length === 0 || bOpen.length === 0) {
    return { pairs, matchedBy: opts.embedMany ? 'meaning' : 'identical' };
  }

  // Embed each distinct text once; compare part-by-part with a memo, so the cost follows the number
  // of distinct labels rather than the number of statement pairs.
  const texts = new Map<string, number>();
  const want = (s: string) => { if (!texts.has(s)) texts.set(s, texts.size); };
  const partsOf = (st: Statement) => ({ s: termText(st.s), p: labelFromIRI(st.p.value), o: termText(st.o) });
  for (const st of [...aOpen, ...bOpen]) { const p = partsOf(st); want(p.s); want(p.p); want(p.o); }
  const list = [...texts.keys()];
  const vecs = await opts.embedMany(list);
  const sim = new Map<string, number>();
  const cos = (x: string, y: string) => {
    const k = x < y ? `${x}\u0003${y}` : `${y}\u0003${x}`;
    let v = sim.get(k);
    if (v === undefined) {
      const va = vecs[texts.get(x)!], vb = vecs[texts.get(y)!];
      v = 0; for (let i = 0; i < va.length; i++) v += va[i] * vb[i];
      sim.set(k, v);
    }
    return v;
  };
  const same = (x: string, y: string, th: number) => x === y || cos(x, y) >= th;

  for (const sa of aOpen) {
    const pa = partsOf(sa);
    for (const sb of bOpen) {
      const pb = partsOf(sb);
      const predSame = sa.p.value === sb.p.value
        || (!arePredicateLabelsOpposed(sa.p.value, sb.p.value) && cos(pa.p, pb.p) >= PREDICATE_SYNONYM_THRESHOLD);
      if (!predSame) continue;
      if (!same(pa.s, pb.s, SUBJECT_NEAR_DUPLICATE_THRESHOLD)) continue;
      if (!same(pa.o, pb.o, SUBJECT_NEAR_DUPLICATE_THRESHOLD)) continue;
      add(sa.id, sb.id);
    }
  }
  return { pairs, matchedBy: 'meaning' };
}

/** Pure: categories, entity categories and counts from the statements and the matched pairs. */
export function buildCompareModel(
  statements: readonly Statement[], a: string, b: string, pairs: readonly SharedPair[], matchedBy: MatchMode = 'identical',
): CompareModel {
  const { inA, inB } = compareStatements(statements, a, b);
  const idsA = new Set(inA.map((s) => s.id)), idsB = new Set(inB.map((s) => s.id));
  const sharedIds = new Set<string>();
  // Merge matched statements into claims (union-find over statement ids).
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  for (const [x, y] of pairs) {
    if (!idsA.has(x) || !idsB.has(y)) continue; // a pair naming a statement not in this comparison is ignored
    for (const id of [x, y]) if (!parent.has(id)) parent.set(id, id);
    parent.set(find(x), find(y));
    sharedIds.add(x); sharedIds.add(y);
  }
  const claims = new Set([...sharedIds].map(find));

  const statementCategory = new Map<string, CompareCategory>();
  let aOnly = 0, bOnly = 0;
  for (const st of inA) { if (sharedIds.has(st.id)) statementCategory.set(st.id, 'shared'); else { statementCategory.set(st.id, 'a'); aOnly++; } }
  for (const st of inB) { if (sharedIds.has(st.id)) statementCategory.set(st.id, 'shared'); else { statementCategory.set(st.id, 'b'); bOnly++; } }

  const touched = new Map<string, Set<CompareCategory>>();
  for (const st of [...inA, ...inB]) {
    const c = statementCategory.get(st.id)!;
    for (const t of [st.s, st.o]) { const k = termKey(t); (touched.get(k) ?? touched.set(k, new Set()).get(k)!).add(c); }
  }
  const entityCategory = new Map<string, CompareCategory>();
  for (const [k, cats] of touched) {
    entityCategory.set(k, cats.has('shared') || (cats.has('a') && cats.has('b')) ? 'shared' : cats.has('a') ? 'a' : 'b');
  }
  const outside = statements.filter((st) => live(st) && st.sourceId !== a && st.sourceId !== b).length;
  return {
    sourceA: a, sourceB: b, statementCategory, entityCategory,
    counts: { a: aOnly, b: bOnly, shared: claims.size, sharedStatements: sharedIds.size, outside },
    matchedBy,
  };
}

/** Convenience: match, then build. */
export async function computeCompare(
  statements: readonly Statement[], a: string, b: string, opts: MatchOptions = {},
): Promise<CompareModel> {
  const { pairs, matchedBy } = await findSharedPairs(statements, a, b, opts);
  return buildCompareModel(statements, a, b, pairs, matchedBy);
}

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * Two overlapping circles, in world units (the 2D renderer's units; the 3D renderer uses the same
 * numbers on x and y). Lobe centres sit at +/- OFFSET, each circle has radius RADIUS, so the
 * overlap is a lens centred on the origin where the shared statements are anchored.
 */
export const VENN = { OFFSET: 7, RADIUS: 12 } as const;

export interface VennPoint { x: number; y: number }

/**
 * Anchor for one entity. Entities of the same category get a deterministic spread around the
 * category's anchor (by index), so the lobes read as areas rather than three dots; the force
 * simulation then settles each entity near its own anchor.
 */
export function vennAnchor(category: CompareCategory, index: number, count: number): VennPoint {
  const cx = category === 'a' ? -VENN.OFFSET - 3 : category === 'b' ? VENN.OFFSET + 3 : 0;
  // The shared anchor is the centre of the overlap, spread only vertically so it stays a core.
  const spread = category === 'shared' ? 3.2 : 5.5;
  if (count <= 1) return { x: cx, y: 0 };
  // Golden-angle sunflower: even fill of a disc, stable per index.
  const r = spread * Math.sqrt((index + 0.5) / count);
  const th = index * 2.399963229728653;
  const sx = category === 'shared' ? 0.55 : 1; // the lens is narrow: squeeze shared horizontally
  return { x: cx + r * Math.cos(th) * sx, y: r * Math.sin(th) };
}

/** Anchors for every entity in the model, in a stable order (sorted by key). */
export function compareAnchors(model: CompareModel): Map<string, VennPoint> {
  const byCat: Record<CompareCategory, string[]> = { a: [], b: [], shared: [] };
  for (const [k, c] of model.entityCategory) byCat[c].push(k);
  const out = new Map<string, VennPoint>();
  for (const c of ['a', 'b', 'shared'] as const) {
    const keys = byCat[c].sort();
    keys.forEach((k, i) => out.set(k, vennAnchor(c, i, keys.length)));
  }
  return out;
}

/** Legend rows for the UI, the one place labels and counts come from. */
export function compareLegend(model: CompareModel, titles: { a: string; b: string }, colors: CompareColors) {
  return [
    { id: 'a' as const, color: colors.a, count: model.counts.a, label: `only in ${titles.a}` },
    { id: 'shared' as const, color: colors.shared, count: model.counts.shared, label: 'in both' },
    { id: 'b' as const, color: colors.b, count: model.counts.b, label: `only in ${titles.b}` },
  ];
}

/** What a renderer needs: the model plus the colours and lobe titles to draw it with. */
export interface CompareView { model: CompareModel; colors: CompareColors; titleA: string; titleB: string }

/** Row below the diagram for entities that belong to neither side (drawn quietly, not in a lobe). */
export function outsideAnchor(index: number, count: number): VennPoint {
  const width = Math.min(34, Math.max(4, count * 1.6));
  return { x: count <= 1 ? 0 : -width / 2 + (width * index) / (count - 1), y: VENN.RADIUS + 7 };
}

/**
 * Anchors for a renderer: the model's entities in their lobes, every other entity (`allKeys`) in the
 * outside row, plus four invisible FRAME points at the extremes of the two circles so a camera fit
 * frames the whole diagram and not only where entities happen to be. Frame keys start with `cmp:`.
 */
export function compareAnchorsFor(model: CompareModel, allKeys: readonly string[]): Map<string, VennPoint> {
  const out = compareAnchors(model);
  const outside = allKeys.filter((k) => !model.entityCategory.has(k) && !k.startsWith('src:')).sort();
  outside.forEach((k, i) => out.set(k, outsideAnchor(i, outside.length)));
  const w = VENN.OFFSET + VENN.RADIUS, h = VENN.RADIUS;
  out.set('cmp:frame-l', { x: -w, y: 0 }); out.set('cmp:frame-r', { x: w, y: 0 });
  out.set('cmp:frame-t', { x: 0, y: -h - 3 }); // room for the lobe titles above
  out.set('cmp:frame-b', { x: 0, y: outside.length ? VENN.RADIUS + 9 : h });
  return out;
}
