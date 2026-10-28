import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SH = resolve(__dirname, '../local-claude.sh');
function window(ctx: number) {
  const r = spawnSync('bash', [SH, `--ctx=${ctx}`], {
    env: { ...process.env, RECKONS_DEPUTY_PRINT_WINDOW: '1' },
    encoding: 'utf8'
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe('local-claude compaction threshold = max(100k, 3/4 of window)', () => {
  it('uses 3/4 on large windows (160k -> 122880)', () => {
    expect(window(163840).out).toBe('122880');
  });
  it('clamps to 100000 at gpt-oss native maximum (131072)', () => {
    const r = window(131072);
    expect(r.code).toBe(0);
    expect(r.out).toBe('100000');
  });
  it('refuses windows where 100k leaves under 24k headroom', () => {
    const r = window(98304);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/too small/);
  });
});
