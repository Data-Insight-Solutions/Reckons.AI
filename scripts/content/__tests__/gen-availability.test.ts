import { describe, expect, it } from 'vitest';
import { generationAvailability } from '../gen-assets';

/** F58.9.17 — what a runner offers depends on the operating system, before any file is looked at. */
describe('generationAvailability by platform', () => {
  it('never offers splats from a picture on macOS, and says why in plain words', () => {
    const r = generationAvailability('splat', 'darwin');
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/needs an NVIDIA GPU with CUDA/);
    expect(r.reason).toMatch(/Pictures and videos still work/);
  });

  it('judges pictures and video on macOS by their installed files, like on Linux', () => {
    for (const stage of ['image', 'video'] as const) {
      const r = generationAvailability(stage, 'darwin');
      if (!r.available) expect(r.reason).toMatch(/file\(s\) missing/);
    }
  });

  it('keeps the Linux splat rule: available only when its tool and model files exist', () => {
    const r = generationAvailability('splat', 'linux');
    if (!r.available) expect(r.reason).toMatch(/file\(s\) missing/);
    else expect(r.reason).toBeUndefined();
  });
});
