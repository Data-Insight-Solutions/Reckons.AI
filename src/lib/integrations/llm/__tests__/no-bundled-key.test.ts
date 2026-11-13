/**
 * COUNSEL-BRIEF.md says cloud LLM calls run "under the user's own API key and the user's own
 * account". Three things have to hold for that to be true of the PUBLISHED build, and each is
 * pinned here so a change that breaks one fails a test instead of a sentence going quietly stale:
 *
 *  1. Nothing in the build pipeline supplies a provider key (no CI secret passed in as a VITE_ var).
 *  2. If one were supplied — through the environment OR a local `.env` file, both of which Vite
 *     inlines — the build refuses (vite-secret-guard), unless the explicit local-only override is present.
 *  3. A cloud request carries exactly the key the caller (the person's Settings) passed, nothing else.
 *
 * The honest limit: a developer's LOCAL build can still bake a key via VITE_SECRET_GUARD_ALLOW=1.
 * That build is not the published one, and the guard says so when it is used.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnvWithDotenv, findBakedSecrets } from '../../../../../scripts/offline/vite-secret-guard';
import { extractWithClaude } from '../claude';

afterEach(() => vi.unstubAllGlobals());

const SECRET_VITE = /VITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)/i;

describe('the published build bundles no provider key', () => {
  it('no CI workflow or package script supplies a VITE_ secret to the build', () => {
    const dir = '.github/workflows';
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(dir, f));
    files.push('package.json');
    const offenders = files.filter((f) => SECRET_VITE.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('.env.example ships every VITE_ key empty', () => {
    const lines = readFileSync('.env.example', 'utf8').split('\n').filter((l) => SECRET_VITE.test(l.split('=')[0]) && !l.trim().startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.split('=')[1]?.trim() ?? '').toBe('');
  });

  it('the guard blocks a key that only lives in a local .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    writeFileSync(join(dir, '.env'), 'VITE_ANTHROPIC_API_KEY=sk-ant-test\nVITE_PREFERRED_BACKEND=mock\n');
    expect(findBakedSecrets(buildEnvWithDotenv(dir, {} as NodeJS.ProcessEnv))).toEqual(['VITE_ANTHROPIC_API_KEY']);
  });

  it('an empty key in .env (as .env.example ships it) does not trip the guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    writeFileSync(join(dir, '.env'), 'VITE_OPENAI_API_KEY=\nVITE_GEMINI_API_KEY=""\n');
    expect(findBakedSecrets(buildEnvWithDotenv(dir, {} as NodeJS.ProcessEnv))).toEqual([]);
  });

  it('the build script runs the guard before vite build', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts.build).toMatch(/^npx tsx scripts\/offline\/vite-secret-guard\.ts && vite build/);
  });
});

describe('a cloud request uses only the key it was handed', () => {
  it('sends the caller-supplied key and no other credential', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"triples":[]}' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await extractWithClaude('Acme', 'Import', { apiKey: 'user-entered-key', model: 'claude-opus-5-5' });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('user-entered-key');
    expect(Object.keys(headers).filter((h) => /key|authorization/i.test(h))).toEqual(['x-api-key']);
  });
});
