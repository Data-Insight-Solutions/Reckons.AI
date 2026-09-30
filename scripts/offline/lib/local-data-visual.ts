/**
 * Pure parts of scripts/offline/local-data-visual.ts — kept apart so they are testable without a
 * browser or anyone's data.
 */
import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Console noise the harness itself causes when --serve differs from --origin: the origin's dev-server
 * websocket is blocked on purpose, and loopback fetches from a proxied page are refused. Reported
 * separately so it is never mistaken for an app error, and never silently dropped either.
 */
export function isHarnessNoise(message: string): boolean {
  return /\[vite\] failed to connect to websocket|WebSocket connection to 'ws:\/\/localhost|Failed to send error to Vite server|access the `loopback` address space|net::ERR_FAILED$/.test(message);
}

/** Chromium's on-disk name for an origin's storage: http://localhost:5173 -> http_localhost_5173. */
export function originDirName(origin: string): string {
  const u = new URL(origin);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol.replace(':', '')}_${u.hostname}_${port}`;
}

export type BrowserProfile = {
  /** Profile directory holding IndexedDB/ and "Local Storage/". */
  dir: string;
  /** Browser executable that wrote it — the same build must read it back. */
  executable: string;
  /** Where a scratch copy must live for that browser to be allowed to open it (snap confinement). */
  scratchParent: string;
  label: string;
};

/** Chromium-family profiles on this machine that hold data for `origin`, most recently written first. */
export function findProfiles(origin: string, home = homedir()): BrowserProfile[] {
  const name = `${originDirName(origin)}.indexeddb.leveldb`;
  const families: { root: string; executable: string; scratchParent: string; label: string }[] = [
    { root: path.join(home, 'snap/chromium/common/chromium'), executable: '/snap/bin/chromium', scratchParent: path.join(home, 'snap/chromium/common'), label: 'Chromium (snap)' },
    { root: path.join(home, '.config/chromium'), executable: '/usr/bin/chromium', scratchParent: path.join(home, '.cache'), label: 'Chromium' },
    { root: path.join(home, '.config/google-chrome'), executable: '/usr/bin/google-chrome', scratchParent: path.join(home, '.cache'), label: 'Google Chrome' },
    { root: path.join(home, '.config/BraveSoftware/Brave-Browser'), executable: '/usr/bin/brave-browser', scratchParent: path.join(home, '.cache'), label: 'Brave' },
    { root: path.join(home, '.config/microsoft-edge'), executable: '/usr/bin/microsoft-edge', scratchParent: path.join(home, '.cache'), label: 'Edge' },
  ];
  const found: (BrowserProfile & { mtime: number })[] = [];
  for (const f of families) {
    if (!existsSync(f.root)) continue;
    for (const p of ['Default', 'Profile 1', 'Profile 2', 'Profile 3']) {
      const db = path.join(f.root, p, 'IndexedDB', name);
      if (!existsSync(db)) continue;
      found.push({ dir: path.join(f.root, p), executable: f.executable, scratchParent: f.scratchParent, label: `${f.label} / ${p}`, mtime: statSync(db).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(({ mtime: _mtime, ...rest }) => rest);
}

/**
 * The private output directory for screenshots and the report. Personal data renders into these
 * screenshots, so the directory is outside any git checkout, owner-only, and never behind a symlink —
 * the same rules scripts/offline/lib/private-audit.ts applies to host audits.
 */
export function privateVisualDirectory(stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state')): string {
  if (!path.isAbsolute(stateHome)) throw new Error('State location must be absolute.');
  const dir = path.resolve(stateHome, 'reckons', 'local-visual');
  for (let p = dir; ; p = path.dirname(p)) {
    if (existsSync(path.join(p, '.git'))) throw new Error('Refusing to write personal screenshots inside a Git checkout.');
    try { if (lstatSync(p).isSymbolicLink()) throw new Error('Refusing a symlinked output path.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (p === path.dirname(p)) break;
  }
  return dir;
}

export type Args = { origin: string; serve: string; paths: string[]; width: number; height: number; keep: boolean; waitFor?: string; evalExpr?: string };

export function parseArgs(argv: string[]): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const origin = (get('origin') ?? 'http://localhost:5173').replace(/\/$/, '');
  const serve = (get('serve') ?? origin).replace(/\/$/, '');
  for (const u of [origin, serve]) {
    const h = new URL(u).hostname;
    if (!['localhost', '127.0.0.1', '::1'].includes(h)) throw new Error(`Only local origins are allowed, got ${u}: personal data must not be served to or from another machine.`);
  }
  const paths = (get('paths') ?? '/').split(',').map((p) => (p.startsWith('/') ? p : `/${p}`));
  return {
    origin, serve, paths,
    width: Number(get('width') ?? 1280), height: Number(get('height') ?? 1000),
    keep: argv.includes('--keep'), waitFor: get('wait-for'), evalExpr: get('eval'),
  };
}
