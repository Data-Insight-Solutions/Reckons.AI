/**
 * Store-level entry points for the source corpus (F221): pick the linked workspace folder, or OPFS
 * when none is linked, and delegate to the shared module. Retention failure is reported, never thrown.
 */
import { retainSource, readRetainedText, readFoldedCorpora, type RetainInput, type RetainResult, type CorpusRoot } from '../ingest/source-corpus';
import type { FoldedCorpus } from '../ingest/source-chunks';
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

/** The retained sources' passages, to fold into the space file on export (F107.10.2). Empty when none are kept. */
export async function readSourcePassages(sources: Array<{ id: string; hash?: string }>): Promise<FoldedCorpus[]> {
  const root = await currentRoot();
  return root ? readFoldedCorpora(root, sources) : [];
}
