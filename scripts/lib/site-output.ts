import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertSitePath } from '../../src/lib/publish/output-path.js';

const MANIFEST = '.reckons-site.json';
const FORMAT = 'reckons-generated-site-v1';

function directoryChain(root: string, destination: string): void {
  let current = root;
  for (const part of path.relative(root, destination).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    if (!existsSync(current)) {
      // lstat also detects a dangling symlink, which existsSync does not.
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink output path'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe output directory');
  }
}

function verifyOwned(directory: string): void {
  const marker = path.join(directory, MANIFEST);
  if (!existsSync(marker) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) {
    throw new Error('Output directory is not owned by the site generator; choose a new directory');
  }
  const manifest = JSON.parse(readFileSync(marker, 'utf8'));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files) || !manifest.files.every((f: unknown) => typeof f === 'string')) {
    throw new Error('Invalid site ownership manifest');
  }
  const owned = new Set<string>(manifest.files.map((f: string) => assertSitePath(f)));
  const ownedDirectories = new Set<string>();
  for (const file of owned) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) ownedDirectories.add(parts.slice(0, i).join('/'));
  }
  const walk = (dir: string, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Symlink in output directory');
      if (entry.isDirectory()) {
        if (!ownedDirectories.has(relative)) throw new Error('Unowned output directory');
        walk(path.join(dir, entry.name), relative + '/');
      } else if (!entry.isFile() || (relative !== MANIFEST && !owned.has(relative))) {
        throw new Error('Unowned file in output directory');
      }
    }
  };
  walk(directory);
}

/** Stage first; only replace directories previously created by this generator.
 * Assumes exclusive access to the output parent while publishing (not a sandbox
 * against a hostile local process racing filesystem changes).
 */
export function writeGeneratedSite(output: string, files: Record<string, string>, options: { cwd?: string; inputFile?: string } = {}): string {
  const root = realpathSync(options.cwd ?? process.cwd());
  if (!output || /[\\\x00-\x1f]/.test(output) || output.split('/').some(p => p === '.' || p === '..')) {
    throw new Error('Ambiguous site output directory');
  }
  const destination = path.resolve(root, output);
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Site output must be a child directory of the working directory');
  }
  if (options.inputFile) {
    const input = realpathSync(options.inputFile);
    if (input === destination || input.startsWith(destination + path.sep)) throw new Error('Input graph is inside output directory');
  }
  const paths = Object.keys(files).map(assertSitePath);
  // Validate every path before creating or replacing anything.
  const outputPaths = new Set(paths);
  if (paths.some(p => p.split('/').slice(0, -1).some((_, index, parts) => outputPaths.has(parts.slice(0, index + 1).join('/'))))) {
    throw new Error('Conflicting site output paths');
  }
  directoryChain(root, destination);
  if (existsSync(destination)) verifyOwned(destination);
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(path.join(parent, '.reckons-site-stage-'));
  let previous: string | undefined;
  try {
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(stage, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, { flag: 'wx' });
    }
    writeFileSync(path.join(stage, MANIFEST), JSON.stringify({ format: FORMAT, files: paths }), { flag: 'wx' });
    directoryChain(root, destination);
    if (existsSync(destination)) {
      verifyOwned(destination);
      previous = mkdtempSync(path.join(parent, '.reckons-site-previous-'));
      // Empty reserved sibling directory is replaced atomically by the old output.
      renameSync(destination, previous);
    }
    try { renameSync(stage, destination); }
    catch (error) { if (previous) renameSync(previous, destination); throw error; }
    if (previous) rmSync(previous, { recursive: true });
    return destination;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
