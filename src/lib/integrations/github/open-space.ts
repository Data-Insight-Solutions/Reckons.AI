/**
 * OPEN A KNOWLEDGE BASE FROM GITHUB (F310). Matt, 2026-11-25, asking that people can open one from a GitHub file.
 * (GitHub will not even display static/reckons-roadmap.ttl: at 2.37 MB it is "too big to show".)
 *
 * A link /about?gh=<owner>/<repo>/<path.ttl>[@<ref>] opens that Turtle file as a knowledge base of its own, after the
 * reader confirms. The browser reads the file itself, through api.github.com (already in the CSP's connect-src;
 * raw.githubusercontent.com is not), asking for the raw media type so files over 1 MB come back whole. No server,
 * no account, public repositories only; it is stored on this device, like any example.
 *
 * Honest limits: GitHub allows 60 unauthenticated API calls an hour per address, and a private repository answers
 * 404, which is reported as "not found or not public". Statements keep the status the file gives them.
 */

export type GithubFileRef = { owner: string; repo: string; ref: string; path: string };

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_BYTES = 25 * 1024 * 1024;

const okPath = (p: string) =>
  /\.ttl$/i.test(p) && p.split('/').every((seg) => NAME.test(seg) && seg !== '.' && seg !== '..');
const okRef = (r: string) => /^[A-Za-z0-9._\/-]{1,200}$/.test(r) && !r.split('/').includes('..');

/**
 * Pure: a GitHub file reference from any of the forms a person has to hand, or null.
 *   https://github.com/<owner>/<repo>/blob/<ref>/<path>
 *   https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
 *   <owner>/<repo>/<path>[@<ref>]            (the form the gh= parameter carries; ref defaults to the default branch)
 */
export function parseGithubFileRef(input: string | null | undefined): GithubFileRef | null {
  if (!input) return null;
  const s = input.trim();
  let owner: string, repo: string, ref: string, path: string;
  const page = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(s);
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(s);
  if (page || raw) {
    [, owner, repo, ref, path] = (page ?? raw)!;
  } else {
    if (/^[a-z]+:/i.test(s)) return null; // some other URL
    const at = s.lastIndexOf('@');
    const body = at > 0 ? s.slice(0, at) : s;
    ref = at > 0 ? s.slice(at + 1) : '';
    const parts = body.split('/');
    if (parts.length < 3) return null;
    [owner, repo] = parts;
    path = parts.slice(2).join('/');
  }
  path = path.split(/[?#]/)[0];
  if (!NAME.test(owner) || !NAME.test(repo) || !okPath(path) || (ref !== '' && !okRef(ref))) return null;
  return { owner, repo, ref, path };
}

/** Pure: the API address that returns the file's raw bytes. */
export function githubApiUrl(r: GithubFileRef): string {
  const p = r.path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${r.owner}/${r.repo}/contents/${p}${r.ref ? `?ref=${encodeURIComponent(r.ref)}` : ''}`;
}

/** Pure: the file's page on github.com, shown to the reader before anything is fetched. */
export function githubPageUrl(r: GithubFileRef): string {
  return `https://github.com/${r.owner}/${r.repo}/blob/${r.ref || 'HEAD'}/${r.path}`;
}

/** Pure: the link that opens the file in Reckons.AI, for a README badge or a message. */
export function openFromGithubLink(r: GithubFileRef, origin = 'https://reckons.ai'): string {
  return `${origin}/about?gh=${r.owner}/${r.repo}/${r.path}${r.ref ? `@${r.ref}` : ''}`;
}

/** Pure: the name it opens under, and the uri that keeps a second open from making a duplicate. */
export function githubSpaceIdentity(r: GithubFileRef): { name: string; uri: string } {
  const file = r.path.split('/').pop()!;
  return { name: `${r.repo}: ${file}`, uri: `github://${r.owner}/${r.repo}/${r.path}${r.ref ? `@${r.ref}` : ''}` };
}

/** Fetch the Turtle text. Errors say what happened in words a reader can act on. */
export async function fetchGithubTurtle(r: GithubFileRef, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(githubApiUrl(r), { headers: { Accept: 'application/vnd.github.raw' } });
  if (res.status === 404) throw new Error(`Not found, or not a public repository: ${githubPageUrl(r)}`);
  if (res.status === 403 || res.status === 429) throw new Error('GitHub refused for now (its limit is 60 reads an hour without signing in). Try again later.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${githubPageUrl(r)}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`The file is ${(len / 1048576).toFixed(1)} MB; the limit for opening from GitHub is 25 MB.`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('The file is over the 25 MB limit for opening from GitHub.');
  return text;
}
