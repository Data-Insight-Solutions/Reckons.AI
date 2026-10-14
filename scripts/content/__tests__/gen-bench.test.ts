/**
 * The generation-model bench's pure parts (F183.1): candidate screening against RECORDED Hugging
 * Face API responses (no network), the incumbent revision check, the decision rule, the judge-free
 * quality metrics, and the one-GPU lock. The fixtures in ./fixtures are trimmed real responses
 * recorded 2026-10-14.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HFRawModel } from '../../../tests/visual/hf-model-query';
import { MODELS, OUTPUTS } from '../gen-assets';
import { REQUIRED_SPLAT_PROPS } from '../asset-checks';
import {
  DEFAULT_BUDGET, LICENSE_ALLOWLIST, STAGE_SPECS, attributionFor, licensePolicy, checklistScore, compareRevision, decide, dedupeByFile, foregroundMask, generationLock,
  parseYesNo, perSeedQuality, rankForDiscovery, readSplatPoints, repoOfSource, screenCandidate, splatQuality, splatScore, videoQuality, videoScore,
  type Arm, type BenchRun,
} from '../gen-bench-lib';
import { loadBenchTasks } from '../gen-bench-graph';

const { image: IMAGE_BRIEFS, video: VIDEO_BRIEFS, splat: SPLAT_BRIEFS, seeds: SEEDS } = loadBenchTasks();

const fx = <T>(n: string): T => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8')) as T;
const list = fx<HFRawModel[]>('hf-list-text-to-image.json');
const byId = (id: string) => list.find((m) => m.id === id)!;
const info = (r: string) => fx<HFRawModel>(`hf-info-${r.replace('/', '__')}.json`);

describe('licensePolicy: Creative Commons (F183.2)', () => {
  it('allows cc-by-4.0, and says attribution is required', () => {
    const v = licensePolicy('cc-by-4.0');
    expect(v).toMatchObject({ allowed: true, attributionRequired: true, flag: null });
    expect(licensePolicy('CC-BY-4.0').allowed).toBe(true);
  });
  it('allows cc0-1.0 with no attribution duty', () => {
    expect(licensePolicy('cc0-1.0')).toMatchObject({ allowed: true, attributionRequired: false });
  });
  it('denies every non-commercial and no-derivatives variant', () => {
    for (const l of ['cc-by-nc-4.0', 'cc-by-nd-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nc-nd-4.0', 'cc-by-nc-3.0']) {
      const v = licensePolicy(l, { allowShareAlike: true });
      expect(v.allowed, l).toBe(false);
      expect(v.reason, l).toMatch(/not permissive/);
    }
  });
  it('flags cc-by-sa-4.0: denied by default, allowed only with the recorded flag, and the flag stays on the verdict', () => {
    expect(licensePolicy('cc-by-sa-4.0')).toMatchObject({ allowed: false, flag: 'share-alike' });
    expect(licensePolicy('cc-by-sa-4.0', { allowShareAlike: true })).toMatchObject({ allowed: true, flag: 'share-alike', attributionRequired: true });
  });
  it('still refuses an unknown or missing licence', () => {
    expect(licensePolicy('other').allowed).toBe(false);
    expect(licensePolicy(null).allowed).toBe(false);
    expect(licensePolicy('cc-by-3.0').allowed).toBe(false);
  });
  it('discovery screening drops -nc and -nd before download and keeps cc-by-4.0', () => {
    const model = (license: string): HFRawModel => ({ id: 'someone/Cool-Z-Image-GGUF', cardData: { license }, tags: ['gguf', 'z-image', 'stable-diffusion.cpp'], siblings: [{ rfilename: 'cool-Q4_K_M.gguf', size: 4 * 1024 ** 3 }] });
    expect(screenCandidate(model('cc-by-nc-4.0'), 'image').kept).toBe(false);
    expect(screenCandidate(model('cc-by-nd-4.0'), 'image').reasons[0]).toMatch(/not permissive/);
    expect(screenCandidate(model('cc-by-sa-4.0'), 'image').reasons[0]).toMatch(/share-alike/);
    expect(screenCandidate(model('cc-by-4.0'), 'image').kept).toBe(true);
  });
  it('attributionFor carries credit, the licence link and an indication of changes; MIT needs none here', () => {
    const t = attributionFor('someone/Cool-Z-Image-GGUF', 'cc-by-4.0', 're-quantised to Q4_K_M');
    expect(t).toContain('https://huggingface.co/someone/Cool-Z-Image-GGUF');
    expect(t).toContain('https://creativecommons.org/licenses/by/4.0/');
    expect(t).toContain('Changes: re-quantised to Q4_K_M');
    expect(attributionFor('a/b', 'mit')).toBe('');
    expect(attributionFor('a/b', 'cc0-1.0')).toBe('');
  });
});

describe('screenCandidate: licence, runtime, format, size', () => {
  it('drops a licence that is not on the allowlist, saying which', () => {
    const s = screenCandidate(byId('city96/FLUX.1-dev-gguf'), 'image');
    expect(s.kept).toBe(false);
    expect(s.reasons[0]).toMatch(/licence "other" is not on the allowlist/);
  });
  it('the allowlist is permissive licences only', () => {
    expect(LICENSE_ALLOWLIST).toEqual(expect.arrayContaining(['apache-2.0', 'mit']));
    for (const bad of ['other', 'cc-by-nc-4.0', 'creativeml-openrail-m', 'openrail++']) expect(LICENSE_ALLOWLIST).not.toContain(bad);
  });
  it('drops an Apache-2.0 repository whose name says the weights are unfiltered', () => {
    const m = byId('AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF');
    expect(m.cardData?.license).toBe('apache-2.0');
    expect(screenCandidate(m, 'image').reasons[0]).toMatch(/unfiltered or adult/);
  });
  it('does not treat the incumbent repository as a candidate', () => {
    const s = screenCandidate(info('leejet/Z-Image-Turbo-GGUF'), 'image');
    expect(s.incumbent).toBe(true);
    expect(s.kept).toBe(false);
  });
  it('keeps a same-base repository from the listing alone and says file sizes are still needed', () => {
    const s = screenCandidate(byId('unsloth/Z-Image-Turbo-GGUF'), 'image');
    expect(s.kept).toBe(true);
    expect(s.needsFiles).toBe(true);
    expect(s.needsRecipe).toBe(false);
  });
  it('with the file list, picks the largest weight file that fits and calls a same-base repo a drop-in', () => {
    const s = screenCandidate(info('vnbot-ai/Z-Image-Turbo-GGUF'), 'image');
    expect(s.kept).toBe(true);
    expect(s.needsRecipe).toBe(false);
    expect(s.file!.name).toMatch(/\.gguf$/);
    expect(s.file!.bytes).toBeLessThanOrEqual(STAGE_SPECS.image.maxFileBytes);
  });
  it('keeps a different architecture but marks that it needs a recipe', () => {
    const m = { ...info('xCloudinfo/Qwen-Image-2.1-GGUF'), cardData: { license: 'apache-2.0', base_model: 'Qwen/Qwen-Image-2.1' } };
    const s = screenCandidate(m, 'image');
    expect(s.kept).toBe(true);
    expect(s.needsRecipe).toBe(true);
  });
  it('drops a repository whose smallest weight file is over the one-GPU cap', () => {
    const big: HFRawModel = {
      id: 'someone/Big-Z-Image-GGUF', cardData: { license: 'mit' }, tags: ['gguf', 'z-image', 'stable-diffusion.cpp'],
      siblings: [{ rfilename: 'big-Q8.gguf', size: 30 * 1024 ** 3 }],
    };
    expect(screenCandidate(big, 'image').reasons[0]).toMatch(/over the 16 GiB cap/);
  });
  it('drops gated, private, licence-less and adapter repositories', () => {
    const base = { cardData: { license: 'mit' }, tags: ['gguf', 'stable-diffusion.cpp'] };
    expect(screenCandidate({ id: 'a/b', ...base, gated: 'manual' }, 'image').reasons[0]).toMatch(/gated/);
    expect(screenCandidate({ id: 'a/b', ...base, private: true }, 'image').reasons[0]).toMatch(/private/);
    expect(screenCandidate({ id: 'a/b', tags: ['gguf'] }, 'image').reasons[0]).toMatch(/no licence/);
    expect(screenCandidate({ id: 'a/flux-lora-gguf', ...base }, 'image').reasons[0]).toMatch(/adapter/);
  });
  it('drops a repository with no evidence the runtime loads it', () => {
    const m: HFRawModel = { id: 'a/mystery-model-gguf', cardData: { license: 'mit' }, tags: ['gguf'] };
    expect(screenCandidate(m, 'image').reasons[0]).toMatch(/no evidence stable-diffusion.cpp loads/);
  });
  it('splat: only the one architecture the runner can load survives; a permissive licence is not enough', () => {
    const trellis = fx<HFRawModel[]>('hf-list-image-to-3d.json').find((m) => m.id === 'microsoft/TRELLIS-image-large')!;
    expect(trellis.cardData?.license).toBe('mit');
    expect(screenCandidate(trellis, 'splat').kept).toBe(false);
    const revision: HFRawModel = { id: 'someone/TripoSplat-v2', cardData: { license: 'mit' }, tags: ['safetensors'], siblings: [{ rfilename: 'triposplat_v2.safetensors', size: 3e9 }] };
    expect(screenCandidate(revision, 'splat').kept).toBe(true);
  });
  it('ranks drop-ins first, then recency, never by likes alone', () => {
    const mk = (repo: string, needsRecipe: boolean, lastModified: string, downloads: number) =>
      ({ repo, kept: true, reasons: [''], license: 'mit', incumbent: false, needsRecipe, needsFiles: false, downloads, likes: 0, lastModified });
    const out = rankForDiscovery([mk('new-recipe', true, '2026-10-12', 9), mk('old-dropin', false, '2026-01-01', 1), mk('new-dropin', false, '2026-10-01', 5)]);
    expect(out.map((o) => o.repo)).toEqual(['new-dropin', 'old-dropin', 'new-recipe']);
  });
  it('folds re-uploads of one file into the most downloaded', () => {
    const mk = (repo: string, downloads: number) => ({ repo, kept: true, reasons: ['ok'], license: 'mit', incumbent: false, needsRecipe: false, needsFiles: false, downloads, likes: 0, lastModified: null, file: { name: 'x/same.gguf', bytes: 123 } });
    const { kept, folded } = dedupeByFile([mk('copy-a', 3), mk('original', 900), mk('copy-b', 5)]);
    expect(kept.map((k) => k.repo)).toEqual(['original']);
    expect(folded).toHaveLength(2);
  });
});

describe('compareRevision: receipt SHA-256 vs the repository now', () => {
  const leejet = info('leejet/Z-Image-Turbo-GGUF');
  const q8 = leejet.siblings!.find((s) => s.rfilename.endsWith('z_image_turbo-Q8_0.gguf') || s.rfilename.endsWith('Q8_0.gguf'))!;
  const file = q8.rfilename.split('/').pop()!;
  const source = 'https://huggingface.co/leejet/Z-Image-Turbo-GGUF';
  it('is unchanged when the LFS hash equals the one the receipt recorded', () => {
    expect(compareRevision({ file, sha256: q8.lfs!.sha256, source }, leejet).status).toBe('unchanged');
  });
  it('flags a file whose bytes changed upstream', () => {
    const r = compareRevision({ file, sha256: 'a'.repeat(64), source }, leejet);
    expect(r.status).toBe('changed-upstream');
    expect(r.detail).toMatch(/differs/);
  });
  it('says so when the file is gone from the repository, and when the API did not answer', () => {
    expect(compareRevision({ file: 'renamed.gguf', sha256: 'b'.repeat(64), source }, leejet).status).toBe('not-in-repo');
    expect(compareRevision({ file, sha256: q8.lfs!.sha256, source }, null).status).toBe('unreachable');
  });
  it('reads the repository out of a receipt source URL', () => {
    expect(repoOfSource(source)).toBe('leejet/Z-Image-Turbo-GGUF');
    expect(repoOfSource('https://example.com/x')).toBeNull();
  });
});

// ── The decision rule ────────────────────────────────────────────────────────

const run = (brief: string, seed: number, quality: number | null, o: Partial<BenchRun> = {}): BenchRun =>
  ({ brief, seed, hardPass: true, quality, seconds: 10, peakVramMiB: 12000, bytes: 1, ...o });
/** quality[i][j] = brief i, seed j */
const arm = (id: string, q: number[][], o: Partial<BenchRun> = {}, license = 'apache-2.0'): Arm =>
  ({ id, license, runs: q.flatMap((row, i) => row.map((v, j) => run(`b${i}`, 100 + j, v, o))) });

