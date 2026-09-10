/**
 * Docs graph registration (F187.0) — the four registries must agree.
 *
 * The check exists because docs-user-paths.ttl was named in `scripts/docs-pages.ts` and in none
 * of the other three lists, so `npm run docs:compose` would have deleted 21 published pages while
 * the orphan gate reported nothing dropped. These tests pin the two properties that make the
 * check worth having:
 *
 *   - it reads the ARRAY LITERAL, not the file text, so a graph named only in a comment or a
 *     doc-string does not count as registered — which is precisely how the real fault hid;
 *   - it fails when a registry parses to nothing, rather than reporting all-clear. A check that
 *     silently stops checking is the same failure it exists to catch, one level up.
 *
 * The last test runs the real script against the real repository, so the registries and the
 * graphs on disk have to actually agree — not just the parser.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arrayLiteralEntries, EXEMPT, REGISTRIES } from '../offline/docs-graph-registration';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');

describe('reading a registry array literal', () => {
  it('finds the graphs named inside the array', () => {
    const src = `const CORPUS = [\n  'docs-llm.ttl', 'starter-guide.ttl',\n];`;
    expect([...arrayLiteralEntries(src, 'CORPUS')].sort()).toEqual(['docs-llm.ttl', 'starter-guide.ttl']);
  });

  it('does NOT count a graph mentioned only in a comment — the whole point', () => {
    const src = `
      // docs-user-paths.ttl is handled elsewhere, see the module doc.
      const CORPUS = [
        'docs-llm.ttl',
      ];`;
    const found = arrayLiteralEntries(src, 'CORPUS');
    expect(found.has('docs-llm.ttl')).toBe(true);
    expect(found.has('docs-user-paths.ttl')).toBe(false);
  });

  it('returns nothing for a registry that is not there, rather than guessing', () => {
    expect(arrayLiteralEntries(`const OTHER = ['docs-llm.ttl'];`, 'CORPUS').size).toBe(0);
  });

  it('accepts single or double quotes, since both appear across these files', () => {
    const src = `const CORPUS = [\n  "docs-llm.ttl",\n  'docs-testing.ttl',\n];`;
    expect(arrayLiteralEntries(src, 'CORPUS').size).toBe(2);
  });
});

describe('the registries themselves', () => {
  it('reads a non-empty list from every registry — an empty one means it stopped checking', () => {
    for (const r of REGISTRIES) {
      const entries = r.read(readFileSync(join(ROOT, r.file), 'utf8'));
      expect(entries.size, `${r.label} parsed to zero graphs`).toBeGreaterThan(0);
    }
  });

  it('states a reason for every exemption, so nothing is quietly excused', () => {
    for (const [file, why] of Object.entries(EXEMPT)) {
      expect(why.trim().length, `${file} is exempt with no stated reason`).toBeGreaterThan(20);
    }
  });

  it('registers docs-user-paths.ttl everywhere — the graph the incident was about', () => {
    for (const r of REGISTRIES) {
      const entries = r.read(readFileSync(join(ROOT, r.file), 'utf8'));
      expect(entries.has('docs-user-paths.ttl'), `missing from ${r.label}`).toBe(true);
    }
  });
});

describe('the check against the real repository', () => {
  it('passes, so the registries and static/ actually agree right now', () => {
    // Throws on a non-zero exit, which is the assertion.
    const out = execFileSync('npx', ['tsx', 'scripts/offline/docs-graph-registration.ts', '--quiet'], {
      cwd: ROOT, encoding: 'utf8',
    });
    expect(out).toMatch(/registered in all/);
  }, 60_000);
});
