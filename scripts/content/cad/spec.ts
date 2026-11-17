/**
 * F299.1 (kb:cad-creation) — a part described as DATA: a kind plus named numeric parameters.
 *
 * The dimensions are facts. The solid is built from them and later checked against them, so a
 * part's record can never drift from what was asked for. Everything here is pure (no files, no
 * Python), which is what lets the rules be unit-tested without a CAD kernel installed.
 *
 * Units: millimetres for lengths, plain counts for counts. A value outside the plausible range
 * is REFUSED rather than clamped: a silently clamped dimension is a part that is not the one
 * the spec described.
 */
import { createHash } from 'crypto';

export type PartKind = 'bracket' | 'enclosure';

export interface PartSpec {
  kind: PartKind;
  /** Short lowercase id, used in folder and file names. */
  name: string;
  params: Record<string, number>;
}

interface ParamRule {
  min: number;
  max: number;
  integer?: boolean;
}

/** The accepted parameters per kind. Every one is REQUIRED: there are no silent defaults. */
export const PARAM_RULES: Record<PartKind, Record<string, ParamRule>> = {
  // L-bracket: a base plate (width x depth) with an upright wall (width x height), both `thickness` thick.
  bracket: {
    width_mm: { min: 5, max: 500 },
    height_mm: { min: 5, max: 500 },
    depth_mm: { min: 5, max: 500 },
    thickness_mm: { min: 0.5, max: 50 },
    hole_diameter_mm: { min: 1, max: 50 },
    hole_count: { min: 0, max: 12, integer: true },
    fillet_mm: { min: 0, max: 50 },
  },
  // Box with a lid lip: open top, rounded vertical corners, a rebate at the rim for a lid to sit in.
  enclosure: {
    width_mm: { min: 10, max: 500 },
    depth_mm: { min: 10, max: 500 },
    height_mm: { min: 5, max: 500 },
    wall_mm: { min: 0.8, max: 20 },
    corner_radius_mm: { min: 0.5, max: 100 },
    lip_height_mm: { min: 0.5, max: 20 },
  },
};

/** Every parameter name any kind accepts (the graph stores one predicate per name). */
export const ALL_PARAM_NAMES: string[] = [
  ...new Set(Object.values(PARAM_RULES).flatMap((r) => Object.keys(r))),
].sort();

export function validateSpec(spec: unknown): string[] {
  const problems: string[] = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];
  const s = spec as Partial<PartSpec>;
  if (!s.kind || !(s.kind in PARAM_RULES)) return [`unknown part kind ${JSON.stringify(s.kind)} (expected ${Object.keys(PARAM_RULES).join(' or ')})`];
  if (typeof s.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(s.name)) problems.push('name must be 1-40 chars of a-z, 0-9 and hyphen');
  if (!s.params || typeof s.params !== 'object') return [...problems, 'params missing'];
  const rules = PARAM_RULES[s.kind];
  for (const [k, rule] of Object.entries(rules)) {
    const v = s.params[k];
    if (v === undefined) { problems.push(`missing parameter ${k}`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(`${k} must be a finite number`); continue; }
    if (v < 0) { problems.push(`${k} is negative (${v})`); continue; }
    if (rule.integer && !Number.isInteger(v)) problems.push(`${k} must be a whole number (${v})`);
    if (v < rule.min || v > rule.max) problems.push(`${k} = ${v} is outside ${rule.min}..${rule.max}`);
  }
  for (const k of Object.keys(s.params)) if (!(k in rules)) problems.push(`unknown parameter ${k} for ${s.kind}`);
  if (problems.length) return problems;

  const p = s.params as Record<string, number>;
  if (s.kind === 'bracket') {
    if (p.thickness_mm * 2 >= Math.min(p.height_mm, p.depth_mm)) problems.push('thickness is too large for the height and depth');
    if (p.hole_count > 0) {
      if (p.hole_diameter_mm >= p.depth_mm - p.thickness_mm) problems.push('hole does not fit in the base plate (diameter >= depth - thickness)');
      if (p.hole_count * p.hole_diameter_mm * 1.5 > p.width_mm) problems.push('holes do not fit across the width');
    }
    if (p.fillet_mm >= Math.min(p.height_mm - p.thickness_mm, p.depth_mm - p.thickness_mm)) problems.push('fillet is larger than the leg it blends into');
  } else {
    if (p.wall_mm * 2 >= Math.min(p.width_mm, p.depth_mm)) problems.push('wall is too thick for the width and depth');
    if (p.corner_radius_mm * 2 >= Math.min(p.width_mm, p.depth_mm)) problems.push('corner radius is too large for the width and depth');
    if (p.wall_mm + p.lip_height_mm >= p.height_mm) problems.push('wall plus lip height must be less than the height');
  }
  return problems;
}

export function assertValidSpec(spec: unknown): asserts spec is PartSpec {
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(`invalid part spec: ${problems.join('; ')}`);
}

/** Canonical JSON: keys sorted, so the same spec hashes the same however it was written. */
export function canonicalSpecJson(spec: PartSpec): string {
  const sorted = Object.fromEntries(Object.keys(spec.params).sort().map((k) => [k, spec.params[k]]));
  return JSON.stringify({ kind: spec.kind, name: spec.name, params: sorted });
}

export function specSha256(spec: PartSpec): string {
  return createHash('sha256').update(canonicalSpecJson(spec)).digest('hex');
}

/** The bounding box (x, y, z extents, mm) the spec promises. The solid is checked against it. */
export function expectedBbox(spec: PartSpec): { x: number; y: number; z: number } {
  const p = spec.params;
  return { x: p.width_mm, y: p.depth_mm, z: p.height_mm };
}
