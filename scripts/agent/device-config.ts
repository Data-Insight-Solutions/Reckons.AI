/**
 * DEVICE CONFIG — thresholds and recurring schedules are STATEMENTS, so they live in graphs (F74.7).
 *
 * Matt, 2026-09-30: "Why .json and not a TTL file? We might want some level of device specific TTL
 * definitions?" He is right: the graphs are the source of truth, and a limit that differs per
 * machine is a statement scoped to that machine.
 *
 *   DEFAULTS   scripts/agent/defaults/device-defaults.ttl   (generic, in the repo)
 *              reckons-workspace/schedules.ttl              (the existing schedule graph, reused)
 *   OVERRIDES  ${XDG_CONFIG_HOME:-~/.config}/reckons/device.ttl   (private, mode 0600, outside git)
 *
 * A statement is scoped to a machine by `kpred:device <profile>`, where the profile carries
 * `kpred:hostname "<name>"` ("*" = every machine). One device.ttl can hold several machines; a group
 * scoped to another host is ignored. Overrides win PER PROPERTY: setting only kpred:yellow on a
 * threshold keeps the default red. Later sources win over earlier ones, and within a source a
 * host-specific group wins over a wildcard one. Entities are matched by IRI (schedules) or by
 * rdfs:label (thresholds, whose IRI is per-device).
 *
 * RUNTIME STATE IS NOT HERE and stays JSON/JSONL on purpose: the heartbeat mtime, current.json,
 * worker.json, queue.jsonl and queue.done.jsonl are written constantly, must be replaced atomically,
 * and are guarded by file locks; none of that is a statement worth a graph, and parsing TTL on every
 * write would be the wrong cost. Only DEFINITIONS (what the limit IS) are graphs.
 *
 * CACHE: parsing TTL with n3 costs milliseconds, which the status line cannot afford, so the compiled
 * result is cached as JSON beside the queue state, keyed by the host and the mtimes of every source.
 * Editing any source invalidates it. A stale or unwritable cache is ignored, never trusted.
 *
 * WEAKNESS, said out loud: hostname scoping trusts os.hostname(); two machines with the same name
 * share overrides, and renaming a machine silently drops its overrides back to the defaults.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const THRESHOLD = 'urn:kbase:type/Threshold';
export const SCHEDULE = 'urn:kbase:type/Schedule';

export const configDir = (): string => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'reckons');
export const devicePath = (): string => process.env.RECKONS_DEVICE_TTL || path.join(configDir(), 'device.ttl');
export const legacyWatchJsonPath = (): string => path.join(configDir(), 'watch.json');
export const defaultsPath = (): string => path.join(path.dirname(fileURLToPath(import.meta.url)), 'defaults', 'device-defaults.ttl');
const cachePath = (): string => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'reckons', 'jobs', 'device-config.cache.json');

// ── pure: parse, scope, merge ──────────────────────────────────────────────

type Q = { subject: { value: string }; predicate: { value: string }; object: { value: string } };
type Group = { src: number; subject: string; specific: boolean; props: Map<string, string> };

const hostMatches = (declared: string, host: string): boolean => declared === '*' || declared.toLowerCase() === host.toLowerCase();

/**
 * Statement groups (one per source and subject) that apply to `host`, in precedence order: earlier
 * sources first, wildcard before host-specific within a source, so folding left to right makes the
 * last write win. A group naming a profile for ANOTHER host is dropped. Pure.
 */
export function scopedGroups(sources: string[], host: string): Group[] {
  const groups: Group[] = [];
  sources.forEach((ttl, src) => {
    const quads = new Parser().parse(ttl) as Q[];
    const hostOf = new Map<string, string>(); // profile IRI -> hostname
    for (const q of quads) if (q.predicate.value === `${KPRED}hostname`) hostOf.set(q.subject.value, q.object.value);
    const bySubject = new Map<string, Q[]>();
    for (const q of quads) bySubject.set(q.subject.value, [...(bySubject.get(q.subject.value) ?? []), q]);
    for (const [subject, qs] of bySubject) {
      if (hostOf.has(subject) && !qs.some((q) => q.predicate.value !== `${KPRED}hostname` && q.predicate.value !== RDF_TYPE)) continue; // a profile, not data
      const device = qs.find((q) => q.predicate.value === `${KPRED}device`)?.object.value;
      const declared = device !== undefined ? hostOf.get(device) : undefined;
      if (device !== undefined && (declared === undefined || !hostMatches(declared, host))) continue;
      const props = new Map<string, string>();
      for (const q of qs) props.set(q.predicate.value, q.object.value); // last value of a repeated predicate wins
      groups.push({ src, subject, specific: declared !== undefined && declared !== '*', props });
    }
  });
  return groups.sort((a, b) => a.src - b.src || Number(a.specific) - Number(b.specific));
}

