/**
 * CSP ORIGIN AUDIT — script tier. Zero tokens, no model, right by construction.
 *
 * WHY THIS EXISTS. Twice now a shipped feature has been dead in the browser because the host
 * it calls was missing from the connect-src allowlist in src/app.html, and twice the failure
 * was invisible to the test suite:
 *
 *   2026-07-31 (F55)  Indico. indico-verify.ts was 6/6 green while no browser had ever
 *                     reached the server, because the verifier ran in Node — a layer that
 *                     enforces neither CSP nor CORS.
 *   2026-08-13        api.github.com (repo ingest F14 AND site export F27, both marked
 *                     shipped, both blocked since the initial-release commit), api.tavily.com,
 *                     api.firecrawl.dev, and api.reckons.ai — the reckons provider's own
 *                     default baseUrl, which only entered the policy when an env var
 *                     overrode it.
 *
 * A CSP refusal happens BEFORE the request is sent, so there is no status code, no server log
 * and no network entry — just "TypeError: Failed to fetch". Nothing in a Node test suite can
 * see it. But the question "is every origin this code fetches present in the policy?" is
 * decidable by reading the source, which makes it script tier: the promotion ladder says
 * anything Opus does twice should stop being an Opus task.
 *
 * PRECISION OVER RECALL, DELIBERATELY. src/ mentions ~49 external hosts, of which only a
 * handful are actually fetched — the rest are documentation links, RDF namespaces, example.com
 * placeholders and test fixtures. A checker that flagged all 49 would move cost from
 * diagnosis to triage rather than removing it, which is the failure mode CLAUDE.md warns
 * about. So this only reports an origin when it can tie it to an actual network call.
 *
 * Run: npx tsx scripts/offline/csp-origin-audit.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONNECT_SRC_ENV_VARS } from './csp-connect-src.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const APP_HTML = join(ROOT, 'src/app.html');
const SCAN_DIRS = ['src/lib', 'src/routes'];

/** Origins the build-time substitution can add from configured env vars — not violations. */
const SUBSTITUTABLE = new Set(CONNECT_SRC_ENV_VARS);

// ── the policy ───────────────────────────────────────────────────────────────

/** Pull the connect-src source list out of the <meta> CSP. */
function readConnectSrc(html: string): string[] {
  const csp = html.match(/content="(default-src[^"]*)"/)?.[1];
  if (!csp) throw new Error('No CSP <meta> found in src/app.html');
  const directive = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
  if (!directive) throw new Error('No connect-src directive in the CSP');
  return directive.split(/\s+/).slice(1).filter(Boolean);
}

/**
 * Does the policy admit this origin? Handles the wildcard host forms actually in use
 * (https://*.huggingface.co) and scheme-only sources, but deliberately does NOT try to be a
 * complete CSP evaluator — an over-clever matcher that silently passes something the browser
 * would refuse is worse than no checker at all.
 */
