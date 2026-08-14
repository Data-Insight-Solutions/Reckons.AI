/**
 * Page composition (F27) — a page declares the graph it is made from.
 *
 * The tests that matter here are the ones about what is NOT published. Consolidating 269
 * auto-generated pages into a dozen curated ones is an editorial act, and the only difference
 * between "curated" and "we silently lost 250 pages of content" is whether the leftovers are
 * reported. So orphan reporting is tested as a hard requirement, not a nicety.
 */
import { describe, it, expect } from 'vitest';
import {
  composePages, describeComposition, PageDefinitionError,
  type PageDefinition, type SourceEntity,
} from '../page-composition';

const ent = (over: Partial<SourceEntity> & { iri: string }): SourceEntity => ({
  graph: 'docs-architecture.ttl',
  title: over.iri.split('/').pop() ?? over.iri,
  definition: '',
  types: ['Concept'],
  ...over,
});

const ARCH = 'docs-architecture.ttl';
const FEAT = 'docs-features.ttl';

const entities: SourceEntity[] = [
  ent({ iri: 'kb:ttl-first', graph: ARCH, title: 'TTL-first docs', types: ['Concept'] }),
  ent({ iri: 'kb:style-guide', graph: ARCH, title: 'Style guide', types: ['Document'] }),
  ent({ iri: 'kb:ingest', graph: FEAT, title: 'Ingest', types: ['Feature'] }),
  ent({ iri: 'kb:review', graph: FEAT, title: 'Review', types: ['Feature'] }),
  ent({ iri: 'kb:internal-note', graph: ARCH, title: 'GUIDE.md → Superseded', types: ['Concept'] }),
];

const def = (over: Partial<PageDefinition> & { id: string }): PageDefinition => ({
  title: over.id,
  section: 'Docs',
  purpose: 'A stated reason to open this page.',
  sources: [],
  ...over,
});

describe('a page sources from a graph', () => {
  it('composes every entity in the declared graph onto one page', () => {
    const report = composePages(
      [def({ id: 'how-it-works', title: 'How it works', sources: [{ kind: 'graph', graph: FEAT }] })],
      entities,
    );
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0].entityCount).toBe(2);
    expect(report.pages[0].sections[0].entities.map((e) => e.title)).toEqual(['Ingest', 'Review']);
  });

  it('composes ONE page from SEVERAL graphs, grouped by where each part came from', () => {
    // The thing winner-takes-all resolveHomeFile() cannot express: it picks one owning file per
    // entity and drops the other's assertions.
    const report = composePages(
      [def({
        id: 'overview',
        title: 'Overview',
        sources: [{ kind: 'graph', graph: ARCH }, { kind: 'graph', graph: FEAT }],
      })],
      entities,
    );
    const [page] = report.pages;
    expect(page.entityCount).toBe(5);
    expect(page.sections.map((s) => s.graph)).toEqual([ARCH, FEAT]);
    expect(page.sections[1].entities.map((e) => e.title)).toEqual(['Ingest', 'Review']);
  });

  it('sources a single named entity — the "About page from at least one graph" case', () => {
    const report = composePages(
      [def({
        id: 'about',
        title: 'About',
        sources: [{ kind: 'entity', iri: 'kb:ttl-first' }],
      })],
      entities,
    );
    expect(report.pages[0].sections).toEqual([
      { graph: ARCH, entities: [expect.objectContaining({ iri: 'kb:ttl-first' })] },
    ]);
  });

  it('sources by type, optionally narrowed to one graph', () => {
    const all = composePages(
      [def({ id: 'features', sources: [{ kind: 'type', type: 'Feature' }] })],
      entities,
    );
    expect(all.pages[0].entityCount).toBe(2);

    const narrowed = composePages(
      [def({ id: 'features', sources: [{ kind: 'type', type: 'Feature', graph: ARCH }] })],
      entities,
    );
    expect(narrowed.pages[0].entityCount).toBe(0);
  });
});

describe('what is NOT published is reported', () => {
  it('names every entity no page claimed', () => {
    // The whole safety mechanism. Curating from 269 to a dozen pages means most entities lose
    // their own page; the difference from data loss is that this list exists.
    const report = composePages(
      [def({ id: 'features', sources: [{ kind: 'graph', graph: FEAT }] })],
      entities,
    );
    expect(report.orphans.map((e) => e.title)).toEqual([
      'GUIDE.md → Superseded', 'Style guide', 'TTL-first docs',
    ]);
  });

  it('reports nothing orphaned when every entity is claimed', () => {
    const report = composePages(
      [def({
        id: 'everything',
        sources: [{ kind: 'graph', graph: ARCH }, { kind: 'graph', graph: FEAT }],
      })],
      entities,
    );
    expect(report.orphans).toEqual([]);
  });

  it('reports an entity claimed by two pages instead of silently awarding it to one', () => {
    // resolveHomeFile() awards it to the first file and DROPS the other's assertions — which is
    // how a page can currently lose content it was asserted to have. Visible duplication is a
    // decision the author can act on; a silent drop is one they never learn about.
    const report = composePages(
      [
        def({ id: 'a', title: 'A', sources: [{ kind: 'graph', graph: FEAT }] }),
        def({ id: 'b', title: 'B', sources: [{ kind: 'type', type: 'Feature' }] }),
      ],
      entities,
    );
    expect(report.duplicated.map((d) => d.title)).toEqual(['Ingest', 'Review']);
    expect(report.duplicated[0].pages).toEqual(['a', 'b']);
    // And it really is on both pages, not arbitrarily dropped from one.
    expect(report.pages.every((p) => p.entityCount === 2)).toBe(true);
  });

  it('flags a page that matched nothing — usually a typo in a graph name', () => {
    const report = composePages(
      [def({ id: 'typo', sources: [{ kind: 'graph', graph: 'docs-architcture.ttl' }] })],
      entities,
    );
    expect(report.emptyPages).toEqual(['typo']);
  });
});

