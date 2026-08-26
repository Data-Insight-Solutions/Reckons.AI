#!/usr/bin/env npx tsx
/**
 * Deploy a shipped workflow to YOUR n8n, via the public REST API.
 *
 * static/n8n/*.workflow.json are import-ready, but importing them is a manual click-path, and a
 * manual click-path is where "I set it up" and "it is actually running" quietly diverge. This
 * makes it one command and, more usefully, makes the failure modes loud.
 *
 * THE GOTCHA THIS EXISTS FOR. n8n's public API rejects a workflow object carrying fields it
 * treats as read-only, and every export carries several: id, active, tags, meta, pinData,
 * versionId, createdAt, updatedAt. POSTing an export verbatim returns a 400 naming ONE field at
 * a time, so you strip it, resubmit, and meet the next one. Only name/nodes/connections/settings
 * survive the filter below.
 *
 * CREDENTIALS ARE NOT DEPLOYED AND SHOULD NOT BE. A workflow references credentials by id on the
 * instance, and there is no API to create an OAuth credential unattended. So a deploy lands
 * INACTIVE by default and prints which nodes still need wiring. Activating a workflow whose
 * Google node has no credential produces one that fails every execution while reporting itself
 * active — strictly worse than an inactive workflow you know to finish.
 *
 * Usage:
 *   export N8N_API_URL=https://n8n.example.com    # instance root, no /api/v1 suffix
 *   export N8N_API_KEY=...                        # n8n -> Settings -> n8n API -> create key
 *   npx tsx scripts/n8n-deploy.ts static/n8n/ios-note-capture.workflow.json
 *   npx tsx scripts/n8n-deploy.ts <file> --dry-run    # validate and show payload, send nothing
 *   npx tsx scripts/n8n-deploy.ts <file> --activate   # only once credentials are attached
 *   npx tsx scripts/n8n-deploy.ts --list              # what is already on the instance
 */

import { readFileSync } from 'fs';

/** The only keys POST /workflows accepts. Everything else is read-only and 400s. */
const CREATE_FIELDS = ['name', 'nodes', 'connections', 'settings'] as const;

/** Node types that cannot work until a human attaches a credential in the UI. */
const NEEDS_CREDENTIAL = /googleDrive|googleTasks|gmail|microsoftOutlook|slack|notion|airtable|openAi/i;

export type WorkflowFile = {
  name?: string;
  nodes?: Array<{ name: string; type: string; credentials?: unknown }>;
  connections?: unknown;
  settings?: unknown;
  [k: string]: unknown;
};

/** Strip an exported workflow down to what the create endpoint will accept. */
export function toCreatePayload(wf: WorkflowFile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CREATE_FIELDS) {
    if (wf[key] !== undefined) out[key] = wf[key];
  }
  // Required by the API even when the export omitted it.
  if (out.settings === undefined) out.settings = { executionOrder: 'v1' };
  return out;
}

/** Nodes a human must finish wiring before activation means anything. */
export function credentialGaps(wf: WorkflowFile): string[] {
  return (wf.nodes ?? [])
    .filter((n) => NEEDS_CREDENTIAL.test(n.type) && !n.credentials)
    .map((n) => `${n.name} (${n.type.replace('n8n-nodes-base.', '')})`);
}

