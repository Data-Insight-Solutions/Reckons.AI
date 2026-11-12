/**
 * Dead-weight, one QUESTION per directory (F89.4.3).
 *
 * The sweep used to queue one review row per unimported file. A deliberate scaffold or a vendored
 * tree of 40 files became 40 rows a person could only defer, because the sweep cannot tell a
 * deliberate scaffold from dead code (a reviewer batch on 2026-11-10 deferred 10 of 10 such rows,
 * each accurate and none decidable). What the sweep cannot know is INTENT, so it asks for it once
 * per directory and stores the answer as a fact it reads on its next run:
 *
 *     <module that owns the directory>  kpred:kept-on-purpose  "<repo-relative directory>"
 *
 * A directory answered that way, or lying under one that was, is never listed again.
 * Pure over its inputs: no filesystem, no clock, so a fixture drives it.
 */
import type { Quad } from 'n3';

export const KEPT_ON_PURPOSE = 'urn:kbase:predicate/kept-on-purpose';
export const DIRECTORY_PREDICATE = KEPT_ON_PURPOSE;

const clean = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '');
export const dirOf = (file: string): string => {
  const i = file.lastIndexOf('/');
  return i < 0 ? '.' : file.slice(0, i);
};

/** Directories the graph records as kept whole on purpose. */
export function keptDirectories(quads: Iterable<Pick<Quad, 'predicate' | 'object'>>): Set<string> {
  const out = new Set<string>();
  for (const q of quads) if (q.predicate.value === KEPT_ON_PURPOSE) out.add(clean(q.object.value));
  return out;
}

/** True when `dir` is a kept directory or lies under one. */
export function isKept(dir: string, kept: ReadonlySet<string>): boolean {
  const d = clean(dir);
  for (const k of kept) if (d === k || d.startsWith(`${k}/`)) return true;
  return false;
}

export interface DirectoryGroup { dir: string; files: string[] }

/**
 * Group unimported files by their directory. Files under a kept directory are counted in
 * `suppressed` and appear in no group.
 */
export function groupByDirectory(files: readonly string[], kept: ReadonlySet<string>): { groups: DirectoryGroup[]; suppressed: number } {
  const by = new Map<string, string[]>();
  let suppressed = 0;
  for (const f of [...new Set(files)].sort()) {
    const dir = dirOf(f);
    if (isKept(dir, kept)) { suppressed++; continue; }
    (by.get(dir) ?? by.set(dir, []).get(dir)!).push(f);
  }
  return { groups: [...by].map(([dir, fs]) => ({ dir, files: fs })), suppressed };
}

export interface DirectoryQuestionRow {
  subject: string;
  predicate: string;
  question: string;
  type: 'question';
  lane: 'question';
  kb: 'codebase';
  agent: 'offline:dead-weight';
  priority: 'medium';
  addedAt: string;
  addedByMcp: true;
}

/**
 * The one row for a directory. The subject is the owning module when the graph names one, else a
 * concept derived from the path. The question carries the exact answer to give.
 */
export function directoryQuestion(g: DirectoryGroup, opts: { owner?: string; now: string }): DirectoryQuestionRow {
  const slug = g.dir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
  const shown = g.files.slice(0, 6).map((f) => f.slice(g.dir.length + 1) || f).join(', ');
  const more = g.files.length > 6 ? ` and ${g.files.length - 6} more` : '';
  return {
    subject: opts.owner ?? `urn:kbase:concept/dir-${slug}`,
    predicate: DIRECTORY_PREDICATE,
    question: `[dead-weight/directory] Is ${g.dir}/ kept whole on purpose? ${g.files.length} file(s) in it have no import line anywhere (${shown}${more}). `
      + `Answer "${g.dir}" if it is a deliberate scaffold, vendored or published tree: the sweep then stops listing it. Otherwise finish the wiring or retire the files.`,
    type: 'question',
    lane: 'question',
    kb: 'codebase',
    agent: 'offline:dead-weight',
    priority: 'medium',
    addedAt: opts.now,
    addedByMcp: true,
  };
}
