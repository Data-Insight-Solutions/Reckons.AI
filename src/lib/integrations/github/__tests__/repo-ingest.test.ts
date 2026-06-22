import { describe, it, expect } from 'vitest';
import {
  parseRepoUrl,
  buildRepoExtractionText,
  type RepoMeta,
  type RepoFile,
} from '../repo-ingest';

describe('parseRepoUrl', () => {
  it('parses owner/repo shorthand', () => {
    expect(parseRepoUrl('anthropics/claude-code')).toEqual({
      owner: 'anthropics',
      repo: 'claude-code',
    });
  });

  it('parses full GitHub URL', () => {
    expect(parseRepoUrl('https://github.com/anthropics/claude-code')).toEqual({
      owner: 'anthropics',
      repo: 'claude-code',
      branch: undefined,
    });
  });

  it('parses URL with branch', () => {
    expect(parseRepoUrl('https://github.com/anthropics/claude-code/tree/dev')).toEqual({
      owner: 'anthropics',
      repo: 'claude-code',
      branch: 'dev',
    });
  });

  it('strips .git suffix', () => {
    expect(parseRepoUrl('https://github.com/user/repo.git')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: undefined,
    });
  });

  it('returns null for invalid input', () => {
    expect(parseRepoUrl('not-a-repo')).toBeNull();
    expect(parseRepoUrl('https://example.com/foo')).toBeNull();
    expect(parseRepoUrl('')).toBeNull();
  });

  it('handles dots and hyphens in names', () => {
    expect(parseRepoUrl('my-org/my.project')).toEqual({
      owner: 'my-org',
      repo: 'my.project',
    });
  });
});

describe('buildRepoExtractionText', () => {
  const meta: RepoMeta = {
    owner: 'test',
    repo: 'app',
    branch: 'main',
    headSha: 'abc12345678',
    description: 'A test repo',
    language: 'TypeScript',
    stars: 42,
    fileCount: 3,
  };

  const files: RepoFile[] = [
    { path: 'README.md', size: 100, sha: 'aaa', content: '# Test App\nA demo app.', type: 'doc' },
    { path: 'src/index.ts', size: 200, sha: 'bbb', content: 'export function main() { console.log("hello"); }', type: 'code' },
    { path: 'tsconfig.json', size: 50, sha: 'ccc', content: '{ "compilerOptions": {} }', type: 'config' },
  ];

  it('includes repo metadata', () => {
    const text = buildRepoExtractionText(meta, files);
    expect(text).toContain('test/app');
    expect(text).toContain('main');
    expect(text).toContain('abc12345');
    expect(text).toContain('A test repo');
    expect(text).toContain('TypeScript');
  });

  it('includes file contents', () => {
    const text = buildRepoExtractionText(meta, files);
    expect(text).toContain('README.md');
    expect(text).toContain('# Test App');
    expect(text).toContain('src/index.ts');
    expect(text).toContain('export function main');
  });

  it('sorts docs first, then configs, then code', () => {
    const text = buildRepoExtractionText(meta, files);
    const readmeIdx = text.indexOf('README.md');
    const configIdx = text.indexOf('tsconfig.json');
    const codeIdx = text.indexOf('src/index.ts');
    expect(readmeIdx).toBeLessThan(configIdx);
    expect(configIdx).toBeLessThan(codeIdx);
  });

  it('respects maxChars limit', () => {
    const text = buildRepoExtractionText(meta, files, 200);
    expect(text.length).toBeLessThanOrEqual(250); // some buffer for truncation message
    expect(text).toContain('truncated');
  });
});
