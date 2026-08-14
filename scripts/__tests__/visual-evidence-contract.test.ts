import { describe, expect, it } from 'vitest';
import { assertEvidenceManifest } from '../visual-evidence-contract';
import { parseVlmReview } from '../visual-evidence-report';

const manifest = {
  schemaVersion: 1,
  run: {
    commitSha: 'abc123',
    dirty: true,
    startedAt: '2026-07-28T00:00:00.000Z',
    finishedAt: '2026-07-28T00:00:01.000Z',
    baseUrl: 'http://localhost:4175',
    buildMode: 'production',
    project: 'pixel-7',
    browser: 'chromium',
    browserVersion: '149',
    deviceProfile: 'Pixel 7',
    device: {
      userAgent: 'Pixel 7',
      deviceScaleFactor: 2.625,
      touchPoints: 1,
      coarsePointer: true,
      noHover: true,
    },
    orientation: 'portrait',
    viewport: { width: 412, height: 839 },
    tools: {
      node: 'v22.17.1',
      playwright: '1.61.1',
      ollama: '0.11.4',
      vlmModel: 'qwen2.5vl:7b',
      vlmModelDigest: 'b'.repeat(64),
    },
  },
  runtimeErrors: { page: [], console: [] },
  screenshots: [
    {
      id: 'facts',
      label: 'Facts',
      path: 'pixel/facts.png',
      sha256: 'a'.repeat(64),
      bytes: 42,
      capturedAt: '2026-07-28T00:00:00.500Z',
      url: 'http://localhost:4175/ingest',
      viewport: { width: 412, height: 839 },
      renderer: 'none',
      audit: [{ name: 'overflow', pass: true, detail: 'false' }],
    },
  ],
};

describe('visual evidence contract', () => {
  it('accepts a complete manifest', () => {
    expect(() => assertEvidenceManifest(manifest)).not.toThrow();
  });

  it('rejects a malformed screenshot hash', () => {
    const malformed = structuredClone(manifest);
    malformed.screenshots[0].sha256 = 'not-a-hash';
    expect(() => assertEvidenceManifest(malformed)).toThrow(/SHA-256/);
  });

  it('rejects screenshot paths outside the evidence root', () => {
    const malformed = structuredClone(manifest);
    malformed.screenshots[0].path = '../outside.png';
    expect(() => assertEvidenceManifest(malformed)).toThrow(/evidence root/);
  });

  it('parses a fenced, structured advisory review', () => {
    expect(
      parseVlmReview(
        '```json\n{"summary":"Looks coherent","findings":[{"category":"layout","severity":"warning","message":"Tight spacing"}]}\n```',
      ),
    ).toEqual({
      summary: 'Looks coherent',
      findings: [{ category: 'layout', severity: 'warning', message: 'Tight spacing' }],
    });
  });

  it('rejects unstructured or out-of-schema model output', () => {
    expect(() => parseVlmReview('Looks good')).toThrow(/not JSON/);
    expect(() =>
      parseVlmReview(
        '{"summary":"Review","findings":[{"category":"security","severity":"warning","message":"No"}]}',
      ),
    ).toThrow(/invalid category/);
  });
});
