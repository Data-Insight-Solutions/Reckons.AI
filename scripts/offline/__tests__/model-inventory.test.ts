import { describe, expect, it } from 'vitest';
import { defaultsInSource, flagsInConfig, missing, withTag } from '../model-inventory';

describe('model inventory', () => {
  it('finds tagged model defaults on model lines, not tags, URLs or comments', () => {
    const src = [
      "const MODEL = flag('model') ?? 'qwen3:32b';",
      "const model = arg('model', 'qwen3-coder:latest');",
      " * the old default was 'qwen3.6:latest'",
      "const url = 'http://localhost:11434'; // model host",
      "const label = 'release:0.2.6';",
      "const who = flag('model') ?? 'opus';",
    ].join('\n');
    expect(defaultsInSource('a.ts', src)).toEqual([
      { model: 'qwen3:32b', where: 'a.ts:1' },
      { model: 'qwen3-coder:latest', where: 'a.ts:2' },
    ]);
  });

  it('reads --model and --models flags from config, adding :latest', () => {
    expect(flagsInConfig('s.ttl', 'kpred:command "x --models=gemma3:27b,qwen3.8" ;\n"--model=nuextract"'))
      .toEqual([
        { model: 'gemma3:27b', where: 's.ttl:1' },
        { model: 'qwen3.8:latest', where: 's.ttl:1' },
        { model: 'nuextract:latest', where: 's.ttl:2' },
      ]);
  });

  it('reports what is missing, grouped by model, treating a bare name as :latest', () => {
    const gone = missing(
      [{ model: 'qwen3.6:latest', where: 'a.ts:1' }, { model: 'qwen3.6', where: 'b.ts:2' }, { model: 'qwen3.8', where: 'c.ts:3' }],
      ['qwen3.8:latest', 'qwen3.8-160k:latest'],
    );
    expect([...gone]).toEqual([['qwen3.6:latest', ['a.ts:1', 'b.ts:2']]]);
    expect(withTag('x:7b')).toBe('x:7b');
  });
});
