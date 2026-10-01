/**
 * GPU START GATE — the worker does not start a GPU job onto a GPU that is full, hot or in use (F74.7).
 *
 * Matt, 2026-09-30, watching ~50% GPU and most VRAM in use: "let's ensure protections are there for
 * over-utilization." The gate is checked before STARTING each GPU job (script-tier jobs skip it).
 * It FAILS CLOSED: if nvidia-smi is missing or errors, GPU state is UNKNOWN and no GPU job starts.
 *
 * Limits (defaults in scripts/agent/defaults/device-defaults.ttl as startVramPct / startTempC /
 * startOtherUtilPct; override per machine in the private ~/.config/reckons/device.ttl): VRAM used >= 90%, temperature >= 83 C, utilization >= 80% that is not
 * Ollama's own.
 *
 * WEAKNESSES, said out loud:
 *  - Utilization is per GPU but nvidia-smi's compute-apps list names no GPU, so "other processes" is
 *    approximated: utilization at or over the limit counts as the owner's own use UNLESS every
 *    compute process listed is Ollama. A game is a graphics process and may not appear in the compute
 *    list at all; its load is then unattributed, which counts as "other" (blocks), on purpose.
 *  - VRAM is read raw, so a model Ollama itself still holds (it unloads after its keep-alive) can
 *    pause the next job for a few minutes. It cannot deadlock: the hold ends when the model unloads.
 *  - Non-Ollama memory is summed over all GPUs (the process list names no GPU) and a container's process
 *    may be listed under a name that is not recognizable; any non-"ollama" name counts as foreign (blocks).
 *  - A single reading is a sample; it can pass a moment before a game launches.
 */
import { execFile } from 'node:child_process';
import { loadDeviceConfig, type ThresholdOverride } from './device-config.js';

export type Gpu = { index: number; util: number; usedMiB: number; totalMiB: number; tempC: number };
export type ComputeApp = { pid: number; name: string; usedMiB: number };
export type GpuLimits = { vramPct: number; tempC: number; otherUtilPct: number; foreignVramMiB: number };
export const DEFAULT_GPU_LIMITS: GpuLimits = { vramPct: 90, tempC: 83, otherUtilPct: 80, foreignVramMiB: 4096 };

export const GPU_QUERY = ['--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'];
export const APPS_QUERY = ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'];

const lines = (csv: string): string[] => csv.split('\n').map((l) => l.trim()).filter(Boolean);

/** null when any row is malformed (unknown, not empty). "[N/A]" fields are malformed. Pure. */
export function parseGpus(csv: string): Gpu[] | null {
  const rows = lines(csv);
  if (rows.length === 0) return null;
  const out: Gpu[] = [];
  for (const r of rows) {
    const [index, util, used, total, temp] = r.split(',').map((x) => Number(x.trim()));
    if ([index, util, used, total, temp].some((n) => !Number.isFinite(n)) || total <= 0) return null;
    out.push({ index, util, usedMiB: used, totalMiB: total, tempC: temp });
  }
  return out;
}

/** An empty result is a real answer (nothing computing); a malformed row is null. Pure. */
export function parseApps(csv: string): ComputeApp[] | null {
  const out: ComputeApp[] = [];
  for (const r of lines(csv)) {
    const parts = r.split(',').map((x) => x.trim());
    const used = Number(parts[parts.length - 1]);
    const pid = Number(parts[0]);
    if (parts.length < 3 || !Number.isFinite(pid) || !Number.isFinite(used)) return null;
    out.push({ pid, name: parts.slice(1, -1).join(','), usedMiB: used });
  }
  return out;
}

export const isOllamaProcess = (a: ComputeApp): boolean => /ollama/i.test(a.name);

const LIMIT_METRIC: Record<keyof GpuLimits, string> = { vramPct: 'startVramPct', tempC: 'startTempC', otherUtilPct: 'startOtherUtilPct', foreignVramMiB: 'startForeignVramMiB' };

