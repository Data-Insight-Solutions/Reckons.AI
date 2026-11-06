import { describe, expect, it } from 'vitest';
import { gpuVerdict, missingTelemetryVerdict } from '../session-gpu';

/** F58.9.17 — a Mac has no nvidia-smi by design; Linux without it still holds GPU jobs. */
describe('missing GPU telemetry by platform', () => {
  it('lets a job start on macOS, where nvidia-smi never exists', () => {
    expect(missingTelemetryVerdict('darwin')).toEqual({ ok: true });
  });
  it('still fails closed on Linux and everywhere else', () => {
    for (const p of ['linux', 'win32', 'freebsd'] as const) {
      const v = missingTelemetryVerdict(p);
      expect(v.ok).toBe(false);
      expect(v).toEqual(gpuVerdict(null, null));
    }
  });
});
