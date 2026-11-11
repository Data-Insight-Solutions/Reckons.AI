import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importTurtleFull } from '../../../src/lib/rdf/import-ttl.js';
import { standingOf } from '../../../src/lib/rdf/statement-standing.js';
import { buildGarden, validateStory } from '../build-garden.js';
import * as S from '../garden-story.js';

/** The review story is deterministic and validates; an unmade picture leaves its slot empty. Synthetic data only. */
describe('the garden review story', () => {
  it('validates: quotes are in their sources, citations exist, the proposal passes its shape, every question blocks an option', () => {
    expect(validateStory()).toEqual([]);
  });

  it('writes all four standings, two options with one recommended, three questions that name what they block, and no placeholder for empty slots', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'garden-'));
    try {
      const r = await buildGarden(dir);
      const again = await buildGarden(dir);
      expect(again.ttl).toBe(r.ttl); // deterministic
      const { statements, sources } = await importTurtleFull(r.ttl);
      expect(new Set(statements.map(standingOf))).toEqual(new Set(['held', 'pending', 'proposed', 'question']));
      expect(new Set(statements.map((s) => s.proposalOption).filter(Boolean))).toEqual(new Set(S.OPTIONS.map((o) => o.id)));
      expect(statements.filter((s) => s.p.value.endsWith('recommended-option'))).toHaveLength(1);
      const questions = statements.filter((s) => s.needsObject);
      expect(questions).toHaveLength(3);
      for (const q of questions) expect(q.blocks?.length).toBeGreaterThan(0);
      expect(sources.length).toBeGreaterThanOrEqual(5);
      expect(statements.filter((s) => s.excerpt && s.grounded).length).toBeGreaterThan(20);
      // nothing generated: no preview, no scan, and each empty slot is said so
      expect(statements.some((s) => s.p.value === 'urn:kbase:asset/preview' || s.p.value === 'urn:kbase:predicate/splat')).toBe(false);
      expect(r.empty).toEqual(expect.arrayContaining(['picture: overview', 'scan: north-lawn']));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('attaches a generated scan with the real attach code: linked to its capture, and an unlinked one asks its question', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'garden-'));
    try {
      for (const slot of ['north-lawn', 'flooded-footpath']) {
        const g = path.join(dir, 'assets', 'generated', slot);
        mkdirSync(g, { recursive: true });
        writeFileSync(path.join(g, 'splat.ply'), `fake splat bytes for ${slot}`); // a stand-in file for the attach code to hash; never shipped
      }
      const r = await buildGarden(dir);
      const { statements } = await importTurtleFull(r.ttl);
      const link = statements.filter((s) => s.p.value === 'urn:kbase:predicate/reconstructed-from' && !s.needsObject);
      expect(link).toHaveLength(1);
      expect(link[0].o.value).toBe('urn:kbase:concept/capture-north');
      expect(statements.filter((s) => s.needsObject && s.question === 'Which capture is this a scan of?')).toHaveLength(1);
      expect(statements.filter((s) => s.p.value === 'urn:kbase:predicate/splat')).toHaveLength(2);
      expect(existsSync(path.join(dir, 'assets', 'previews'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the draft walk has 6 to 9 steps and every narration line avoids the words a first-time viewer would not know', () => {
    expect(S.WALK.length).toBeGreaterThanOrEqual(6);
    expect(S.WALK.length).toBeLessThanOrEqual(9);
    for (const step of S.WALK) expect(step.narration).not.toMatch(/\b(statement|node|predicate|triple|graph|RDF)\b/i);
  });
});