/** Limits from resolved threshold statements (metric -> {limit}); anything not a finite number keeps the default. Pure. */
export function mergeGpuLimits(over: Record<string, ThresholdOverride> | undefined, base: GpuLimits = DEFAULT_GPU_LIMITS): GpuLimits {
  const out = { ...base };
  for (const k of Object.keys(out) as (keyof GpuLimits)[]) {
    const v = over?.[LIMIT_METRIC[k]]?.limit;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function loadGpuLimits(): GpuLimits {
  try { return mergeGpuLimits(loadDeviceConfig().thresholds); } catch { return mergeGpuLimits(undefined); }
}

export type GpuVerdict = { ok: true } | { ok: false; kind: 'unknown' | 'full' | 'hot' | 'busy'; reason: string };

/**
 * May a GPU job start? `gpus` null = nvidia-smi missing or unreadable -> unknown -> no. `apps` null
 * (the process list failed) is treated as "cannot show the load is Ollama's", so high utilization
 * blocks. Pure.
 */
export function gpuVerdict(gpus: Gpu[] | null, apps: ComputeApp[] | null, limits: GpuLimits = DEFAULT_GPU_LIMITS): GpuVerdict {
  if (!gpus) return { ok: false, kind: 'unknown', reason: 'GPU state unknown (nvidia-smi missing or failed) — GPU jobs held' };
  for (const g of gpus) {
    const pct = (g.usedMiB / g.totalMiB) * 100;
    if (pct >= limits.vramPct) return { ok: false, kind: 'full', reason: `GPU ${g.index} VRAM ${Math.round(pct)}% >= ${limits.vramPct}%` };
    if (g.tempC >= limits.tempC) return { ok: false, kind: 'hot', reason: `GPU ${g.index} at ${g.tempC} C >= ${limits.tempC} C` };
  }
  // Memory held by non-Ollama compute processes (e.g. a WebODM container). The per-GPU percent check
  // misses this when the load is spread over several GPUs (2026-10-01: ~23 GB of 48 GB held, each GPU
  // under 90%, then a 24 GB model was loaded and Ollama crashed with "CUDA illegal memory access").
  // The process list names no GPU, so this sums across GPUs. An unreadable list (apps null) is not
  // blocked here: raw VRAM above still covers the full case, and unknown-list + load blocks below.
  const foreignMiB = (apps ?? []).filter((a) => !isOllamaProcess(a)).reduce((n, a) => n + a.usedMiB, 0);
  if (foreignMiB >= limits.foreignVramMiB) return { ok: false, kind: 'busy', reason: `non-Ollama GPU processes hold ${Math.round(foreignMiB)} MiB >= ${limits.foreignVramMiB} MiB` };
  const loaded = gpus.find((g) => g.util >= limits.otherUtilPct);
  if (loaded) {
    const onlyOllama = apps !== null && apps.length > 0 && apps.every(isOllamaProcess);
    if (!onlyOllama) return { ok: false, kind: 'busy', reason: `GPU ${loaded.index} ${loaded.util}% busy and not only Ollama's` };
  }
  return { ok: true };
}

const smi = (args: string[]): Promise<string | null> =>
  new Promise((resolve) => execFile('nvidia-smi', args, { timeout: 5000, encoding: 'utf8' }, (err, out) => resolve(err ? null : out)));

/** Reads nvidia-smi (execFile, no shell) and decides. Never throws. */
export async function readGpuVerdict(limits: GpuLimits = loadGpuLimits()): Promise<GpuVerdict> {
  const g = await smi(GPU_QUERY);
  const gpus = g === null ? null : parseGpus(g);
  if (!gpus) return gpuVerdict(null, null, limits);
  const a = await smi(APPS_QUERY);
  return gpuVerdict(gpus, a === null ? null : parseApps(a), limits);
}