/** Placeholders shipped deliberately, so a half-configured deploy is caught before it runs. */
export function unsetPlaceholders(wf: WorkflowFile): string[] {
  const found: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (/^PUT-[A-Z-]+-HERE$/.test(v)) found.push(`${path} = ${v}`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        walk(val, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(wf.nodes, 'nodes');
  return found;
}

/** Webhook paths this workflow will answer on, so the deploy can print the real URL. */
export function webhookPaths(wf: WorkflowFile): string[] {
  return (wf.nodes ?? [])
    .filter((n) => n.type === 'n8n-nodes-base.webhook')
    .map((n) => String((n as { parameters?: { path?: unknown } }).parameters?.path ?? ''))
    .filter(Boolean);
}

// -- CLI ---------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const activate = args.includes('--activate');
const list = args.includes('--list');
const file = args.find((a) => !a.startsWith('--'));

function requireEnv(): { url: string; key: string } {
  const url = process.env.N8N_API_URL?.replace(/\/+$/, '');
  const key = process.env.N8N_API_KEY;
  if (!url || !key) {
    console.error(
      'Set N8N_API_URL and N8N_API_KEY first.\n' +
        '  N8N_API_URL  instance root, e.g. https://n8n.example.com (no /api/v1)\n' +
        '  N8N_API_KEY  n8n -> Settings -> n8n API -> Create an API key',
    );
    process.exit(2);
  }
  return { url, key };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, key } = requireEnv();
  return fetch(`${url}/api/v1${path}`, {
    ...init,
    headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function main(): Promise<void> {
  if (list) {
    const res = await api('/workflows?limit=100');
    if (!res.ok) {
      console.error(`List failed: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const body = (await res.json()) as { data?: Array<{ id: string; name: string; active: boolean }> };
    for (const w of body.data ?? []) {
      console.log(`  ${w.active ? 'ACTIVE  ' : 'inactive'} ${w.id.padEnd(20)} ${w.name}`);
    }
    console.log(`\n  ${(body.data ?? []).length} workflow(s)`);
    return;
  }

  if (!file) {
    console.error('usage: n8n-deploy.ts <static/n8n/*.workflow.json> [--dry-run] [--activate]');
    console.error('       n8n-deploy.ts --list');
    process.exit(2);
  }

  const wf = JSON.parse(readFileSync(file, 'utf8')) as WorkflowFile;
  const payload = toCreatePayload(wf);
  const gaps = credentialGaps(wf);
  const placeholders = unsetPlaceholders(wf);

  console.log(`\nDeploying "${wf.name}" from ${file}`);
  console.log(`  ${(wf.nodes ?? []).length} nodes, stripped to: ${Object.keys(payload).join(', ')}`);

  if (placeholders.length > 0) {
    console.log('\n  \x1b[33mPLACEHOLDERS STILL UNSET\x1b[0m - it will deploy but not work:');
    for (const p of placeholders) console.log(`    ${p}`);
  }
  if (gaps.length > 0) {
    console.log('\n  \x1b[33mCREDENTIALS NEEDED\x1b[0m - attach these in the n8n UI:');
    for (const g of gaps) console.log(`    ${g}`);
  }

  if (dryRun) {
    console.log('\n  --dry-run: nothing sent. The keys above are what would be POSTed.\n');
    return;
  }

  const res = await api('/workflows', { method: 'POST', body: JSON.stringify(payload) });
  const text = await res.text();
  if (!res.ok) {
    console.error(`\n  Deploy failed: HTTP ${res.status}\n  ${text}`);
    if (res.status === 400) {
      console.error('\n  A 400 here is usually another read-only field your n8n version rejects.');
      console.error('  This script strips id/active/tags/meta/pinData/versionId; if yours names');
      console.error('  a different one, add it to CREATE_FIELDS in scripts/n8n-deploy.ts.');
    }
    process.exit(1);
  }

  const created = JSON.parse(text) as { id: string };
  console.log(`\n  \x1b[32mCreated\x1b[0m workflow ${created.id} (inactive)`);

  const base = process.env.N8N_API_URL?.replace(/\/+$/, '');
  for (const p of webhookPaths(wf)) {
    console.log(`  POST here:  ${base}/webhook/${p}`);
    console.log(`  while editing in the UI, use:  ${base}/webhook-test/${p}`);
  }

  if (activate) {
    if (gaps.length > 0 || placeholders.length > 0) {
      console.log('\n  \x1b[33mRefusing to activate\x1b[0m while credentials or placeholders are outstanding.');
      console.log('  An active workflow that fails every execution still reports itself active.');
      return;
    }
    const act = await api(`/workflows/${created.id}/activate`, { method: 'POST' });
    console.log(act.ok ? '  Activated.' : `  Activation failed: HTTP ${act.status} ${await act.text()}`);
  } else {
    console.log('\n  Left INACTIVE. Finish credentials in the UI, then activate there or re-run with --activate.');
  }
  console.log();
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ' ');
if (invokedDirectly) {
  main().catch((e) => {
    console.error('n8n-deploy failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
