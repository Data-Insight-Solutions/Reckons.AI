import { describe, it, expect } from 'vitest';
import { conflictNotice, separateConflictCopies, type DiscoveredSpace } from '../sync-conflicts';

const sp = (path: string, stableId?: string): DiscoveredSpace => ({ folderName: path.split('/').at(-2) ?? path, path: path.split('/'), meta: { name: path, stableId } });

describe('separateConflictCopies — the space id decides, not the filename', () => {
  it('keeps the conventional file and reports each service\'s conflict copy', () => {
    for (const copy of [
      'kbs/work/work (Matt\'s conflicted copy 2026-09-30).ttl', // Dropbox
      'kbs/work/work-DESKTOP-4F2A.ttl', // OneDrive
      'kbs/work/work 2.ttl', // iCloud
      'kbs/work/work (1).ttl', // Google Drive for desktop
      'kbs/work/work.sync-conflict-20260930-101500-ABCDEFG.ttl', // Syncthing
    ]) {
      const { kept, conflicts } = separateConflictCopies([sp(copy, 'id-1'), sp('kbs/work/work.ttl', 'id-1')]);
      expect(kept.map((k) => k.path.join('/'))).toEqual(['kbs/work/work.ttl']);
      expect(conflicts).toEqual([{ stableId: 'id-1', kept: 'kbs/work/work.ttl', copies: [copy] }]);
    }
  });

  it('prefers a name without conflict markers when neither file is conventional', () => {
    const { kept } = separateConflictCopies([sp('notes/plan (1).ttl', 'x'), sp('notes/plan.ttl', 'x')]);
    expect(kept[0].path.join('/')).toBe('notes/plan.ttl');
  });

  it('leaves distinct spaces and id-less files alone, in discovery order', () => {
    const found = [sp('kbs/a/a.ttl', 'A'), sp('loose.ttl'), sp('kbs/b/b.ttl', 'B'), sp('other.ttl')];
    const { kept, conflicts } = separateConflictCopies(found);
    expect(kept).toEqual(found);
    expect(conflicts).toEqual([]);
  });

  it('never groups two files that simply lack a stable id', () => {
    expect(separateConflictCopies([sp('x.ttl'), sp('x (1).ttl')]).conflicts).toEqual([]);
  });

  it('says what was used, what was skipped, and that nothing was deleted', () => {
    expect(conflictNotice({ stableId: 'i', kept: 'kbs/w/w.ttl', copies: ['kbs/w/w (1).ttl'] }))
      .toMatch(/2 files claim to be the same space.*Using kbs\/w\/w\.ttl; not imported: kbs\/w\/w \(1\)\.ttl.*nothing was deleted/);
  });
});