describe('decide: the upgrade rule', () => {
  // Incumbent per-seed means: 0.60, 0.70, 0.65 -> spread 0.10
  const inc = arm('inc', [[0.6, 0.7, 0.65], [0.6, 0.7, 0.65]]);

  it('UPGRADE: beats the incumbent by more than its own seed spread, passes every check, in budget', () => {
    const d = decide(inc, arm('cand', [[0.85, 0.9, 0.88], [0.85, 0.9, 0.88]]));
    expect(d.verdict).toBe('upgrade');
    expect(d.numbers.incumbentSpread).toBeCloseTo(0.1, 6);
    expect(d.numbers.delta).toBeGreaterThan(0.1);
  });
  it('HOLD: a gain smaller than the incumbent\'s own seed-to-seed spread is noise', () => {
    const d = decide(inc, arm('cand', [[0.7, 0.75, 0.72], [0.7, 0.75, 0.72]]));
    expect(d.verdict).toBe('hold');
    expect(d.reasons.join(' ')).toMatch(/does not exceed the incumbent's own seed spread/);
  });
  it('HOLD: identical results never upgrade, even when the spread is zero (minimum margin)', () => {
    const flat = arm('inc', [[0.8, 0.8, 0.8]]);
    expect(decide(flat, arm('same', [[0.8, 0.8, 0.8]])).verdict).toBe('hold');
    expect(decide(flat, arm('tiny', [[0.805, 0.805, 0.805]])).verdict).toBe('hold');
    expect(decide(flat, arm('better', [[0.85, 0.85, 0.85]])).verdict).toBe('upgrade');
  });
  it('HOLD: a candidate that fails a hard check the incumbent passes, however good its quality', () => {
    const c = arm('cand', [[0.95, 0.95, 0.95], [0.95, 0.95, 0.95]]);
    c.runs[2] = { ...c.runs[2], hardPass: false };
    const d = decide(inc, c);
    expect(d.verdict).toBe('hold');
    expect(d.numbers.hardRegressions).toEqual(['b0#102']);
  });
  it('a hard check the incumbent ALSO fails is not held against the candidate', () => {
    const i2 = arm('inc', [[0.6, 0.7, 0.65]]);
    i2.runs[1] = { ...i2.runs[1], hardPass: false };
    const c = arm('cand', [[0.95, 0.95, 0.95]]);
    c.runs[1] = { ...c.runs[1], hardPass: false };
    expect(decide(i2, c).numbers.hardRegressions).toEqual([]);
  });
  it('HOLD: over the time budget', () => {
    const d = decide(inc, arm('slow', [[0.9, 0.9, 0.9], [0.9, 0.9, 0.9]], { seconds: 16 }));
    expect(d.verdict).toBe('hold');
    expect(d.reasons.join(' ')).toMatch(/1.60x/);
  });
  it('HOLD: over the VRAM budget', () => {
    const d = decide(inc, arm('big', [[0.9, 0.9, 0.9], [0.9, 0.9, 0.9]], { peakVramMiB: 23500 }));
    expect(d.verdict).toBe('hold');
    expect(d.reasons.join(' ')).toMatch(/peak VRAM 23500/);
  });
  it('HOLD: share-alike needs the recorded flag; with it the licence passes and is flagged', () => {
    const win = arm('sa', [[0.9, 0.9, 0.9], [0.9, 0.9, 0.9]], {}, 'cc-by-sa-4.0');
    expect(decide(inc, win).verdict).toBe('hold');
    expect(decide(inc, win).reasons.join(' ')).toMatch(/share-alike/);
    expect(decide(inc, win, { ...DEFAULT_BUDGET, allowShareAlike: true }).verdict).toBe('upgrade');
  });
  it('UPGRADE is possible for cc-by-4.0, the same as for MIT', () => {
    expect(decide(inc, arm('by', [[0.9, 0.9, 0.9], [0.9, 0.9, 0.9]], {}, 'cc-by-4.0')).verdict).toBe('upgrade');
  });
  it('HOLD: a licence off the allowlist, even if everything else wins', () => {
    const d = decide(inc, arm('nc', [[0.9, 0.9, 0.9], [0.9, 0.9, 0.9]], {}, 'cc-by-nc-4.0'));
    expect(d.verdict).toBe('hold');
    expect(d.reasons.join(' ')).toMatch(/licence "cc-by-nc-4.0"/);
  });
  it('the budget is configurable', () => {
    const slow = arm('slow', [[0.9, 0.9, 0.9], [0.9, 0.9, 0.9]], { seconds: 16 });
    expect(decide(inc, slow, { ...DEFAULT_BUDGET, maxTimeRatio: 2 }).verdict).toBe('upgrade');
  });
  it('INSUFFICIENT: an incumbent at the ceiling leaves no headroom, however large the apparent gain', () => {
    const top = arm('inc', [[0.96, 0.96, 0.96], [0.96, 0.96, 0.96]]);
    const d = decide(top, arm('cand', [[1, 1, 1], [1, 1, 1]]));
    expect(d.verdict).toBe('insufficient-evidence');
    expect(d.reasons[0]).toMatch(/no headroom/);
  });
  it('INSUFFICIENT: one seed cannot measure a spread', () => {
    expect(decide(arm('inc', [[0.6], [0.7]]), arm('cand', [[0.9], [0.9]])).verdict).toBe('insufficient-evidence');
  });
  it('INSUFFICIENT: the candidate is missing runs the incumbent has', () => {
    const c = arm('cand', [[0.9, 0.9, 0.9]]);
    expect(decide(inc, c).verdict).toBe('insufficient-evidence');
  });
  it('INSUFFICIENT: no quality score (judge down), or no VRAM measurement', () => {
    expect(decide(inc, arm('nojudge', [[null as never, 0.9, 0.9], [0.9, 0.9, 0.9]])).verdict).toBe('insufficient-evidence');
    expect(decide(inc, arm('novram', [[0.9, 0.9, 0.9], [0.9, 0.9, 0.9]], { peakVramMiB: null })).verdict).toBe('insufficient-evidence');
  });
  it('seed spread is across seeds of per-brief means, so a harder brief does not look like seed noise', () => {
    const m = perSeedQuality(arm('x', [[0.2, 0.4], [0.8, 1.0]]).runs);
    expect([...m.values()].map((v) => Number(v.toFixed(2)))).toEqual([0.5, 0.7]);
  });
});

// ── Video metrics ────────────────────────────────────────────────────────────

const flat = (v: number, n = 12) => new Uint8Array(n).fill(v);

describe('videoQuality', () => {
  const src = flat(100);
  it('a still clip has no motion and a perfect first frame', () => {
    const q = videoQuality([flat(100), flat(100), flat(100)], src);
    expect(q.motion).toBe(0);
    expect(q.firstFrameSimilarity).toBe(1);
  });
  it('smooth steady change is motion without flicker', () => {
    const q = videoQuality([flat(100), flat(110), flat(120), flat(130)], src);
    expect(q.motion).toBeCloseTo(10 / 255, 6);
    expect(q.flicker).toBeCloseTo(0, 6);
  });
  it('strobing is flicker', () => {
    const q = videoQuality([flat(100), flat(200), flat(100), flat(200), flat(100)], src);
    expect(q.flicker).toBeGreaterThan(0.2);
  });
  it('a clip that starts from a different picture scores low first-frame similarity', () => {
    expect(videoQuality([flat(200), flat(200)], src).firstFrameSimilarity).toBeCloseTo(1 - 100 / 255, 6);
  });
  it('the blended score rewards motion, smoothness and fidelity, and punishes a still, a strobe and a stranger', () => {
    const good = videoScore({ motion: 0.06, flicker: 0, firstFrameSimilarity: 1 });
    expect(good).toBe(1);
    expect(videoScore({ motion: 0, flicker: 0, firstFrameSimilarity: 1 })).toBeCloseTo(2 / 3, 6);
    expect(videoScore({ motion: 0.06, flicker: 0.1, firstFrameSimilarity: 1 })).toBeCloseTo(2 / 3, 6);
    expect(videoScore({ motion: 0.06, flicker: 0, firstFrameSimilarity: 0.2 })).toBeCloseTo((1 + 1 + 0.2) / 3, 6);
  });
});

// ── Splat metrics ────────────────────────────────────────────────────────────

/** A binary 3DGS PLY of points from `gen`, all visible unless `hidden`. */
function ply(points: [number, number, number][], o: { nan?: boolean } = {}): Uint8Array {
  const props = REQUIRED_SPLAT_PROPS;
  const head = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', `element vertex ${points.length}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n'));
  const body = new DataView(new ArrayBuffer(points.length * props.length * 4));
  points.forEach((p, i) => props.forEach((n, k) => {
    const v = n === 'x' ? p[0] : n === 'y' ? p[1] : n === 'z' ? p[2] : n === 'opacity' ? 3 : 0.1;
    body.setFloat32((i * props.length + k) * 4, o.nan && i === 0 && n === 'x' ? NaN : v, true);
  }));
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head);
  out.set(new Uint8Array(body.buffer), head.length);
  return out;
}

