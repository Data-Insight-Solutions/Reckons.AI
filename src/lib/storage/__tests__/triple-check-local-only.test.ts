/**
 * F100.1 done-test (F273 phase 0), Matt 2026-10-28: "We really need a triple-check that is completely free
 * open source, without API services off this device other than the web get."
 *
 * Two halves, both deterministic. STATIC: the triple-check files may import only local provider functions,
 * name no hosted host and carry no API key. DYNAMIC: the real search + judge chain runs with fetch stubbed,
 * under the default settings AND under settings that ask for a hosted service, and every request must be a
 * GET or must go to loopback. A hosted choice must be refused before any request leaves.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsRecord } from '../db';
import { searchTripleCheck, scrapeTripleCheck, searchConfigurationError } from '$lib/integrations/search/triple-check';
import { judgeWebEvidence, judgeSpaceEvidence, tripleCheckProviderError } from '$lib/integrations/llm/triple-check';
import { researchFixture } from '../../../../scripts/starter/research-fixture';

const FILES = ['src/lib/integrations/search/triple-check.ts', 'src/lib/integrations/llm/triple-check.ts', 'src/lib/storage/triple-check.ts', 'src/lib/rdf/triple-check.ts', 'src/lib/stores/triple-check.svelte.ts'];
const source = (f: string) => readFileSync(resolve(process.cwd(), f), 'utf8');
const LOCAL_CHAT = new Set(['chatOllama', 'chatChromeAI']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
type Call = { url: URL; method: string };
afterEach(() => vi.unstubAllGlobals());

describe('Triple Check is local and free: static', () => {
  it('imports no hosted provider, search vendor or SDK', () => {
    for (const f of FILES) {
      const text = source(f);
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        const [, names, from] = m;
        if (/\/providers$/.test(from)) for (const n of names.split(',').map(x => x.replace(/\btype\b/, '').trim()).filter(Boolean)) expect(LOCAL_CHAT.has(n), `${f} imports hosted ${n}`).toBe(true);
        expect(from, f).not.toMatch(/tavily|firecrawl|openai|anthropic|gemini|openrouter|reckons-api/i);
      }
    }
  });
  it('names no remote host, bearer token or API key', () => {
    for (const f of FILES) {
      const text = source(f).replace(/https:\/\/local\.invalid\//g, '');
      expect(text, f).not.toMatch(/api\.(tavily|firecrawl)|https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}\//i);
      expect(text, f).not.toMatch(/ApiKey|authorization|Bearer|method:\s*'(POST|PUT|DELETE|PATCH)'/i);
    }
  });
});

const withLocal = (x: Partial<SettingsRecord>) => ({ ollamaBaseUrl: 'http://localhost:11434', ...x }) as SettingsRecord;

describe('Triple Check is local and free: every request, with fetch stubbed', () => {
  const claim = researchFixture()[0].claims[0];
  const run = async (settings: Partial<SettingsRecord>) => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
      if (url.pathname.endsWith('/search')) return new Response(JSON.stringify({ results: [{ url: 'https://evidence.test/', title: 'E', content: 'passage' }] }));
      return new Response(JSON.stringify({ choices: [{ message: { content: '[{"index":0,"stance":"neutral","confidence":0.5}]' } }] }));
    }));
    const s = withLocal(settings), signal = new AbortController().signal;
    let refused: string | null = null;
    try {
      const found = await searchTripleCheck(s, 'a claim', signal);
      const read = await Promise.all(found.map(f => scrapeTripleCheck(s, f, signal)));
      await judgeWebEvidence(claim, read, s, signal);
      await judgeSpaceEvidence(claim, [{ spaceId: 'x', spaceName: 'X', statementId: 's', entity: 'e', claim: 'c', relation: 'similar', provenance: 'unknown', reference: false }], s, signal).catch(() => {});
    } catch (e) { refused = (e as Error).message; }
    return { calls, refused };
  };
  const leaves = (calls: Call[]) => calls.filter(c => !LOOPBACK.has(c.url.hostname) && c.method !== 'GET');

  it('default settings: runs the whole chain, and only GET or loopback requests are made', async () => {
    const { calls, refused } = await run({ tripleCheckEnabled: true });
    expect(refused).toBeNull(); expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(LOOPBACK.has(c.url.hostname) || c.method === 'GET', `${c.method} ${c.url.href}`).toBe(true);
  });
  it.each([
    ['Tavily search', { tripleCheckSearch: 'tavily', tavilyApiKey: 'k' }],
    ['Firecrawl search', { tripleCheckSearch: 'firecrawl', firecrawlApiKey: 'k' }],
    ['Firecrawl scrape', { tripleCheckScrape: 'firecrawl', firecrawlApiKey: 'k' }],
    ['Claude', { tripleCheckBackend: 'claude', claudeApiKey: 'k' }],
    ['OpenAI', { tripleCheckBackend: 'openai', openaiApiKey: 'k' }],
    ['Gemini', { tripleCheckBackend: 'gemini', geminiApiKey: 'k' }],
    ['OpenRouter', { tripleCheckBackend: 'openrouter', openrouterApiKey: 'k' }],
    ['hosted gateway', { tripleCheckBackend: 'reckons', reckonsApiKey: 'k' }],
    ['Ollama on another machine', { ollamaBaseUrl: 'https://ollama.example.com' }],
    ['SearXNG on another host', { tripleCheckSearch: 'searxng', searxngBaseUrl: 'https://search.example.com' }],
  ] as unknown as [string, Partial<SettingsRecord>][])('%s: refused, and nothing leaves the device', async (_n, settings) => {
    const { calls, refused } = await run({ tripleCheckEnabled: true, ...settings } as Partial<SettingsRecord>);
    expect(leaves(calls)).toEqual([]);
    expect(calls.filter(c => !LOOPBACK.has(c.url.hostname))).toEqual([]);
    expect(refused ?? searchConfigurationError(withLocal(settings)) ?? tripleCheckProviderError(withLocal(settings))).not.toBeNull();
  });
  describe('LAN addresses (Matt 2026-10-28: allow LAN, opt-in)', () => {
    const lan = (extra: Partial<SettingsRecord>) => run({ tripleCheckEnabled: true, ...extra } as Partial<SettingsRecord>);
    it('a named private address is allowed, for SearXNG and Ollama', async () => {
      const { calls, refused } = await lan({ searxngBaseUrl: 'http://192.168.1.20:8888', ollamaBaseUrl: 'http://10.0.0.5:11434', tripleCheckLanHosts: ['192.168.1.20', '10.0.0.5'] });
      expect(refused).toBeNull(); expect(calls.map(c => c.url.hostname)).toEqual(expect.arrayContaining(['192.168.1.20', '10.0.0.5']));
    });
    it('a .local name and a fd00:: literal are private when named', () => {
      const s = (u: string, h: string) => searchConfigurationError(withLocal({ searxngBaseUrl: u, tripleCheckLanHosts: [h] }));
      expect(s('http://box.local:8888', 'box.local')).toBeNull(); expect(s('http://[fd12::1]:8888', '[fd12::1]')).toBeNull();
    });
    it('an unnamed private address is refused', async () => {
      const { calls, refused } = await lan({ searxngBaseUrl: 'http://192.168.1.20:8888' });
      expect(refused).not.toBeNull(); expect(calls).toEqual([]);
      expect(searchConfigurationError(withLocal({ searxngBaseUrl: 'http://172.20.0.1', tripleCheckLanHosts: ['172.20.0.2'] }))).not.toBeNull();
    });
    it('a public address is refused even when named', async () => {
      for (const h of ['8.8.8.8', '172.32.0.1', '11.0.0.1', 'search.example.com', 'fc00.example.com']) {
        const { calls, refused } = await lan({ searxngBaseUrl: `http://${h}`, tripleCheckLanHosts: [h] });
        expect(refused, h).not.toBeNull(); expect(calls, h).toEqual([]);
      }
    });
    it('a name is never trusted: only a literal private address or .local counts, since a name can resolve publicly', () => {
      expect(tripleCheckProviderError(withLocal({ ollamaBaseUrl: 'http://gpu-box:11434', tripleCheckLanHosts: ['gpu-box'] }))).not.toBeNull();
      expect(tripleCheckProviderError(withLocal({ ollamaBaseUrl: 'http://gpu-box.local:11434', tripleCheckLanHosts: ['gpu-box.local'] }))).toBeNull();
    });
  });
  it('a hosted analysis provider chosen elsewhere in the app is not inherited', async () => {
    const { calls, refused } = await run({ tripleCheckEnabled: true, analyzeBackend: 'claude', preferredBackend: 'claude', claudeApiKey: 'k' } as Partial<SettingsRecord>);
    expect(refused).toBeNull(); expect(calls.some(c => c.url.hostname.includes('anthropic'))).toBe(false);
    for (const c of calls) expect(LOOPBACK.has(c.url.hostname) || c.method === 'GET', `${c.method} ${c.url.href}`).toBe(true);
  });
  it('local in-browser providers are accepted', () => {
    for (const p of ['ollama', 'wasm', 'chrome-ai']) expect(tripleCheckProviderError(withLocal({ tripleCheckBackend: p as SettingsRecord['tripleCheckBackend'] }))).toBeNull();
  });
});
