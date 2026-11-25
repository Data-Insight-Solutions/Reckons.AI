import { describe, expect, it, vi } from 'vitest';
import { fetchGithubTurtle, githubApiUrl, githubSpaceIdentity, openFromGithubLink, parseGithubFileRef } from '../open-space';

/** F310: opening a Turtle file from a public GitHub repository (Matt, 2026-11-25). */
describe('opening a knowledge base from GitHub', () => {
  const roadmap = { owner: 'Data-Insight-Solutions', repo: 'Reckons.AI', ref: 'main', path: 'static/reckons-roadmap.ttl' };

  it('reads the forms a person has to hand: a file page, a raw link, and owner/repo/path@ref', () => {
    expect(parseGithubFileRef('https://github.com/Data-Insight-Solutions/Reckons.AI/blob/main/static/reckons-roadmap.ttl')).toEqual(roadmap);
    expect(parseGithubFileRef('https://raw.githubusercontent.com/Data-Insight-Solutions/Reckons.AI/main/static/reckons-roadmap.ttl')).toEqual(roadmap);
    expect(parseGithubFileRef('Data-Insight-Solutions/Reckons.AI/static/reckons-roadmap.ttl@main')).toEqual(roadmap);
    expect(parseGithubFileRef('Data-Insight-Solutions/Reckons.AI/static/reckons-roadmap.ttl')).toEqual({ ...roadmap, ref: '' });
  });

  it('refuses anything that is not a .ttl file in a plainly named repository', () => {
    for (const bad of [null, '', 'owner/repo', 'owner/repo/README.md', 'owner/repo/../secret.ttl', 'o w/repo/a.ttl',
      'https://example.com/owner/repo/blob/main/a.ttl', 'javascript:alert(1)//a.ttl', 'owner/repo/a.ttl@main/../x'])
      expect(parseGithubFileRef(bad), String(bad)).toBeNull();
  });

  it('asks the API (in the CSP) for the raw bytes, and builds the link and the identity', () => {
    expect(githubApiUrl(roadmap)).toBe('https://api.github.com/repos/Data-Insight-Solutions/Reckons.AI/contents/static/reckons-roadmap.ttl?ref=main');
    expect(openFromGithubLink(roadmap)).toBe('https://reckons.ai/about?gh=Data-Insight-Solutions/Reckons.AI/static/reckons-roadmap.ttl@main');
    expect(parseGithubFileRef(new URL(openFromGithubLink(roadmap)).searchParams.get('gh'))).toEqual(roadmap); // round trip
    expect(githubSpaceIdentity(roadmap)).toEqual({ name: 'Reckons.AI: reckons-roadmap.ttl', uri: 'github://Data-Insight-Solutions/Reckons.AI/static/reckons-roadmap.ttl@main' });
  });

  it('sends the raw media type and reports refusals in words a reader can act on', async () => {
    const ok = vi.fn(async () => new Response('<urn:a> <urn:b> "c" .', { status: 200 }));
    await expect(fetchGithubTurtle(roadmap, ok as unknown as typeof fetch)).resolves.toContain('<urn:a>');
    expect((ok.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({ Accept: 'application/vnd.github.raw' });
    const status = (n: number) => (async () => new Response('', { status: n })) as unknown as typeof fetch;
    await expect(fetchGithubTurtle(roadmap, status(404))).rejects.toThrow(/not a public repository/);
    await expect(fetchGithubTurtle(roadmap, status(403))).rejects.toThrow(/60 reads an hour/);
    const huge = (async () => new Response('x', { status: 200, headers: { 'content-length': String(30 * 1048576) } })) as unknown as typeof fetch;
    await expect(fetchGithubTurtle(roadmap, huge)).rejects.toThrow(/25 MB/);
  });
});
