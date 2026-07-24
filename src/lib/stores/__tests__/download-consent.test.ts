/**
 * Download-consent concurrency.
 *
 * This is a regression suite for a REAL shipped first-run hang, found 2026-07-18.
 *
 * `semanticEnrichDiff` embeds subjects and predicates in parallel (`Promise.all`), so two callers
 * reached the embedder at once, neither found a loaded model, and BOTH requested consent. The store
 * held a SINGLE `_pending` slot, so the second request overwrote the first and threw away its
 * `resolve`. The user saw one dialog, clicked Download, resolved the second caller — and the first
 * awaited a promise that could never settle. No error, no log, no spinner: the ingest simply never
 * finished, verified stalling past 240 s in a real visible browser.
 *
 * The root fix is in embed.ts (one shared in-flight load). These tests cover the store's own
 * guarantee, which matters independently: a queue that silently DROPS a caller is a trap for
 * whoever races it next. Every consent request must settle, one way or another.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/embed', () => ({
  setEmbedConsentHandler: vi.fn(),
  setEmbeddingModel: vi.fn(),
}));
vi.mock('$lib/integrations/llm/wasm', () => ({
  setDownloadConsentHandler: vi.fn(),
}));

type ConsentHandler = (model: string, mb: number) => Promise<boolean>;

let requestConsent: ConsentHandler;
let pendingConsent: () => { model: string } | null;
let resolveConsent: (ok: boolean) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const store = await import('../download-consent.svelte');
  const { setEmbedConsentHandler } = await import('$lib/embed');

  store.initDownloadConsent();
  pendingConsent = store.pendingConsent as typeof pendingConsent;
  resolveConsent = store.resolveConsent;

  // initDownloadConsent hands the same factory to embed.ts and wasm.ts — capture the real one.
  requestConsent = vi.mocked(setEmbedConsentHandler).mock.calls[0][0] as ConsentHandler;
});

afterEach(() => {
  if (pendingConsent()) resolveConsent(false);
  vi.restoreAllMocks();
});

describe('single consent request', () => {
  it('resolves true when the user accepts', async () => {
    const p = requestConsent('some/model', 33);
    expect(pendingConsent()?.model).toBe('some/model');
    resolveConsent(true);
    await expect(p).resolves.toBe(true);
  });

  it('resolves false when the user declines', async () => {
    const p = requestConsent('some/model', 33);
    resolveConsent(false);
    await expect(p).resolves.toBe(false);
  });
});

describe('CONCURRENT consent requests — the first-run hang', () => {
  it('settles BOTH callers when two race for the SAME model', async () => {
    // The exact shape of the bug: two parallel embedMany calls, one model, one dialog.
    const a = requestConsent('same/model', 33);
    const b = requestConsent('same/model', 33);

    // One dialog is shown, not two — the second piggy-backs.
    expect(pendingConsent()?.model).toBe('same/model');

    resolveConsent(true);

    // Before the fix, `a` never settled and Promise.all hung forever.
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
  });

  it('propagates a decline to both racing callers', async () => {
    const a = requestConsent('same/model', 33);
    const b = requestConsent('same/model', 33);
    resolveConsent(false);
    await expect(Promise.all([a, b])).resolves.toEqual([false, false]);
  });

  it('settles the superseded caller when a DIFFERENT model arrives', async () => {
    const first = requestConsent('model/one', 500);
    const second = requestConsent('model/two', 33);

    // The older request must not be left dangling. Failing fast and visibly beats hanging.
    await expect(first).resolves.toBe(false);

    resolveConsent(true);
    await expect(second).resolves.toBe(true);
  });

  it('warns when it supersedes, so a surprise decline is never silent', async () => {
    const warn = vi.spyOn(console, 'warn');
    const first = requestConsent('model/one', 500);
    requestConsent('model/two', 33);
    await first;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('superseded'));
    resolveConsent(false);
  });

  it('leaves no pending consent once everything has settled', async () => {
    const a = requestConsent('same/model', 33);
    const b = requestConsent('same/model', 33);
    resolveConsent(true);
    await Promise.all([a, b]);
    expect(pendingConsent()).toBeNull();
  });

  it('survives three racing callers — nothing is dropped', async () => {
    const ps = [requestConsent('m', 10), requestConsent('m', 10), requestConsent('m', 10)];
    resolveConsent(true);
    await expect(Promise.all(ps)).resolves.toEqual([true, true, true]);
  });
});
