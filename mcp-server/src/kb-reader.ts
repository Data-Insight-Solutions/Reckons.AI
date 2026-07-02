/**
 * KB Reader — parses Reckons.AI .ttl files into queryable in-memory triples.
 *
 * Supports two modes:
 *  1. Single-file: `--kb /path/to/knowledge.ttl` (legacy)
 *  2. Workspace:   `--kb /path/to/workspace/` (scans kbs/{name}/{name}.ttl,
 *                  falling back to the legacy kbs/{name}/kb.ttl filename)
 *
 * Reckons.AI exports annotated Turtle with named graphs carrying provenance:
 *   GRAPH <urn:kbase:source/SOURCE_ID> { s p o . }
 *
 * This reader handles both annotated (named graphs) and plain Turtle.
 */

import { readFileSync, statSync, readdirSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store, Parser, DataFactory, type Quad } from 'n3';

export type Triple = {
  subject: string;
  predicate: string;
  object: string;
  objectIsLiteral: boolean;
  graph?: string;
  sourceId?: string;
};

export type KBStats = {
  tripleCount: number;
  sourceCount: number;
  entityCount: number;
  lastModified: Date;
};

export type KBInfo = {
  folderName: string;
  name: string;
  stats: KBStats;
};

// ── Single-KB store ─────────────────────────────────────────────────────────

function parseTtl(text: string): Quad[] {
  try {
    const parser = new Parser({ format: 'Turtle*' });
    const quads = parser.parse(text);
    if (quads.length > 0) return quads;
  } catch { /* try plain Turtle */ }

  try {
    const parser = new Parser({ format: 'Turtle' });
    return parser.parse(text);
  } catch { /* return empty */ }

  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function quadToTriple(q: any): Triple {
  return {
    subject: q.subject.value,
    predicate: q.predicate.value,
    object: q.object.value,
    objectIsLiteral: q.object.termType === 'Literal',
    graph: q.graph?.value || undefined,
    sourceId: q.graph?.value?.replace('urn:kbase:source/', '') || undefined,
  };
}

function storeStats(store: Store, mtime: number): KBStats {
  const subjects = new Set<string>();
  const graphs = new Set<string>();
  for (const q of store) {
    subjects.add(q.subject.value);
    if (q.graph?.value) graphs.add(q.graph.value);
  }
  return {
    tripleCount: store.size,
    sourceCount: graphs.size,
    entityCount: subjects.size,
    lastModified: new Date(mtime),
  };
}

// ── KBReader (single file — kept for internal use) ──────────────────────────

export class KBReader {
  private ttlPath: string;
  private store: Store = new Store();
  private lastMtime = 0;

  constructor(ttlPath: string) {
    this.ttlPath = resolve(ttlPath);
    this.reload();
  }

  reload(): void {
    try {
      const stat = statSync(this.ttlPath);
      const mtime = stat.mtimeMs;
      if (mtime === this.lastMtime) return;
      this.lastMtime = mtime;

      const text = readFileSync(this.ttlPath, 'utf8');
      const quads = parseTtl(text);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (quads.length > 0) this.store = new Store(quads as any);
    } catch {
      // File doesn't exist yet or is unreadable — start with empty store
    }
  }

  watch(cb: () => void): void {
    watchFile(this.ttlPath, { interval: 2000 }, () => {
      this.reload();
      cb();
    });
  }

  /** Stop watching this reader's file (used when a KB's resolved path changes). */
  unwatch(): void {
    unwatchFile(this.ttlPath);
  }

  stats(): KBStats {
    return storeStats(this.store, this.lastMtime);
  }

  allTriples(): Triple[] {
    const out: Triple[] = [];
    for (const q of this.store) out.push(quadToTriple(q));
    return out;
  }

  triplesAbout(iri: string): Triple[] {
    const node = DataFactory.namedNode(iri);
    const out: Triple[] = [];
    const seen = new Set<string>();
    const add = (q: Quad) => {
      const key = `${q.subject.value}\t${q.predicate.value}\t${q.object.value}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(quadToTriple(q));
    };
    for (const q of this.store.getQuads(node, null, null, null)) add(q);
    for (const q of this.store.getQuads(null, null, node, null)) add(q);
    return out;
  }

  subgraph(iri: string, hops = 1): Triple[] {
    const visited = new Set<string>([iri]);
    let frontier = [iri];
    const out: Triple[] = [];
    const seen = new Set<string>();

    for (let h = 0; h < hops; h++) {
      const next: string[] = [];
      for (const entity of frontier) {
        const node = DataFactory.namedNode(entity);
        const add = (q: Quad) => {
          const key = `${q.subject.value}\t${q.predicate.value}\t${q.object.value}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.push(quadToTriple(q));
          if (q.object.termType === 'NamedNode' && !visited.has(q.object.value)) {
            visited.add(q.object.value);
            next.push(q.object.value);
          }
          if (!visited.has(q.subject.value)) {
            visited.add(q.subject.value);
            next.push(q.subject.value);
          }
        };
        for (const q of this.store.getQuads(node, null, null, null)) add(q);
        for (const q of this.store.getQuads(null, null, node, null)) add(q);
      }
      frontier = next;
    }
    return out;
  }

  entityIRIs(): string[] {
    const seen = new Set<string>();
    for (const q of this.store) {
      if (q.subject.termType === 'NamedNode') seen.add(q.subject.value);
    }
    return [...seen];
  }

  resolveLabel(label: string): string | null {
    const lower = label.toLowerCase();
    for (const iri of this.entityIRIs()) {
      const slug = iri.split('/').pop()?.toLowerCase() ?? '';
      if (slug === lower || slug.includes(lower)) return iri;
    }
    return null;
  }
}