describe('definitions are validated before anything is composed', () => {
  it('refuses a page with no sources', () => {
    expect(() => composePages([def({ id: 'empty' })], entities))
      .toThrow(/about nothing/);
  });

  it('refuses a page with no stated purpose', () => {
    // The consolidation brief as a rule: a page nobody can state the point of is exactly what
    // 269 auto-generated pages already are.
    expect(() => composePages(
      [def({ id: 'x', purpose: '  ', sources: [{ kind: 'graph', graph: ARCH }] })],
      entities,
    )).toThrow(PageDefinitionError);
  });

  it('refuses two pages that resolve to the same file path', () => {
    expect(() => composePages(
      [
        def({ id: 'a', title: 'How It Works', section: 'Docs', sources: [{ kind: 'graph', graph: ARCH }] }),
        def({ id: 'b', title: 'how it works', section: 'Docs', sources: [{ kind: 'graph', graph: FEAT }] }),
      ],
      entities,
    )).toThrow(/same path/);
  });

  it('refuses duplicate ids', () => {
    expect(() => composePages(
      [
        def({ id: 'same', title: 'One', sources: [{ kind: 'graph', graph: ARCH }] }),
        def({ id: 'same', title: 'Two', sources: [{ kind: 'graph', graph: FEAT }] }),
      ],
      entities,
    )).toThrow(/Duplicate page id/);
  });
});

describe('the sentence shown to the author', () => {
  it('states the coverage AND the omission', () => {
    const report = composePages(
      [def({ id: 'features', title: 'Features', sources: [{ kind: 'graph', graph: FEAT }] })],
      entities,
    );
    const text = describeComposition(report);
    expect(text).toContain('1 page covering 2 entities');
    expect(text).toContain('3 entities are claimed by no page and would NOT be published');
  });

  it('does not invent caveats when there are none', () => {
    const report = composePages(
      [def({
        id: 'all',
        sources: [{ kind: 'graph', graph: ARCH }, { kind: 'graph', graph: FEAT }],
      })],
      entities,
    );
    expect(describeComposition(report)).toBe('1 page covering 5 entities.');
  });
});

describe('deliberate exclusion is not the same as an orphan', () => {
  // Conflating them is how a curated site quietly becomes a lossy one. An orphan is an entity
  // nobody decided about; an exclusion is a decision that carries its reason.
  const tree: SourceEntity[] = [
    ent({ iri: 'arch:MigrationStatus', graph: ARCH, title: 'Markdown migration' }),
    ent({ iri: 'arch:MigGuide', graph: ARCH, title: 'GUIDE.md → Superseded', parent: 'arch:MigrationStatus' }),
    ent({ iri: 'arch:MigKb', graph: ARCH, title: 'KB_VS_MARKDOWN.md → Superseded', parent: 'arch:MigrationStatus' }),
    ent({ iri: 'kb:ttl-first', graph: ARCH, title: 'TTL-first docs' }),
  ];
  const all = [def({ id: 'how', title: 'How it works', sources: [{ kind: 'graph', graph: ARCH }] })];

  it('keeps an excluded subtree off the page a graph-wide source would sweep it into', () => {
    const report = composePages(all, tree, [
      { id: 'migration-tracker', under: 'arch:MigrationStatus', reason: 'Internal bookkeeping.' },
    ]);
    expect(report.pages[0].sections[0].entities.map((e) => e.title))
      .toEqual(['Markdown migration', 'TTL-first docs']);
    expect(report.excluded.map((e) => e.title).sort())
      .toEqual(['GUIDE.md → Superseded', 'KB_VS_MARKDOWN.md → Superseded']);
  });

  it('reports the reason alongside each exclusion', () => {
    const report = composePages(all, tree, [
      { id: 'migration-tracker', under: 'arch:MigrationStatus', reason: 'Internal bookkeeping.' },
    ]);
    expect(report.excluded[0]).toMatchObject({ rule: 'migration-tracker', reason: 'Internal bookkeeping.' });
  });

  it('does not count an excluded entity as an orphan', () => {
    const report = composePages(
      [def({ id: 'nothing', sources: [{ kind: 'entity', iri: 'kb:ttl-first' }] })],
      tree,
      [{ id: 'r', under: 'arch:MigrationStatus', reason: 'Internal.' }],
    );
    expect(report.orphans.map((e) => e.title)).toEqual(['Markdown migration']);
    expect(report.excluded).toHaveLength(2);
  });

  it('excludes a single entity by IRI', () => {
    const report = composePages(all, tree, [{ id: 'one', entity: 'kb:ttl-first', reason: 'Draft.' }]);
    expect(report.excluded.map((e) => e.iri)).toEqual(['kb:ttl-first']);
  });

  it('refuses an exclusion with no stated reason', () => {
    expect(() => composePages(all, tree, [{ id: 'silent', under: 'arch:MigrationStatus', reason: ' ' }]))
      .toThrow(/silent drop/);
  });

  it('survives a skos:broader cycle instead of hanging', () => {
    const cyclic: SourceEntity[] = [
      ent({ iri: 'a', graph: ARCH, title: 'A', parent: 'b' }),
      ent({ iri: 'b', graph: ARCH, title: 'B', parent: 'a' }),
    ];
    const report = composePages(
      [def({ id: 'p', sources: [{ kind: 'graph', graph: ARCH }] })],
      cyclic,
      [{ id: 'r', under: 'nowhere', reason: 'Internal.' }],
    );
    expect(report.pages[0].entityCount).toBe(2);
  });
});
