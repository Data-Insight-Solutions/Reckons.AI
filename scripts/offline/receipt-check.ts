#!/usr/bin/env npx tsx
/**
 * Receipt self-check (SCRIPT tier, F74.15 / kb:run-receipt) — a receipt is checked against itself.
 *
 * The registration check's measured value is the truth; the top-level `frames.registered` is
 * derived from it when the receipt is written. `validateReceipt` now fails when the two
 * disagree, and this script runs that check over every receipt.json under a directory, so a
 * directory of scan output either says "all receipts agree with their own checks" or names
 * the one that does not.
 *
 * Deterministic, zero tokens, fails loudly: a rule ("do these two numbers match") is a script,
 * not a model (F74.3). It reads files and prints lines; it edits nothing and writes no proposals.
 *
 * Usage:
 *   npx tsx scripts/offline/receipt-check.ts <directory>
 *
 * Exit codes: 0 all receipts pass (or none found), 1 at least one receipt fails, 2 usage error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReceipt, type ScanReceipt } from '../content/scan-room-lib.js';

export interface ReceiptResult {
  path: string;
  problems: string[];
}

/** Every receipt.json under root (recursive), sorted so the output is stable. */
export function findReceipts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === 'receipt.json') out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Validate every receipt under root. A file that is not JSON is itself a failed receipt. */
export function checkReceipts(root: string): ReceiptResult[] {
  return findReceipts(root).map((path) => {
    try {
      const receipt = JSON.parse(readFileSync(path, 'utf8')) as ScanReceipt;
      return { path, problems: validateReceipt(receipt) };
    } catch (e) {
      return { path, problems: [`not valid JSON: ${String(e).split('\n')[0]}`] };
    }
  });
}

/** One line per receipt; returns the process exit code (0 pass, 1 a failure, 2 usage). */
export function main(argv: string[], log = (line: string) => console.log(line), err = (line: string) => console.error(line)): number {
  if (argv.length !== 1) {
    err('usage: receipt-check <directory>   (one directory is required; it is refused when absent)');
    return 2;
  }
  const root = argv[0];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    err(`not a directory: ${root}`);
    return 2;
  }
  const results = checkReceipts(root);
  if (!results.length) {
    log(`0 receipts under ${root}`);
    return 0;
  }
  let failed = 0;
  for (const r of results) {
    const rel = relative(root, r.path) || r.path;
    if (r.problems.length) {
      failed++;
      log(`FAIL ${rel} — ${r.problems.join('; ')}`);
    } else {
      log(`ok   ${rel}`);
    }
  }
  log(`${results.length - failed} of ${results.length} receipt(s) agree with their own checks`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
