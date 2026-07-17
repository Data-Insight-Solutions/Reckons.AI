/**
 * copyText must NEVER throw — the button-crawl caught the "copy full" button crashing on a
 * clipboard permission rejection. It returns success/failure so callers can react, not explode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyText } from '../clipboard';

describe('copyText', () => {
  const origClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'clipboard');

  beforeEach(() => {
    // jsdom has no execCommand by default; stub it so the legacy path is testable.
    (document as unknown as { execCommand?: unknown }).execCommand = vi.fn(() => true);
  });
  afterEach(() => {
    if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
    vi.restoreAllMocks();
  });

  it('uses the modern clipboard API when it works', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('does NOT throw when the modern API rejects (the crash the crawl found) — falls back', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // execCommand fallback returns true (stubbed) — the rejection is swallowed, no throw.
    await expect(copyText('x')).resolves.toBe(true);
  });

  it('falls back to execCommand when there is no async clipboard API', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    expect(await copyText('y')).toBe(true);
    expect((document as unknown as { execCommand: ReturnType<typeof vi.fn> }).execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false (never throws) when both paths fail', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => { throw new Error('nope'); };
    await expect(copyText('z')).resolves.toBe(false);
  });
});
