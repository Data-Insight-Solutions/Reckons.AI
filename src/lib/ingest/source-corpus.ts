/**
 * Source corpus (F221) — the shared, storage-agnostic half of retaining a source.
 *
 * Layout (Matt, 2026-09-29; one module for browser and CLI so neither drifts into its own format):
 *
 *   sources/<slug>-<hash8>/original.<ext>   bytes exactly as received (only when there ARE bytes)
 *                          text.md          derived plain text
 *                          chunks.ttl       derived chunk corpus (chunksToTurtle)
 *
 * This module is pure: no DOM, no filesystem, no Node API. Storage is the thin `CorpusRoot`
 * interface below; adapters live in src/lib/storage/source-corpus-fs.ts.
 *
 * RULES HELD HERE:
 *  - RETENTION PASSES THE INGEST SAFETY GATE: text the classifier blocks is not retained.
 *  - A FAILED WRITE NEVER THROWS INTO INGEST: `retainSource` returns a result describing what
 *    happened (`retained`, `blocked`, `skipped` or `failed`), so the extraction is never lost to a
 *    disk error.
 *  - chunks.ttl is a separate corpus: it is never loaded into the statement store or fact search.
 *    The folder walk skips CORPUS_DIR for that reason (workspace.svelte.ts).
 */
import { classifyText } from '../safety/content-policy';
import { chunkText, chunksToTurtle, corporaFromImported, type FoldedCorpus } from './source-chunks';

/** Directory under the workspace root (or OPFS root). Never exported, published or walked for graphs. */
export const CORPUS_DIR = 'sources';
export const TEXT_FILE = 'text.md';
export const CHUNKS_FILE = 'chunks.ttl';
export const ORIGINAL_BASENAME = 'original';

/** Lowercase ASCII slug, at most 40 chars, never empty. Readable folder names for humans. */
export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'source';
}

/** First 8 characters of a content hash, restricted to [a-z0-9]. Null when the hash is unusable. */
export function hash8(hash: string): string | null {
  const h = hash.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return h.length === 8 ? h : null;
}

/** sources/<this>/ — null when there is no usable hash (never invent a name that cannot be found again). */
export function corpusDirName(title: string, hash: string): string | null {
  const h = hash8(hash);
  return h ? `${slugify(title)}-${h}` : null;
}

/** Find the directory for a source among existing directory names, by its hash suffix alone,
 *  so renaming a source's title never orphans its corpus. */
export function findCorpusDir(dirNames: string[], hash: string): string | null {
  const h = hash8(hash);
  if (!h) return null;
  return dirNames.find((n) => n.endsWith(`-${h}`)) ?? null;
}

const EXT_BY_MEDIA: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/** Extension for original.<ext>: from the filename when it has a sane one, else the media type, else bin. */
export function originalExtension(filename?: string, mediaType?: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '');
  if (m) return m[1].toLowerCase();
  const media = (mediaType ?? '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MEDIA[media] ?? 'bin';
}

/** Thin storage seam (extension point: adapters are FileSystemDirectoryHandle, OPFS and test fakes). */
export interface CorpusDir {
  write(name: string, data: string | Uint8Array): Promise<void>;
  readText(name: string): Promise<string | null>;
}
/** Root of the corpus store (extension point: same adapters as CorpusDir). */
export interface CorpusRoot {
  /** Names of the per-source directories. */
  listDirs(): Promise<string[]>;
  openDir(name: string, create: boolean): Promise<CorpusDir | null>;
}

export type RetainInput = {
  sourceId: string;
  title: string;
  /** Hash of `text` (the Source's own hash); names the version and the folder. */
  hash: string;
  text: string;
  /** Bytes as received, when there are bytes (an uploaded file). Never modified. */
  original?: { bytes: Uint8Array; filename?: string; mediaType?: string };
  generatedAt?: string;
};

export type RetainResult =
  | { status: 'retained'; dir: string; files: string[] }
  | { status: 'blocked' }
  | { status: 'skipped'; reason: 'no-hash' | 'no-text' }
  | { status: 'failed'; error: string };