/** Filled disc mask of radius r centred in a 128 grid. */
function discMask(r: number, size = 128): Uint8Array {
  const m = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((x - size / 2) ** 2 + (y - size / 2) ** 2 <= r * r) m[y * size + x] = 1;
  return m;
}

function sphere(n: number, rx: number, ry: number, rz: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  let s = 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  while (pts.length < n) {
    const [x, y, z] = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    if (x * x + y * y + z * z <= 1) pts.push([x * rx, y * ry, z * rz]);
  }
  return pts;
}

describe('splat metrics', () => {
  const mask = discMask(40);
  it('a solid ball matches a disc silhouette and has depth about equal to its width', () => {
    const q = splatQuality(readSplatPoints(ply(sphere(4000, 1, 1, 1)))!, mask);
    expect(q.silhouetteIoU).toBeGreaterThan(0.7);
    expect(q.depthToWidth).toBeGreaterThan(0.8);
    expect(q.depthToWidth).toBeLessThan(1.2);
    expect(splatScore(q, [0.3, 1.6])).toBeGreaterThan(0.85);
  });
  it('a flat card has a good silhouette and almost no depth, which the score punishes', () => {
    const q = splatQuality(readSplatPoints(ply(sphere(4000, 1, 1, 0.02)))!, mask);
    expect(q.depthToWidth).toBeLessThan(0.1);
    expect(splatScore(q, [0.3, 1.6])).toBeLessThan(0.65);
  });
  it('a flat oval does not fit a round silhouette from any side', () => {
    const q = splatQuality(readSplatPoints(ply(sphere(4000, 1, 0.5, 0.15)))!, mask);
    expect(q.silhouetteIoU).toBeLessThan(0.65);
  });
  it('is found by whichever axis is the view axis (the convention is not assumed)', () => {
    const a = splatQuality(readSplatPoints(ply(sphere(4000, 1, 1, 0.3)))!, mask);
    const b = splatQuality(readSplatPoints(ply(sphere(4000, 0.3, 1, 1)))!, mask);
    expect(a.depthToWidth).toBeCloseTo(b.depthToWidth, 1);
  });
  it('non-finite values zero the score', () => {
    const pts = readSplatPoints(ply(sphere(500, 1, 1, 1), { nan: true }))!;
    expect(pts.finite).toBe(false);
    expect(splatScore(splatQuality(pts, mask), [0.3, 1.6])).toBe(0);
  });
  it('rejects bytes that are not a float PLY', () => {
    expect(readSplatPoints(new TextEncoder().encode('nothing here'))).toBeNull();
  });
});

