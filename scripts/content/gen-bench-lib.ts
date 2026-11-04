/**
 * The pure parts of the generation-model bench (F183.1 / kb:gen-model-bench): candidate screening,
 * the upgrade decision rule, and the quality metrics that need no judge. Nothing here touches the
 * network, the GPU or the disk, so every rule is unit-tested without any of them.
 *
 * THE DECISION RULE IS THE POINT. A benchmark that cannot say "hold" is advertising. An upgrade is
 * proposed only when the candidate (1) passes every hard check the incumbent passes, (2) beats the
 * incumbent on quality by MORE than the incumbent's own seed-to-seed spread — otherwise the
 * difference is what you get from re-rolling the dice — and (3) stays inside the cost budget.
 * Downloads and likes order the discovery list; they are never evidence of quality.
 */
import type { HFRawModel } from '../../tests/visual/hf-model-query.js';

export type GenStage = 'image' | 'video' | 'splat';

// ── Discovery: licence, format, size ─────────────────────────────────────────

/**
 * Hugging Face licence ids a candidate may carry, as an allowlist of exact ids. Permissive software
 * and data licences: Apache-2.0, MIT and BSD (the incumbents are Apache-2.0 and MIT), ISC (MIT in
 * all but name), the public-domain dedications CC0-1.0 and Unlicense, and, since F183.2, CC BY 4.0
 * (permissive on condition of attribution; see licensePolicy). NOT on the list, on purpose:
 * "other" (where Qwen-research and FLUX.1-dev style terms hide), the OpenRAIL family and
 * creativeml-openrail (use restrictions that travel with the weights), and every -nc and -nd variant.
 * cc-by-sa is handled by licensePolicy, not by this list. A licence outside the rules ends a
 * candidate before download (kb:gen-model-bench constraint). Licence tags are the uploader's claim;
 * this is a screen from a desk reading, not legal advice (kb:gen-bench-in-graph).
 */
