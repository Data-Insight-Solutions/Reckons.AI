/**
 * RAM GUARD: a queued local job must not push a model into system RAM (F74.11).
 *
 * WHY (2026-11-04, measured): Ollama 0.40.11 put a model on GPU 0, then started a llama-server
 * without its CUDA backend ("compiled without support for GPU offload"). So qwen3.8-160k, and
 * three minutes later qwen3-coder, loaded about 17 GB each into host RAM with mmap off. The second
 * load swapped the machine for five minutes and took the desktop session down. The GPU gate
 * (session-gpu.ts) saw two idle GPUs, because it reads only nvidia-smi.
 *
 * THREE CHECKS, limits in scripts/agent/defaults/device-defaults.ttl (ramStartAvailMiB,
 * ramFloorAvailMiB, ramSpillAnonMiB; override per machine in ~/.config/reckons/device.ttl):
 *  - START: a GPU job does not start while MemAvailable is under ramStartAvailMiB (default 6 GiB).
 *  - SPILL: while any job runs, the Ollama service's ANONYMOUS memory (memory.stat `anon` of its
 *    cgroup) over ramSpillAnonMiB (default 6 GiB) means weights were copied into RAM. The worker
 *    stops the job, unloads every model and pauses the queue. Anonymous memory is the right signal:
 *    a fully offloaded model keeps a few hundred MiB of host buffers, and a model too big for VRAM
 *    that Ollama memory-maps (gpt-oss:120b, CPU_Mapped 22 GB on 2026-11-04) is FILE memory that the
 *    kernel can drop and reload, so it is not a spill here.
 *  - FLOOR: while any job runs, MemAvailable under ramFloorAvailMiB (default 2 GiB) stops it,
 *    even a job that opted into spilling. That leaves room for the desktop.
 * A job queued with `--ram-spill` (QueueJob.ramSpill) skips SPILL only. Use it for a model that
 * cannot fit in VRAM when Ollama loads it without mmap.
 *
 * WEAKNESSES, said out loud:
 *  - Linux only. With no /proc/meminfo the START and FLOOR checks pass, and with no readable cgroup
 *    (Ollama not run as the systemd service ollama.service, or a different cgroup path) SPILL cannot
 *    see anything. RECKONS_OLLAMA_CGROUP overrides the path. An unknown reading is never a block, unlike
 *    the GPU gate, because the worker also runs on machines without either file.
 *  - It samples every few seconds. A spill fills RAM at roughly 0.45 GB/s (17 GB in 38 s), so a
 *    sample catches it around 6 to 8 GB, well before the 17 GB that froze the machine. A faster
 *    spill could get further.
 *  - Only the queue is guarded. A model loaded by hand, by the app, or by offline:all outside the
 *    worker is not watched. The systemd-oomd setting on ollama.service is the backstop for those.
 */
import { readFileSync } from 'node:fs';
import { loadDeviceConfig, type ThresholdOverride } from './device-config.js';

export type RamLimits = { startAvailMiB: number; floorAvailMiB: number; spillAnonMiB: number; hardAnonMiB: number };
export const DEFAULT_RAM_LIMITS: RamLimits = { startAvailMiB: 6144, floorAvailMiB: 2048, spillAnonMiB: 6144, hardAnonMiB: 12288 };

export type MemInfo = { totalMiB: number; availMiB: number };
export type RamSample = { mem: MemInfo | null; anonMiB: number | null };
export type RamVerdict = { ok: true } | { ok: false; kind: 'low' | 'spill' | 'floor'; reason: string };

const LIMIT_METRIC: Record<keyof RamLimits, string> = { startAvailMiB: 'ramStartAvailMiB', floorAvailMiB: 'ramFloorAvailMiB', spillAnonMiB: 'ramSpillAnonMiB', hardAnonMiB: 'ramHardAnonMiB' };

/** /proc/meminfo text -> total and available MiB; null when either line is missing. Pure. */
export function parseMeminfo(text: string): MemInfo | null {
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  return total === undefined || avail === undefined ? null : { totalMiB: total / 1024, availMiB: avail / 1024 };
}

/** A cgroup v2 memory.stat text -> its `anon` bytes as MiB; null when absent. Pure. */
export function parseAnonMiB(text: string): number | null {
  const m = /^anon (\d+)$/m.exec(text);
  return m ? Number(m[1]) / 1048576 : null;
}

