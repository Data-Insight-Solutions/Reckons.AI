/**
 * GitHub repository ingest — fetches repo file tree via GitHub API,
 * reads code/docs files, and prepares them for triple extraction.
 *
 * Works entirely in-browser using the GitHub REST API (no git clone needed).
 * Supports:
 *  - Full repo tree walk (initial ingest)
 *  - Delta updates via Compare API (re-ingest only changed files)
 *  - Configurable file filters (extensions, paths, .gitignore-style globs)
 */

const GITHUB_API = 'https://api.github.com';

// File extensions we consider "ingestable" as knowledge sources
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.svelte', '.vue', '.py', '.rs', '.go',
  '.java', '.kt', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.swift', '.dart', '.lua', '.zig', '.ex', '.exs', '.erl', '.hs',
  '.ml', '.mli', '.clj', '.cljs', '.scala', '.r', '.jl', '.sh', '.bash',
  '.zsh', '.fish', '.ps1', '.bat', '.cmd',
]);

const DOC_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.adoc', '.tex', '.org',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.html', '.css', '.scss', '.less', '.sql',
  '.env.example', '.gitignore', '.dockerignore',
]);

// Paths to skip entirely
const SKIP_PATHS = [
  'node_modules/', '.git/', 'dist/', 'build/', '.next/', '.svelte-kit/',
  '.nuxt/', '__pycache__/', '.pytest_cache/', 'target/', 'vendor/',
  '.venv/', 'venv/', 'coverage/', '.nyc_output/',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock',
];

// Max file size to fetch (100KB — larger files are usually generated/binary)
const MAX_FILE_SIZE = 100_000;

// ── Types ─────────────────────────────────────────────────────────────────

export type RepoRef = {
  owner: string;
  repo: string;
  branch?: string; // defaults to default branch
};

export type RepoFile = {
  path: string;
  size: number;
  sha: string;
  content: string;
  type: 'code' | 'doc' | 'config';
};

export type RepoDelta = {
  added: RepoFile[];
  modified: RepoFile[];
  removed: string[]; // paths
  fromSha: string;
  toSha: string;
};

export type RepoMeta = {
  owner: string;
  repo: string;
  branch: string;
  headSha: string;
  description: string | null;
  language: string | null;
  stars: number;
  fileCount: number;
};

export type RepoIngestProgress =
  | { phase: 'fetching-tree'; fileCount?: number }
  | { phase: 'reading-files'; current: number; total: number }
  | { phase: 'comparing'; fromSha: string; toSha: string }
  | { phase: 'done'; meta: RepoMeta; files: RepoFile[] };

// ── Parse repo URL ──────────────────────────────────────────────────────

export function parseRepoUrl(input: string): RepoRef | null {
  // Handle "owner/repo" shorthand
  const shorthand = input.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (shorthand) {
    return { owner: shorthand[1], repo: shorthand[2] };
  }

  // Handle full GitHub URLs
  const urlMatch = input.match(
    /github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/]+))?(?:\/|$)/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      branch: urlMatch[3] || undefined,
    };
  }

  return null;
}

// ── API helpers ─────────────────────────────────────────────────────────

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghFetch<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: headers(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub API rate limit exceeded. Add a token in Settings → Integrations.');
    }
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Fetch repo metadata ─────────────────────────────────────────────────

export async function fetchRepoMeta(
  ref: RepoRef,
  token?: string,
): Promise<RepoMeta> {
  const repo = await ghFetch<{
    default_branch: string;
    description: string | null;
    language: string | null;
    stargazers_count: number;
  }>(`/repos/${ref.owner}/${ref.repo}`, token);

  const branch = ref.branch ?? repo.default_branch;
  const branchData = await ghFetch<{ commit: { sha: string } }>(
    `/repos/${ref.owner}/${ref.repo}/branches/${branch}`,
    token,
  );

  return {
    owner: ref.owner,
    repo: ref.repo,
    branch,
    headSha: branchData.commit.sha,
    description: repo.description,
    language: repo.language,
    stars: repo.stargazers_count,
    fileCount: 0, // filled after tree walk
  };
}

// ── File classification ─────────────────────────────────────────────────

function shouldSkip(path: string): boolean {
  return SKIP_PATHS.some((skip) => path.startsWith(skip) || path.includes('/' + skip));
}

function classifyFile(path: string): 'code' | 'doc' | 'config' | null {
  if (shouldSkip(path)) return null;

  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1) {
    // Special files without extensions
    const name = path.split('/').pop() ?? '';
    if (['Makefile', 'Dockerfile', 'Procfile', 'Rakefile', 'Justfile'].includes(name)) return 'config';
    if (['README', 'LICENSE', 'CHANGELOG', 'CONTRIBUTING', 'AUTHORS'].includes(name)) return 'doc';
    return null;
  }

  const ext = path.slice(lastDot).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  return null;
}

// ── Full tree walk ──────────────────────────────────────────────────────

