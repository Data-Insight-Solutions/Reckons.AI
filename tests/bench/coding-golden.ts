/**
 * Coding Bench — self-contained, objectively-graded tasks.
 *
 * Each task hands the model a fully specified problem (exact export name +
 * signature + behaviour) and asks for a single TypeScript code block. The runner
 * writes the model's code to `solution.ts` in a temp dir alongside `driver.ts`,
 * then runs the driver with tsx — a nonzero exit = fail. No app build, no network,
 * deterministic pass/fail.
 *
 * This measures code-EDIT/GEN correctness (understand spec → produce working
 * code), which is the core signal for picking a local coding model. It does NOT
 * measure full agentic behaviour (tool use, multi-file exploration, iteration) —
 * that's the phase-2 tool-loop bench.
 *
 * Tasks are chosen to discriminate: a trivial edit, a from-scratch implementation,
 * a bug fix, and a parser — spanning instruction-following, string logic, and
 * edge-case handling.
 */

export interface CodingTask {
  id: string;
  kind: 'edit' | 'implement' | 'fix' | 'parse';
  /** Self-contained instruction; must name the exact export + signature. */
  prompt: string;
  /** Driver asserts the solution; throws (→ nonzero exit) on any failure. */
  driver: string;
}

const header = 'import { strict as assert } from "node:assert";\n';

export const CODING_TASKS: CodingTask[] = [
  {
    id: 'dismissed-tips-edit',
    kind: 'edit',
    prompt: [
      'Here is a TypeScript function:',
      '',
      '```ts',
      'export function dismissedTips(): string[] {',
      "  return ['setup-local-folder', 'tutorial-welcome', 'tutorial-ingest'];",
      '}',
      '```',
      '',
      "Add the string 'tip-shelly-explore' as a new element of the returned array,",
      'keeping the existing three elements unchanged and in order.',
      'Return ONLY the full updated function in a single TypeScript code block.',
    ].join('\n'),
    driver: header + [
      'import { dismissedTips } from "./solution";',
      'const r = dismissedTips();',
      'assert.deepEqual(r, ["setup-local-folder","tutorial-welcome","tutorial-ingest","tip-shelly-explore"]);',
      'console.log("ok");',
    ].join('\n'),
  },
  {
    id: 'slugify-implement',
    kind: 'implement',
    prompt: [
      'Implement and export a TypeScript function with this exact signature:',
      '',
      '  export function slugify(input: string): string',
      '',
      'Behaviour: lowercase the input; replace every run of non-alphanumeric',
      'characters with a single hyphen; remove leading and trailing hyphens.',
      'Examples: "Hello, World!" -> "hello-world";  "  A__B  " -> "a-b";',
      '"already-slug" -> "already-slug";  "!!!" -> "".',
      'Return ONLY a single TypeScript code block.',
    ].join('\n'),
    driver: header + [
      'import { slugify } from "./solution";',
      'assert.equal(slugify("Hello, World!"), "hello-world");',
      'assert.equal(slugify("  A__B  "), "a-b");',
      'assert.equal(slugify("already-slug"), "already-slug");',
      'assert.equal(slugify("!!!"), "");',
      'assert.equal(slugify("Foo   Bar 42"), "foo-bar-42");',
      'console.log("ok");',
    ].join('\n'),
  },
  {
    id: 'clamp-fix',
    kind: 'fix',
    prompt: [
      'The following function is supposed to clamp x into the inclusive range',
      '[min, max], but it has a bug:',
      '',
      '```ts',
      'export function clamp(x: number, min: number, max: number): number {',
      '  if (x < min) return max;',
      '  if (x > max) return min;',
      '  return x;',
      '}',
      '```',
      '',
      'Fix the bug. Return ONLY the corrected function in a single TypeScript code block.',
    ].join('\n'),
    driver: header + [
      'import { clamp } from "./solution";',
      'assert.equal(clamp(5, 0, 10), 5);',
      'assert.equal(clamp(-3, 0, 10), 0);',
      'assert.equal(clamp(99, 0, 10), 10);',
      'assert.equal(clamp(0, 0, 10), 0);',
      'assert.equal(clamp(10, 0, 10), 10);',
      'console.log("ok");',
    ].join('\n'),
  },
  {
    id: 'parse-kv',
    kind: 'parse',
    prompt: [
      'Implement and export a TypeScript function with this exact signature:',
      '',
      '  export function parseKeyValues(text: string): Record<string, string>',
      '',
      'Parse newline-separated "key=value" lines into an object. Rules:',
      '- Split each line on the FIRST "=" only (values may contain "=").',
      '- Trim whitespace around both key and value.',
      '- Skip blank lines and any line with no "=".',
      '- Later duplicate keys overwrite earlier ones.',
      'Example: "a = 1\\n\\nb=x=y\\nnope\\na=2" -> { a: "2", b: "x=y" }.',
      'Return ONLY a single TypeScript code block.',
    ].join('\n'),
    driver: header + [
      'import { parseKeyValues } from "./solution";',
      'assert.deepEqual(parseKeyValues("a = 1\\n\\nb=x=y\\nnope\\na=2"), { a: "2", b: "x=y" });',
      'assert.deepEqual(parseKeyValues(""), {});',
      'assert.deepEqual(parseKeyValues("  k =  v  "), { k: "v" });',
      'console.log("ok");',
    ].join('\n'),
  },
];

export const TOTAL_TASKS = CODING_TASKS.length;