// ── MultiKBReader (workspace directory) ─────────────────────────────────────

export class MultiKBReader {
  private wsDir: string;
  private kbsDir: string;
  private readers = new Map<string, KBReader>(); // folderName → KBReader
  /** folderName → resolved ttl path currently backing that reader (for re-resolution on rename/migration) */
  private resolvedPaths = new Map<string, string>();
  /** Change callback registered via watch() — attached to readers created on later re-scans too */
  private watchCb: (() => void) | null = null;
  /** Legacy single-file reader (for backward compat with --kb file.ttl) */
  private legacyReader: KBReader | null = null;

  constructor(kbPath: string) {
    const stat = statSync(kbPath);

    if (!stat.isDirectory()) {
      // Legacy mode: single .ttl file
      this.legacyReader = new KBReader(kbPath);
      this.wsDir = '';
      this.kbsDir = '';
      return;
    }

    this.wsDir = resolve(kbPath);
    this.kbsDir = join(this.wsDir, 'kbs');
    this.scanKbs();
  }

  /**
   * Resolve the TTL file for a KB folder. Prefers `{folderName}.ttl`;
   * falls back to the legacy `kb.ttl`. If both exist, the named file wins
   * and a warning is logged so stale legacy files get noticed.
   */
  private resolveTtlPath(kbDir: string, folderName: string): string | null {
    const namedPath = join(kbDir, `${folderName}.ttl`);
    const legacyPath = join(kbDir, 'kb.ttl');
    const namedExists = existsSync(namedPath);
    const legacyExists = existsSync(legacyPath);

    if (namedExists && legacyExists) {
      console.error(
        `[kb-reader] Both ${folderName}.ttl and legacy kb.ttl found in ${kbDir} — using ${folderName}.ttl (kb.ttl ignored)`
      );
      return namedPath;
    }
    if (namedExists) return namedPath;
    if (legacyExists) return legacyPath;
    return null;
  }

