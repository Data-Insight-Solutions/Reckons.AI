/**
 * Settings → This Device, the host half (F245). A Vite plugin, DEV SERVER ONLY (`apply: 'serve'`).
 *
 * Matt, 2026-10-29: the agent:watch terminal "was getting very long and difficult to keep properly
 * scrolled down to the bottom and still see the most important details. We should add an agent
 * watch UI page, and a way to start the agent watch command from the UI." A page cannot read the
 * Ollama log, run nvidia-smi or start a process; the dev server is a Node process on the same
 * machine that Matt already runs, so it is the host here. Endpoints, under /__reckons/device/:
 *
 *   GET  agent-watch          the latest snapshot from the watcher child, and whether it runs
 *   POST agent-watch/start    start `watch.ts --ndjson` (the queue worker too, unless {worker:false})
 *   POST agent-watch/stop     SIGTERM it; the watcher stops its worker in turn
 *   GET  host                 OS, CPU, memory, GPUs
 *   GET  installed            Ollama models (/api/tags) and the MCP servers in .mcp.json
 *
 * NOT kb:local-host-mode (F243). That is the real host: opt-in, token on every endpoint, reachable
 * from a phone. This one exists only while `npm run dev` runs, so a deployed or `vite preview` build
 * has none of it and the page says so. It takes no token; instead it answers only requests whose Host
 * is a loopback name (which defeats DNS rebinding) and, for POST, whose Origin is that same host
 * (which defeats another site posting to localhost). It runs no command it is given: the only
 * process it starts is the watcher, with fixed arguments. WEAKNESS: any page served by this dev
 * server can call it, which is the same trust the dev server already extends to its own pages.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export const BRIDGE_PREFIX = '/__reckons/device';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const hostname = (hostHeader: string | undefined): string | undefined => {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
};

/** Pure. A read needs a loopback Host; a write also needs an Origin naming that same host. */
export function isTrustedRequest(r: { method?: string; host?: string; origin?: string; secFetchSite?: string }): boolean {
  const h = hostname(r.host);
  if (!h || !LOOPBACK.has(h)) return false;
  if (r.secFetchSite && r.secFetchSite !== 'same-origin' && r.secFetchSite !== 'none') return false;
  if ((r.method ?? 'GET') === 'GET') return true;
  if (!r.origin) return false;
  try {
    return new URL(r.origin).host === r.host;
  } catch {
    return false;
  }
}

export type McpServerView = { name: string; transport: 'stdio' | 'http'; via: string };

/** Pure. Names and how each server is reached: never args, env or headers, which carry keys. */
export function mcpServers(json: unknown): McpServerView[] {
  const servers = (json as { mcpServers?: Record<string, { command?: string; url?: string; type?: string }> })?.mcpServers ?? {};
  return Object.entries(servers).map(([name, s]) => {
    if (s.url) {
      let via = 'url';
      try { via = new URL(s.url).host; } catch { /* keep 'url' */ }
      return { name, transport: 'http', via };
    }
    return { name, transport: 'stdio', via: path.basename(s.command ?? '?') };
  });
}

type WatchState = {
  child?: ChildProcess;
  startedAt?: string;
  worker: boolean;
  /** The last complete snapshot line, already parsed. */
  snapshot?: unknown;
  snapshotAt?: string;
  /** Last few stderr lines, for when it dies before its first snapshot. */
  stderr: string[];
  /** requested: stopped from the page. tsx relays SIGTERM as exit code 143, so the signal alone cannot tell. */
  exit?: { code: number | null; signal: string | null; at: string; requested: boolean };
  stopRequested?: boolean;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) break;
  }
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function gpus(): { index: number; name: string; memoryMiB: number; driver?: string }[] {
  const r = spawnSync('nvidia-smi', ['--query-gpu=index,name,memory.total,driver_version', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.trim().split('\n').map((l) => {
    const [index, name, mem, driver] = l.split(',').map((x) => x.trim());
    return { index: Number(index), name, memoryMiB: Number(mem), driver };
  });
}

function hostSpecs() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpus[0]?.model?.trim() ?? 'unknown',
    cores: cpus.length,
    memoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    uptimeSeconds: os.uptime(),
    node: process.version,
    /** Empty when nvidia-smi is absent: no NVIDIA GPU visible, not "no GPU". */
    gpus: gpus(),
  };
}