function allowedBy(sources: string[], origin: string): boolean {
  const { protocol, hostname } = new URL(origin);
  return sources.some((raw) => {
    const src = raw.replace(/^(https?|wss?):\/\//, (m) => m);
    if (src === '*') return true;
    if (!src.includes('://')) return false;
    let u: URL;
    try {
      u = new URL(src.replace('*.', 'wildcard.'));
    } catch {
      return false;
    }
    if (u.protocol !== protocol && !(u.protocol === 'https:' && protocol === 'wss:')) return false;
    if (src.includes('://*.')) {
      const suffix = src.slice(src.indexOf('://*.') + 4); // ".huggingface.co[...]"
      return hostname.endsWith(suffix.split('/')[0]);
    }
    return u.hostname === hostname;
  });
}

// ── the code ─────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(ts|svelte|js)$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const NETWORK_CALL = /\b(?:fetch|WebSocket|EventSource)\s*\(\s*/g;

type Finding = { origin: string; file: string; line: number; snippet: string };

/**
 * Find origins reachable by a network call in one file.
 *
 * Two shapes cover essentially all real usage here:
 *   1. the URL sits inline in the call        — fetch('https://api.tavily.com/search')
 *   2. the URL is a module const used later   — const GITHUB_API = 'https://api.github.com'
 *                                               ... fetch(`${GITHUB_API}${path}`)
 * The second is the one a naive grep for `fetch('https` misses, and it is exactly how
 * api.github.com and api.firecrawl.dev were written.
 */
function scanFile(file: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const found = new Map<string, Finding>();

  /**
   * Resolve an identifier to a URL by searching BACKWARDS from the call site for its nearest
   * preceding assignment.
   *
   * A file-wide name->url map is WRONG HERE, and quietly so — that was the first version of
   * this function and it produced a false negative on the very bug it was written to catch.
   * src/lib/integrations/llm/providers.ts defines several providers in one file and reuses the
   * names `url` and `baseUrl` in each, so a flat first-write-wins map bound `url` to Gemini and
   * `baseUrl` to the Ollama localhost default, and api.reckons.ai vanished. Nearest-preceding
   * assignment is what a reader does, and it respects function boundaries closely enough
   * without parsing the file.
   */
  const resolve = (name: string, before: number, depth = 0): string | undefined => {
    if (depth > 3) return undefined;
    const region = text.slice(0, before);
    // Direct: name = 'https://...'   (covers const/let/var AND default parameters)
    const direct = [
      ...region.matchAll(
        new RegExp(`\\b${name}\\s*(?::[^=,)]+)?=\\s*['"\`]((?:https?|wss?)://[^'"\`\\s\${]+)`, 'g'),
      ),
    ].pop();
    // Indirect: name = `${other}/path`
    const indirect = [
      ...region.matchAll(new RegExp(`\\b${name}\\s*(?::[^=]+)?=\\s*\`([^\`]*)\``, 'g')),
    ].pop();
    if (direct && (!indirect || direct.index! > indirect.index!)) return direct[1];
    if (indirect) {
      const ref = indirect[1].match(/\$\{\s*([A-Za-z_$][\w$]*)/);
      if (ref) return resolve(ref[1], indirect.index!, depth + 1);
    }
    return undefined;
  };

  const record = (url: string, idx: number) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    if (/\.example(\.com)?$|(^|\.)example\.com$|localhost|127\.0\.0\.1/.test(new URL(url).hostname)) return;
    const line = text.slice(0, idx).split('\n').length;
    if (!found.has(origin)) {
      found.set(origin, { origin, file, line, snippet: (lines[line - 1] ?? '').trim().slice(0, 96) });
    }
  };

  for (const m of text.matchAll(
    /\b(?:fetch|WebSocket|EventSource)\s*\(\s*[`'"]((?:https?|wss?):\/\/[^`'"\s${]+)/g,
  )) {
    record(m[1], m.index!);
  }

  // Identifier or template argument: fetch(url, …) / fetch(`${GITHUB_API}${path}`, …)
  for (const m of text.matchAll(NETWORK_CALL)) {
    const at = m.index! + m[0].length;
    const arg = text.slice(at, at + 120);
    const ident = arg.match(/^`[^`]*?\$\{\s*([A-Za-z_$][\w$]*)/) ?? arg.match(/^([A-Za-z_$][\w$]*)\s*[,)]/);
    if (!ident) continue;
    const url = resolve(ident[1], m.index!);
    if (url) record(url, m.index!);
  }

  return [...found.values()];
}

// ── report ───────────────────────────────────────────────────────────────────

const sources = readConnectSrc(readFileSync(APP_HTML, 'utf8'));
const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

const violations: Finding[] = [];
const substitutable: Finding[] = [];

for (const file of files) {
  for (const f of scanFile(file)) {
    if (allowedBy(sources, f.origin)) continue;
    // An origin supplied by a configured env var is legitimately absent from the literal policy.
    if ([...SUBSTITUTABLE].some((v) => readFileSync(file, 'utf8').includes(v))) {
      substitutable.push(f);
      continue;
    }
    violations.push(f);
  }
}

console.log(`csp-origin-audit — ${files.length} files, ${sources.length} connect-src sources\n`);

if (substitutable.length) {
  console.log('Supplied at build time by a configured env var (not a violation):');
  for (const f of substitutable) {
    console.log(`  ${f.origin}  ${relative(ROOT, f.file)}:${f.line}`);
  }
  console.log('');
}

if (violations.length === 0) {
  console.log('OK — every origin reached by a network call is present in connect-src.');
  process.exit(0);
}

console.log(`${violations.length} origin(s) fetched by code but MISSING from connect-src:\n`);
for (const f of violations) {
  console.log(`  ${f.origin}`);
  console.log(`    ${relative(ROOT, f.file)}:${f.line}  ${f.snippet}`);
}
console.log(
  '\nThe browser refuses these BEFORE the request is sent, so the feature fails with a bare\n' +
    '"Failed to fetch" and no server ever sees the attempt. Add the origin to connect-src in\n' +
    'src/app.html, or route the call through an already-allowed proxy.',
);
process.exit(1);
