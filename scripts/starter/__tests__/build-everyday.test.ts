import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importTurtleFull } from '../../../src/lib/rdf/import-ttl';
import { buildReviewed, factKey, OUT, render, stableId, STARTER, TEXT_DIR } from '../build-everyday';
import { checkDraft, readPlan } from '../draft-sample-sources';

// Synthetic texts: one sentence per fact, built from its required words. Real texts are drafted
// by a local model and approved by a person; the build rules do not depend on which.
const plan = readPlan();
const texts = Object.fromEntries(plan.sources.map((s) => [s.id, s.facts.map((f) => `${f.by ?? 'Note'}: ${f.must.join(' and ')}.`).join('\n') + '\n']));
const starterTtl = readFileSync(STARTER, 'utf8');

describe('build-everyday', () => {
  it('annotates every planned fact and reports no problems', async () => {
    const r = await buildReviewed({ starterTtl, plan, texts });
    expect(r.problems).toEqual([]);
    expect(r.sources).toHaveLength(8); // seven samples and the curated example
    const planned = plan.sources.flatMap((s) => s.facts);
    for (const f of planned) {
      const st = r.statements.find((s) => factKey(s) === f.fact);
      expect(st, f.fact).toBeDefined();
      expect(texts[st!.sourceId!]).toContain(st!.excerpt!); // the passage is in the source
      expect(st!.status).toBe(f.status ?? 'confirmed');
      if ((f.status ?? 'confirmed') !== 'pending') expect(st!.settledBy?.channel).toBe('review');
      else expect(st!.settledBy).toBeUndefined();
    }
  });

  it('records the replaced price as superseded, linked from its replacement', async () => {
    const r = await buildReviewed({ starterTtl, plan, texts });
    const now = r.statements.find((s) => factKey(s) === 'oh-ridge|nightly-rate|$23')!;
    const old = r.statements.find((s) => factKey(s) === 'oh-ridge|nightly-rate|$25')!;
    expect(now.supersedes).toBe(old.id);
    expect(old.status).toBe('superseded');
  });

  it('fails by name when a passage is not in its source', async () => {
    const broken = { ...texts, 'sample-oh-ridge': texts['sample-oh-ridge'].replace('$23', '23 dollars') };
    const r = await buildReviewed({ starterTtl, plan, texts: broken });
    expect(r.problems.join('\n')).toContain('"$23"');
  });

  it('is deterministic and survives the app importer: statuses, sources, excerpts and reviewers', async () => {
    const a = render(await buildReviewed({ starterTtl, plan, texts }));
    const b = render(await buildReviewed({ starterTtl, plan, texts }));
    expect(a).toBe(b);
    const back = await importTurtleFull(a);
    expect(back.sources.map((s) => s.id).sort()).toEqual([...plan.sources.map((s) => s.id), 'starter-curated'].sort());
    expect(back.statements.filter((s) => s.sourceId === 'imported')).toEqual([]);
    const counts = back.statements.reduce<Record<string, number>>((c, s) => ({ ...c, [s.status]: (c[s.status] ?? 0) + 1 }), {});
    expect(counts.pending).toBe(3);
    expect(counts.rejected).toBe(2);
    expect(counts.superseded).toBe(1);
    const rate = back.statements.find((s) => s.id === stableId('oh-ridge|nightly-rate|$23'))!;
    expect(rate.sourceId).toBe('sample-oh-ridge');
    expect(rate.excerpt).toContain('$23');
    expect(rate.settledBy?.actor).toBe('Alex');
  });

  it('routes the three pending facts to the person, not to a reviewing agent a first visit does not have', async () => {
    const { buildReviewPlan } = await import('../../../src/lib/rdf/review-pipeline');
    const back = await importTurtleFull(render(await buildReviewed({ starterTtl, plan, texts })));
    const pending = back.statements.filter((s) => s.status === 'pending');
    const routed = buildReviewPlan(pending, {}, back.statements).routed;
    expect(routed.user).toHaveLength(3);
    expect(routed.agent).toHaveLength(0);
    for (const s of pending) expect(s.excerpt).toBeTruthy(); // the passage is still shown
  });
});

describe('the committed starter', () => {
  const real = Object.fromEntries(plan.sources.map((s) => [s.id, readFileSync(`${TEXT_DIR}/${s.id}.md`, 'utf8')]));
  it('every approved sample text passes the drafting checks (no invented figure, no leaked prompt words)', () => {
    for (const s of plan.sources) expect(checkDraft(s, real[s.id]).problems, s.id).toEqual([]);
  });
  it('static/starter-everyday-reviewed.ttl is exactly what the generator writes (run build-everyday.ts)', async () => {
    const r = await buildReviewed({ starterTtl, plan, texts: real });
    expect(r.problems).toEqual([]);
    expect(readFileSync(OUT, 'utf8')).toBe(render(r));
  });
});
