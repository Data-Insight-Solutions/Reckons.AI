/**
 * Publish targets — bring-your-own static host (F76). One place that knows the hosts a user can
 * publish their graph-site to, how each deploys, and the LIMITS that decide whether an asset-heavy
 * graph fits (Matt: "GitHub Pages isn't ideal due to file-size limits... Cloudflare and/or GitLab?").
 *
 * Reckons.AI hosts nothing — it builds the artifact and hands it to the user's own host. The
 * browser-first reality shapes the deploy model: GitHub's API is CORS-friendly, so the app can PUT
 * files straight to a GitHub repo; most other hosts (Cloudflare, GitLab) deploy by WATCHING a git
 * repo, so the app pushes to git and the host auto-deploys. Direct-upload APIs generally are not
 * browser-CORS-reachable and need a proxy (a Worker, or the user's n8n) — noted, not pretended.
 */

/** Which git host the app can PUSH the built site to (the deploy source). */
export type GitBackend = 'github' | 'gitlab';

/** How a host turns the built files into a live site. */
export type DeployModel =
  | 'cli' //           a local CLI deploys the built folder directly (Wrangler, netlify-cli) — no CORS, most direct
  | 'git-watched' //   host watches a connected git repo and auto-deploys on push (GitHub/GitLab Pages)
  | 'manual'; //       user drops the .zip / folder into the host's dashboard

/** A local CLI that deploys the built site folder. Local installs are acceptable (Matt, 2026-07-16). */
export interface DeployCli {
  tool: string;
  /** How to install it (shown once). */
  install: string;
  /** The deploy command, given the built-site directory and the project/site name. */
  command: (dir: string, project: string) => string;
}

export interface PublishTarget {
  id: 'github-pages' | 'cloudflare-pages' | 'gitlab-pages' | 'netlify' | 'zip';
  label: string;
  /** Per-file hard limit in MB. Infinity = effectively none for a static site. */
  perFileLimitMB: number;
  /** Rough whole-site soft limit in MB, or Infinity. For guidance, not a hard gate. */
  siteSoftLimitMB: number;
  deploy: DeployModel;
  /** The local CLI that deploys this target (when deploy is 'cli'). */
  cli?: DeployCli;
  /** Git hosts this target can deploy FROM (for git-watched, or as a CLI alternative). */
  gitBackends: GitBackend[];
  /** One-line setup guidance surfaced in the publish UI. */
  setup: string;
  /** The custom-domain / DNS step — technical but guided; empty when the host gives a free subdomain. */
  dns?: string;
}

/**
 * The known targets. Ordered by Matt's decision (F76): Cloudflare first (unlimited bandwidth, ~20k
 * files, already the operator host), then GitLab and Netlify, GitHub Pages kept but flagged
 * file-size-limited, and the always-available offline zip.
 */
export const PUBLISH_TARGETS: PublishTarget[] = [
  {
    id: 'cloudflare-pages',
    label: 'Cloudflare Pages',
    perFileLimitMB: 25, // Cloudflare Pages caps individual files at 25 MB — big media must offload to R2.
    siteSoftLimitMB: Infinity, // ~20,000 files, unlimited bandwidth.
    deploy: 'cli', // Wrangler does Direct Upload locally — no browser CORS, handles the whole deploy.
    cli: {
      tool: 'wrangler',
      install: 'npm i -g wrangler  (then: wrangler login)',
      command: (dir, project) => `wrangler pages deploy ${dir} --project-name=${project}`,
    },
    gitBackends: ['github', 'gitlab'], // alternative: connect a repo and let Cloudflare auto-deploy.
    setup: 'Deploy the built folder with Wrangler (wrangler pages deploy). Or connect a git repo to a Cloudflare Pages project for auto-deploy.',
    dns: 'Free *.pages.dev subdomain out of the box. For a custom domain, add it in the Pages project and Cloudflare guides the DNS (automatic if the domain is already on Cloudflare).',
  },
  {
    id: 'gitlab-pages',
    label: 'GitLab Pages',
    perFileLimitMB: Infinity, // effectively generous; whole-site cap is configurable (self-hosted).
    siteSoftLimitMB: 1024,
    deploy: 'git-watched',
    gitBackends: ['gitlab'],
    setup: 'Push to a GitLab project with a Pages CI job publishing the built site; GitLab serves it.',
    dns: 'Free <group>.gitlab.io subdomain. Custom domain: add it in Settings → Pages and set the DNS record it shows at your registrar.',
  },
  {
    id: 'netlify',
    label: 'Netlify',
    perFileLimitMB: Infinity,
    siteSoftLimitMB: Infinity,
    deploy: 'cli', // netlify-cli deploys the built folder directly.
    cli: {
      tool: 'netlify-cli',
      install: 'npm i -g netlify-cli  (then: netlify login)',
      command: (dir, project) => `netlify deploy --prod --dir=${dir}${project ? ` --site=${project}` : ''}`,
    },
    gitBackends: ['github', 'gitlab'],
    setup: 'Deploy the built folder with the Netlify CLI (netlify deploy --prod). Or connect a git repo for auto-deploy.',
    dns: 'Free *.netlify.app subdomain. Custom domain: add it in Site settings → Domains and set the DNS at your registrar.',
  },
  {
    id: 'github-pages',
    label: 'GitHub Pages',
    perFileLimitMB: 100, // hard 100 MB/file, and ~1 GB site soft cap — tight for asset-heavy graphs.
    siteSoftLimitMB: 1024,
    deploy: 'git-watched',
    gitBackends: ['github'],
    setup: 'Enable Pages on a GitHub repo; the app pushes the built site and GitHub serves it.',
    dns: 'Free <user>.github.io subdomain. Custom domain: add a CNAME file + set the DNS record at your registrar.',
  },
  {
    id: 'zip',
    label: 'Download .zip (host anywhere)',
    perFileLimitMB: Infinity,
    siteSoftLimitMB: Infinity,
    deploy: 'manual',
    gitBackends: [],
    setup: 'Download the site as a .zip and drop it into any static host or folder.',
  },
];

export function getTarget(id: PublishTarget['id']): PublishTarget | undefined {
  return PUBLISH_TARGETS.find((t) => t.id === id);
}

export interface AssetSizeWarning {
  path: string;
  bytes: number;
  limitMB: number;
}

/**
 * Preflight: which files in the built site exceed the chosen host's per-file limit. This is the
 * concrete answer to the file-size worry — before publishing, tell the user exactly which assets
 * (a big GLB, a video) will be rejected by e.g. Cloudflare's 25 MB cap, so they can offload those
 * to object storage (R2) and reference them by URL instead of failing the whole deploy.
 *
 * `files` maps path -> byte length (or the string content, whose UTF-8 byte length is measured).
 */
export function checkAssetSizes(
  files: Record<string, string | number | Uint8Array>,
  target: PublishTarget,
): AssetSizeWarning[] {
  const limitBytes = target.perFileLimitMB * 1024 * 1024;
  if (!Number.isFinite(limitBytes)) return [];
  const warnings: AssetSizeWarning[] = [];
  for (const [path, v] of Object.entries(files)) {
    const bytes =
      typeof v === 'number' ? v : typeof v === 'string' ? new TextEncoder().encode(v).length : v.byteLength;
    if (bytes > limitBytes) warnings.push({ path, bytes, limitMB: target.perFileLimitMB });
  }
  return warnings.sort((a, b) => b.bytes - a.bytes);
}

/** Human-readable size, for the preflight UI. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
