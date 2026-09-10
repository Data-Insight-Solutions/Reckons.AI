#!/usr/bin/env npx tsx
/**
 * Rank the local generation catalogue by whether an agent can actually run it. SCRIPT TIER.
 *
 * Matt, 2026-08-28: "prioritize easy to install and open, along with compatibility to run from
 * local agents."
 *
 * THREE AXES, AND EVERY ONE IS DERIVED FROM THE REPOSITORY RATHER THAN RECALLED. That restriction
 * is the whole point: "easy to install" is exactly the kind of claim a language model will assert
 * confidently and wrongly, and the catalogue already caught seven dormant projects whose READMEs
 * say nothing about it.
 *
 *   OPEN        the licence class. Permissive is usable outright; GPL/AGPL only as the user's own
 *               separate process; NONE or NOASSERTION is not clearable by inspection at all.
 *   INSTALLABLE the top-level file listing says how it is installed. A prebuilt binary or a
 *               Dockerfile beats a Python environment, and a repo with neither is a build.
 *   INVOKABLE   the README documents a COMMAND. An agent drives a tool through kpred:command, so a
 *               project whose only documented entry point is a web UI cannot be a task no matter
 *               how good it is.
 *
 * MAINTENANCE IS A GATE, NOT AN AXIS. A dormant project can score perfectly on all three and still
 * be the wrong answer, so it is reported separately rather than averaged away.
 *
 * WHAT THIS DOES NOT MEASURE: whether the output is any good. That is taste, it routes to the user
 * (kb:verifiability-axis), and no amount of repository metadata substitutes for looking at a
 * generated image.
 *
 * Usage:
 *   npx tsx scripts/offline/generation-fit.ts                    rank the catalogue
 *   npx tsx scripts/offline/generation-fit.ts --write            write scores back into the TTL
 */
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const CATALOGUE = 'static/reckons-generation-tools.ttl';

const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'MPL-2.0', 'ISC']);
const COPYLEFT = new Set(['GPL-3.0', 'AGPL-3.0', 'GPL-2.0', 'LGPL-3.0']);

export type Fit = {
  repo: string;
  license: string;
  open: 0 | 1 | 2;
  installable: 0 | 1 | 2;
  invokable: 0 | 1 | 2;
  total: number;
  install: string;
  invoke: string;
  dormant: boolean;
};

/** Licence class. Unlicensed scores zero because it is not a matter of degree. */
export function scoreOpen(license: string): { score: 0 | 1 | 2; why: string } {
  if (PERMISSIVE.has(license)) return { score: 2, why: license };
  if (COPYLEFT.has(license)) return { score: 1, why: `${license} — sidecar only` };
  return { score: 0, why: 'no recognised licence' };
}

/**
 * How it installs, from the top-level file listing.
 *
 * A prebuilt release or a Dockerfile is one command; a Python project is an environment, a CUDA
 * version and an afternoon. That ordering is not a preference, it is the difference between a task
 * a runner can set up unattended and one that needs a person.
 */
export function scoreInstall(files: string[], hasReleases: boolean): { score: 0 | 1 | 2; why: string } {
  const has = (name: string) => files.some((f) => f.toLowerCase() === name);
  if (hasReleases) return { score: 2, why: 'prebuilt release' };
  if (has('dockerfile') || has('docker-compose.yml') || has('compose.yaml')) return { score: 2, why: 'docker' };
  if (has('package.json')) return { score: 1, why: 'node' };
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) return { score: 1, why: 'python env' };
  if (has('cmakelists.txt') || has('makefile')) return { score: 1, why: 'build from source' };
  return { score: 0, why: 'unclear' };
}

/**
 * Whether the README documents a command an agent could put in kpred:command.
 *
 * Text evidence, not judgement: a fenced shell invocation, a `--flag`, a `python -m`, a
 * `docker run`, a `curl` against a local port. A project documented only through screenshots of a
 * web UI scores zero, which is correct — it may be excellent and it still cannot be a task.
 */
