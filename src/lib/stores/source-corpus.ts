/**
 * Store-level entry points for the source corpus (F221): pick the linked workspace folder, or OPFS
 * when none is linked, and delegate to the shared module. Retention failure is reported, never thrown.
 */
import { retainSource, readRetainedText, readFoldedCorpora, adoptPassages, type AdoptReport, type RetainInput, type RetainResult, type CorpusRoot } from '../ingest/source-corpus';
import { corporaFromImported, type FoldedCorpus } from '../ingest/source-chunks';
import { fsCorpusRoot, opfsCorpusRoot } from '../storage/source-corpus-fs';
import { workspaceHandle } from './workspace.svelte';

async function currentRoot(): Promise<CorpusRoot | null> {
  const h = workspaceHandle();
  return h ? fsCorpusRoot(h) : opfsCorpusRoot();
}

export async function retainSourceCorpus(input: RetainInput): Promise<RetainResult> {
  const root = await currentRoot();
  if (!root) return { status: 'failed', error: 'no workspace folder and no OPFS available' };
  return retainSource(root, input);
}

/** Retained text for a source version (by Source.hash), or null. */
export async function readRetainedSourceText(hash: string | undefined): Promise<string | null> {
  if (!hash) return null;
  const root = await currentRoot();
  return root ? readRetainedText(root, hash) : null;
}

/** Passages are immutable per document version (its hash), so a save never re-reads a document it has read. */
const passageCache = new Map<string, FoldedCorpus>();

/**
 * The retained documents' passages, to fold into the saved file on every write of it: copy,
 * workspace sync, Drive sync, auto-save (F107.10.2 / F107.10.3). Empty when none are kept. A read
 * failure yields fewer passages, never a failed save.
 */
export async function readSourcePassages(sources: Array<{ id: string; hash?: string }>): Promise<FoldedCorpus[]> {
  const out: FoldedCorpus[] = [];
  const missing: Array<{ id: string; hash?: string }> = [];
  for (const s of sources) {
    const hit = s.hash ? passageCache.get(`${s.id}:${s.hash}`) : undefined;
    if (hit) out.push(hit); else missing.push(s);
  }
  if (missing.length > 0) {
    const root = await currentRoot();
    const read = root ? await readFoldedCorpora(root, missing) : [];
    for (const c of read) {
      const src = missing.find((m) => m.id === c.sourceId);
      if (src?.hash) passageCache.set(`${src.id}:${src.hash}`, c);
    }
    out.push(...read);
  }
  return out;
}

/** `readSourcePassages`, tolerant: for the save paths, where passages are a rider and never a reason to fail. */
export async function passagesForSave(sources: Array<{ id: string; hash?: string }>): Promise<FoldedCorpus[]> {
  try { return await readSourcePassages(sources); } catch (e) { console.warn('[save] source passages not included:', e); return []; }
}

/**
 * Passages read from an opened saved file: keep them here so the Source View finds them (F107.10.3).
 * Returns what was adopted and what was not, and why.
 */
export async function adoptSpacePassages(
  chunks: Parameters<typeof corporaFromImported>[0],
  versions: Record<string, string> | undefined,
  sources: Array<{ id: string; title: string }>,
): Promise<AdoptReport | null> {
  if (chunks.length === 0) return null;
  const root = await currentRoot();
  if (!root) return null;
  return adoptPassages(root, corporaFromImported(chunks, versions), Object.fromEntries(sources.map((s) => [s.id, s.title])));
}
