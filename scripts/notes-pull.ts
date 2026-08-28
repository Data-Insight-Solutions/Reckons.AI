#!/usr/bin/env npx tsx
/**
 * Drain buffered notes from n8n into the local Reckons.AI workspace.
 *
 * THE LAST HOP, AND THE ONLY ONE THAT RUNS ON YOUR MACHINE. A note dictated into a ring reaches
 * n8n over MCP and waits in a data table — which is what lets you capture with the laptop shut.
 * This pulls that buffer down and appends it to knowledge.pending.jsonl, where the app's 10s
 * workspace poll imports it as pending facts.
 *
 * WHY THIS EXISTS RATHER THAN GOOGLE DRIVE. Drive was only ever the medium both sides could
 * reach. It cost an OAuth client, and when that client was deleted the entire capture path died
 * with an error nobody saw. A poll from the machine that owns the data needs no third party, no
 * credential that can be revoked elsewhere, and nothing inbound.
 *
 * DELIVERY IS AT-LEAST-ONCE, DELIBERATELY. Rows are written to disk and only THEN acked. A crash
 * between those two produces a duplicate on the next run, never a loss — and duplicates are
 * harmless, because pending rows carry deterministic ids and the app dedupes on import. The
 * other order would trade a harmless duplicate for a silently lost note. Never make that trade
 * on capture.
 *
 * Usage:
 *   npx tsx scripts/notes-pull.ts                 # one drain
 *   npx tsx scripts/notes-pull.ts --watch         # every 60s
 *   npx tsx scripts/notes-pull.ts --dry-run       # show what would land, ack nothing
 *
 * Env (reads .env): N8N_API_URL, N8N_CAPTURE_HEADER_NAME, N8N_CAPTURE_HEADER_VALUE
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import path from 'path';

function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const watch = args.includes('--watch');
const arg = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i+1] ? args[i+1] : d; };

const WORKSPACE = arg('--workspace', 'reckons-workspace');
const PENDING = path.join(WORKSPACE, 'knowledge.pending.jsonl');
const EVERY = parseInt(arg('--every', '60'), 10) * 1000;

function requireEnv(): { base: string; header: string; value: string } {
  const base = process.env.N8N_API_URL?.replace(/\/+$/, '');
  const header = process.env.N8N_CAPTURE_HEADER_NAME;
  const value = process.env.N8N_CAPTURE_HEADER_VALUE;
  if (!base || !header || !value) {
    console.error('Set N8N_API_URL, N8N_CAPTURE_HEADER_NAME and N8N_CAPTURE_HEADER_VALUE in .env');
    process.exit(2);
  }
  return { base, header, value };
}

type Row = { id: number | string; line: string; subject?: string; capturedAt?: string };

async function drainOnce(): Promise<number> {
  const { base, header, value } = requireEnv();
  const headers = { [header]: value };

  const res = await fetch(`${base}/webhook/reckons-notes-drain`, { headers });
  if (!res.ok) throw new Error(`drain failed: HTTP ${res.status}`);
  const body = (await res.json()) as { ok: boolean; rows?: Row[] };
  const rows = (body.rows ?? []).filter((r) => typeof r?.line === 'string' && r.line.trim());
  if (rows.length === 0) return 0;

  // Each stored `line` is already a complete, newline-terminated JSONL row built and validated
  // server-side — including the newline-injection guard. Nothing is re-serialised here, so a
  // note cannot be reshaped in transit.
  const text = rows.map((r) => (r.line.endsWith('\n') ? r.line : r.line + '\n')).join('');

  if (dryRun) {
    console.log(`  --dry-run: ${rows.length} note(s) would land in ${PENDING}; acking nothing.`);
    for (const r of rows) console.log(`    ${r.capturedAt ?? ''} ${r.subject ?? ''}`);
    return rows.length;
  }

  mkdirSync(WORKSPACE, { recursive: true });
  appendFileSync(PENDING, text, 'utf8');   // WRITE FIRST

  const ack = await fetch(`${base}/webhook/reckons-notes-ack`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: rows.map((r) => r.id) }),
  });
  if (!ack.ok) {
    // Written locally but not acked: they arrive again next run as duplicates, which the app
    // folds on import. Say so rather than implying a clean pass.
    console.warn(`  wrote ${rows.length} note(s) but ack failed (HTTP ${ack.status}) — expect duplicates next run`);
    return rows.length;
  }
  return rows.length;
}

async function main(): Promise<void> {
  const run = async () => {
    try {
      const n = await drainOnce();
      if (n > 0) console.log(`  ${new Date().toISOString()}  drained ${n} note(s) -> ${PENDING}`);
    } catch (e) {
      console.error(`  ${new Date().toISOString()}  ${e instanceof Error ? e.message : e}`);
    }
  };
  await run();
  if (watch) {
    console.log(`  watching every ${EVERY / 1000}s — the app imports within 10s of each write`);
    setInterval(run, EVERY);
  }
}

main().catch((e) => { console.error('notes-pull failed:', e); process.exit(1); });
