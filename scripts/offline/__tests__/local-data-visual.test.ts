import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findProfiles, originDirName, parseArgs, privateVisualDirectory } from '../lib/local-data-visual';

describe('local-data-visual helpers', () => {
  it('names an origin the way Chromium stores it', () => {
    expect(originDirName('http://localhost:5173')).toBe('http_localhost_5173');
    expect(originDirName('https://example.test')).toBe('https_example.test_443');
  });

  it('finds only profiles holding data for the origin, newest first', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'lv-home-'));
    const put = (rel: string) => { mkdirSync(path.join(home, rel), { recursive: true }); writeFileSync(path.join(home, rel, 'CURRENT'), 'x'); };
    put('.config/google-chrome/Default/IndexedDB/http_localhost_5173.indexeddb.leveldb');
    put('snap/chromium/common/chromium/Default/IndexedDB/http_localhost_9999.indexeddb.leveldb');
    const found = findProfiles('http://localhost:5173', home);
    expect(found.map((p) => p.label)).toEqual(['Google Chrome / Default']);
  });

  it('refuses a non-local origin, so personal data is never served to or from another machine', () => {
    expect(() => parseArgs(['--origin=https://reckons.ai'])).toThrow(/Only local origins/);
    expect(() => parseArgs(['--serve=http://192.168.1.20:5173'])).toThrow(/Only local origins/);
    expect(parseArgs(['--paths=kb,/']).paths).toEqual(['/kb', '/']);
  });

  it('keeps personal screenshots out of any git checkout', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'lv-repo-'));
    mkdirSync(path.join(repo, '.git'));
    expect(() => privateVisualDirectory(path.join(repo, 'state'))).toThrow(/inside a Git checkout/);
    expect(privateVisualDirectory(mkdtempSync(path.join(tmpdir(), 'lv-state-')))).toMatch(/reckons\/local-visual$/);
  });
});

describe('harness noise', () => {
  it('labels only the messages the proxy itself causes', async () => {
    const { isHarnessNoise } = await import('../lib/local-data-visual');
    expect(isHarnessNoise('[vite] failed to connect to websocket.')).toBe(true);
    expect(isHarnessNoise("Access to fetch at 'http://localhost:11434/api/tags' ... access the `loopback` address space.")).toBe(true);
    expect(isHarnessNoise('TypeError: Cannot read properties of undefined')).toBe(false);
  });
});