export async function fetchRepoFiles(
  ref: RepoRef,
  token?: string,
  onProgress?: (p: RepoIngestProgress) => void,
): Promise<{ meta: RepoMeta; files: RepoFile[] }> {
  const meta = await fetchRepoMeta(ref, token);
  onProgress?.({ phase: 'fetching-tree' });

  // Get the full recursive tree
  type TreeItem = { path: string; type: string; size?: number; sha: string };
  const tree = await ghFetch<{ tree: TreeItem[]; truncated: boolean }>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${meta.headSha}?recursive=1`,
    token,
  );

  // Filter to ingestable files
  const candidates = tree.tree.filter((item) => {
    if (item.type !== 'blob') return false;
    if ((item.size ?? 0) > MAX_FILE_SIZE) return false;
    return classifyFile(item.path) !== null;
  });

  meta.fileCount = candidates.length;
  onProgress?.({ phase: 'fetching-tree', fileCount: candidates.length });

  // Fetch file contents in batches (avoid rate limits)
  const BATCH_SIZE = 10;
  const files: RepoFile[] = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    onProgress?.({ phase: 'reading-files', current: i, total: candidates.length });

    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          const blob = await ghFetch<{ content: string; encoding: string }>(
            `/repos/${ref.owner}/${ref.repo}/git/blobs/${item.sha}`,
            token,
          );

          let content: string;
          if (blob.encoding === 'base64') {
            content = atob(blob.content.replace(/\n/g, ''));
          } else {
            content = blob.content;
          }

          // Skip binary-looking content
          if (content.includes('\0')) return null;

          return {
            path: item.path,
            size: item.size ?? content.length,
            sha: item.sha,
            content,
            type: classifyFile(item.path)!,
          } satisfies RepoFile;
        } catch {
          return null; // skip files that fail to fetch
        }
      }),
    );

    files.push(...results.filter((f): f is RepoFile => f !== null));
  }

  onProgress?.({ phase: 'done', meta, files });
  return { meta, files };
}

// ── Delta update via Compare API ────────────────────────────────────────

export async function fetchRepoDelta(
  ref: RepoRef,
  fromSha: string,
  token?: string,
  onProgress?: (p: RepoIngestProgress) => void,
): Promise<RepoDelta> {
  const meta = await fetchRepoMeta(ref, token);
  const toSha = meta.headSha;

  if (fromSha === toSha) {
    return { added: [], modified: [], removed: [], fromSha, toSha };
  }

  onProgress?.({ phase: 'comparing', fromSha, toSha });

  type CompareFile = {
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed';
    sha: string;
    patch?: string;
  };

  const compare = await ghFetch<{ files: CompareFile[] }>(
    `/repos/${ref.owner}/${ref.repo}/compare/${fromSha}...${toSha}`,
    token,
  );

  const added: RepoFile[] = [];
  const modified: RepoFile[] = [];
  const removed: string[] = [];

  const toFetch = compare.files.filter((f) => {
    const type = classifyFile(f.filename);
    if (!type) return false;
    if (f.status === 'removed') {
      removed.push(f.filename);
      return false;
    }
    return true;
  });

  // Fetch contents of added/modified files
  const BATCH_SIZE = 10;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    onProgress?.({ phase: 'reading-files', current: i, total: toFetch.length });

    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          const blob = await ghFetch<{ content: string; encoding: string }>(
            `/repos/${ref.owner}/${ref.repo}/git/blobs/${item.sha}`,
            token,
          );

          let content: string;
          if (blob.encoding === 'base64') {
            content = atob(blob.content.replace(/\n/g, ''));
          } else {
            content = blob.content;
          }

          if (content.includes('\0')) return null;

          const type = classifyFile(item.filename)!;
          return {
            file: { path: item.filename, size: content.length, sha: item.sha, content, type } satisfies RepoFile,
            status: item.status,
          };
        } catch {
          return null;
        }
      }),
    );

    for (const r of results) {
      if (!r) continue;
      if (r.status === 'added') added.push(r.file);
      else modified.push(r.file);
    }
  }

  return { added, modified, removed, fromSha, toSha };
}

// ── Build extraction text from repo files ───────────────────────────────

/**
 * Builds a structured text representation of repo files suitable for
 * LLM triple extraction. Groups by type and includes file paths as context.
 */
export function buildRepoExtractionText(
  meta: RepoMeta,
  files: RepoFile[],
  maxChars = 50_000,
): string {
  const sections: string[] = [
    `Repository: ${meta.owner}/${meta.repo}`,
    `Branch: ${meta.branch} (${meta.headSha.slice(0, 8)})`,
    meta.description ? `Description: ${meta.description}` : '',
    meta.language ? `Primary language: ${meta.language}` : '',
    `Files analyzed: ${files.length}`,
    '',
  ].filter(Boolean);

  // Sort: docs first (likely README, guides), then configs, then code
  const sorted = [...files].sort((a, b) => {
    const order = { doc: 0, config: 1, code: 2 };
    return order[a.type] - order[b.type];
  });

  let charCount = sections.join('\n').length;

  for (const file of sorted) {
    const header = `\n--- ${file.path} (${file.type}) ---\n`;
    const content = file.content.slice(0, 8_000); // cap per file
    const block = header + content + '\n';

    if (charCount + block.length > maxChars) {
      sections.push(`\n[... ${sorted.length - sections.length} more files truncated]`);
      break;
    }

    sections.push(block);
    charCount += block.length;
  }

  return sections.join('\n');
}

/**
 * Code-aware extraction prompt supplement — recognizes software architecture
 * patterns and emits code-specific predicates.
 */
export const CODE_EXTRACTION_SUPPLEMENT = `
Additional rules for code/repository sources:
- Recognize functions, classes, components, modules, and services as entities.
- Use predicates like "imports", "depends-on", "exports", "extends", "implements", "calls", "renders", "configures".
- For TypeScript/JavaScript: identify exported functions/types, component hierarchies, store patterns.
- For Svelte/Vue/React: identify components, their props, events, and parent-child relationships.
- For config files: identify settings, environment variables, build targets, dependencies.
- Entity slugs should use the module/function path: "lib-rdf-types" not just "types".
- Mark dependency relationships (package.json, imports) with predicate "depends-on".
- Mark architectural patterns (store, component, utility, route) with predicate "has-role".
`;
