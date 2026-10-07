import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { classify, insertHasFiles, isCode, readCoverageRatchet, readLinks } from '../codebase-coverage';

const PRE = '@prefix kpred: <urn:kbase:predicate/> .\n@prefix code: <urn:reckons:code/> .\n@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix ktype: <urn:kbase:type/> .\n';

describe('codebase coverage (2026-10-07)', () => {
  it('counts code, not vendored assets, generated pages or declarations', () => {
    expect(isCode('src/lib/rdf/diff.ts')).toBe(true);
    expect(isCode('scripts/agent/session-heartbeat.sh')).toBe(true);
    expect(['static/draco/x.js', 'content/a.md', 'src/app.d.ts', 'README.md'].some(isCode)).toBe(false);
  });

  it('assigns by test name first, then by a module that is ABOUT the folder', () => {
    const ttl = PRE + 'code:rdf rdf:type ktype:Concept ;\n  kpred:has-file "src/lib/rdf/a.ts" ;\n  kpred:has-file "src/lib/rdf/b.ts" ;\n  kpred:has-file "src/lib/rdf/c.ts" .\n'
      + 'code:audit rdf:type ktype:Concept ;\n  kpred:has-file "scripts/offline/host.ts" ;\n  kpred:has-file "scripts/lib/x.ts" ;\n  kpred:has-file "scripts/lib/y.ts" ;\n  kpred:has-file "scripts/lib/z.ts" .\n';
    const links = readLinks([{ path: 'g.ttl', ttl }]);
    const code = ['src/lib/rdf/a.ts', 'src/lib/rdf/b.ts', 'src/lib/rdf/c.ts', 'src/lib/rdf/d.ts', 'src/lib/rdf/__tests__/a.test.ts',
      'scripts/offline/host.ts', 'scripts/offline/job.ts', 'scripts/lib/x.ts', 'scripts/lib/y.ts', 'scripts/lib/z.ts', 'tools/new.ts'];
    const got = Object.fromEntries(classify(code, links).map((u) => [u.file, u.kind === 'sibling' ? u.module.split('/').pop() : u.kind]));
    expect(got['src/lib/rdf/__tests__/a.test.ts']).toBe('rdf');   // test name
    expect(got['src/lib/rdf/d.ts']).toBe('rdf');                  // 3 owned, affinity 3/3
    expect(got['scripts/offline/job.ts']).toBe('weak');            // a topic module with one file here
    expect(got['tools/new.ts']).toBe('none');
  });

  it('inserts inside the block, moving the terminator, and the result parses', () => {
    const ttl = PRE + 'code:rdf rdf:type ktype:Concept ;\n  kpred:has-file "src/lib/rdf/a.ts" .\n\ncode:other rdf:type ktype:Concept .\n';
    const r = insertHasFiles(ttl, 'rdf', ['src/lib/rdf/z.ts', 'src/lib/rdf/b.ts']);
    expect(r.inserted).toBe(2);
    expect(() => new Parser({ format: 'Turtle' }).parse(r.ttl)).not.toThrow();
    expect(r.ttl).toContain('kpred:has-file "src/lib/rdf/a.ts" ;\n  kpred:has-file "src/lib/rdf/b.ts" ;\n  kpred:has-file "src/lib/rdf/z.ts" .');
    expect(insertHasFiles(ttl, 'missing', ['x']).inserted).toBe(0);
  });

  it('reads the ratchet baseline', () => {
    expect(readCoverageRatchet('code:repo kpred:coverage-ratchet "unlinked/206" .')).toBe(206);
    expect(readCoverageRatchet('nothing here')).toBeNull();
  });
});