export function scoreInvoke(readme: string): { score: 0 | 1 | 2; why: string } {
  const text = readme.toLowerCase();
  const cli = /(^|\n)\s*(\$ |> )?(\.\/|python -m |python3 -m |npx |uvx |cargo run|go run)/.test(text)
    || /--\w[\w-]+\s/.test(text);
  const http = /localhost:\d+|127\.0\.0\.1:\d+|curl\s+-x?\s*post|\/v1\/|api endpoint/.test(text);
  const docker = /docker run|docker compose up/.test(text);
  if (cli && (http || docker)) return { score: 2, why: 'cli + api' };
  if (cli) return { score: 2, why: 'cli' };
  if (http || docker) return { score: 1, why: http ? 'http api' : 'docker only' };
  return { score: 0, why: 'no documented command' };
}

function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return '';
  }
}

export function assess(repo: string): Fit | null {
  const meta = gh(['api', `repos/${repo}`, '--jq', '{l:(.license.spdx_id // "NONE"),p:.pushed_at[0:10]}']);
  if (!meta) return null;
  const { l: license, p: pushed } = JSON.parse(meta);

  const listing = gh(['api', `repos/${repo}/contents`, '--jq', '[.[].name] | join("\\n")']);
  const files = listing.trim().split('\n').filter(Boolean);
  const releases = gh(['api', `repos/${repo}/releases?per_page=1`, '--jq', 'length']).trim();
  const hasReleases = releases === '1';

  const readmeB64 = gh(['api', `repos/${repo}/readme`, '--jq', '.content']).replace(/\s/g, '');
  const readme = readmeB64 ? Buffer.from(readmeB64, 'base64').toString('utf8') : '';

  const open = scoreOpen(license);
  const install = scoreInstall(files, hasReleases);
  const invoke = scoreInvoke(readme);

  return {
    repo,
    license,
    open: open.score,
    installable: install.score,
    invokable: invoke.score,
    total: open.score + install.score + invoke.score,
    install: install.why,
    invoke: invoke.why,
    dormant: pushed < '2026-01-01',
  };
}

/** Every repo-url in the catalogue, as owner/name. */
export function catalogueRepos(file = CATALOGUE): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/kpred:repo-url\s+"https:\/\/github\.com\/([^"]+)"/g)].map((m) => m[1]);
}

function main(): void {
  const repos = catalogueRepos();
  const fits: Fit[] = [];
  for (const repo of repos) {
    const fit = assess(repo);
    if (fit) fits.push(fit);
  }
  fits.sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));

  console.log('  fit  open inst invk  repo                                    install        invoke');
  for (const f of fits) {
    const flag = f.dormant ? ' \x1b[2m(dormant)\x1b[0m' : '';
    console.log(
      `  ${String(f.total).padStart(3)}/6   ${f.open}    ${f.installable}    ${f.invokable}   ` +
        `${f.repo.padEnd(38)} ${f.install.padEnd(14)} ${f.invoke}${flag}`,
    );
  }

  const best = fits.filter((f) => f.total === 6 && !f.dormant);
  console.log(`\n${best.length} scored 6/6 and are actively maintained:`);
  for (const f of best) console.log(`   ${f.repo}  (${f.license})`);
  console.log('\nMaintenance is a GATE, not an axis — a dormant tool can score 6/6 and still be wrong.');
  console.log('And none of this measures whether the OUTPUT is any good. That is taste, and it routes to you.');

  if (WRITE) {
    let ttl = readFileSync(CATALOGUE, 'utf8');
    for (const f of fits) {
      const marker = `kpred:repo-url     "https://github.com/${f.repo}" ;`;
      if (!ttl.includes(marker)) continue;
      ttl = ttl.replace(
        marker,
        `${marker}\n    kpred:agent-fit    ${f.total} ;\n` +
          `    kpred:install-shape ${JSON.stringify(f.install)} ;\n` +
          `    kpred:agent-interface ${JSON.stringify(f.invoke)} ;`,
      );
    }
    writeFileSync(CATALOGUE, ttl, 'utf8');
    console.log(`\nWrote agent-fit scores into ${CATALOGUE}.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('generation-fit.ts')) main();
