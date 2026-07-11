import { describe, it, expect } from 'vitest';
import { kbToGraphText, sweepKbToGraph } from '../terminology';

describe('kbToGraphText', () => {
  it('maps knowledge base(s) case-preserving', () => {
    expect(kbToGraphText('your knowledge base').out).toBe('your knowledge graph');
    expect(kbToGraphText('Knowledge Base').out).toBe('Knowledge Graph');
    expect(kbToGraphText('two knowledge bases').out).toBe('two knowledge graphs');
  });

  it('maps the KB/KBs acronym to lowercase mid-sentence', () => {
    expect(kbToGraphText('build your KB today').out).toBe('build your graph today');
    expect(kbToGraphText('import other KBs as sources').out).toBe('import other graphs as sources');
  });

  it('capitalizes at a sentence start', () => {
    expect(kbToGraphText('KB of your rights').out).toBe('Graph of your rights');
    expect(kbToGraphText('Done. KB ready').out).toBe('Done. Graph ready');
  });

  it('does not touch KBaseDB, kb: prefixes, or kilobytes', () => {
    expect(kbToGraphText('KBaseDB').out).toBe('KBaseDB');
    expect(kbToGraphText('kb:entity').out).toBe('kb:entity');
    expect(kbToGraphText('a 64 KB file').out).toBe('a 64 KB file');
  });
});

describe('sweepKbToGraph — literals only', () => {
  it('rewrites inside literals but never IRIs or prefixes', () => {
    const ttl = [
      'kb:my-kb rdf:type ktype:KnowledgeBase ;',
      '    rdfs:label "My KB" ;',
      '    rdfs:comment "Import this KB into your knowledge base." ;',
      '    p:x <urn:kbase:concept/kb-thing> .',
    ].join('\n');
    const { out } = sweepKbToGraph(ttl);
    expect(out).toContain('"My graph"');
    expect(out).toContain('"Import this graph into your knowledge graph."');
    // identifiers untouched
    expect(out).toContain('kb:my-kb');
    expect(out).toContain('ktype:KnowledgeBase');
    expect(out).toContain('<urn:kbase:concept/kb-thing>');
  });
});