export type ThresholdOverride = { yellow?: number; red?: number; limit?: number };

/** metric (rdfs:label) -> its merged yellow/red/limit. Per-property merge. Pure. */
export function resolveThresholds(sources: string[], host: string): Record<string, ThresholdOverride> {
  const out: Record<string, ThresholdOverride> = {};
  for (const g of scopedGroups(sources, host)) {
    if (g.props.get(RDF_TYPE) !== THRESHOLD && !isThresholdMember(g)) continue;
    const metric = g.props.get(RDFS_LABEL);
    if (!metric) continue;
    const t = (out[metric] ??= {});
    for (const k of ['yellow', 'red', 'limit'] as const) {
      const v = Number(g.props.get(`${KPRED}${k}`));
      if (g.props.has(`${KPRED}${k}`) && Number.isFinite(v)) t[k] = v;
    }
  }
  return out;
}
/** A device override may omit rdf:type; it still counts if it carries a metric label and a threshold property. */
const isThresholdMember = (g: Group): boolean => g.props.has(RDFS_LABEL) && ['yellow', 'red', 'limit'].some((k) => g.props.has(`${KPRED}${k}`));

/** IRI -> merged properties, for entities typed `type` in ANY source (an override may omit the type). Pure. */
export function resolveEntities(sources: string[], host: string, type: string): Map<string, Map<string, string>> {
  const groups = scopedGroups(sources, host);
  const typed = new Set(groups.filter((g) => g.props.get(RDF_TYPE) === type).map((g) => g.subject));
  const out = new Map<string, Map<string, string>>();
  for (const g of groups) {
    if (!typed.has(g.subject)) continue;
    const m = out.get(g.subject) ?? new Map<string, string>();
    for (const [k, v] of g.props) m.set(k, v);
    out.set(g.subject, m);
  }
  return out;
}

// ── schedules (compiled form) ──────────────────────────────────────────────

export type CompiledSchedule = { iri: string; label: string; command: string; every: string; network: boolean; tier?: string; harness?: string };

export function compileSchedules(sources: string[], host: string): CompiledSchedule[] {
  const out: CompiledSchedule[] = [];
  for (const [iri, p] of resolveEntities(sources, host, SCHEDULE)) {
    const command = p.get(`${KPRED}command`);
    const every = p.get(`${KPRED}every`);
    if (!command || !every || p.get(`${KPRED}enabled`) === 'false') continue;
    out.push({ iri, label: p.get(RDFS_LABEL) ?? iri, command, every, network: p.get(`${KPRED}network`) === 'true', tier: p.get(`${KPRED}tier`), harness: p.get(`${KPRED}harness`) });
  }
  return out;
}

// ── migration from the old watch.json (never silent) ───────────────────────

/** The device.ttl text equivalent to an old watch.json. Pure. */
export function legacyWatchToTurtle(json: unknown, host: string): string {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'device';
  const dev = `<urn:reckons:device/${slug}>`;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const lines = [
    '@prefix kpred: <urn:kbase:predicate/> .', '@prefix ktype: <urn:kbase:type/> .', '@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .', '',
    `${dev} a ktype:DeviceProfile ; kpred:hostname ${JSON.stringify(host)} .`, '',
  ];
  const emit = (metric: string, props: [string, number | undefined][]) => {
    const set = props.filter(([, v]) => v !== undefined);
    if (!set.length) return;
    lines.push(`<urn:reckons:threshold/${metric}/${slug}> a ktype:Threshold ; rdfs:label ${JSON.stringify(metric)} ; kpred:device ${dev} ;`);
    lines.push(`    ${set.map(([k, v]) => `kpred:${k} ${v}`).join(' ; ')} .`);
  };
  for (const metric of ['gpuUtil', 'vramPct', 'latencySec', 'jobElapsedRatio', 'failuresLastHour', 'queueLength']) {
    const b = (o[metric] ?? {}) as Record<string, unknown>;
    emit(metric, [['yellow', num(b.yellow)], ['red', num(b.red)]]);
  }
  const g = (o.gpuStart ?? {}) as Record<string, unknown>;
  emit('startVramPct', [['limit', num(g.vramPct)]]);
  emit('startTempC', [['limit', num(g.tempC)]]);
  emit('startOtherUtilPct', [['limit', num(g.otherUtilPct)]]);
  return lines.join('\n') + '\n';
}