export const LICENSE_ALLOWLIST = ['apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'bsd', 'isc', 'cc0-1.0', 'unlicense', 'cc-by-4.0'];

export interface LicenseVerdict {
  allowed: boolean;
  /** Plain-language reason (the drop reason when not allowed). */
  reason: string;
  /** Licences that only permit use if credit travels with the output (CC BY). */
  attributionRequired: boolean;
  /** Set for share-alike (copyleft) licences: allowed only when the caller records the flag. */
  flag: 'share-alike' | null;
}

/**
 * The licence rule (Matt, 2026-10-14: Creative Commons is permissive; researched against MIT):
 * allow cc-by-4.0 (attribution required) and cc0-1.0; deny anything non-commercial (-nc) or
 * no-derivatives (-nd); allow share-alike (-sa) ONLY when `allowShareAlike` is set, which is the
 * recorded flag, and mark it. Everything else must be on LICENSE_ALLOWLIST.
 */
export function licensePolicy(license: string | null | undefined, opts: { allowShareAlike?: boolean } = {}): LicenseVerdict {
  const no = (reason: string): LicenseVerdict => ({ allowed: false, reason, attributionRequired: false, flag: null });
  if (!license) return no('no licence declared');
  const l = license.toLowerCase();
  if (/(^|-)n[cd](-|$)/.test(l)) return no(`licence "${license}" restricts commercial use or derivatives, so it is not permissive`);
  if (/^cc-by-sa(-|$)/.test(l)) {
    return opts.allowShareAlike
      ? { allowed: true, reason: `licence "${license}" is share-alike (copyleft); allowed because the share-alike flag was recorded`, attributionRequired: true, flag: 'share-alike' }
      : { allowed: false, reason: `licence "${license}" is share-alike (copyleft) and needs an explicit recorded flag to be allowed`, attributionRequired: true, flag: 'share-alike' };
  }
  if (!LICENSE_ALLOWLIST.includes(l)) return no(`licence "${license}" is not on the allowlist (${LICENSE_ALLOWLIST.join(', ')})`);
  return { allowed: true, reason: `licence "${license}" is on the allowlist`, attributionRequired: l.startsWith('cc-by'), flag: null };
}

const CC_URLS: Record<string, string> = {
  'cc-by-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'cc-by-sa-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
};

/**
 * The text a CC BY model requires to accompany what it produced or was benchmarked as: credit to
 * the source, a link to the licence, and an indication that changes were made. Empty when the
 * licence needs none. `changes` should say what WE did (for example "re-quantised weights, run
 * through stable-diffusion.cpp"), because CC BY asks for an indication of changes.
 */
export function attributionFor(repo: string, license: string | null | undefined, changes = 'weights were loaded as published and run unmodified by Reckons.AI'): string {
  const v = licensePolicy(license, { allowShareAlike: true });
  if (!license || !v.attributionRequired) return '';
  const url = CC_URLS[license.toLowerCase()] ?? 'https://creativecommons.org/licenses/';
  return `Model "${repo}" (https://huggingface.co/${repo}), licensed ${license.toUpperCase()} (${url}). Changes: ${changes}.`;
}

const GiB = 1024 ** 3;

export interface StageSpec {
  pipelineTag: string;
  /** Hugging Face tag filter for the listing query. */
  tagFilter?: string;
  /** File extensions the stage's runtime loads. */
  extensions: string[];
  /** The runtime this stage uses, in words, for the reason text. */
  runtime: string;
  /** A repo or its tags/arch must match one of these, or there is no evidence the runtime loads it. */
  families: RegExp;
  /** Tag that is itself the evidence (the repo advertises the runtime). */
  runtimeTag?: string;
  /** Largest single weight file that leaves room on one 24 GB GPU for encoder, VAE and activations. */
  maxFileBytes: number;
  /** base_model of the incumbent: a candidate quantised/finetuned from it is a drop-in. */
  dropInBase: string;
  /** Repositories the incumbent already uses (lowercase). */
  incumbentRepos: string[];
}

export const STAGE_SPECS: Record<GenStage, StageSpec> = {
  image: {
    pipelineTag: 'text-to-image', tagFilter: 'gguf', extensions: ['.gguf'], runtime: 'stable-diffusion.cpp',
    families: /z[-_ ]?image|flux|sd3|sdxl|stable[-_ ]?diffusion|qwen[-_ ]?image|chroma|hidream|lumina|anima|ovis/i,
    runtimeTag: 'stable-diffusion.cpp',
    // Incumbent diffusion file is 6.6 GB at Q8; encoder 4.3 GB; VAE 0.3 GB. 16 GiB leaves ~6 GiB for activations.
    maxFileBytes: 16 * GiB, dropInBase: 'tongyi-mai/z-image-turbo',
    incumbentRepos: ['leejet/z-image-turbo-gguf', 'unsloth/qwen3-4b-instruct-2507-gguf', 'comfy-org/z_image_turbo'],
  },
  video: {
    pipelineTag: 'image-to-video', tagFilter: 'gguf', extensions: ['.gguf'], runtime: 'stable-diffusion.cpp (vid_gen)',
    families: /wan/i, runtimeTag: 'stable-diffusion.cpp',
    maxFileBytes: 14 * GiB, dropInBase: 'wan-ai/wan2.2-ti2v-5b',
    incumbentRepos: ['quantstack/wan2.2-ti2v-5b-gguf', 'city96/umt5-xxl-encoder-gguf'],
  },
  splat: {
    pipelineTag: 'image-to-3d', extensions: ['.safetensors'], runtime: 'TripoSplat (scripts/content/triposplat_run.py)',
    // The splat runner is TripoSplat-specific code; no other architecture has a loader here.
    families: /triposplat/i,
    maxFileBytes: 12 * GiB, dropInBase: 'vast-ai/triposplat',
    incumbentRepos: ['vast-ai/triposplat'],
  },
};

/** Words in a repo id that say it is a piece of a model, not a model. */
const NOT_A_MODEL = /lora|controlnet|adapter|\bvae\b|encoder|clip|mmproj|upscal|embedding|ip-adapter/i;
/**
 * Repositories whose own name says the weights are unfiltered or adult. The project's content policy
 * (src/lib/safety/content-policy.ts) is not something a bench should route around by picking the
 * model that ignores it, and generated assets ship in a public example space.
 */
const UNFILTERED = /uncensor|abliterat|nsfw|porn|nude|hentai|lewd|erotic|\bxxx\b/i;
const NOT_DIFFUSION_FILE = /mmproj|vae|clip|t5|umt5|encoder|qwen3-4b|text[-_]?enc|\bllm\b/i;

export function licenseOf(m: HFRawModel): string | null {
  const fromCard = m.cardData?.license;
  if (typeof fromCard === 'string' && fromCard) return fromCard.toLowerCase();
  const tag = (m.tags ?? []).find((t) => t.startsWith('license:'));
  return tag ? tag.slice('license:'.length).toLowerCase() : null;
}

export interface Screening {
  repo: string;
  kept: boolean;
  /** Why it was kept or dropped. Always non-empty. */
  reasons: string[];
  license: string | null;
  incumbent: boolean;
  file?: { name: string; bytes: number };
  /** True when the architecture differs from the incumbent: needs a recipe naming its encoder and VAE. */
  needsRecipe: boolean;
  /** True when the listing carried no file sizes, so size could not be judged yet. */
  needsFiles: boolean;
  downloads: number; likes: number; lastModified: string | null;
}

/**
 * Judge one repository for one stage. Pass the listing entry for a first screen (licence, runtime
 * evidence) or the full `?blobs=true` info (adds the size/format screen). First failing reason wins,
 * and is the only reason given for a drop, so the report reads as a funnel.
 */
export function screenCandidate(m: HFRawModel, stage: GenStage, spec: StageSpec = STAGE_SPECS[stage]): Screening {
  const repo = m.id;
  const lower = repo.toLowerCase();
  const license = licenseOf(m);
  const base: Screening = {
    repo, kept: false, reasons: [], license, incumbent: spec.incumbentRepos.includes(lower), needsRecipe: false, needsFiles: false,
    downloads: m.downloads ?? 0, likes: m.likes ?? 0, lastModified: m.lastModified ?? null,
  };
  const drop = (why: string): Screening => ({ ...base, kept: false, reasons: [why] });

  if (base.incumbent) return drop('this is an incumbent repository: handled by the revision check, not as a candidate');
  if (m.private) return drop('private repository');
  if (m.gated) return drop('gated: downloading needs an account agreement');
  if (!license) return drop('no licence declared');
  const lp = licensePolicy(license);
  if (!lp.allowed) return drop(lp.reason);
  if (UNFILTERED.test(`${lower} ${(m.tags ?? []).join(' ')}`)) return drop('name or tags say the weights are unfiltered or adult: outside the content policy for a public example space');
  if (NOT_A_MODEL.test(lower)) return drop('looks like an adapter, encoder or VAE, not a full model');

  const tags = (m.tags ?? []).map((t) => t.toLowerCase());
  const arch = m.gguf?.architecture ?? '';
  const evidence = (spec.runtimeTag && tags.includes(spec.runtimeTag)) || spec.families.test(`${repo} ${arch} ${tags.join(' ')}`);
  if (!evidence) return drop(`no evidence ${spec.runtime} loads this architecture${arch ? ` (${arch})` : ''}`);
  // A tag alone is not proof for the splat runner, whose loader is one architecture's code.
  if (stage === 'splat' && !spec.families.test(repo)) return drop(`${spec.runtime} loads one architecture only`);

  const hasFormatTag = spec.extensions.includes('.gguf') ? tags.includes('gguf') || !!m.gguf : tags.includes('safetensors');
  if (!m.siblings) {
    if (!hasFormatTag) return drop(`no ${spec.extensions.join('/')} files advertised (tags)`);
    return { ...base, kept: true, needsFiles: true, reasons: ['passes licence and runtime screens; file sizes not fetched yet'], needsRecipe: !isDropIn(m, spec) };
  }
  const files = m.siblings.filter((s) => spec.extensions.some((e) => s.rfilename.toLowerCase().endsWith(e)) && !NOT_DIFFUSION_FILE.test(s.rfilename));
  if (!files.length) return drop(`no ${spec.extensions.join('/')} weight file in the repository`);
  const fits = files.filter((s) => (s.size ?? 0) > 0 && (s.size ?? 0) <= spec.maxFileBytes);
  if (!fits.length) {
    const smallest = Math.min(...files.map((f) => f.size ?? Infinity));
    return drop(`smallest weight file is ${(smallest / GiB).toFixed(1)} GiB, over the ${(spec.maxFileBytes / GiB).toFixed(0)} GiB cap for one 24 GB GPU`);
  }
  // Largest file that fits: the highest-fidelity quantisation the budget allows.
  const pick = fits.reduce((a, b) => ((b.size ?? 0) > (a.size ?? 0) ? b : a));
  const needsRecipe = !isDropIn(m, spec);
  return {
    ...base, kept: true, file: { name: pick.rfilename, bytes: pick.size ?? 0 }, needsRecipe,
    reasons: [`licence ${license}; ${spec.runtime} evidence; ${pick.rfilename} is ${((pick.size ?? 0) / GiB).toFixed(1)} GiB`
      + (needsRecipe ? '; different architecture from the incumbent, so it needs a recipe (its own encoder and VAE) before it can run' : '; same base model as the incumbent: drop-in for the diffusion file')],
  };
}

export function isDropIn(m: HFRawModel, spec: StageSpec): boolean {
  const base = m.cardData?.base_model;
  const bases = (Array.isArray(base) ? base : base ? [base] : []).map((b) => String(b).toLowerCase());
  const fromTags = (m.tags ?? []).filter((t) => t.startsWith('base_model:')).map((t) => t.replace(/^base_model:(\w+:)?/, '').toLowerCase());
  return [...bases, ...fromTags].some((b) => b === spec.dropInBase);
}

/**
 * Discovery order only: drop-ins first (they can run today), then most recently updated, then
 * downloads. Never a quality claim.
 */
export function rankForDiscovery(items: Screening[]): Screening[] {
  return [...items].sort((a, b) => Number(a.needsRecipe) - Number(b.needsRecipe)
    || (b.lastModified ?? '').localeCompare(a.lastModified ?? '') || b.downloads - a.downloads);
}

/** Re-uploads of one file under many names: keep the most downloaded, say how many were folded in. */
export function dedupeByFile(items: Screening[]): { kept: Screening[]; folded: Screening[] } {
  const best = new Map<string, Screening>();
  const folded: Screening[] = [];
  for (const it of items) {
    const k = it.file ? `${it.file.name.split('/').pop()}|${it.file.bytes}` : it.repo;
    const cur = best.get(k);
    if (!cur) { best.set(k, it); continue; }
    const [win, lose] = it.downloads > cur.downloads ? [it, cur] : [cur, it];
    best.set(k, { ...win, reasons: [...win.reasons, `(${lose.repo} is a re-upload of the same file and was folded in)`] });
    folded.push({ ...lose, kept: false, reasons: [`same file as ${win.repo} (name and byte size)`] });
  }
  return { kept: [...best.values()], folded };
}

// ── Incumbent revision check ─────────────────────────────────────────────────

export interface RecordedModel { file: string; sha256: string; source: string }
export type RevisionStatus = 'unchanged' | 'changed-upstream' | 'not-in-repo' | 'unreachable';
export interface RevisionResult {
  file: string; repo: string; status: RevisionStatus; detail: string;
  repoSha: string | null; repoLastModified: string | null;
}

export function repoOfSource(source: string): string | null {
  const m = /huggingface\.co\/([^/]+\/[^/?#]+)/.exec(source);
  return m ? m[1] : null;
}

/**
 * Compare what a receipt recorded (file SHA-256) with what the repository serves now. The receipts
 * do not record the repository commit, so the exact test is the file's LFS hash: equal means the
 * weights are byte-identical, whatever the commit. `info` null = the API could not be reached.
 */
export function compareRevision(rec: RecordedModel, info: HFRawModel | null, receiptRanAt?: string): RevisionResult {
  const repo = repoOfSource(rec.source) ?? rec.source;
  const out = (status: RevisionStatus, detail: string): RevisionResult =>
    ({ file: rec.file, repo, status, detail, repoSha: info?.sha ?? null, repoLastModified: info?.lastModified ?? null });
  if (!info) return out('unreachable', 'Hugging Face API did not answer; revision unknown');
  const sib = info.siblings?.find((s) => s.rfilename.split('/').pop() === rec.file);
  if (!sib) return out('not-in-repo', `${rec.file} is no longer in ${repo} (renamed or removed); revision unknown`);
  if (!sib.lfs) return out('unreachable', `${rec.file} has no LFS hash in the listing`);
  if (sib.lfs.sha256 === rec.sha256) {
    const newer = receiptRanAt && info.lastModified && info.lastModified > receiptRanAt;
    return out('unchanged', `weights byte-identical to the receipt${newer ? ` (repo has newer commits, ${info.lastModified?.slice(0, 10)}, that do not touch this file)` : ''}`);
  }
  return out('changed-upstream', `${rec.file} differs: receipt ${rec.sha256.slice(0, 12)}, now ${sib.lfs.sha256.slice(0, 12)} (repo updated ${info.lastModified?.slice(0, 10) ?? '?'})`);
}

// ── The decision rule ────────────────────────────────────────────────────────

export interface BenchRun {
  brief: string; seed: number;
  /** Did every hard check in asset-checks.ts pass (and did generation finish)? */
  hardPass: boolean;
  /** 0..1, or null when no judgement was possible (judge down). */
  quality: number | null;
  seconds: number;
  /** Peak GPU memory above the pre-run baseline, MiB; null if it could not be measured. */
  peakVramMiB: number | null;
  bytes: number;
}
export interface Arm { id: string; license: string | null; runs: BenchRun[] }
export interface Budget {
  /** Candidate mean seconds per run / incumbent's. */
  maxTimeRatio: number;
  /** Largest acceptable peak VRAM, MiB (one 24 GB card, with headroom). */
  maxVramMiB: number;
  /** Floor on the quality gain even when the incumbent's spread is zero. */
  minMargin: number;
  /** Seeds per brief the incumbent needs for a spread to mean anything. */
  minSeeds: number;
  /** Incumbent mean quality at or above this leaves no headroom to show an improvement. */
  ceiling: number;
  /** The recorded flag that lets a share-alike (copyleft) licence through. */
  allowShareAlike: boolean;
}
export const DEFAULT_BUDGET: Budget = { maxTimeRatio: 1.5, maxVramMiB: 22 * 1024, minMargin: 0.02, minSeeds: 2, ceiling: 0.95, allowShareAlike: false };

export type Verdict = 'upgrade' | 'hold' | 'insufficient-evidence';
export interface Decision {
  verdict: Verdict;
  reasons: string[];
  numbers: {
    incumbentQuality: number | null; candidateQuality: number | null; delta: number | null;
    incumbentSpread: number | null; timeRatio: number | null; candidatePeakVramMiB: number | null; hardRegressions: string[];
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const key = (r: BenchRun) => `${r.brief}#${r.seed}`;

/** Mean quality per seed (over briefs): the replicates the spread is measured across. */
export function perSeedQuality(runs: BenchRun[]): Map<number, number> {
  const by = new Map<number, number[]>();
  for (const r of runs) if (r.quality !== null) by.set(r.seed, [...(by.get(r.seed) ?? []), r.quality]);
  return new Map([...by].map(([s, q]) => [s, mean(q)]));
}

export function decide(inc: Arm, cand: Arm, budget: Budget = DEFAULT_BUDGET): Decision {
  const numbers: Decision['numbers'] = {
    incumbentQuality: null, candidateQuality: null, delta: null, incumbentSpread: null, timeRatio: null, candidatePeakVramMiB: null, hardRegressions: [],
  };
  const insufficient = (why: string[]): Decision => ({ verdict: 'insufficient-evidence', reasons: why, numbers });
  const problems: string[] = [];

  const seeds = new Set(inc.runs.map((r) => r.seed));
  if (!inc.runs.length) problems.push('the incumbent has no runs');
  if (seeds.size < budget.minSeeds) problems.push(`the incumbent has ${seeds.size} seed(s); its seed-to-seed spread needs at least ${budget.minSeeds}`);
  const candKeys = new Set(cand.runs.map(key));
  const missing = inc.runs.filter((r) => !candKeys.has(key(r)));
  if (missing.length) problems.push(`the candidate has no run for ${missing.length} of the incumbent's ${inc.runs.length} brief×seed pairs`);
  if (inc.runs.some((r) => r.quality === null) || cand.runs.some((r) => r.quality === null)) problems.push('some runs have no quality score (judge unavailable or the output was unreadable)');
  if (problems.length) return insufficient(problems);

  // Found on the first real run (2026-10-14): 28 of 30 images scored a perfect checklist, so a 0.027
  // 'gain' was two judge answers. A benchmark with no headroom cannot say a candidate is better.
  numbers.incumbentQuality = mean([...perSeedQuality(inc.runs).values()]);
  if (numbers.incumbentQuality >= budget.ceiling) {
    numbers.candidateQuality = mean([...perSeedQuality(cand.runs).values()]);
    numbers.delta = numbers.candidateQuality - numbers.incumbentQuality;
    return insufficient([`the incumbent already scores ${fmt(numbers.incumbentQuality)} (ceiling ${budget.ceiling}): the briefs have no headroom to show an improvement, so a gain of ${fmt(numbers.delta)} is a few judge answers, not evidence. Harder briefs are needed.`]);
  }
  // 1. Hard checks: nothing the incumbent passes may be failed by the candidate.
  const candByKey = new Map(cand.runs.map((r) => [key(r), r]));
  numbers.hardRegressions = inc.runs.filter((r) => r.hardPass && !candByKey.get(key(r))!.hardPass).map(key);
  // 2. Quality against the incumbent's own spread.
  const incSeeds = [...perSeedQuality(inc.runs).values()];
  const candSeeds = [...perSeedQuality(cand.runs).values()];
  numbers.incumbentQuality = mean(incSeeds);
  numbers.candidateQuality = mean(candSeeds);
  numbers.delta = numbers.candidateQuality - numbers.incumbentQuality;
  numbers.incumbentSpread = Math.max(...incSeeds) - Math.min(...incSeeds);
  // 3. Cost.
  const incSec = mean(inc.runs.map((r) => r.seconds));
  numbers.timeRatio = incSec > 0 ? mean(cand.runs.map((r) => r.seconds)) / incSec : null;
  const peaks = cand.runs.map((r) => r.peakVramMiB).filter((v): v is number => v !== null);
  numbers.candidatePeakVramMiB = peaks.length ? Math.max(...peaks) : null;

  const why: string[] = [];
  if (numbers.hardRegressions.length) why.push(`fails hard check(s) the incumbent passes: ${numbers.hardRegressions.join(', ')}`);
  const lp = licensePolicy(cand.license, { allowShareAlike: budget.allowShareAlike });
  if (!lp.allowed) why.push(`licence "${cand.license ?? 'unknown'}" is not on the allowlist: ${lp.reason}`);
  const need = Math.max(numbers.incumbentSpread, budget.minMargin);
  if (!(numbers.delta > numbers.incumbentSpread && numbers.delta >= budget.minMargin)) {
    why.push(`quality gain ${fmt(numbers.delta)} does not exceed the incumbent's own seed spread ${fmt(numbers.incumbentSpread)}`
      + (budget.minMargin > numbers.incumbentSpread ? ` (floor ${fmt(budget.minMargin)})` : '') + ` (needs more than ${fmt(need)})`);
  }
  if (numbers.timeRatio === null) why.push('incumbent time is zero; cost ratio undefined');
  else if (numbers.timeRatio > budget.maxTimeRatio) why.push(`${numbers.timeRatio.toFixed(2)}x the incumbent's time exceeds the ${budget.maxTimeRatio}x budget`);
  if (numbers.candidatePeakVramMiB !== null && numbers.candidatePeakVramMiB > budget.maxVramMiB) why.push(`peak VRAM ${numbers.candidatePeakVramMiB} MiB exceeds the ${budget.maxVramMiB} MiB budget`);
  if (numbers.candidatePeakVramMiB === null) return insufficient(['peak VRAM was not measured for the candidate, so the cost budget cannot be checked', ...why]);

  return why.length ? { verdict: 'hold', reasons: why, numbers }
    : { verdict: 'upgrade', reasons: [`beats the incumbent by ${fmt(numbers.delta)} (spread ${fmt(numbers.incumbentSpread)}), passes every hard check, within budget`], numbers };
}
const fmt = (n: number) => n.toFixed(3);

// ── Video metrics (pure over decoded frames) ─────────────────────────────────

/** Mean absolute difference of two equal-length 0..255 buffers, scaled to 0..1. */
export function mad(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n / 255;
}

export interface VideoQuality {
  /** Mean change between consecutive frames, 0..1. Zero is a still image. */
  motion: number;
  /** Mean second difference |f[i+1] - 2 f[i] + f[i-1]|, 0..1. Smooth motion is ~0; popping and strobing is large. */
  flicker: number;
  /** 1 - mean absolute difference between the clip's first frame and the source image. 1 is identical. */
  firstFrameSimilarity: number;
}

export function videoQuality(frames: Uint8Array[], source: Uint8Array): VideoQuality {
  if (frames.length < 2) return { motion: 0, flicker: 0, firstFrameSimilarity: frames.length ? 1 - mad(frames[0], source) : 0 };
  let motion = 0;
  for (let i = 1; i < frames.length; i++) motion += mad(frames[i], frames[i - 1]);
  motion /= frames.length - 1;
  let flicker = 0;
  let n = 0;
  for (let i = 1; i < frames.length - 1; i++) {
    let s = 0;
    const [p, c, q] = [frames[i - 1], frames[i], frames[i + 1]];
    for (let k = 0; k < c.length; k++) s += Math.abs(q[k] - 2 * c[k] + p[k]);
    flicker += s / c.length / 255;
    n++;
  }
  return { motion, flicker: n ? flicker / n : 0, firstFrameSimilarity: 1 - mad(frames[0], source) };
}

/**
 * One 0..1 number for the decision rule. A PROXY, and says so: equal weights on "it moves" (motion
 * saturating at 5%), "it does not strobe" (flicker saturating at 5%) and "it still looks like the
 * picture it started from". The weights are not calibrated against human preference; the receipt
 * keeps the three raw numbers so a human can disagree with the blend.
 */
export function videoScore(q: VideoQuality): number {
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return (clamp(q.motion / 0.05) + (1 - clamp(q.flicker / 0.05)) + clamp(q.firstFrameSimilarity)) / 3;
}

// ── Splat metrics (pure over the PLY bytes and a source-image mask) ──────────

export interface SplatPoints { count: number; xyz: Float32Array; visible: Uint8Array; finite: boolean }

/** Read x/y/z and the visibility of each Gaussian from a binary little-endian 3DGS PLY. */
export function readSplatPoints(bytes: Uint8Array): SplatPoints | null {
  const marker = new TextEncoder().encode('end_header\n');
  let end = -1;
  outer: for (let i = 0; i < Math.min(bytes.length - marker.length, 65536); i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    end = i + marker.length;
    break;
  }
  if (end < 0) return null;
  const header = new TextDecoder().decode(bytes.subarray(0, end)).split('\n').map((l) => l.trim());
  const count = Number(header.find((l) => l.startsWith('element vertex'))?.split(/\s+/)[2] ?? 0);
  const props = header.filter((l) => l.startsWith('property')).map((l) => l.split(/\s+/)[2]);
  if (!count || props.some((_, i) => header.filter((l) => l.startsWith('property'))[i].split(/\s+/)[1] !== 'float')) return null;
  const stride = props.length * 4;
  const [ix, iy, iz, io] = ['x', 'y', 'z', 'opacity'].map((n) => props.indexOf(n));
  if ([ix, iy, iz, io].some((i) => i < 0) || bytes.length - end < count * stride) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + end, count * stride);
  const xyz = new Float32Array(count * 3);
  const visible = new Uint8Array(count);
  let finite = true;
  for (let i = 0; i < count; i++) {
    const b = i * stride;
    for (let k = 0; k < 3; k++) { const v = view.getFloat32(b + [ix, iy, iz][k] * 4, true); xyz[i * 3 + k] = v; if (!Number.isFinite(v)) finite = false; }
    visible[i] = 1 / (1 + Math.exp(-view.getFloat32(b + io * 4, true))) > 0.05 ? 1 : 0;
  }
  return { count, xyz, visible, finite };
}

/** Foreground of a plain-background picture: pixels far from the median colour of the border. */
export function foregroundMask(rgb: Uint8Array, w: number, h: number, threshold = 40): Uint8Array {
  const border: number[][] = [[], [], []];
  const take = (x: number, y: number) => { for (let c = 0; c < 3; c++) border[c].push(rgb[(y * w + x) * 3 + c]); };
  for (let x = 0; x < w; x++) { take(x, 0); take(x, h - 1); }
  for (let y = 0; y < h; y++) { take(0, y); take(w - 1, y); }
  const med = border.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = Math.abs(rgb[i * 3] - med[0]) + Math.abs(rgb[i * 3 + 1] - med[1]) + Math.abs(rgb[i * 3 + 2] - med[2]);
    mask[i] = d > threshold ? 1 : 0;
  }
  return mask;
}

export interface SplatQuality {
  /** Extent along the viewing axis / extent across the picture, of the best-matching projection. */
  depthToWidth: number;
  /** Intersection over union of the projected silhouette and the source foreground, best of all viewing axes and flips. */
  silhouetteIoU: number;
  finite: boolean;
  visibleCount: number;
}

const pct = (sorted: Float32Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

/**
 * Orthographic point projection against the source image's foreground. The splat's coordinate
 * convention is not assumed: all three viewing axes, both orderings of the other two and every sign
 * flip are tried (24 configurations) and the best IoU is kept, which is applied to every arm alike
 * but does flatter all of them a little. Extents use the 1st to 99th percentile so a few stray
 * Gaussians do not decide the ratio. Points are stamped 3x3 on a 128 grid; Gaussian size is ignored.
 */
export function splatQuality(pts: SplatPoints, mask: Uint8Array, size = 128): SplatQuality {
  const idx: number[] = [];
  for (let i = 0; i < pts.count; i++) if (pts.visible[i] && Number.isFinite(pts.xyz[i * 3]) && Number.isFinite(pts.xyz[i * 3 + 1]) && Number.isFinite(pts.xyz[i * 3 + 2])) idx.push(i);
  if (idx.length < 10) return { depthToWidth: 0, silhouetteIoU: 0, finite: pts.finite, visibleCount: idx.length };
  const axisVals = [0, 1, 2].map((a) => Float32Array.from(idx, (i) => pts.xyz[i * 3 + a]));
  const range = axisVals.map((v) => { const s = Float32Array.from(v).sort(); return [pct(s, 0.01), pct(s, 0.99)] as const; });
  const extent = range.map(([lo, hi]) => hi - lo);
  // Foreground bounding box, to fit the projection into the same frame as the mask.
  let [mx0, my0, mx1, my1, fg] = [size, size, -1, -1, 0];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mask[y * size + x]) { fg++; mx0 = Math.min(mx0, x); mx1 = Math.max(mx1, x); my0 = Math.min(my0, y); my1 = Math.max(my1, y); }
  if (!fg) return { depthToWidth: 0, silhouetteIoU: 0, finite: pts.finite, visibleCount: idx.length };
  let best = { iou: -1, depth: 0, width: 1 };
  for (let view = 0; view < 3; view++) {
    const others = [0, 1, 2].filter((a) => a !== view);
    for (const swap of [false, true]) for (const fu of [1, -1]) for (const fv of [1, -1]) {
      const [au, av] = swap ? [others[1], others[0]] : [others[0], others[1]];
      const wU = extent[au], wV = extent[av];
      if (!(wU > 1e-6) || !(wV > 1e-6)) continue;
      const scale = Math.min((mx1 - mx0 + 1) / wU, (my1 - my0 + 1) / wV);
      const cx = (mx0 + mx1 + 1) / 2, cy = (my0 + my1 + 1) / 2;
      const grid = new Uint8Array(size * size);
      const midU = (range[au][0] + range[au][1]) / 2, midV = (range[av][0] + range[av][1]) / 2;
      for (let k = 0; k < idx.length; k++) {
        const px = Math.round(cx + fu * (axisVals[au][k] - midU) * scale);
        const py = Math.round(cy + fv * (axisVals[av][k] - midV) * scale);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const x = px + dx, y = py + dy;
          if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = 1;
        }
      }
      let inter = 0, uni = 0;
      for (let i = 0; i < size * size; i++) { if (grid[i] && mask[i]) inter++; if (grid[i] || mask[i]) uni++; }
      const iou = uni ? inter / uni : 0;
      if (iou > best.iou) best = { iou, depth: extent[view], width: wU };
    }
  }
  return { depthToWidth: best.depth / best.width, silhouetteIoU: Math.max(0, best.iou), finite: pts.finite, visibleCount: idx.length };
}

/** One 0..1 number: half silhouette agreement, half "has depth in the range the brief expects". */
export function splatScore(q: SplatQuality, expectDepth: [number, number]): number {
  const [lo, hi] = expectDepth;
  const depthOk = q.depthToWidth >= lo && q.depthToWidth <= hi ? 1 : q.depthToWidth < lo ? Math.max(0, q.depthToWidth / lo) : Math.max(0, hi / q.depthToWidth);
  return q.finite ? (q.silhouetteIoU + depthOk) / 2 : 0;
}

// ── Image judge answers ──────────────────────────────────────────────────────

/** YES/NO from a model's one-word answer; null = ambiguous (counted as not confirmed). */
export function parseYesNo(raw: string): boolean | null {
  const t = raw.toUpperCase().replace(/[^A-Z ]/g, ' ');
  const yes = /\bYES\b/.test(t);
  const no = /\bNO\b/.test(t);
  return yes && !no ? true : no && !yes ? false : null;
}

/** Fraction of checklist items confirmed. An ambiguous answer is NOT a confirmation. */
export function checklistScore(answers: (boolean | null)[]): number {
  return answers.length ? answers.filter((a) => a === true).length / answers.length : 0;
}

// ── The one-GPU lock ─────────────────────────────────────────────────────────

/** Processes that mean another generation job owns a GPU. Ollama is excluded: the bench uses it as its judge. */
export const GENERATION_PROCESS = /sd-cli|sd-vulkan|triposplat|colmap|\bbrush\b|gen-assets|gen-bench|stable-diffusion|ffmpeg.*(?:nvenc|cuda)/i;

/** The reasons the bench must not start, or [] when the machine is free. `ownPids` = this process and its ancestors (npm, tsx). Never a reason to kill anything. */
export function generationLock(apps: { pid: number; name: string; usedMiB: number }[], psLines: string[], ownPids: number[]): string[] {
  const reasons: string[] = [];
  for (const a of apps) if (!ownPids.includes(a.pid) && !/ollama/i.test(a.name)) reasons.push(`GPU compute process ${a.name} (pid ${a.pid}, ${a.usedMiB} MiB)`);
  for (const l of psLines) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    if (!m || ownPids.includes(Number(m[1])) || apps.some((a) => a.pid === Number(m[1]))) continue;
    if (GENERATION_PROCESS.test(m[2]) && !/gen-bench-lib|vitest|grep/.test(m[2])) reasons.push(`generation process pid ${m[1]}: ${m[2].slice(0, 80)}`);
  }
  return reasons;
}
