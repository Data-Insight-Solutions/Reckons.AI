import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';
import { checkDocsStatus } from '../offline/docs-status';
import { STATUS_GRAPHS, statusIndex, resolveStatus, renderStatusSummary } from '../docs-pages';

const HEAD = `@prefix feat: <urn:reckons:feature/> .
@prefix kb: <urn:kbase:concept/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix ktype: <urn:kbase:type/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
`;
const parse = (ttl: string) => new Parser().parse(HEAD + ttl);
const roadmap = statusIndex(parse(`kb:built kpred:has-status "production" . kb:idea kpred:has-status "planned" .`));

describe('checkDocsStatus', () => {
  it('takes a mapped capability\'s status from the roadmap', () => {
    const { problems, rows } = checkDocsStatus(parse(`
      feat:A a ktype:Concept ; skos:exactMatch kb:built .
      feat:B a ktype:Concept ; skos:broadMatch kb:idea .
      feat:Page a ktype:Concept ; kpred:status-not-applicable "a reading guide" .`), roadmap);
    expect(problems).toEqual([]);
    expect(rows.map((r) => [r.iri.split('/').pop(), r.status, r.via])).toEqual([
      ['A', 'production', 'exact'], ['B', 'planned', 'broad'], ['Page', null, 'n/a'],
    ]);
  });

  it('fails a capability with no status at all', () => {
    const { problems } = checkDocsStatus(parse(`feat:Orphan a ktype:Concept .`), roadmap);
    expect(problems).toEqual([expect.stringContaining('Orphan has no status')]);
  });

  it('fails a capability that states its own status beside a mapping — the Git Analysis case', () => {
    const { problems } = checkDocsStatus(parse(`feat:Git a ktype:Concept ; skos:exactMatch kb:built ; kpred:has-status "functional" .`), roadmap);
    expect(problems).toEqual([expect.stringContaining('AND a roadmap mapping')]);
  });

  it('fails a mapping to a roadmap entity that has no status', () => {
    const { problems } = checkDocsStatus(parse(`feat:C a ktype:Concept ; skos:exactMatch kb:missing .`), roadmap);
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining('maps to urn:kbase:concept/missing')]));
  });

  it('holds for the real docs and roadmap graphs', () => {
    const read = (f: string) => new Parser().parse(readFileSync(join('static', f), 'utf8'));
    const docs = readdirSync('static').filter((f) => f.startsWith('docs-') && f.endsWith('.ttl') && f !== 'docs-all.ttl');
    const { problems, rows } = checkDocsStatus(docs.flatMap(read), statusIndex(STATUS_GRAPHS.flatMap(read)));
    expect(problems).toEqual([]);
    expect(rows.filter((r) => r.status).length).toBeGreaterThan(30);
  });
});

describe('resolveStatus', () => {
  const entity = (iri: Record<string, string[]>, lit: Record<string, string[]> = {}) => ({
    iriProps: new Map(Object.entries(iri)), literalProps: new Map(Object.entries(lit)),
  });
  it('prefers an exact match, then a broader one, then the entity\'s own literal', () => {
    const exact = 'http://www.w3.org/2004/02/skos/core#exactMatch', broad = 'http://www.w3.org/2004/02/skos/core#broadMatch';
    const own = 'urn:kbase:predicate/has-status';
    expect(resolveStatus(entity({ [exact]: ['urn:kbase:concept/idea'], [broad]: ['urn:kbase:concept/built'] }), roadmap)?.status).toBe('planned');
    expect(resolveStatus(entity({ [broad]: ['urn:kbase:concept/built'] }), roadmap)?.via).toBe('broad');
    expect(resolveStatus(entity({}, { [own]: ['scaffolded'] }), roadmap)).toEqual({ status: 'scaffolded', via: 'own' });
    expect(resolveStatus(entity({}), roadmap)).toBeNull();
  });
});

describe('renderStatusSummary', () => {
  it('groups capabilities by status, links each, and names the host page when it is shared', () => {
    const refs = new Map([
      ['a', { slug: 'a', section: 'Features', title: 'Alpha' }],
      ['b', { slug: 'shelly', section: 'Features', title: 'Shelly' }],
    ]);
    const md = renderStatusSummary(
      [{ iri: 'a', status: 'production' }, { iri: 'b', status: 'planned' }],
      refs, (iri) => (iri === 'a' ? 'Alpha' : 'Story System'),
    ).join('\n');
    expect(md).toContain('## Works today (1)');
    expect(md).toContain('- [Alpha](../features/a) · production');
    expect(md).toContain('## Not built yet (1)');
    expect(md).toContain('- [Story System](../features/shelly) · planned — on the Shelly page');
    expect(md).toContain('## Partly built (0)');
  });
});
