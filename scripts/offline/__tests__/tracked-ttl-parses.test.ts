import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';

/**
 * EVERY tracked .ttl parses. graph-lint reads static/ graphs it knows about; this reads them all
 * (83 files, ~0.3 s on 2026-11-13). Two were broken that day and no check saw either:
 * reckons-workspace/schedules.ttl (an unescaped quote — it crashed the queue worker and silently
 * dropped every schedule) and static/examples/README.ttl (rdf: used, never declared).
 */
const files = execSync("git ls-files '*.ttl'", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

describe('every tracked Turtle file parses', () => {
  it('finds the tracked files', () => expect(files.length).toBeGreaterThan(50));
  it.each(files)('%s', (file) => {
    expect(() => new Parser({ baseIRI: 'urn:reckons:base/' }).parse(readFileSync(file, 'utf8'))).not.toThrow();
  });
});