describe('foregroundMask', () => {
  it('finds an object on a plain background', () => {
    const w = 8, h = 8;
    const rgb = new Uint8Array(w * h * 3).fill(30);
    for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) rgb.set([220, 40, 40], (y * w + x) * 3);
    const m = foregroundMask(rgb, w, h);
    expect(m.reduce((a, b) => a + b, 0)).toBe(4);
    expect(m[3 * w + 3]).toBe(1);
    expect(m[0]).toBe(0);
  });
});

// ── Judge answers and the lock ───────────────────────────────────────────────

describe('judge answers', () => {
  it('parses YES/NO and treats anything else as ambiguous', () => {
    expect(parseYesNo('YES')).toBe(true);
    expect(parseYesNo('No.')).toBe(false);
    expect(parseYesNo('Yes, but no')).toBeNull();
    expect(parseYesNo('')).toBeNull();
  });
  it('an ambiguous answer is not a confirmation', () => {
    expect(checklistScore([true, true, null, false])).toBe(0.5);
    expect(checklistScore([])).toBe(0);
  });
});

describe('generationLock: one GPU, nobody else on it', () => {
  it('is clear when only Ollama and this process are present', () => {
    expect(generationLock([{ pid: 50, name: '/usr/local/bin/ollama', usedMiB: 9000 }], ['  900 /usr/bin/ollama serve', ' 1000 node gen-bench.ts'], [1000, 999])).toEqual([]);
  });
  it('refuses for a foreign GPU compute process and for a generation process in ps, naming each, killing nothing', () => {
    const why = generationLock([{ pid: 777, name: 'python', usedMiB: 5000 }], ['  778 /home/x/gen/bin/sd-vulkan/sd-cli -M vid_gen', '  779 colmap feature_extractor'], [1000]);
    expect(why).toHaveLength(3);
    expect(why.join('\n')).toMatch(/python/);
    expect(why.join('\n')).toMatch(/sd-cli/);
    expect(why.join('\n')).toMatch(/colmap/);
  });
  it('does not mistake its own ancestors (npm, tsx) for another job', () => {
    expect(generationLock([], ['  500 npm run bench:gen -- --stage=image', ' 501 node tsx gen-bench.ts'], [500, 501])).toEqual([]);
  });
});

