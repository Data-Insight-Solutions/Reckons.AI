/**
 * MEASURE THIS DEVICE (F269) — `npm run device:measure`.
 *
 * Reads, without sudo and without changing anything: memory, each GPU's memory (nvidia-smi, when
 * present), free disk where the workspace lives, the local models the model server lists (when it
 * is reachable) and the tools jobs need. Writes the private device space (mode 0600, outside Git).
 *
 * Output to the terminal is TERMS and counts only, never values or paths: a device inventory is
 * private (AGENTS.md, F172.1). A probe that cannot run leaves its terms unmeasured, which is
 * different from measured absent; the summary says which.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measurementsToValues, type RawMeasurements } from './device-capabilities.js';
import { buildMeasuredSpaceText } from './device-space-build.js';
import { deviceMeasuredPath, deviceStableId } from './device-space-paths.js';
import { writeAtomic } from './queue-to-space.js';

const run = (cmd: string, args: string[]): string | undefined => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }); } catch { return undefined; }
};
const onPath = (name: string): boolean => run('sh', ['-c', `command -v ${name}`]) !== undefined;

/** MemAvailable in bytes from /proc/meminfo text; undefined when absent. Pure. */
export function parseMemAvailable(meminfo: string): number | undefined {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : undefined;
}
/** Per-GPU memory in MiB from `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`. Pure. */
export function parseGpuMemory(out: string): number[] {
  return out.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0);
}
/** Model names from an Ollama /api/tags body; undefined when it does not look like one. Pure. */
export function parseModelNames(body: unknown): string[] | undefined {
  const arr = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(arr)) return undefined;
  return arr.map((m) => (m as { name?: unknown }).name).filter((n): n is string => typeof n === 'string');
}

async function probeModels(): Promise<string[] | undefined> {
  const base = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    return r.ok ? parseModelNames(await r.json()) : undefined;
  } catch { return undefined; }
}

function probeTools(): Record<string, boolean> {
  const home = os.homedir();
  const share = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const venv = (n: string): boolean => existsSync(path.join(share, 'reckons', 'venvs', n)) && readdirSync(path.join(share, 'reckons', 'venvs', n)).length > 0;
  return {
    blender: onPath('blender'),
    colmap: onPath('colmap'),
    ollama: onPath('ollama'),
    'nvidia-smi': onPath('nvidia-smi'),
    build123d: venv('cad'),
    tada: venv('tada'),
  };
}

async function measure(): Promise<RawMeasurements> {
  const raw: RawMeasurements = { measuredAt: new Date().toISOString(), ramTotalBytes: os.totalmem(), tools: probeTools() };
  try { raw.ramAvailableBytes = parseMemAvailable((await import('node:fs')).readFileSync('/proc/meminfo', 'utf8')); } catch { /* not Linux */ }
  const gpu = run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
  if (gpu !== undefined) raw.gpuMemoryMiB = parseGpuMemory(gpu);
  else if (raw.tools?.['nvidia-smi'] === false) raw.gpuMemoryMiB = []; // no driver tool: the device reports no GPU
  try { const s = statfsSync(process.cwd()); raw.diskFreeBytes = s.bavail * s.bsize; } catch { /* leave unmeasured */ }
  raw.models = await probeModels();
  return raw;
}

async function main(): Promise<void> {
  const raw = await measure();
  const m = measurementsToValues(raw);
  const out = deviceMeasuredPath();
  writeAtomic(out, buildMeasuredSpaceText(m, deviceStableId(), Date.now()));
  const terms = Object.keys(m.values).sort();
  const present = terms.filter((t) => m.values[t] !== false);
  const absent = terms.filter((t) => m.values[t] === false);
  console.log(`device:measure wrote the private device space (mode 0600, outside Git): ${terms.length} term(s) measured.`);
  console.log(`  found: ${present.map((t) => (t.startsWith('model:') ? 'model:*' : t)).filter((t, i, a) => a.indexOf(t) === i).join(', ')}`);
  console.log(`  looked, absent: ${absent.join(', ') || '(none)'}`);
  if (raw.models === undefined) console.log('  models unmeasured: the model server was not reachable.');
  if (raw.gpuMemoryMiB === undefined) console.log('  gpu unmeasured: nvidia-smi gave no answer.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(String(e)); process.exit(1); });
