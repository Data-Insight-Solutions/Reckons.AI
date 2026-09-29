import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { importTurtleFull } from '../import-ttl';
import { buildProvenanceIndex, filterProvenanceIndex } from '../provenance-view';
import type { Statement, Source } from '../types';

/**
 * The Sources view, against a graph with SEVERAL sources.
 *
 * SourcesExplorer.svelte and SourcesPanel.svelte had no test coverage of any kind, and the
 * reason was structural rather than neglectful: every fixture in the repository arrived from ONE
 * source, so the view's actual job — saying which source said a thing, and surfacing it when two
 * disagree — had nothing to act on. tests/fixtures/multi-source.ttl exists to give it something.
 *
 * These assert the pure layer the component renders (provenance-view.ts), not the markup, so they
 * fail on a provenance regression rather than on a class rename — the failure mode that left
 * preview-collage timing out for months against `.tg-chip`.
 */
describe('provenance across several sources', () => {
  let statements: Statement[];
  let sources: Source[];

  beforeAll(async () => {
    const ttl = readFileSync('tests/fixtures/multi-source.ttl', 'utf8');
    const result = await importTurtleFull(ttl);
    statements = result.statements;
    sources = result.sources;
  });

  it('imports every source with its kind, through the app importer', () => {
    expect(sources).toHaveLength(5);
    const byUri = new Map(sources.map((s) => [s.uri, s]));
    expect(byUri.get('note://2026-03-02-site-visit')?.kind).toBe('note');
    expect(byUri.get('note://2026-03-09-committee')?.kind).toBe('note');
    expect(byUri.get('file://correspondence/2026-03-11-bramley-quote.eml')?.kind).toBe('document');
    expect(byUri.get('file://correspondence/2026-03-14-key-access.thread')?.kind).toBe('document');
    expect(byUri.get('https://example.invalid/grants/community-buildings')?.kind).toBe('url');
  });

  it('offers more than one kind to filter by — the thing one source can never test', () => {
    const kinds = new Set(sources.map((s) => s.kind));
    expect(kinds.size).toBeGreaterThan(1);
    expect([...kinds].sort()).toEqual(['document', 'note', 'url']);
  });

  // RECORDED GAP, NOT AN OVERSIGHT. Source.kind has no `email` and no `thread`, so an email and a
  // message thread are both `document` and the kind filter cannot separate them. Pinning it here
  // means adding those kinds later breaks this test loudly instead of silently changing the view.
  it('cannot yet separate an email from a message thread, and says so', () => {
    const documents = sources.filter((s) => s.kind === 'document');
    expect(documents).toHaveLength(2);
    expect(documents.map((s) => s.title).sort()).toEqual([
      'Email — Bramley Roofing, revised quote',
      'Thread — hall key access (4 messages)'
    ]);
  });

  it('attributes every statement to a real source record, inventing none', () => {
    const index = buildProvenanceIndex(statements, sources);
    expect(index.sources.length).toBeGreaterThan(0);
    const known = new Set(sources.map((s) => s.id));
    for (const ps of index.sources) {
      // `source` is optional on ProvenanceSource — a statement can name a source id the graph
      // has no record for. The point of this assertion is that that NEVER happens here, so an
      // undefined one must fail rather than be skipped by an optional chain.
      expect(ps.source, 'every provenance node must carry its source record').toBeDefined();
      expect(known.has(ps.source!.id)).toBe(true);
    }
  });

  /**
   * THE CASE THAT JUSTIFIES THE VIEW. The committee note and the email both state a quoted
   * amount for the same contractor, and they disagree — 4200 against 4650. Provenance is the
   * only thing that can tell them apart, and a graph where every fact has one uncontested
   * source would never exercise it.
   */
  it('keeps both sides of a disagreement, each with its own source', () => {
    const quotes = statements.filter(
      (st) => st.p.value.endsWith('/quoted-amount') && st.status !== 'rejected'
    );
    expect(quotes).toHaveLength(2);

    const values = quotes.map((q) => q.o.value).sort();
    expect(values).toEqual(['4200', '4650']);

    const sourceIds = new Set(quotes.map((q) => q.sourceId));
    expect(sourceIds.size, 'the two figures must come from DIFFERENT sources').toBe(2);
  });

  it('groups one entity that several sources talk about', () => {
    const hall = statements.filter(
      (st) => st.s.value.endsWith('/village-hall') && st.status !== 'rejected'
    );
    const contributing = new Set(hall.map((st) => st.sourceId).filter(Boolean));
    expect(contributing.size, 'village-hall should carry facts from more than one source')
      .toBeGreaterThan(1);
  });

  it('filters to pending without losing the contested pair', () => {
    const index = buildProvenanceIndex(statements, sources);
    const pending = filterProvenanceIndex(index, 'pending');
    const confirmed = filterProvenanceIndex(index, 'confirmed');
    expect(pending.sources.length).toBeGreaterThan(0);
    expect(confirmed.sources.length).toBeGreaterThan(0);
    // Both quoted-amount statements are pending, so a pending filter must keep both sources.
    const pendingSourceIds = new Set(pending.sources.map((s) => s.source?.id).filter(Boolean));
    expect(pendingSourceIds.size).toBeGreaterThan(1);
  });

  // REFRESHABLE_KINDS is url/repository/calendar. A note cannot be re-fetched and neither can an
  // email somebody sent you, which is why the fixture carries exactly one refreshable source.
  it('has exactly one source that could be re-fetched', () => {
    const refreshable = sources.filter((s) => ['url', 'repository', 'calendar'].includes(s.kind));
    expect(refreshable).toHaveLength(1);
    expect(refreshable[0].kind).toBe('url');
  });
});
