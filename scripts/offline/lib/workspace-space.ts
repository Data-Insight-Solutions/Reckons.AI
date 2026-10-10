/**
 * Which workspace space a static graph file belongs to — the `kb` a pending row must carry.
 *
 * The app's drain (partitionPendingJsonl) imports a pending row ONLY into the space its `kb` names;
 * a row without one is retained forever and never reaches the Review tab. Producers whose findings
 * are about a FILE (graph-lint) resolve it here instead of guessing one space for everything.
 *
 * setup-reckons-workspace.sh links each space's .ttl to its source in static/, so the mapping is
 * read from those links, not restated. A file no space links to returns undefined: its row stays
 * unscoped (and unreviewable in the app) rather than being imported into the wrong space.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function spaceForFileMap(root = process.cwd()): Map<string, string> {
  const kbs = path.join(root, 'reckons-workspace', 'kbs');
  const map = new Map<string, string>();
  if (!existsSync(kbs)) return map;
  for (const space of readdirSync(kbs, { withFileTypes: true })) {
    if (!space.isDirectory()) continue;
    const dir = path.join(kbs, space.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ttl') && !f.endsWith('.trig')) continue;
      try { map.set(path.relative(root, realpathSync(path.join(dir, f))), space.name); }
      catch { /* a dangling link names no file */ }
    }
  }
  return map;
}
