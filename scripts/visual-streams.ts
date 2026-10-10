#!/usr/bin/env npx tsx
/**
 * Local VLM workflow streams. Start a branch preview, then:
 * OLLAMA_BASE_URL=http://localhost:11434 npm run visual:streams -- --base=http://localhost:4173
 * --config=<JSON> replaces the examples; --streams=id,id selects streams; --model=<name> overrides
 * their models. --list validates and lists the configuration without opening a browser or model.
 * Fresh contexts, sequential GPU calls, private evidence, no cloud fallback. Exit 2 = incomplete or
 * failed execution/assertion; exit 1 = visual proposals needing review; exit 0 = run completed.
 * A completed unverified exploration is NOT a passing test; receipts preserve that distinction.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { localOrigin, parseStreams } from './visual-streams/contract.js';
import { runStream, saveJson, needsReview, type Ask, type StreamReport } from './visual-streams/runner.js';
import { logEvent } from './agent/local-activity.js';
import { localOptions } from './offline/lib/local-model.js';
import { queueFindings, type Finding } from './offline/pending-queue.js';
import { pendingQueuePath } from './offline/lib/main-workspace.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const arg of args) if (arg !== '--list' && !/^--(base|config|streams|model)=.+/.test(arg)) throw new Error(`Unknown argument: ${arg}`);
let streams = parseStreams(JSON.parse(readFileSync(resolve(flag('config') ?? 'scripts/visual-streams/examples.json'), 'utf8')));
if (flag('streams')) {
  const ids = flag('streams')!.split(',');
  if (ids.some(id => !streams.some(s => s.id === id))) throw new Error('Unknown stream selection');
  streams = streams.filter(s => ids.includes(s.id));
}
if (flag('model')) streams = streams.map(s => ({ ...s, model: flag('model')! }));
if (args.includes('--list')) {
  for (const s of streams) console.log(`${s.id} · ${s.mode} · ${s.viewport.width}×${s.viewport.height} · ${s.lenses.map(l => l.id).join(', ')}\n  ${s.goal}`);
} else {
  if (!flag('base')) throw new Error('Choose a branch preview with --base=http://localhost:<port>');
  const base = localOrigin(flag('base')!);
  if (!process.env.OLLAMA_BASE_URL) throw new Error('OLLAMA_BASE_URL is required; local VLM use is opt-in');
  const ollama = localOrigin(process.env.OLLAMA_BASE_URL);
  const root = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'reckons', 'visual-streams');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, 'run-'));
  const run = `visual-streams-${directory.split('/').at(-1)}`;
  const started = Date.now();
  const reports: StreamReport[] = [];
  const provenance = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    base, buildMode: 'caller-supplied preview (not attested)', startedAt: new Date().toISOString(),
  };
  const findings: Finding[] = [];
  logEvent({ kind: 'run-start', run, at: provenance.startedAt, task: 'visual-streams', models: [...new Set(streams.map(s => s.model))],
    items: streams.length, votesPerModel: 1, engine: 'ollama-vision', cwd: process.cwd(), pid: process.pid, host: hostname() });
  let failure: string | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    for (const stream of streams) {
      let call = 0;
      const ask: Ask = async ({ model, prompt, images, schema, signal }) => {
        const at = Date.now(), item = `${stream.id}/${++call}`;
        process.stdout.write(`  ${item} · ${model}\n`);
        try {
          const response = await fetch(`${ollama}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            // JSON mode works with the local Ollama-compatible gateway too; its VLM backend
            // rejected schema grammar on 2026-10-09. Keep the schema in the prompt and validate.
            signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), body: JSON.stringify({ model,
              prompt: `${prompt}\nExact response schema: ${JSON.stringify(schema)}`, images,
              stream: false, format: 'json', options: localOptions({ num_ctx: 8192, num_predict: 700, temperature: 0 }) }) });
          if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
          const answer = await response.json() as { response?: string; error?: string; done?: boolean };
          if (answer.error || !answer.done || !answer.response?.trim()) throw new Error(answer.error || 'Empty or incomplete VLM response');
          logEvent({ kind: 'vote', run, at: new Date().toISOString(), model, item, ms: Date.now() - at, value: 'response', reason: answer.response.slice(0, 160) });
          return answer.response;
        } catch (e) {
          logEvent({ kind: 'vote', run, at: new Date().toISOString(), model, item, ms: Date.now() - at, error: String(e) });
          throw e;
        }
      };
      const report = await runStream(browser, stream, base, join(directory, stream.id), ask);
      reports.push(report);
      console.log(`${stream.id}: ${report.status}${needsReview(report) ? '; visual proposals need review' : ''} (${report.frames.length} frames)`);
      for (const frame of report.frames) {
        if (frame.overflow) findings.push({
          subject: 'urn:kbase:concept/vlm-workflow-streams', predicate: 'urn:kbase:predicate/observation', kb: 'roadmap',
          type: 'observation', priority: 'medium', question: `${stream.id}, frame ${frame.index}: browser measured horizontal overflow.`,
          note: `Screenshot SHA256 ${frame.sha256}; private receipt ${directory}/${stream.id}/report.json`,
        });
        for (const review of frame.reviews) if (review.result && review.result.verdict !== 'ok') findings.push({
          subject: 'urn:kbase:concept/vlm-workflow-streams', predicate: 'urn:kbase:predicate/observation', kb: 'roadmap',
          type: 'question', priority: 'medium', question: `${stream.id}, frame ${frame.index}, ${review.lens}: ${review.result.detail}`,
          note: `Unverified local VLM proposal (${stream.model}); screenshot SHA256 ${frame.sha256}; private receipt ${directory}/${stream.id}/report.json`,
        });
      }
      if (report.status === 'error' || report.status === 'exhausted') failure = 'One or more streams did not complete successfully';
      saveJson(join(directory, 'run.json'), { ...provenance, reports, failure });
    }
    queueFindings(findings, { agent: 'offline:visual-streams', path: pendingQueuePath(), kb: 'roadmap', recomputes: false });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try { await browser?.close(); } catch (error) { failure = `Browser cleanup failed: ${String(error)}`; }
    saveJson(join(directory, 'run.json'), { ...provenance, finishedAt: new Date().toISOString(), reports, failure });
    logEvent({ kind: 'run-end', run, at: new Date().toISOString(), ms: Date.now() - started, counts: { streams: reports.length, proposals: findings.length },
      resultPath: join(directory, 'run.json'), failed: failure });
  }
  console.log(`Evidence: ${directory}/run.json`);
  if (failure) console.error(failure);
  process.exitCode = failure ? 2 : reports.some(needsReview) ? 1 : 0;
}
