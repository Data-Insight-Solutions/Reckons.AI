/**
 * Agentic Bench — tasks that require a tool-use loop, not a single shot.
 *
 * Each task drops starter files into a sandbox temp dir and gives the model a
 * goal plus tools (list_files, read_file, write_file, run_tests, finish). A good
 * agent reads the failing test, edits the source, re-runs, and finishes. This
 * measures multi-turn behaviour the single-shot coding bench can't: turns taken,
 * self-verification (did it run the tests), scope discipline (did it edit only
 * what it should), and spiral rate (did it thrash until the turn cap).
 *
 * `testCmd` is FIXED per task (never model-controlled) — the run_tests tool only
 * ever executes this. Verification = this command exiting 0 after the loop.
 */

export interface AgenticTask {
  id: string;
  /** Instruction handed to the agent. */
  goal: string;
  /** Starter files written into the sandbox (relative names). */
  files: Record<string, string>;
  /** Files the agent is expected to modify — anything else is a scope violation. */
  allowedFiles: string[];
  /** Fixed argv run by the run_tests tool and by final verification (cwd = sandbox). */
  testCmd: string[];
  /** Rough minimum turns a competent agent needs (for efficiency scoring). */
  idealTurns: number;
}

const assertHeader = 'import { strict as assert } from "node:assert";\n';

export const AGENTIC_TASKS: AgenticTask[] = [
  {
    id: 'fix-failing-test',
    goal:
      'The tests in this project are failing. Run them to see the failure, then fix the bug in ' +
      'math.ts so all tests pass. Do NOT modify math.test.ts. Call finish when the tests pass.',
    files: {
      'math.ts': [
        'export function clamp(x: number, lo: number, hi: number): number {',
        '  // BUG: bounds are swapped',
        '  if (x < lo) return hi;',
        '  if (x > hi) return lo;',
        '  return x;',
        '}',
        '',
        'export function sum(xs: number[]): number {',
        '  return xs.reduce((a, b) => a + b, 0);',
        '}',
      ].join('\n'),
      'math.test.ts': assertHeader + [
        'import { clamp, sum } from "./math";',
        'assert.equal(clamp(5, 0, 10), 5);',
        'assert.equal(clamp(-2, 0, 10), 0);',
        'assert.equal(clamp(99, 0, 10), 10);',
        'assert.equal(sum([1, 2, 3]), 6);',
        'console.log("ok");',
      ].join('\n'),
    },
    allowedFiles: ['math.ts'],
    testCmd: ['npx', 'tsx', 'math.test.ts'],
    idealTurns: 3,
  },
  {
    id: 'implement-to-spec',
    goal:
      'Implement the slugify function in slug.ts so the tests pass. Read slug.test.ts first to ' +
      'learn the exact expected behaviour. Run the tests to confirm, then call finish.',
    files: {
      'slug.ts': '// TODO: implement and export slugify(input: string): string\n',
      'slug.test.ts': assertHeader + [
        'import { slugify } from "./slug";',
        'assert.equal(slugify("Hello, World!"), "hello-world");',
        'assert.equal(slugify("  A__B  "), "a-b");',
        'assert.equal(slugify("already-slug"), "already-slug");',
        'assert.equal(slugify("!!!"), "");',
        'console.log("ok");',
      ].join('\n'),
    },
    allowedFiles: ['slug.ts'],
    testCmd: ['npx', 'tsx', 'slug.test.ts'],
    idealTurns: 3,
  },
  {
    id: 'two-file-rename',
    goal:
      'Rename the exported constant MAX_RETRIES to RETRY_LIMIT everywhere it appears. config.ts ' +
      'defines it and app.ts imports it. Keep behaviour identical. Run the tests, then call finish.',
    files: {
      'config.ts': 'export const MAX_RETRIES = 3;\n',
      'app.ts': [
        'import { MAX_RETRIES } from "./config";',
        'export function budget(): number {',
        '  return MAX_RETRIES * 2;',
        '}',
      ].join('\n'),
      'rename.test.ts': assertHeader + [
        '// Imports the NEW name — fails unless the rename actually happened.',
        'import { RETRY_LIMIT } from "./config";',
        'import { budget } from "./app";',
        'assert.equal(RETRY_LIMIT, 3);',
        'assert.equal(budget(), 6);',
        'console.log("ok");',
      ].join('\n'),
    },
    allowedFiles: ['config.ts', 'app.ts'],
    testCmd: ['npx', 'tsx', 'rename.test.ts'],
    idealTurns: 4,
  },
];

export const TOTAL_AGENTIC = AGENTIC_TASKS.length;