async function installed(root: string) {
  const base = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  let ollama: { up: boolean; url: string; models: { name: string; sizeBytes: number; family?: string; parameters?: string; quantization?: string; modifiedAt?: string }[] };
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const tags = (await r.json()) as { models?: { name: string; size: number; modified_at?: string; details?: { family?: string; parameter_size?: string; quantization_level?: string } }[] };
    ollama = { up: true, url: base, models: (tags.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size, family: m.details?.family, parameters: m.details?.parameter_size, quantization: m.details?.quantization_level, modifiedAt: m.modified_at })) };
  } catch {
    ollama = { up: false, url: base, models: [] };
  }
  let mcp: McpServerView[] | null = null;
  const mcpPath = path.join(root, '.mcp.json');
  if (existsSync(mcpPath)) {
    try { mcp = mcpServers(JSON.parse(readFileSync(mcpPath, 'utf8'))); } catch { mcp = null; }
  }
  return { ollama, mcp, mcpFile: existsSync(mcpPath) ? '.mcp.json' : null };
}

export function deviceBridge(): Plugin {
  const state: WatchState = { worker: true, stderr: [] };
  let root = process.cwd();

  const running = () => !!state.child && state.child.exitCode === null && state.child.signalCode === null;

  function start(worker: boolean): void {
    if (running()) return;
    const tsxCli = createRequire(path.join(root, 'package.json')).resolve('tsx/cli');
    const args = [tsxCli, path.join(root, 'scripts/agent/watch.ts'), '--ndjson', ...(worker ? [] : ['--no-worker'])];
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    Object.assign(state, { child, worker, startedAt: new Date().toISOString(), snapshot: undefined, snapshotAt: undefined, stderr: [], exit: undefined, stopRequested: false });
    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          state.snapshot = JSON.parse(line);
          state.snapshotAt = new Date().toISOString();
        } catch { /* a partial or foreign line; the next one replaces it */ }
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { state.stderr = [...state.stderr, ...chunk.split('\n').filter(Boolean)].slice(-12); });
    child.on('exit', (code, signal) => { state.exit = { code, signal, at: new Date().toISOString(), requested: !!state.stopRequested }; });
  }

  function stop(): void {
    if (!running()) return;
    state.stopRequested = true;
    state.child!.kill('SIGTERM');
  }

  return {
    name: 'reckons-device-bridge',
    apply: 'serve',
    configResolved(config) { root = config.root; },
    configureServer(server) {
      server.httpServer?.once('close', stop);
      process.once('exit', stop);
      server.middlewares.use(BRIDGE_PREFIX, (req, res) => {
        void (async () => {
          if (!isTrustedRequest({ method: req.method, host: req.headers.host, origin: req.headers.origin, secFetchSite: req.headers['sec-fetch-site'] as string | undefined })) {
            return json(res, 403, { error: 'loopback, same-origin requests only' });
          }
          const route = `${req.method} ${(req.url ?? '/').split('?')[0]}`;
          switch (route) {
            case 'GET /agent-watch':
              return json(res, 200, {
                running: running(), pid: running() ? state.child!.pid : undefined, worker: state.worker, startedAt: state.startedAt,
                snapshot: state.snapshot ?? null, snapshotAt: state.snapshotAt, exit: state.exit, stderr: state.stderr,
                command: 'npm run agent:watch',
              });
            case 'POST /agent-watch/start': {
              const body = await readBody(req);
              start(body.worker !== false);
              return json(res, 202, { running: running() });
            }
            case 'POST /agent-watch/stop':
              stop();
              return json(res, 202, { stopping: true });
            case 'GET /host':
              return json(res, 200, hostSpecs());
            case 'GET /installed':
              return json(res, 200, await installed(root));
            default:
              return json(res, 404, { error: `no route ${route}` });
          }
        })().catch((e: unknown) => json(res, 500, { error: String(e) }));
      });
    },
  };
}
