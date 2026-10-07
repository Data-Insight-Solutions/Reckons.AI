/**
 * Thin File System Access / OPFS adapter for the source corpus (F221). All logic lives in
 * $lib/ingest/source-corpus; this only maps its CorpusRoot onto a directory handle.
 */
import { CORPUS_DIR, type CorpusDir, type CorpusRoot } from '../ingest/source-corpus';

class FsCorpusDir implements CorpusDir {
  constructor(private dir: FileSystemDirectoryHandle) {}
  async write(name: string, data: string | Uint8Array): Promise<void> {
    const fh = await this.dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data as never);
    await w.close();
  }
  async readText(name: string): Promise<string | null> {
    try {
      return await (await (await this.dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }
}

/** Corpus rooted at `<root>/sources/`. The folder is created lazily, on first write. */
export function fsCorpusRoot(root: FileSystemDirectoryHandle): CorpusRoot {
  return {
    async listDirs() {
      const names: string[] = [];
      try {
        const sources = await root.getDirectoryHandle(CORPUS_DIR);
        for await (const e of (sources as any).values()) if (e.kind === 'directory') names.push(e.name);
      } catch { /* no sources/ yet */ }
      return names;
    },
    async openDir(name, create) {
      try {
        const sources = await root.getDirectoryHandle(CORPUS_DIR, { create });
        return new FsCorpusDir(await sources.getDirectoryHandle(name, { create }));
      } catch {
        return null;
      }
    },
  };
}

/** OPFS root, for when no folder is linked; null where OPFS is unavailable. */
export async function opfsCorpusRoot(): Promise<CorpusRoot | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    return fsCorpusRoot(await navigator.storage.getDirectory());
  } catch {
    return null;
  }
}