// ── Tasks and the refactor that must not change the default run ──────────────

describe('bench tasks', () => {
  it('every stage has at least 4 synthetic briefs and a checklist or expectation for each', () => {
    for (const set of [IMAGE_BRIEFS, VIDEO_BRIEFS, SPLAT_BRIEFS]) expect(set.length).toBeGreaterThanOrEqual(4);
    for (const b of IMAGE_BRIEFS) expect(b.checklist.length).toBeGreaterThanOrEqual(4);
    expect(new Set(SEEDS).size).toBe(SEEDS.length);
  });
  it('video and splat briefs name an image brief that exists', () => {
    const slugs = new Set(IMAGE_BRIEFS.map((b) => b.slug));
    for (const b of [...VIDEO_BRIEFS, ...SPLAT_BRIEFS]) expect(slugs.has(b.sourceImage)).toBe(true);
  });
});

describe('gen-assets.ts refactor: the default model sets and outputs are unchanged', () => {
  it('names the incumbent per stage as before', () => {
    expect(MODELS.image.map((m) => m.path)).toEqual(['zimage/z_image_turbo-Q8_0.gguf', 'zimage/Qwen3-4B-Instruct-2507-Q8_0.gguf', 'zimage/ae.safetensors']);
    expect(MODELS.image.map((m) => m.role)).toEqual(['diffusion', 'text encoder', 'vae']);
    expect(MODELS.video.map((m) => m.path)).toEqual(['wan22/Wan2.2-TI2V-5B-Q8_0.gguf', 'wan22/umt5-xxl-encoder-Q8_0.gguf', 'wan22/Wan2.2_VAE.safetensors']);
    expect(MODELS.splat).toHaveLength(6);
    expect(OUTPUTS).toEqual({ image: 'image.webp', video: 'video.webm', splat: 'splat.ply' });
  });
});
