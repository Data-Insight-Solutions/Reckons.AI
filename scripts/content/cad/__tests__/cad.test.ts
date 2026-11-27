/**
 * F299.1 / F299.2 — the pure parts of the CAD path (spec rules, script generation, receipt check)
 * run everywhere. The one integration test needs the optional build123d virtualenv and is skipped
 * without it, so CI never depends on a CAD kernel.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { specToBuild123d } from '../generate';
import { checkReceipt, type CadReceipt } from '../receipt';
import { buildPart, cadAvailable } from '../run';
import { ALL_PARAM_NAMES, expectedBbox, specSha256, validateSpec, type PartSpec } from '../spec';
import { CAD_PARAM_PREDICATES } from '../../../../src/lib/rdf/types';
import { sceneToPython } from '../../blender-render';

const bracket = (over: Record<string, number> = {}): PartSpec => ({
  kind: 'bracket',
  name: 'test-bracket',
  params: { width_mm: 60, height_mm: 40, depth_mm: 35, thickness_mm: 4, hole_diameter_mm: 5, hole_count: 2, fillet_mm: 6, ...over },
});
const enclosure = (over: Record<string, number> = {}): PartSpec => ({
  kind: 'enclosure',
  name: 'test-box',
  params: { width_mm: 80, depth_mm: 50, height_mm: 30, wall_mm: 2, corner_radius_mm: 5, lip_height_mm: 3, ...over },
});

describe('part spec validation', () => {
  it('accepts a complete bracket and a complete enclosure', () => {
    expect(validateSpec(bracket())).toEqual([]);
    expect(validateSpec(enclosure())).toEqual([]);
  });
  it('refuses a missing parameter', () => {
    const s = bracket();
    delete s.params.fillet_mm;
    expect(validateSpec(s).join()).toContain('missing parameter fillet_mm');
  });
  it('refuses negative, non-finite and fractional-count values', () => {
    expect(validateSpec(bracket({ thickness_mm: -1 })).join()).toContain('negative');
    expect(validateSpec(bracket({ width_mm: NaN })).join()).toContain('finite');
    expect(validateSpec(bracket({ hole_count: 1.5 })).join()).toContain('whole number');
  });
  it('refuses absurd sizes instead of clamping them', () => {
    expect(validateSpec(bracket({ width_mm: 100000 })).join()).toContain('outside');
    expect(validateSpec(enclosure({ wall_mm: 0.01 })).join()).toContain('outside');
  });
  it('refuses geometry that cannot be built', () => {
    expect(validateSpec(bracket({ hole_diameter_mm: 40 })).join()).toContain('hole');
    expect(validateSpec(bracket({ thickness_mm: 20 })).join()).toContain('thickness');
    expect(validateSpec(enclosure({ wall_mm: 25 })).length).toBeGreaterThan(0);
  });
  it('refuses unknown kinds and unknown parameters', () => {
    expect(validateSpec({ kind: 'gear', name: 'g', params: {} }).join()).toContain('unknown part kind');
    expect(validateSpec({ ...bracket(), params: { ...bracket().params, extra: 1 } }).join()).toContain('unknown parameter extra');
  });
  it('hashes the same spec the same way whatever the key order', () => {
    const a = bracket();
    const b: PartSpec = { ...a, params: Object.fromEntries(Object.entries(a.params).reverse()) };
    expect(specSha256(a)).toBe(specSha256(b));
    expect(specSha256(a)).not.toBe(specSha256(bracket({ width_mm: 61 })));
  });
  it('keeps the graph predicate list in step with the spec parameters', () => {
    const names = CAD_PARAM_PREDICATES.map((p) => p.replace('urn:kbase:predicate/', ''));
    for (const n of ALL_PARAM_NAMES) expect(names).toContain(`param-${n.replace(/_/g, '-')}`);
  });
});

describe('build123d script generation', () => {
  it('is deterministic: the same spec gives a byte-identical script', () => {
    expect(specToBuild123d(bracket())).toBe(specToBuild123d(bracket()));
    expect(specToBuild123d(enclosure())).toBe(specToBuild123d(enclosure()));
  });
  it('changes when a parameter changes, and never embeds an output path', () => {
    const a = specToBuild123d(bracket());
    expect(specToBuild123d(bracket({ width_mm: 61 }))).not.toBe(a);
    expect(a).toContain('sys.argv[1]');
    expect(a).not.toMatch(/\/home\/|\/tmp\//);
  });
  it('refuses to generate from an invalid spec', () => {
    expect(() => specToBuild123d(bracket({ hole_count: -1 }))).toThrow(/invalid part spec/);
  });
});

describe('receipt check', () => {
  const good = (): CadReceipt => {
    const spec = bracket();
    const f = { name: 'x', sha256: 'a', bytes: 1 };
    return {
      schema: 1, spec, specSha256: specSha256(spec), scriptSha256: 'b',
      tools: { build123d: '0', ocp: '0', python: '3' },
      volumeMm3: 17000, bboxMm: expectedBbox(spec), files: { step: f, stl: f },
      origin: 'modelled from parameters', builtAt: '2026-11-17T00:00:00Z',
    };
  };
  it('passes a receipt whose box matches the spec', () => expect(checkReceipt(good())).toEqual([]));
  it('accepts a 0.09 mm error and rejects a 0.2 mm one', () => {
    const near = good(); near.bboxMm = { ...near.bboxMm, x: 60.09 };
    expect(checkReceipt(near)).toEqual([]);
    const far = good(); far.bboxMm = { ...far.bboxMm, z: 40.2 };
    expect(checkReceipt(far).join()).toContain('bounding box z');
  });
  it('rejects a tampered spec, a wrong origin and an impossible volume', () => {
    const t = good(); t.spec = bracket({ width_mm: 70 });
    expect(checkReceipt(t).join()).toContain('specSha256');
    const o = good(); (o as any).origin = 'scanned';
    expect(checkReceipt(o).join()).toContain('origin');
    const v = good(); v.volumeMm3 = 1e9;
    expect(checkReceipt(v).join()).toContain('exceeds');
  });
  it('rejects a file whose bytes changed after the receipt was written', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cad-test-'));
    writeFileSync(path.join(dir, 'part.step'), 'one');
    writeFileSync(path.join(dir, 'part.stl'), 'two');
    const r = good();
    r.files = { step: { name: 'part.step', sha256: 'deadbeef', bytes: 3 }, stl: { name: 'part.stl', sha256: 'deadbeef', bytes: 3 } };
    expect(checkReceipt(r, dir).filter((p) => p.includes('differs'))).toHaveLength(2);
  });
});

describe('STL scene object for Blender', () => {
  it('imports the file and applies material finish only when asked', () => {
    const py = sceneToPython({ objects: [{ shape: 'stl', stl: '/x/part.stl', scale: 0.01, metallic: 0.6 }] }, '/x/o.png');
    expect(py).toContain('stl_import');
    expect(py).toContain('Metallic');
    expect(sceneToPython({ objects: [{ shape: 'cube' }] }, '/x/o.png')).not.toContain('Metallic');
  });
});

describe.skipIf(!cadAvailable())('build123d integration (needs the optional venv)', () => {
  it('builds a bracket whose measured box matches the spec', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cad-int-'));
    const { receipt } = buildPart(bracket(), dir);
    expect(receipt.bboxMm.x).toBeCloseTo(60, 1);
    expect(receipt.bboxMm.z).toBeCloseTo(40, 1);
    expect(checkReceipt(receipt, dir)).toEqual([]);
    expect(readFileSync(path.join(dir, 'part.step'), 'utf8')).toContain('ISO-10303');
  }, 120_000);
  it('builds an enclosure with a lip', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cad-int-'));
    const { receipt } = buildPart(enclosure(), dir);
    expect(receipt.bboxMm.y).toBeCloseTo(50, 1);
    expect(receipt.volumeMm3).toBeGreaterThan(0);
  }, 120_000);
});
