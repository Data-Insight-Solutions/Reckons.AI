import { describe, expect, it } from 'vitest';
import { DOCS_MAX_BYTES, docsEncodeArgs, docsSizeProblem, posterArgs } from '../docs-output';

describe('docs video size rule', () => {
  it('accepts a video at or under 10 MB', () => {
    expect(docsSizeProblem(DOCS_MAX_BYTES, 'a.mp4')).toBeNull();
    expect(docsSizeProblem(4_000_000)).toBeNull();
  });
  it('refuses one byte over, naming the size and that nothing was written', () => {
    const msg = docsSizeProblem(DOCS_MAX_BYTES + 1, 'a.mp4');
    expect(msg).toMatch(/a\.mp4 is 10\.0 MB, over the 10 MB limit/);
    expect(msg).toMatch(/nothing was written/);
  });
  it('refuses an empty or unreadable file', () => {
    expect(docsSizeProblem(0)).toMatch(/empty/);
    expect(docsSizeProblem(NaN)).toMatch(/empty/);
  });
  it('encodes for the web: H.264, AAC 96k, faststart, yuv420p, 1280 wide at most', () => {
    const a = docsEncodeArgs({ input: 'in.mp4', out: 'o.mp4' }).join(' ');
    expect(a).toContain('-c:v libx264');
    expect(a).toContain('-preset slow');
    expect(a).toContain('-crf 30');
    expect(a).toContain('-pix_fmt yuv420p');
    expect(a).toContain('-b:a 96k');
    expect(a).toContain('-movflags +faststart');
    expect(a).toContain("min(1280,iw)");
    expect(docsEncodeArgs({ input: 'i', out: 'o', crf: 32 }).join(' ')).toContain('-crf 32');
  });
  it('takes the poster frame at the requested time', () => {
    expect(posterArgs({ input: 'i.mp4', out: 'p.webp', atMs: 5000 })).toContain('5.00');
  });
});