// ── IO with an mtime-keyed cache ───────────────────────────────────────────

export type Compiled = { thresholds: Record<string, ThresholdOverride>; schedules: CompiledSchedule[] };

const mtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/** The cache key: host plus every source's mtime. Pure given the numbers. */
export const cacheKey = (host: string, mtimes: number[]): string => JSON.stringify([host, ...mtimes]);

export function loadDeviceConfig(root: string = mainCheckoutRoot(), host: string = os.hostname()): Compiled {
  const files = [defaultsPath(), path.join(root, 'reckons-workspace', 'schedules.ttl'), devicePath()];
  const key = cacheKey(host, files.map(mtime));
  try {
    const c = JSON.parse(readFileSync(cachePath(), 'utf8')) as { key: string; value: Compiled };
    if (c.key === key) return c.value;
  } catch { /* no cache, or unreadable: recompile */ }
  const sources = files.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8'));
  let value: Compiled;
  try { value = { thresholds: resolveThresholds(sources, host), schedules: compileSchedules(sources, host) }; }
  catch (e) {
    // A syntax error in the PRIVATE device.ttl must not take the watcher down: say so and use the defaults alone.
    console.error(`device-config: ${(e as Error).message.split('\n')[0]} — ignoring ${devicePath()}`);
    const safe = files.filter((f) => f !== devicePath() && existsSync(f)).map((f) => readFileSync(f, 'utf8'));
    return { thresholds: resolveThresholds(safe, host), schedules: compileSchedules(safe, host) };
  }
  try {
    mkdirSync(path.dirname(cachePath()), { recursive: true });
    const tmp = `${cachePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, value }));
    renameSync(tmp, cachePath());
  } catch { /* an unwritable cache only costs a re-parse */ }
  return value;
}

let hinted = false;
/** One stderr hint when a legacy watch.json exists and device.ttl does not. Never converts silently. */
export function legacyHint(): void {
  if (hinted || !existsSync(legacyWatchJsonPath()) || existsSync(devicePath())) return;
  hinted = true;
  console.error(`device-config: ${legacyWatchJsonPath()} is no longer read. Run \`npm run agent:device -- migrate\` to print the equivalent TTL for ${devicePath()}.`);
}

function main(): void {
  const cmd = process.argv[2];
  if (cmd === 'migrate') {
    if (!existsSync(legacyWatchJsonPath())) { console.error(`no ${legacyWatchJsonPath()} to migrate`); process.exit(1); }
    process.stdout.write(`# Put this in ${devicePath()} (mode 0600). Not written for you.\n`);
    process.stdout.write(legacyWatchToTurtle(JSON.parse(readFileSync(legacyWatchJsonPath(), 'utf8')), os.hostname()));
  } else if (cmd === 'init') {
    if (existsSync(devicePath())) { console.error(`${devicePath()} already exists`); process.exit(1); }
    mkdirSync(path.dirname(devicePath()), { recursive: true });
    writeFileSync(devicePath(), legacyWatchToTurtle({}, os.hostname()) + '\n# Add overrides, e.g.:\n# <urn:reckons:threshold/startTempC/me> a ktype:Threshold ; rdfs:label "startTempC" ; kpred:device <urn:reckons:device/' + (os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'device') + '> ; kpred:limit 80 .\n', { mode: 0o600 });
    chmodSync(devicePath(), 0o600);
    console.log(`created ${devicePath()} (0600)`);
  } else if (cmd === 'show') {
    console.log(JSON.stringify(loadDeviceConfig(), null, 2));
  } else {
    console.error('Usage: device-config.ts migrate | init | show');
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