/** Limits from resolved threshold statements; anything not a finite positive number keeps the default. Pure. */
export function mergeRamLimits(over: Record<string, ThresholdOverride> | undefined, base: RamLimits = DEFAULT_RAM_LIMITS): RamLimits {
  const out = { ...base };
  for (const k of Object.keys(out) as (keyof RamLimits)[]) {
    const v = over?.[LIMIT_METRIC[k]]?.limit;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

export function loadRamLimits(): RamLimits {
  try { return mergeRamLimits(loadDeviceConfig().thresholds); } catch { return mergeRamLimits(undefined); }
}

const gib = (mib: number): string => `${(mib / 1024).toFixed(1)} GiB`;

/** May a GPU job START? Unknown memory passes (see WEAKNESSES). Pure. */
export function ramStartVerdict(mem: MemInfo | null, limits: RamLimits = DEFAULT_RAM_LIMITS): RamVerdict {
  if (mem && mem.availMiB < limits.startAvailMiB) {
    return { ok: false, kind: 'low', reason: `system RAM available ${gib(mem.availMiB)} < ${gib(limits.startAvailMiB)}` };
  }
  return { ok: true };
}

/**
 * Where Ollama's loaded models live, from its own /api/ps: 'all-gpu' when every model's size_vram
 * covers its size, 'spilled' when any model holds part of itself in system RAM, 'unknown' when no
 * model is listed yet (still loading) or the answer is unreadable. Pure.
 */
export type GpuResidency = 'all-gpu' | 'spilled' | 'unknown';
export function residencyFromPs(ps: unknown): GpuResidency {
  const models = (ps as { models?: { size?: number; size_vram?: number }[] } | null)?.models;
  if (!Array.isArray(models) || models.length === 0) return 'unknown';
  if (models.some((m) => typeof m.size !== 'number' || typeof m.size_vram !== 'number')) return 'unknown';
  return models.every((m) => (m.size_vram as number) >= (m.size as number) * 0.98) ? 'all-gpu' : 'spilled';
}

/** Asks Ollama where its models live. Never throws; 'unknown' on any failure. */
export async function readOllamaResidency(base: string): Promise<GpuResidency> {
  try {
    return residencyFromPs(await (await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(2500) })).json());
  } catch { return 'unknown'; }
}

/** How long anonymous RAM may sit above the soft limit with residency unknown (a model loading). */
export const SPILL_GRACE_MS = 60_000;

/**
 * Must the RUNNING job stop? The floor applies to every job; the spill check is skipped for a job that
 * opted in. Pure.
 *
 * SPILL, refined 2026-11-05: a model loading with mmap disabled (Ollama does that under host memory
 * pressure) passes through anonymous RAM even when every layer ends on the GPU. That tripped the
 * 6 GiB limit at 6.1 GiB on a load that put 66/66 layers on CUDA. So above the soft limit the job
 * stops only when Ollama says a model IS in system RAM, or when residency stays unknown longer than
 * the grace; above the hard limit it stops at once. Without `ctx` the old rule holds (stop at soft).
 */
export function ramWatchVerdict(
  s: RamSample, limits: RamLimits = DEFAULT_RAM_LIMITS, allowSpill = false,
  ctx?: { residency: GpuResidency; overSoftForMs: number },
): RamVerdict {
  if (s.mem && s.mem.availMiB < limits.floorAvailMiB) {
    return { ok: false, kind: 'floor', reason: `system RAM available fell to ${gib(s.mem.availMiB)} (floor ${gib(limits.floorAvailMiB)})` };
  }
  if (allowSpill || s.anonMiB === null || s.anonMiB <= limits.spillAnonMiB) return { ok: true };
  const held = `Ollama holds ${gib(s.anonMiB)} of anonymous system RAM`;
  if (s.anonMiB > limits.hardAnonMiB) {
    return { ok: false, kind: 'spill', reason: `${held} (hard limit ${gib(limits.hardAnonMiB)}): a model is loading into RAM instead of the GPU` };
  }
  if (!ctx) return { ok: false, kind: 'spill', reason: `${held} (limit ${gib(limits.spillAnonMiB)}): a model is loading into RAM instead of the GPU` };
  if (ctx.residency === 'all-gpu') return { ok: true };
  if (ctx.residency === 'spilled') {
    return { ok: false, kind: 'spill', reason: `${held} (limit ${gib(limits.spillAnonMiB)}) and Ollama reports a model only partly on the GPU` };
  }
  if (ctx.overSoftForMs > SPILL_GRACE_MS) {
    return { ok: false, kind: 'spill', reason: `${held} (limit ${gib(limits.spillAnonMiB)}) for ${Math.round(ctx.overSoftForMs / 1000)} s with no model reported on the GPU` };
  }
  return { ok: true };
}

export const ollamaCgroup = (): string => process.env.RECKONS_OLLAMA_CGROUP ?? '/sys/fs/cgroup/system.slice/ollama.service';

const readOr = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

/** Reads /proc/meminfo and the Ollama cgroup's memory.stat. Never throws. */
export function readRamSample(cgroup: string = ollamaCgroup()): RamSample {
  const mi = readOr('/proc/meminfo');
  const st = readOr(`${cgroup}/memory.stat`);
  return { mem: mi === null ? null : parseMeminfo(mi), anonMiB: st === null ? null : parseAnonMiB(st) };
}

/** Unloads every model Ollama has resident (keep_alive 0). Returns the names it asked to unload. Never throws. */
export async function unloadOllamaModels(base: string): Promise<string[]> {
  try {
    const ps = (await (await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(5000) })).json()) as { models?: { name?: string; model?: string }[] };
    const names = (ps.models ?? []).map((m) => m.model ?? m.name).filter((n): n is string => typeof n === 'string');
    await Promise.all(names.map((model) => fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(15000),
    }).catch(() => undefined)));
    return names;
  } catch { return []; }
}
