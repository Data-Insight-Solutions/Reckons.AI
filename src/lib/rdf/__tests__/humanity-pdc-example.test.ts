import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import { importTurtleFull } from '../import-ttl';
import { toTurtleFull } from '../serialize';
import { extractStories } from '../story';
import { HUMANITY_PDC_EXAMPLE } from '../../examples/humanity-pdc';

const ttl = readFileSync('static/example-humanity-pdc.ttl', 'utf8');
// n3 ships no type declarations and @types/n3 is not installed, so under the app tsconfig
// `type Quad` resolves to a namespace and fails `npm run check` — which CI blocks on. This is
// the only n3 import under src/; everywhere else it is used from scripts/ or mcp-server/, which
// typecheck separately. The test reads one field, so it states that shape locally rather than
// adding a typings dependency for a single length assertion.
const authored = new Parser({ format: 'TriG' })
  .parse(readFileSync('static/examples/humanity-pdc.trig', 'utf8')) as Array<{ graph: { termType: string } }>;
const data = authored.filter((q) => q.graph.termType === 'NamedNode');
const graph = await importTurtleFull(ttl);

describe('Humanity AI / PDC example remains a sourced proposal', () => {
  it('imports every authored fact with its source and pending review state', () => {
    expect(graph.cleanImportCount).toBe(0);
    expect(graph.statements).toHaveLength(data.length);
    expect(new Set(graph.statements.map((s) => s.id)).size).toBe(data.length);
    expect(graph.statements.every((s) => s.status === 'pending')).toBe(true);
    const sources = new Map(graph.sources.map((s) => [s.id, s]));
    for (const s of graph.statements) {
      expect(sources.has(s.sourceId), s.id).toBe(true);
      expect(s.g.value).toBe(`urn:kbase:source/${s.sourceId}`);
      expect(sources.get(s.sourceId)?.trustLevel).toBe('review');
    }
    expect(sources.get('humanity-call')?.uri).toBe('https://humanityai.ai/open-call/');
    expect(sources.get('explorer-proposal')?.uri.startsWith('urn:reckons:proposal/')).toBe(true);
    expect(sources.get('user-background')?.uri).not.toBe(sources.get('pdc-service')?.uri);
  });

  it('keeps source facts, local implementation and proposed PDC integration distinct through export', async () => {
    const again = await importTurtleFull(toTurtleFull(graph.statements, graph.sources));
    const facts = (subject: string) => again.statements.filter((s) => s.s.value === `urn:kbase:concept/${subject}`);
    expect(facts('pdc-explorer-proposal').every((s) => s.sourceId === 'explorer-proposal')).toBe(true);
    expect(facts('pdc-explorer-proposal')).toContainEqual(expect.objectContaining({
      p: { kind: 'iri', value: 'urn:kbase:predicate/has-status' }, o: { kind: 'literal', value: 'planned' },
    }));
    expect(facts('personal-notes').every((s) => s.sourceId === 'reckons-code')).toBe(true);
    expect(facts('reckons-builder').every((s) => s.sourceId === 'user-background')).toBe(true);
    expect(facts('humanity-ai-call').find((s) => s.p.value.endsWith('/deadline'))?.o.value)
      .toBe('2026-10-21T16:59:00-07:00');
    expect(again.statements.every((s) => s.status === 'pending')).toBe(true);
  });

  it('has a usable guided story and an accurate example card', () => {
    const subjects = new Set(graph.statements.map((s) => s.s.value));
    const stories = extractStories(graph.statements);
    expect(stories).toHaveLength(1);
    expect(stories[0].steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const step of stories[0].steps) for (const iri of step.highlights) expect(subjects.has(iri)).toBe(true);
    expect(subjects.size).toBe(HUMANITY_PDC_EXAMPLE.entities);
    expect(graph.statements.length).toBe(HUMANITY_PDC_EXAMPLE.triples);
    expect(graph.sources.length).toBe(HUMANITY_PDC_EXAMPLE.sources);
    expect(ttl).toContain(HUMANITY_PDC_EXAMPLE.stableId);
  });

  it('preserves both portable inputs in the combined graph and leaves eligibility unanswered', async () => {
    const combined = new Map(graph.statements.map((s) => [s.id, s]));
    const sourceMap = new Map(graph.sources.map((s) => [s.id, s]));
    const inputs = [];
    for (const file of ['example-humanity-opportunity.ttl', 'example-reckons-seeker.ttl']) {
      const input = await importTurtleFull(readFileSync(`static/${file}`, 'utf8'));
      expect(input.statements.length).toBeGreaterThan(0);
      for (const statement of input.statements) expect(combined.get(statement.id)).toEqual(statement);
      for (const source of input.sources) expect(sourceMap.get(source.id)).toEqual(source);
      inputs.push(input);
    }
    const opportunityIds = new Set(inputs[0].statements.map((s) => s.id));
    expect(inputs[1].statements.some((s) => opportunityIds.has(s.id))).toBe(false);
    const eligibility = graph.statements.filter((s) => s.s.value === 'urn:kbase:concept/alignment-eligibility');
    expect(eligibility.find((s) => s.p.value === 'urn:kbase:predicate/status')?.o.value).toBe('unknown');
    expect(eligibility.every((s) => s.sourceId === 'explorer-proposal' && s.status === 'pending')).toBe(true);
  });
});
