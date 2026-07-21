import { describe, it, expect } from 'vitest';
import { parseCodexOutput } from '../lib/codex.js';

describe('parseCodexOutput — schema-constrained output, honest on junk', () => {
  it('parses a well-formed findings object', () => {
    const raw = JSON.stringify({
      findings: [
        { file: 'src/a.ts', text: 'null deref when list is empty' },
        { text: 'missing await on the ingest promise' },
      ],
    });
    const r = parseCodexOutput(raw);
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toEqual({ file: 'src/a.ts', text: 'null deref when list is empty' });
    expect(r.findings[1].file).toBeUndefined();
  });

  it('strips a stray ```json code fence before parsing', () => {
    const raw = '```json\n{"findings":[{"text":"off-by-one"}]}\n```';
    const r = parseCodexOutput(raw);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([{ file: undefined, text: 'off-by-one' }]);
  });

  it('treats empty output as a clean review (no findings), not a failure', () => {
    expect(parseCodexOutput('   ').ok).toBe(true);
    expect(parseCodexOutput('   ').findings).toHaveLength(0);
  });

  it('drops findings with no usable text rather than emitting blanks', () => {
    const raw = JSON.stringify({ findings: [{ text: '' }, { file: 'x' }, { text: '  real  ' }] });
    const r = parseCodexOutput(raw);
    expect(r.findings).toEqual([{ file: undefined, text: 'real' }]);
  });

  it('fails HONESTLY on output that does not match the schema — never fabricates a finding', () => {
    const r = parseCodexOutput('the diff looks fine to me, no issues really');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not match/i);
    expect(r.findings).toHaveLength(0);
    expect(r.raw).toContain('looks fine');
  });
});