  private scanKbs(): void {
    if (!this.kbsDir || !existsSync(this.kbsDir)) return;

    const entries = readdirSync(this.kbsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const kbDir = join(this.kbsDir, entry.name);
      const ttlPath = this.resolveTtlPath(kbDir, entry.name);

      if (!ttlPath) continue;

      // Load or update the reader — recreate if the resolved path changed
      // (e.g. a workspace was migrated from kb.ttl to {name}.ttl at runtime).
      const prevPath = this.resolvedPaths.get(entry.name);
      if (!this.readers.has(entry.name) || prevPath !== ttlPath) {
        // Stop watching the old file (if any) and watch the newly resolved one
        this.readers.get(entry.name)?.unwatch();
        const reader = new KBReader(ttlPath);
        if (this.watchCb) reader.watch(this.watchCb);
        this.readers.set(entry.name, reader);
        this.resolvedPaths.set(entry.name, ttlPath);
      } else {
        this.readers.get(entry.name)!.reload();
      }
    }
  }

  /** Re-scan the kbs/ directory for new or changed KBs. */
  reload(): void {
    if (this.legacyReader) {
      this.legacyReader.reload();
      return;
    }
    this.scanKbs();
    for (const reader of this.readers.values()) reader.reload();
  }

  /** Watch all KB files for changes (each KB's resolved TTL file — named or legacy). */
  watch(cb: () => void): void {
    if (this.legacyReader) {
      this.legacyReader.watch(cb);
      return;
    }
    this.watchCb = cb; // readers created on future re-scans get watched too
    for (const reader of this.readers.values()) reader.watch(cb);
    // Also poll the kbs/ dir for new KBs
    if (this.kbsDir && existsSync(this.kbsDir)) {
      watchFile(this.kbsDir, { interval: 5000 }, () => {
        this.scanKbs();
        cb();
      });
    }
  }

  /** Is this running in legacy single-file mode? */
  isLegacy(): boolean {
    return this.legacyReader !== null;
  }

  /** List all known KBs with their metadata and stats. */
  listKbs(): KBInfo[] {
    if (this.legacyReader) {
      return [{ folderName: 'default', name: 'default', stats: this.legacyReader.stats() }];
    }

    const result: KBInfo[] = [];
    for (const [folderName, reader] of this.readers) {
      result.push({ folderName, name: folderName, stats: reader.stats() });
    }
    return result;
  }

  /** Get a specific KB reader by folder name. */
  private getReader(kbName?: string): KBReader | null {
    if (this.legacyReader) return this.legacyReader;
    if (!kbName) return null;

    // Try exact folder name match
    if (this.readers.has(kbName)) return this.readers.get(kbName)!;

    // Try case-insensitive / substring match on folder name
    const lower = kbName.toLowerCase();
    for (const [folder, reader] of this.readers) {
      if (folder.toLowerCase() === lower || folder.toLowerCase().includes(lower)) return reader;
    }
    return null;
  }

  /** Get all readers (for cross-KB queries). */
  private allReaders(): KBReader[] {
    if (this.legacyReader) return [this.legacyReader];
    return [...this.readers.values()];
  }

  /** Get all triples, optionally filtered to a specific KB. */
  allTriples(kbName?: string): Triple[] {
    if (kbName) {
      const reader = this.getReader(kbName);
      return reader ? reader.allTriples() : [];
    }
    // All KBs combined
    const out: Triple[] = [];
    for (const reader of this.allReaders()) out.push(...reader.allTriples());
    return out;
  }

  /** Get aggregate stats across all KBs, or for a specific KB. */
  stats(kbName?: string): KBStats & { kbCount: number } {
    const readers = kbName ? (() => { const r = this.getReader(kbName); return r ? [r] : []; })() : this.allReaders();
    let tripleCount = 0, entityCount = 0, sourceCount = 0;
    let lastModified = new Date(0);
    const allEntities = new Set<string>();
    const allSources = new Set<string>();

    for (const reader of readers) {
      const s = reader.stats();
      tripleCount += s.tripleCount;
      if (s.lastModified > lastModified) lastModified = s.lastModified;
      for (const iri of reader.entityIRIs()) allEntities.add(iri);
      for (const t of reader.allTriples()) {
        if (t.graph) allSources.add(t.graph);
      }
    }

    return {
      tripleCount,
      entityCount: allEntities.size,
      sourceCount: allSources.size,
      lastModified,
      kbCount: readers.length,
    };
  }

