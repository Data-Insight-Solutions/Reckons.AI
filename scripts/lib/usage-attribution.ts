/**
 * Pure helpers for scripts/session-tokens.ts: per-branch attribution, time windows, plan
 * calibration and tasks-per-week (roadmap kb:cost-awareness, METHOD steps 1-3).
 *
 * Transcript fields relied on (inspected 2026-09-30 on real JSONL, not assumed):
 *   - `gitBranch`  on every line, main thread AND subagent lines (a worktree agent's lines
 *                  carry the worktree's branch; an Explore agent run in the main checkout
 *                  carries that checkout's branch)
 *   - `cwd`        fallback when gitBranch is absent
 *   - `message.model`, `message.usage`, `message.id`, `requestId`, `timestamp`
 * Subagent transcripts live in <session-id>/subagents/agent-*.jsonl (a subdirectory).
 *
 * DUPLICATE USAGE: the harness writes one line per content block of a response, each carrying
 * the SAME usage block. Measured here: 15298 usage lines, 7033 distinct (requestId, message.id).
 * `dedupeEntries` keeps one per response; the legacy per-session table in session-tokens.ts
 * does not (its output is kept unchanged), so its totals run about 2x higher than --by=branch.
 */

// Relative Opus token weights (input=1): output is dear, cache-read is cheap.
export const W = { input: 1, cacheW: 1.25, cacheR: 0.1, output: 5 };

export type Usage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

export type Family = 'opus' | 'sonnet' | 'haiku' | 'other';
export const FAMILIES: Family[] = ['opus', 'sonnet', 'haiku', 'other'];

export type Entry = {
  ts: string; // ISO timestamp
  branch: string;
  family: Family;
  weighted: number;
  key?: string; // requestId|message.id, for dedupe
  sub?: boolean; // true when read from a <session>/subagents/ transcript
};

export const weigh = (u: Usage): number =>
  (u.input_tokens ?? 0) * W.input +
  (u.cache_creation_input_tokens ?? 0) * W.cacheW +
  (u.cache_read_input_tokens ?? 0) * W.cacheR +
  (u.output_tokens ?? 0) * W.output;

export function modelFamily(model: string | undefined): Family {
  const m = (model ?? '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}

/** Branch a transcript line was made on: gitBranch, else the cwd's last segment. */
export function branchOf(o: { gitBranch?: string; cwd?: string }): string {
  const b = o.gitBranch?.trim();
  if (b && b !== 'HEAD') return b;
  const seg = o.cwd?.split('/').filter(Boolean).pop();
  return seg ? `(cwd:${seg})` : '(unknown)';
}

/** One transcript JSON line -> Entry, or null when it carries no usage (or is synthetic). */
export function entryFromLine(o: any): Entry | null {
  const u = o?.message?.usage;
  if (!u || !o.timestamp) return null;
  if (o.message?.model === '<synthetic>') return null;
  const hasId = Boolean(o.requestId || o.message?.id);
  const key = hasId ? `${o.requestId ?? ''}|${o.message?.id ?? ''}` : undefined;
  return { ts: o.timestamp, branch: branchOf(o), family: modelFamily(o.message?.model), weighted: weigh(u), key };
}

/** Keep one entry per response (the last seen, which has the final output count). */
export function dedupeEntries(entries: Entry[]): Entry[] {
  const byKey = new Map<string, Entry>();
  const out: Entry[] = [];
  for (const e of entries) {
    if (!e.key) { out.push(e); continue; }
    byKey.set(e.key, e);
  }
  return [...out, ...byKey.values()];
}

/** since inclusive, until exclusive; either may be undefined. */
export function inWindow(ts: string, since?: string, until?: string): boolean {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  if (since && t < Date.parse(since)) return false;
  if (until && t >= Date.parse(until)) return false;
  return true;
}

export const filterWindow = (es: Entry[], since?: string, until?: string): Entry[] =>
  es.filter((e) => inWindow(e.ts, since, until));

/** Main thread vs subagents, by model family: the delegation split (Opus main + Sonnet subagents). */
export type ThreadRow = { thread: 'main' | 'subagents'; weighted: number; byFamily: Record<Family, number> };
export function attributeByThread(entries: Entry[]): ThreadRow[] {
  const rows: ThreadRow[] = (['main', 'subagents'] as const).map((thread) => ({ thread, weighted: 0, byFamily: zeroFam() }));
  for (const e of entries) {
    const r = rows[e.sub ? 1 : 0];
    r.weighted += e.weighted;
    r.byFamily[e.family] += e.weighted;
  }
  return rows;
}

/** True when a transcript path belongs to the given session id (its main file or its subagents). */
export const inSession = (file: string, session: string): boolean =>
  file.split('/').some((seg) => seg === session || seg === `${session}.jsonl`);

export type BranchRow = { branch: string; weighted: number; byFamily: Record<Family, number> };

const zeroFam = (): Record<Family, number> => ({ opus: 0, sonnet: 0, haiku: 0, other: 0 });

export function attributeByBranch(entries: Entry[]): BranchRow[] {
  const m = new Map<string, BranchRow>();
  for (const e of entries) {
    let r = m.get(e.branch);
    if (!r) m.set(e.branch, (r = { branch: e.branch, weighted: 0, byFamily: zeroFam() }));
    r.weighted += e.weighted;
    r.byFamily[e.family] += e.weighted;
  }
  return [...m.values()].sort((a, b) => b.weighted - a.weighted);
}

export const TASK_PREFIXES = ['feat', 'fix', 'chore', 'test', 'plan', 'docs', 'agent'] as const;

/** Task kind = the branch prefix, or null for dev, main, staging, worktree-agent-N, or anything else. */
export function taskKind(branch: string): string | null {
  const i = branch.indexOf('/');
  if (i <= 0) return null;
  const p = branch.slice(0, i);
  return (TASK_PREFIXES as readonly string[]).includes(p) ? p : null;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type CalibEntry = { at: string; weeklyPercent: number; plan?: string };

/** Valid entries only (finite percent 0..1000, parseable time), sorted by time. */
export function cleanCalibration(raw: unknown): CalibEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) && Number.isFinite(e.weeklyPercent) && e.weeklyPercent >= 0)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Monday 00:00 UTC of the week containing t. A calendar proxy: the plan's own reset time is not recorded. */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString();
}

