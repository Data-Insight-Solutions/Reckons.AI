#!/usr/bin/env npx tsx
/**
 * Candidate discovery for the generation stages (F183.1 / kb:gen-model-bench).
 *
 * ONLINE AND OPT-IN. This asks the Hugging Face API about model repositories and sends nothing but
 * the query; it needs `--online` on the command line, the way `npm run security:dependencies` is an
 * explicit online check. Without the flag it prints this notice and exits 0 — it never reaches out
 * by accident. Scoring (gen-bench.ts) is fully local.
 *
 * Per stage it does two things:
 *   1. REVISION CHECK — for each model file the incumbent uses, is the repository still serving the
 *      bytes the receipt recorded? (Receipts store the file SHA-256, so the test is exact.)
 *   2. DISCOVERY — list models by pipeline tag, then drop each one for a stated reason: licence not
 *      on the allowlist, no evidence the stage's runtime loads it, no loadable file, too big for one
 *      24 GB GPU. What survives is a candidate LIST, ordered by recency then downloads. That order
 *      is for convenience; downloads and likes are never evidence of quality.
 *
 *   npm run bench:gen:discover                       every stage
 *   npm run bench:gen:discover -- --stage=image --top=15
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hfListModels, hfModelInfo, type HFRawModel } from '../../tests/visual/hf-model-query.js';
import { MODELS, type Receipt } from './gen-assets.js';
import {
  STAGE_SPECS, compareRevision, dedupeByFile, rankForDiscovery, repoOfSource, screenCandidate,
  type GenStage, type RevisionResult, type Screening,
} from './gen-bench-lib.js';

const ROOT = resolve(import.meta.dirname, '../..');

/** The model SHA-256 each stage's most recent receipt recorded, keyed by file name. */
export function recordedModels(stage: GenStage, root = join(ROOT, 'static/generated')) {
  const out = new Map<string, { file: string; sha256: string; source: string; ranAt: string }>();
  if (!existsSync(root)) return out;
  for (const d of readdirSync(root).sort()) {
    const f = join(root, d, 'receipt.json');
    if (!existsSync(f)) continue;
    const st = (JSON.parse(readFileSync(f, 'utf8')) as Receipt).stages[stage];
    for (const m of st?.models ?? []) out.set(m.file, { file: m.file, sha256: m.sha256, source: m.source, ranAt: st!.ranAt });
  }
  return out;
}

async function revisionCheck(stage: GenStage): Promise<RevisionResult[]> {
  const recorded = recordedModels(stage);
  const infoByRepo = new Map<string, HFRawModel | null>();
  const results: RevisionResult[] = [];
  for (const m of MODELS[stage]) {
    const file = m.path.split('/').pop()!;
    const rec = recorded.get(file);
    const repo = repoOfSource(m.source);
    if (!rec || !repo) { results.push({ file, repo: repo ?? m.source, status: 'unreachable', detail: 'no receipt records this file', repoSha: null, repoLastModified: null }); continue; }
    if (!infoByRepo.has(repo)) infoByRepo.set(repo, await hfModelInfo(repo).catch(() => null));
    results.push(compareRevision(rec, infoByRepo.get(repo)!, rec.ranAt));
  }
  return results;
}

async function discover(stage: GenStage, top: number): Promise<{ kept: Screening[]; dropped: Screening[] }> {
  const spec = STAGE_SPECS[stage];
  const seen = new Map<string, HFRawModel>();
  for (const sort of ['downloads', 'lastModified'] as const) {
    for (const m of await hfListModels({ pipelineTag: spec.pipelineTag, filter: spec.tagFilter, sort, limit: 100 })) seen.set(m.id, m);
  }
  const first = [...seen.values()].map((m) => screenCandidate(m, stage));
  const dropped = first.filter((s) => !s.kept);
  // Fetch file lists for up to 40 survivors (drop-ins first); `top` only limits what is printed.
  const survivors = rankForDiscovery(first.filter((s) => s.kept)).slice(0, 40);
  const kept: Screening[] = [];
  for (const s of survivors) {
    // Second screen needs the file list with sizes.
    const info = await hfModelInfo(s.repo).catch(() => null);
    if (!info) { dropped.push({ ...s, kept: false, reasons: ['could not fetch the file list'] }); continue; }
    const full = screenCandidate({ ...seen.get(s.repo)!, siblings: info.siblings }, stage);
    (full.kept ? kept : dropped).push(full);
  }
  const dd = dedupeByFile(kept);
  return { kept: rankForDiscovery(dd.kept).slice(0, top), dropped: [...dropped, ...dd.folded] };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  if (!args.includes('--online')) {
    console.log('gen-bench-discover queries the Hugging Face API (online). Re-run with --online to allow it.\n'
      + 'Scoring (npm run bench:gen) is local and needs no network.');
    return;
  }
  const stages = (arg('stage') ?? 'image,video,splat').split(',') as GenStage[];
  const top = Number(arg('top') ?? 12);
  const report: Record<string, unknown> = { date: new Date().toISOString(), stages: {} };
  for (const stage of stages) {
    const spec = STAGE_SPECS[stage];
    console.log(`\n=== ${stage.toUpperCase()}  (${spec.pipelineTag}; ${spec.runtime}) ===`);
    const revisions = await revisionCheck(stage);
    console.log('Incumbent revision check (receipt SHA-256 vs the repository now):');
    for (const r of revisions) console.log(`  ${r.status === 'unchanged' ? 'same   ' : r.status.toUpperCase().padEnd(7)} ${r.repo} / ${r.file}: ${r.detail}`);
    const { kept, dropped } = await discover(stage, top);
    console.log(`\nCandidates kept (${kept.length}), recency-then-downloads order, which is NOT a quality ranking:`);
    for (const k of kept) {
      console.log(`  + ${k.repo}  [${k.license}]  ${k.file ? `${k.file.name} ${(k.file.bytes / 1024 ** 3).toFixed(1)} GiB` : ''}  updated ${k.lastModified?.slice(0, 10)}\n      ${k.reasons[0]}`);
    }
    const byReason = new Map<string, number>();
    for (const d of dropped) { const r = d.reasons[0].replace(/"[^"]*"/g, '"…"').replace(/[\d.]+ GiB/g, 'N GiB').replace(/\(.*\)/, ''); byReason.set(r, (byReason.get(r) ?? 0) + 1); }
    console.log(`\nDropped (${dropped.length}), by reason:`);
    for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  - ${String(n).padStart(3)}  ${r}`);
    (report.stages as Record<string, unknown>)[stage] = { revisions, kept, dropped: dropped.map((d) => ({ repo: d.repo, license: d.license, reason: d.reasons[0] })) };
  }
  const dir = join(ROOT, 'tests/bench/results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `gen-discover_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nSaved ${file.replace(ROOT + '/', '')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
