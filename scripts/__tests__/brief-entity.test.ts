/** F273 PHASE 0 done-test, CLI half: `npm run brief -- --entity=<iri>` exit codes and output. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PFX = `@prefix kb: <urn:kbase:concept/> .\n@prefix kpred: <urn:kbase:predicate/> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
const run = (ttl: string, entity: string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'brief-')), 'r.ttl');
  writeFileSync(f, ttl);
  return spawnSync('npx', ['tsx', 'scripts/brief.ts', `--entity=${entity}`, `--ttl=${f}`], { encoding: 'utf8' });
};

describe('brief --entity', () => {
  it('exits non-zero and names what is missing', () => {
    const r = run(PFX + 'kb:j rdfs:label "J" ; kpred:feature-id "F1" ; kpred:evidence "e" .', 'kb:j');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('kpred:done-test');
    expect(r.stderr).toContain('kpred:non-goal');
    expect(r.stderr).not.toContain('kpred:evidence');
  });
  it('prints the brief with all four present', () => {
    const r = run(PFX + 'kb:j rdfs:label "J" ; kpred:feature-id "F1" ; kpred:evidence "e" ; kpred:done-test "d" ; kpred:extends "x" ; kpred:non-goal "n" .', 'kb:j');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LOCAL-TIER LEDGER');
    expect(r.stdout).toContain('F1');
  });
});