export type Window = { from: string; to: string; percentDelta: number };

/**
 * The calibration window: in the most recent week holding >=2 entries, from the earliest
 * to the latest entry, provided the percent rose (a fall means the plan reset in between,
 * so the pair says nothing). Returns null when no such pair exists.
 */
export function calibrationWindow(entries: CalibEntry[]): Window | null {
  const weeks = new Map<string, CalibEntry[]>();
  for (const e of entries) {
    const w = weekStart(e.at);
    weeks.set(w, [...(weeks.get(w) ?? []), e]);
  }
  for (const w of [...weeks.keys()].sort().reverse()) {
    const es = weeks.get(w)!;
    if (es.length < 2) continue;
    const a = es[0], b = es[es.length - 1];
    const delta = b.weeklyPercent - a.weeklyPercent;
    if (delta > 0) return { from: a.at, to: b.at, percentDelta: delta };
  }
  return null;
}

export const tokensPerPercent = (usage: Entry[], w: Window): number =>
  filterWindow(usage, w.from, w.to).reduce((s, e) => s + e.weighted, 0) / w.percentDelta;

export type TaskCost = { branch: string; kind: string; family: Family; weighted: number };

/** Each task branch's total and its dominant model family (the one holding the most tokens). */
export function taskCosts(entries: Entry[]): TaskCost[] {
  const out: TaskCost[] = [];
  for (const r of attributeByBranch(entries)) {
    const kind = taskKind(r.branch);
    if (!kind || r.weighted <= 0) continue;
    const family = FAMILIES.reduce((best, f) => (r.byFamily[f] > r.byFamily[best] ? f : best), 'other' as Family);
    out.push({ branch: r.branch, kind, family, weighted: r.weighted });
  }
  return out;
}

export type TasksPerWeek = { tasks: number; medianWeighted: number; tasksPerWeek: number };

export const tasksPerWeek = (tokensPerPct: number, costs: number[]): TasksPerWeek => {
  const med = median(costs);
  return { tasks: costs.length, medianWeighted: med, tasksPerWeek: med > 0 ? (100 * tokensPerPct) / med : 0 };
};

export function groupTasksPerWeek(tokensPerPct: number, costs: TaskCost[]) {
  const by = <K extends string>(pick: (c: TaskCost) => K) => {
    const g = new Map<K, number[]>();
    for (const c of costs) g.set(pick(c), [...(g.get(pick(c)) ?? []), c.weighted]);
    return [...g.entries()].map(([k, v]) => ({ key: k, ...tasksPerWeek(tokensPerPct, v) })).sort((a, b) => b.tasks - a.tasks);
  };
  return {
    overall: tasksPerWeek(tokensPerPct, costs.map((c) => c.weighted)),
    byKind: by((c) => c.kind),
    byFamily: by((c) => c.family)
  };
}
