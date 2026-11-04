import { describe, expect, it } from 'vitest';
import { buildEntityTypesPrompt, type EntitySummary } from '../re-analyze';
import { BUILT_IN_TYPES } from '$lib/rdf/entity-types';

/** One synthetic entity — no real user data. */
const entity: EntitySummary = {
  iri: 'urn:kbase:program/launch-campaign',
  label: 'Launch Campaign',
  currentTypeIri: null,
  currentTypeLabel: null,
  predicates: [],
  statementCount: 1,
  sourceCount: 1,
  isIsland: false,
};

const CUSTOM = { iri: 'urn:kbase:type/program-phase', label: 'Program Phase', description: 'A phase within a program' };

describe('buildEntityTypesPrompt custom types', () => {
  it('lists a custom type\'s label and IRI when passed', () => {
    const prompt = buildEntityTypesPrompt([entity], undefined, undefined, undefined, [CUSTOM]);
    expect(prompt).toContain(CUSTOM.label);
    expect(prompt).toContain(CUSTOM.iri);
    expect(prompt).toContain('CUSTOM TYPES (defined in this knowledge base');
  });

  it('places custom types after the built-ins', () => {
    const prompt = buildEntityTypesPrompt([entity], undefined, undefined, undefined, [CUSTOM]);
    const firstBuiltin = prompt.indexOf(BUILT_IN_TYPES[0].iri);
    const custom = prompt.indexOf(CUSTOM.iri);
    expect(firstBuiltin).toBeGreaterThan(-1);
    expect(custom).toBeGreaterThan(firstBuiltin);
  });

  it('is byte-identical to the old prompt when no custom types are passed', () => {
    const plain = buildEntityTypesPrompt([entity], 'Test KB', 'A test KB', 'guidance text');
    expect(buildEntityTypesPrompt([entity], 'Test KB', 'A test KB', 'guidance text')).toBe(plain);
    expect(buildEntityTypesPrompt([entity], 'Test KB', 'A test KB', 'guidance text', [])).toBe(plain);
    expect(buildEntityTypesPrompt([entity], 'Test KB', 'A test KB', 'guidance text', undefined)).toBe(plain);
    expect(plain).not.toContain('CUSTOM TYPES');
  });

  it('does not duplicate a custom entry whose IRI is a built-in', () => {
    const builtin = BUILT_IN_TYPES[0];
    const prompt = buildEntityTypesPrompt([entity], undefined, undefined, undefined, [
      { iri: builtin.iri, label: 'Impostor', description: 'should not appear' },
      CUSTOM,
    ]);
    expect(prompt).not.toContain('Impostor');
    expect(prompt.match(new RegExp(escaped(builtin.iri), 'g'))).toHaveLength(1);
    expect(prompt).toContain(CUSTOM.iri);
  });
});

function escaped(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