  triplesAbout(iri: string, kbName?: string): Triple[] {
    if (kbName) {
      const reader = this.getReader(kbName);
      return reader ? reader.triplesAbout(iri) : [];
    }
    const seen = new Set<string>();
    const out: Triple[] = [];
    for (const reader of this.allReaders()) {
      for (const t of reader.triplesAbout(iri)) {
        const key = `${t.subject}\t${t.predicate}\t${t.object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }

  subgraph(iri: string, hops: number, kbName?: string): Triple[] {
    if (kbName) {
      const reader = this.getReader(kbName);
      return reader ? reader.subgraph(iri, hops) : [];
    }
    const seen = new Set<string>();
    const out: Triple[] = [];
    for (const reader of this.allReaders()) {
      for (const t of reader.subgraph(iri, hops)) {
        const key = `${t.subject}\t${t.predicate}\t${t.object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }

  entityIRIs(kbName?: string): string[] {
    if (kbName) {
      const reader = this.getReader(kbName);
      return reader ? reader.entityIRIs() : [];
    }
    const seen = new Set<string>();
    for (const reader of this.allReaders()) {
      for (const iri of reader.entityIRIs()) seen.add(iri);
    }
    return [...seen];
  }

  resolveLabel(label: string, kbName?: string): string | null {
    if (kbName) {
      const reader = this.getReader(kbName);
      return reader ? reader.resolveLabel(label) : null;
    }
    for (const reader of this.allReaders()) {
      const iri = reader.resolveLabel(label);
      if (iri) return iri;
    }
    return null;
  }

  /** List sources from sources.json files in workspace KBs. */
  listSources(kbName?: string): Array<{ kb: string; source: Record<string, unknown> }> {
    if (this.legacyReader) return [];
    const results: Array<{ kb: string; source: Record<string, unknown> }> = [];

    const folders = kbName
      ? (() => {
          // Find matching folder
          const lower = kbName.toLowerCase();
          for (const folder of this.readers.keys()) {
            if (folder === kbName || folder.toLowerCase() === lower) return [folder];
          }
          return [];
        })()
      : [...this.readers.keys()];

    for (const folder of folders) {
      const sourcesPath = join(this.kbsDir, folder, 'sources.json');
      if (!existsSync(sourcesPath)) continue;
      try {
        const raw = readFileSync(sourcesPath, 'utf8');
        const sources = JSON.parse(raw) as Record<string, unknown>[];
        for (const src of sources) results.push({ kb: folder, source: src });
      } catch { /* skip bad sources file */ }
    }
    return results;
  }

  /** Get the workspace directory path (for writing pending files). */
  getKbFolderPath(kbName?: string): string | null {
    if (this.legacyReader) return null;
    if (!kbName) {
      // Default to first KB
      const first = this.readers.keys().next().value;
      return first ? join(this.kbsDir, first) : null;
    }
    // Try exact match
    if (this.readers.has(kbName)) return join(this.kbsDir, kbName);
    // Try folder name match
    const lower = kbName.toLowerCase();
    for (const folder of this.readers.keys()) {
      if (folder.toLowerCase() === lower || folder.toLowerCase().includes(lower)) return join(this.kbsDir, folder);
    }
    return null;
  }

  /** Get the legacy TTL path (for kb_add_note backward compat). */
  getLegacyTtlPath(): string | null {
    if (!this.wsDir) return null;
    const p = join(this.wsDir, 'knowledge.ttl');
    return existsSync(p) ? p : null;
  }
}
