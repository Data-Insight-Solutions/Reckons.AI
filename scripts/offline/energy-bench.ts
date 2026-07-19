#!/usr/bin/env npx tsx
/**
 * Energy + cost bench for LOCAL inference (F105, SCRIPT tier).
 *
 * Measures what we can actually substantiate: watt-hours and dollars for a real local
 * task on THIS machine. First-party measurement, no model, no tokens.
 *
 * WHY THIS EXISTS: the environmental case for local-first is sound, but the marketable
 * version of it ("saves N litres of water") is a number we cannot measure. kb:mission is
 * explicit that an unverifiable claim made by the party it benefits is not evidence — so
 * we measure our own side, and treat the hosted side as CITED THIRD-PARTY RANGES, never
 * as our own finding.
 *
 * WHAT IT MEASURES HONESTLY
 *   - MARGINAL energy: idle baseline is sampled first and subtracted. The device is on
 *     anyway; the honest figure is the ADDITIONAL draw the task caused, not total draw.
 *     Reporting total would flatter the hosted side's alternative and overstate our cost —
 *     and marginal-vs-provisioned is the whole structural argument (see F105).
 *   - GPU only, via nvidia-smi. See UNDERCOUNT below.
 *
 * WHAT IT CANNOT MEASURE, STATED RATHER THAN HIDDEN
 *   - CPU/DRAM energy: Intel RAPL counters (/sys/class/powercap/.../energy_uj) are
 *     root-only on modern kernels (hardened after a power side-channel CVE). Not readable
 *     unprivileged, so CPU draw is EXCLUDED, not estimated.
 *   - PSU conversion loss (~10-15%) and the rest of the system: excluded.
 *   => Our local number is an UNDERCOUNT. That is deliberate: the error runs AGAINST our
 *      own thesis, which is the only safe direction to be wrong in your own marketing.
 *      A wall-socket meter is the fix; until then this is a floor, and is labelled one.
 *
 * Usage:
 *   npx tsx scripts/offline/energy-bench.ts                     measure with defaults
 *   npx tsx scripts/offline/energy-bench.ts --model=qwen3-coder:latest
 *   npx tsx scripts/offline/energy-bench.ts --rate=0.17         USD per kWh
 *   npx tsx scripts/offline/energy-bench.ts --json
 */
import { execSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const flag = (n: string, d?: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const MODELS = (flag('models') ?? flag('model', 'qwen3-coder:latest')!).split(',').map((m) => m.trim()).filter(Boolean);
const OLLAMA = process.env.OLLAMA_BASE_URL ?? flag('ollama', 'http://localhost:11434')!;
const USD_PER_KWH = Number(flag('rate', '0.17'));       // US residential average, override per region
const SAMPLE_MS = Number(flag('sample', '250'));
const IDLE_MS = Number(flag('idle', '4000'));

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';

/**
 * Hosted-side parameters. THESE ARE NOT OUR MEASUREMENTS and must not be presented as such.
 * Each needs verification against the primary source before any public use — the values
 * below are commonly-cited figures, recorded here so the METHOD is reviewable, and every
 * one is marked with how much weight it can bear.
 *
 * Deliberately no per-query water figure: converting kWh to litres requires a datacenter's
 * WUE and its grid's water intensity, both of which vary by region and season by more than
 * the effect being claimed. Report the ENERGY, cite water as a range with its assumptions,
 * and never publish a single litre number as though it were measured.
 */
const HOSTED_PARAMS = {
  pue_hyperscale: { value: 1.1, note: 'Power Usage Effectiveness claimed by major cloud operators.', confidence: 'commonly cited; verify against the operator report and year' },
  pue_industry:   { value: 1.5, note: 'Industry-average PUE across all datacenters, materially worse than hyperscale.', confidence: 'commonly cited (Uptime Institute annual survey); verify the year' },
  wue_onsite:     { value: 1.8, unit: 'L/kWh', note: 'Onsite Water Usage Effectiveness — evaporative cooling only.', confidence: 'ORDER OF MAGNITUDE ONLY; varies hugely by climate, season and cooling design' },
  water_offsite:  { value: 1.5, unit: 'L/kWh', note: 'Water consumed generating the electricity (thermoelectric cooling), often larger than onsite.', confidence: 'ORDER OF MAGNITUDE ONLY; depends entirely on grid mix' },
  grid_gCO2_kWh:  { value: 380, note: 'US average grid carbon intensity.', confidence: 'varies ~50-700 by region and hour; use a regional figure for any real claim' },
};

function gpuPowerW(): number {
  try {
    const out = execSync('nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits', { encoding: 'utf8' });
    return out.trim().split('\n').reduce((a, l) => a + (parseFloat(l) || 0), 0);
  } catch { return NaN; }
}

async function sampleWhile<T>(fn: () => Promise<T>): Promise<{ result: T; wh: number; avgW: number; ms: number; samples: number }> {
  const readings: number[] = [];
  let running = true;
  const t0 = Date.now();
  const poll = (async () => { while (running) { const w = gpuPowerW(); if (!isNaN(w)) readings.push(w); await new Promise((r) => setTimeout(r, SAMPLE_MS)); } })();
  const result = await fn();
  running = false; await poll;
  const ms = Date.now() - t0;
  const avgW = readings.reduce((a, b) => a + b, 0) / Math.max(1, readings.length);
  return { result, wh: (avgW * ms) / 3_600_000, avgW, ms, samples: readings.length };
}

async function idleBaseline(): Promise<number> {
  const readings: number[] = [];
  const end = Date.now() + IDLE_MS;
  while (Date.now() < end) { const w = gpuPowerW(); if (!isNaN(w)) readings.push(w); await new Promise((r) => setTimeout(r, SAMPLE_MS)); }
  return readings.reduce((a, b) => a + b, 0) / Math.max(1, readings.length);
}

const TASKS = [
  { name: 'extract-triples', prompt: 'Extract subject-predicate-object triples from: "Ada Lovelace wrote the first algorithm for the Analytical Engine in 1843." Return only the triples.' },
  { name: 'summarize',       prompt: 'Summarize in two sentences: a knowledge graph stores facts as subject-predicate-object triples, each carrying provenance and a review status, so claims can be traced to their source.' },
];

async function main() {
  if (isNaN(gpuPowerW())) {
    console.error('nvidia-smi not available — this bench measures GPU draw and cannot run here.');
    console.error('It reports a FLOOR even where it does work (CPU/PSU excluded); without a GPU reading there is nothing honest to report.');
    process.exit(1);
  }

  const gpuNames = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { encoding: 'utf8' }).trim().split('\n');
  const cpu = (readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.+)/)?.[1] ?? 'unknown').trim();

  console.log(`\n${B}Local inference energy bench${X} ${D}— ${MODELS.length} model(s)${X}`);
  console.log(`${D}${gpuNames.length}x ${gpuNames[0]} · ${cpu}${X}`);
  console.log(`${D}sampling GPU draw every ${SAMPLE_MS}ms; CPU/DRAM/PSU excluded (RAPL is root-only) — this is a FLOOR${X}\n`);

  process.stdout.write(`  idle baseline (${IDLE_MS / 1000}s) … `);
  const idleW = await idleBaseline();
  console.log(`${idleW.toFixed(1)} W\n`);

  const rows: any[] = [];
  for (const model of MODELS) {
    // WARM EACH MODEL FIRST. The first run pays a cold weight-load from disk into VRAM and it
    // dominates everything: the initial version of this bench measured 0.6179 Wh for a 37-token
    // task against 0.0573 Wh for a 49-token one — a 14x spread in Wh/token that was almost
    // entirely load cost, producing a per-token figure ~8x too high. A warm model is also the
    // honest steady state: a user asking a second question does not reload the weights.
    process.stdout.write(`  ${C}${model}${X} warming … `);
    const warmStart = Date.now();
    try {
      await fetch(`${OLLAMA}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'ok', stream: false }) });
    } catch (e) { console.error(`\nCannot reach Ollama at ${OLLAMA}: ${String((e as any)?.message ?? e)}`); process.exit(1); }
    console.log(`${((Date.now() - warmStart) / 1000).toFixed(1)}s ${D}(excluded)${X}`);

    for (const t of TASKS) {
      process.stdout.write(`    ${t.name} … `);
      const { result, wh, avgW, ms } = await sampleWhile(async () => {
        const res = await fetch(`${OLLAMA}/api/generate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: t.prompt, stream: false }),
        });
        if (!res.ok) throw new Error(`Ollama ${res.status}`);
        return res.json() as Promise<any>;
      });
      const marginalWh = Math.max(0, ((avgW - idleW) * ms) / 3_600_000);
      const outTokens = result.eval_count ?? 0;
      rows.push({ model, task: t.name, ms, avgW: +avgW.toFixed(1), totalWh: +wh.toFixed(5),
                  marginalWh: +marginalWh.toFixed(5), outTokens,
                  whPer1kTokens: outTokens ? +((marginalWh / outTokens) * 1000).toFixed(4) : null });
      console.log(`${(ms / 1000).toFixed(1)}s · ${avgW.toFixed(0)}W · ${marginalWh.toFixed(4)} Wh · ${outTokens} tok`);
    }
  }

  const totalMarginal = rows.reduce((a, r) => a + r.marginalWh, 0);
  const perKwh = (wh: number) => (wh / 1000) * USD_PER_KWH;

  console.log(`\n${B}${G}MEASURED (this machine, first-party)${X}`);
  console.log(`  marginal energy, ${rows.length} tasks   ${totalMarginal.toFixed(4)} Wh`);
  console.log(`  cost at $${USD_PER_KWH}/kWh              $${perKwh(totalMarginal).toFixed(8)}`);
  const per1k = rows.filter((r) => r.whPer1kTokens).map((r) => r.whPer1kTokens as number);
  if (per1k.length) {
    const avg1k = per1k.reduce((a, b) => a + b, 0) / per1k.length;
    const lo = Math.min(...per1k), hi = Math.max(...per1k);
    console.log(`  per 1k output tokens          ${avg1k.toFixed(4)} Wh  ${D}(range ${lo.toFixed(4)}–${hi.toFixed(4)})${X}`);
    console.log(`  ${D}→ 1M output tokens ≈ ${(avg1k * 1000).toFixed(1)} Wh ≈ $${perKwh(avg1k * 1000).toFixed(4)} of electricity${X}`);
    // A wide spread across so few tasks means the mean is not yet a number worth quoting.
    if (hi / Math.max(lo, 1e-9) > 3) {
      console.log(`  ${Y}spread is ${(hi / lo).toFixed(1)}x across ${per1k.length} task(s) — do NOT quote the mean.${X}`);
      console.log(`  ${D}Short tasks amortize fixed per-request overhead badly. Add longer//more tasks before citing a per-token figure.${X}`);
    }
  }

  console.log(`\n${B}${Y}NOT MEASURED — third-party parameters, for METHOD review only${X}`);
  console.log(`  ${Y}These are not our findings and must be verified against primary sources before any public use.${X}`);
  for (const [k, v] of Object.entries(HOSTED_PARAMS)) {
    console.log(`  ${k.padEnd(16)} ${String(v.value).padStart(5)} ${((v as any).unit ?? '').padEnd(7)} ${D}${v.note}${X}`);
    console.log(`  ${' '.repeat(16)} ${D}confidence: ${v.confidence}${X}`);
  }

  console.log(`\n${C}HONEST LIMITS${X}`);
  console.log(`  ${D}· GPU only. CPU, DRAM and PSU loss excluded — the local figure is a FLOOR, and the error runs against our own thesis by design.${X}`);
  console.log(`  ${D}· One machine, one model, two short tasks. Not a population.${X}`);
  console.log(`  ${D}· No hosted comparison is computed here. Comparing a local 7B to a frontier model per-query measures the wrong thing unless both can do the task.${X}`);
  console.log(`  ${D}· No litre figure is produced. kWh→litres needs regional WUE and grid water intensity that vary by more than the effect claimed.${X}\n`);

  const out = { measuredAt: new Date().toISOString(), machine: { gpus: gpuNames, cpu }, models: MODELS,
                idleW: +idleW.toFixed(1), usdPerKwh: USD_PER_KWH, tasks: rows, totalMarginalWh: +totalMarginal.toFixed(5),
                hostedParams: HOSTED_PARAMS,
                limits: ['GPU only; CPU/DRAM/PSU excluded — figure is a floor', 'single machine and model', 'no hosted comparison computed', 'no water figure derived'] };
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return; }
  writeFileSync('tests/bench/results/energy-latest.json', JSON.stringify(out, null, 2));
  console.log(`${D}written: tests/bench/results/energy-latest.json${X}\n`);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
