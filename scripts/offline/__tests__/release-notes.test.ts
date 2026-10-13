/**
 * Release notes (F33.1). The notes decide whether a promotion to main is blocked, so what counts
 * as a pull request, a change, and documentation is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { docsLinks, featureChanges, featureStates, parsePullRequests, renderMarkdown, releaseNotesPath } from '../release-notes';

const P = '@prefix kb: <urn:kbase:concept/> . @prefix kpred: <urn:kbase:predicate/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n';

describe('parsePullRequests', () => {
  it('reads both merge wordings, ignores branch syncs, and dedupes', () => {
    const log = [
      'Merge PR #321: local panel\x1f\x1f2026-09-30',
      'Merge pull request #290 from x/ruleset\x1fKeep the live ruleset in .github\x1f2026-09-30',
      "Merge remote-tracking branch 'origin/dev' into feat/x\x1f\x1f2026-09-30",
      'Merge PR #321: local panel\x1f\x1f2026-09-30',
    ].join('\n');
    expect(parsePullRequests(log)).toEqual([
      { number: 290, title: 'Keep the live ruleset in .github', date: '2026-09-30' },
      { number: 321, title: 'local panel', date: '2026-09-30' },
    ]);
  });
});

describe('featureChanges', () => {
  const before = featureStates(`${P}kb:a kpred:feature-id "F1" ; kpred:has-status "planned" ; rdfs:label "A" .\nkb:b kpred:feature-id "F2" ; kpred:has-status "functional" .`);
  const after = featureStates(`${P}kb:a kpred:feature-id "F1" ; kpred:has-status "functional" ; rdfs:label "A" .\nkb:b kpred:feature-id "F2" ; kpred:has-status "functional" .\nkb:c kpred:feature-id "F3" ; kpred:has-status "scaffolded" ; rdfs:label "C" .`);
  const changes = featureChanges(before, after);

  it('reports status moves and new features, not unchanged ones', () => {
    expect(changes.map((c) => [c.featureId, c.from, c.status])).toEqual([['F1', 'planned', 'functional'], ['F3', undefined, 'scaffolded']]);
  });

  it('uses the label when there is one', () => {
    expect(changes[0].label).toBe('A');
  });
});

describe('docs coverage', () => {
  const links = docsLinks([`${P}@prefix cw: <urn:reckons:docs/cw/> .\ncw:Page kpred:relates-to kb:a .`]);

  it('follows kpred:relates-to from a docs entity to the roadmap entity', () => {
    expect(links.get('urn:kbase:concept/a')).toEqual(['urn:reckons:docs/cw/Page']);
  });

  it('marks a feature that reached scaffolded or beyond without docs as UNDOCUMENTED, and nothing else', () => {
    const md = renderMarkdown({
      base: 'main', head: 'staging', prs: [],
      changes: [
        { iri: 'urn:kbase:concept/a', featureId: 'F1', label: 'A', status: 'functional', from: 'planned', docs: [{ entity: 'urn:reckons:docs/cw/Page', path: 'cw/page' }] },
        { iri: 'urn:kbase:concept/c', featureId: 'F3', label: 'C', status: 'scaffolded', docs: [] },
        { iri: 'urn:kbase:concept/d', featureId: 'F4', label: 'D', status: 'planned', docs: [] },
      ],
    });
    expect(md).toContain('**1 undocumented**');
    expect(md).toContain('| F1 A | planned → functional | [cw/page](/docs/cw/page) |');
    expect(md).toContain('| F3 C | new, scaffolded | **UNDOCUMENTED** |');
    expect(md).toContain('| F4 D | new, planned | — |');
    expect(md).toMatch(/Documentation owed before promotion to main[\s\S]*F3 C/);
  });
});

describe('a release is documented by its notes page', () => {
  it('maps a version to the release-notes path and reads the version from the graph', () => {
    expect(releaseNotesPath('0.2.5')).toBe('releases/v0-2-5');
    const ttl = '@prefix kpred: <urn:kbase:predicate/> . <urn:kbase:concept/release-0-2-5> kpred:version "0.2.5" ; kpred:has-status "functional" .';
    expect(featureStates(ttl).get('urn:kbase:concept/release-0-2-5')).toMatchObject({ status: 'functional', version: '0.2.5' });
  });
});