/** Retain a source. Never throws: a storage failure is a result, not an exception. */
export async function retainSource(root: CorpusRoot, input: RetainInput): Promise<RetainResult> {
  if (!input.text) return { status: 'skipped', reason: 'no-text' };
  // The same gate ingest applies to statements: blocked material is not quietly written to disk.
  if (classifyText(input.text).rating === 'blocked') return { status: 'blocked' };
  const dirName = corpusDirName(input.title, input.hash);
  if (!dirName) return { status: 'skipped', reason: 'no-hash' };
  try {
    const dir = await root.openDir(dirName, true);
    if (!dir) return { status: 'failed', error: 'could not open source directory' };
    const files: string[] = [];
    const put = async (name: string, data: string | Uint8Array) => { await dir.write(name, data); files.push(name); };
    if (input.original) {
      await put(`${ORIGINAL_BASENAME}.${originalExtension(input.original.filename, input.original.mediaType)}`, input.original.bytes);
    }
    await put(TEXT_FILE, input.text);
    const ttl = chunksToTurtle({
      sourceId: input.sourceId,
      title: input.title,
      sha256: input.hash,
      chunks: chunkText(input.text),
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    });
    await put(CHUNKS_FILE, ttl);
    return { status: 'retained', dir: dirName, files };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** The retained plain text for a source (by hash), or null when none was kept or it is unreadable. */
export async function readRetainedText(root: CorpusRoot, hash: string): Promise<string | null> {
  try {
    const name = findCorpusDir(await root.listDirs(), hash);
    if (!name) return null;
    const dir = await root.openDir(name, false);
    return (await dir?.readText(TEXT_FILE)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The passages of the retained documents, ready to fold into a saved file (F107.10.2). Reads each
 * document's chunks.ttl through the importer when it is there (the pre-fold format stays readable and
 * keeps its generation time); otherwise cuts the retained text, which is deterministic. A document
 * with no retained copy contributes nothing. Never throws: a failure to read one document skips that
 * document, because a save must not be lost to a cache.
 */
export async function readFoldedCorpora(root: CorpusRoot, sources: Array<{ id: string; hash?: string }>): Promise<FoldedCorpus[]> {
  const out: FoldedCorpus[] = [];
  let dirs: string[];
  try { dirs = await root.listDirs(); } catch { return out; }
  for (const src of sources) {
    if (!src.hash) continue;
    try {
      const name = findCorpusDir(dirs, src.hash);
      const dir = name ? await root.openDir(name, false) : null;
      if (!dir) continue;
      const ttl = await dir.readText(CHUNKS_FILE);
      if (ttl) {
        try {
          const { importTurtleFull } = await import('../rdf/import-ttl');
          const mine = (await importTurtleFull(ttl)).chunks.filter((c) => c.sourceId === src.id);
          if (mine.length > 0) {
            out.push(...corporaFromImported(mine, { [src.id]: src.hash }));
            continue;
          }
        } catch {
          /* an unreadable cache is rebuilt from the retained text below */
        }
      }
      const text = await dir.readText(TEXT_FILE);
      if (text) out.push({ sourceId: src.id, sha256: src.hash, generatedAt: new Date(0).toISOString(), chunks: chunkText(text) });
    } catch {
      /* skip this document */
    }
  }
  return out;
}

export type AdoptReport = {
  adopted: string[];
  /** Already retained here (an original or earlier copy wins; nothing is overwritten). */
  alreadyHere: string[];
  /** Not adopted, and why. Reported, never silently dropped. */
  skipped: Array<{ sourceId: string; reason: string }>;
};

async function sha256Hex(text: string): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * A saved file that carries its documents' passages (F107.10.2) is opened in a profile that holds
 * none of them (F107.10.3). Rebuild each document's retained text from the passages, which are
 * disjoint and together cover it exactly, and write it with its chunks.ttl so the Source View finds
 * it by the same hash as always. This yields the extracted TEXT, not the original document: the
 * original bytes are not in the saved file.
 *
 * A document is adopted only if its passages are contiguous from 0, their text joins to a string
 * whose SHA-256 equals the version the file names, and the safety gate passes. Anything else is
 * reported in `skipped`. A document already retained here is left alone. Never throws.
 */
export async function adoptPassages(
  root: CorpusRoot,
  corpora: FoldedCorpus[],
  titles: Record<string, string>,
): Promise<AdoptReport> {
  const report: AdoptReport = { adopted: [], alreadyHere: [], skipped: [] };
  let dirs: string[] = [];
  try { dirs = await root.listDirs(); } catch { /* an unlistable root adopts nothing below */ }
  for (const c of corpora) {
    const skip = (reason: string) => report.skipped.push({ sourceId: c.sourceId, reason });
    try {
      if (!c.sha256) { skip('the file names no version for these passages'); continue; }
      if (findCorpusDir(dirs, c.sha256)) { report.alreadyHere.push(c.sourceId); continue; }
      const ordered = [...c.chunks].sort((a, b) => a.index - b.index);
      let at = 0;
      let contiguous = ordered.length > 0;
      for (const [i, k] of ordered.entries()) {
        if (k.index !== i || k.start !== at || k.end - k.start !== k.text.length) { contiguous = false; break; }
        at = k.end;
      }
      if (!contiguous) { skip('the passages do not cover the text from start to end'); continue; }
      const text = ordered.map((k) => k.text).join('');
      if (!text) { skip('no text'); continue; }
      const actual = await sha256Hex(text);
      if (actual === null) { skip('cannot verify the version here (no SHA-256)'); continue; }
      if (actual !== c.sha256.toLowerCase()) { skip('the passages do not hash to the version the file names'); continue; }
      if (classifyText(text).rating === 'blocked') { skip('blocked by the content gate'); continue; }
      const title = titles[c.sourceId] ?? c.sourceId;
      const dirName = corpusDirName(title, c.sha256);
      if (!dirName) { skip('unusable version'); continue; }
      const dir = await root.openDir(dirName, true);
      if (!dir) { skip('could not open a folder for it'); continue; }
      await dir.write(TEXT_FILE, text);
      await dir.write(CHUNKS_FILE, chunksToTurtle({
        sourceId: c.sourceId, title, sha256: c.sha256,
        chunks: ordered.map((k) => ({ ...k, contextStart: k.start })),
        generatedAt: c.generatedAt,
      }));
      dirs.push(dirName);
      report.adopted.push(c.sourceId);
    } catch (e) {
      skip(e instanceof Error ? e.message : String(e));
    }
  }
  return report;
}
