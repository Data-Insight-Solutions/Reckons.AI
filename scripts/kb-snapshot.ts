#!/usr/bin/env npx tsx
/**
 * KB Snapshot — captures current KB state for before/after comparison.
 *
 * Used by Claude Code pre-review and post-review commands, and by CI.
 *
 * Usage:
 *   npx tsx scripts/kb-snapshot.ts [options]
 *
 * Options:
 *   --output FILE     Write snapshot JSON to FILE (default: stdout)
 *   --compare FILE    Compare current state against a previous snapshot
 *   --work "desc"     Description of planned/completed work (improves matching)
 *   --ref HEAD~N      Git ref for alignment scoring (default HEAD~5)
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MultiKBReader, type Triple } from '../mcp-server/src/kb-reader.js';
import { bm25Search, invalidateCache } from '../mcp-server/src/search.js';
import { gitChangedFiles, gitLog, gitStatus } from '../mcp-server/src/git-utils.js';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outputIdx = args.indexOf('--output');
const OUTPUT = outputIdx >= 0 ? args[outputIdx + 1] : null;
const compareIdx = args.indexOf('--compare');
const COMPARE = compareIdx >= 0 ? args[compareIdx + 1] : null;
const workIdx = args.indexOf('--work');
const WORK = workIdx >= 0 ? args[workIdx + 1] : null;
const refIdx = args.indexOf('--ref');
const GIT_REF = refIdx >= 0 ? args[refIdx + 1] ?? 'HEAD~5' : 'HEAD~5';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const WORKSPACE = join(ROOT, 'reckons-workspace');

// ── Types ────────────────────────────────────────────────────────────────────

type EntitySnapshot = {
  iri: string;
  slug: string;
  status?: string;
  featureId?: string;
  description?: string;
  testedBy: string[];
  hasFiles: string[];
  dependsOn: string[];
};

type Snapshot = {
  timestamp: string;
  gitBranch: string;
  gitHead: string;
  gitRef: string;
  work?: string;
  entities: EntitySnapshot[];
  alignment: {
    composite: number;
    grade: string;
    coverage: number;
    status: number;
    deps: number;
    scope: number;
    changedFiles: number;
  } | null;
  stats: {
    totalTriples: number;
    totalEntities: number;
    kbCount: number;
  };
};

type SnapshotDiff = {
  addedEntities: string[];
  removedEntities: string[];
  statusChanges: Array<{ entity: string; from: string; to: string }>;
  newTestLinks: Array<{ entity: string; file: string }>;
  removedTestLinks: Array<{ entity: string; file: string }>;
  newFileLinks: Array<{ entity: string; file: string }>;
  removedFileLinks: Array<{ entity: string; file: string }>;
  alignmentDelta: number | null;
  triplesDelta: number;
  summary: string;
};

// ── Snapshot capture ─────────────────────────────────────────────────────────

function captureSnapshot(kb: MultiKBReader): Snapshot {
  const allTriples = kb.allTriples();
  const entityIRIs = kb.entityIRIs();

  // Extract feature entities (those with has-status)
  const entities: EntitySnapshot[] = [];
  for (const iri of entityIRIs) {
    const triples = kb.triplesAbout(iri);

    const get = (suffix: string) => triples.find(t => t.predicate.endsWith(`/${suffix}`))?.object;
    const getAll = (suffix: string) => triples.filter(t => t.predicate.endsWith(`/${suffix}`)).map(t => t.object);

    const status = get('has-status');
    // Only snapshot entities with a status or tested-by or has-file (skip generic triples)
    const testedBy = getAll('tested-by');
    const hasFiles = getAll('has-file');

    if (!status && testedBy.length === 0 && hasFiles.length === 0) continue;

    entities.push({
      iri,
      slug: iri.split('/').pop() ?? iri,
      status,
      featureId: get('feature-id'),
      description: get('description'),
      testedBy,
      hasFiles,
      dependsOn: getAll('depends-on'),
    });
  }

  // Alignment score
  let alignment: Snapshot['alignment'] = null;
  try {
    const changed = gitChangedFiles(GIT_REF);
    if (changed.length > 0) {
      invalidateCache();
      const keywords = new Set<string>();
      for (const f of changed) {
        for (const part of f.path.split('/')) {
          const name = part.replace(/\.[^.]+$/, '');
          if (name.length > 2) {
            keywords.add(name.toLowerCase());
            for (const w of name.split(/[-_.]/).filter(w => w.length > 2)) keywords.add(w.toLowerCase());
          }
        }
      }

      let query = [...keywords].join(' ');
      if (WORK) query = `${WORK} ${query}`;

      const searchHits = bm25Search(allTriples, query, 15);
      const featureEntities: Array<{ slug: string; status: string }> = [];

      for (const hit of searchHits) {
        const iri = hit.triple.subject;
        const triples = kb.triplesAbout(iri);
        const statusT = triples.find(t => t.predicate.endsWith('/has-status'));
        if (!statusT) continue;
        const slug = iri.split('/').pop() ?? iri;
        if (!featureEntities.some(f => f.slug === slug)) {
          featureEntities.push({ slug, status: statusT.object });
        }
      }

      const matchedSlugs = new Set<string>();
      for (const fe of featureEntities) {
        matchedSlugs.add(fe.slug.toLowerCase());
        for (const w of fe.slug.toLowerCase().split(/[-_]/)) if (w.length > 2) matchedSlugs.add(w);
      }

      let covered = 0;
      for (const f of changed) {
        const name = f.path.split('/').pop()?.replace(/\.[^.]+$/, '')?.toLowerCase() ?? '';
        if ([...matchedSlugs].some(s => name.includes(s) || s.includes(name))) covered++;
      }
      const coverageScore = covered / changed.length;

      const ORDER: Record<string, number> = { speculative: 0, planned: 1, scaffolded: 2, functional: 3, production: 4 };
      let statusSum = 0;
      for (const fe of featureEntities) {
        const rank = ORDER[fe.status] ?? 2;
        statusSum += rank <= 1 ? 1.0 : rank === 2 ? 0.9 : rank === 3 ? 0.7 : 0.5;
      }
      const statusScore = featureEntities.length > 0 ? statusSum / featureEntities.length : 0;
      const scopeScore = Math.max(0, 1 - ((changed.length - covered) / changed.length) * 0.8);

      const composite = coverageScore * 0.30 + statusScore * 0.30 + 1.0 * 0.20 + scopeScore * 0.20;
      const grade = composite >= 0.85 ? 'EXCELLENT' : composite >= 0.70 ? 'GOOD' : composite >= 0.50 ? 'FAIR' : 'POOR';

      alignment = { composite, grade, coverage: coverageScore, status: statusScore, deps: 1.0, scope: scopeScore, changedFiles: changed.length };
    }
  } catch { /* git unavailable */ }

  // Git info
  let gitBranch = '', gitHead = '';
  try {
    const status = gitStatus();
    gitBranch = status.branch;
    const commits = gitLog(1);
    gitHead = commits[0]?.hash ?? '';
  } catch { /* git unavailable */ }

  const stats = kb.stats();

  return {
    timestamp: new Date().toISOString(),
    gitBranch,
    gitHead,
    gitRef: GIT_REF,
    work: WORK ?? undefined,
    entities,
    alignment,
    stats: {
      totalTriples: stats.tripleCount,
      totalEntities: stats.entityCount,
      kbCount: stats.kbCount,
    },
  };
}

// ── Snapshot comparison ──────────────────────────────────────────────────────

function compareSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const beforeMap = new Map(before.entities.map(e => [e.iri, e]));
  const afterMap = new Map(after.entities.map(e => [e.iri, e]));

  const addedEntities = after.entities
    .filter(e => !beforeMap.has(e.iri))
    .map(e => e.slug);

  const removedEntities = before.entities
    .filter(e => !afterMap.has(e.iri))
    .map(e => e.slug);

  const statusChanges: SnapshotDiff['statusChanges'] = [];
  const newTestLinks: SnapshotDiff['newTestLinks'] = [];
  const removedTestLinks: SnapshotDiff['removedTestLinks'] = [];
  const newFileLinks: SnapshotDiff['newFileLinks'] = [];
  const removedFileLinks: SnapshotDiff['removedFileLinks'] = [];

  for (const [iri, afterEntity] of afterMap) {
    const beforeEntity = beforeMap.get(iri);
    if (!beforeEntity) continue;

    // Status changes
    if (beforeEntity.status !== afterEntity.status && afterEntity.status) {
      statusChanges.push({
        entity: afterEntity.slug,
        from: beforeEntity.status ?? '(none)',
        to: afterEntity.status,
      });
    }

    // Test link changes
    const beforeTests = new Set(beforeEntity.testedBy);
    const afterTests = new Set(afterEntity.testedBy);
    for (const t of afterTests) {
      if (!beforeTests.has(t)) newTestLinks.push({ entity: afterEntity.slug, file: t });
    }
    for (const t of beforeTests) {
      if (!afterTests.has(t)) removedTestLinks.push({ entity: afterEntity.slug, file: t });
    }

    // File link changes
    const beforeFiles = new Set(beforeEntity.hasFiles);
    const afterFiles = new Set(afterEntity.hasFiles);
    for (const f of afterFiles) {
      if (!beforeFiles.has(f)) newFileLinks.push({ entity: afterEntity.slug, file: f });
    }
    for (const f of beforeFiles) {
      if (!afterFiles.has(f)) removedFileLinks.push({ entity: afterEntity.slug, file: f });
    }
  }

  const alignmentDelta = (before.alignment && after.alignment)
    ? after.alignment.composite - before.alignment.composite
    : null;

  const triplesDelta = after.stats.totalTriples - before.stats.totalTriples;

  // Build summary
  const parts: string[] = [];
  if (addedEntities.length) parts.push(`+${addedEntities.length} entities`);
  if (removedEntities.length) parts.push(`-${removedEntities.length} entities`);
  if (statusChanges.length) parts.push(`${statusChanges.length} status changes`);
  if (newTestLinks.length) parts.push(`+${newTestLinks.length} test links`);
  if (newFileLinks.length) parts.push(`+${newFileLinks.length} file links`);
  if (triplesDelta !== 0) parts.push(`${triplesDelta > 0 ? '+' : ''}${triplesDelta} triples`);
  if (alignmentDelta !== null && Math.abs(alignmentDelta) > 0.01) {
    parts.push(`alignment ${alignmentDelta > 0 ? '+' : ''}${(alignmentDelta * 100).toFixed(0)}%`);
  }

  return {
    addedEntities,
    removedEntities,
    statusChanges,
    newTestLinks,
    removedTestLinks,
    newFileLinks,
    removedFileLinks,
    alignmentDelta,
    triplesDelta,
    summary: parts.length > 0 ? parts.join(', ') : 'no changes',
  };
}

// ── Output formatting ────────────────────────────────────────────────────────

function formatSnapshot(snap: Snapshot): string {
  const lines: string[] = [
    `KB Snapshot — ${snap.timestamp}`,
    `Branch: ${snap.gitBranch}  Head: ${snap.gitHead.slice(0, 8)}`,
    `Stats: ${snap.stats.totalTriples} triples, ${snap.stats.totalEntities} entities, ${snap.stats.kbCount} KBs`,
  ];

  if (snap.work) lines.push(`Work: ${snap.work}`);

  if (snap.alignment) {
    lines.push(`Alignment: ${snap.alignment.composite.toFixed(2)} (${snap.alignment.grade})`);
    lines.push(`  Coverage: ${(snap.alignment.coverage * 100).toFixed(0)}%  Status: ${(snap.alignment.status * 100).toFixed(0)}%  Scope: ${(snap.alignment.scope * 100).toFixed(0)}%`);
  }

  const features = snap.entities.filter(e => e.status);
  if (features.length > 0) {
    lines.push('', `Features (${features.length}):`);
    for (const e of features) {
      const tests = e.testedBy.length > 0 ? ` [${e.testedBy.length} tests]` : '';
      const files = e.hasFiles.length > 0 ? ` [${e.hasFiles.length} files]` : '';
      lines.push(`  ${e.slug} [${e.status}]${tests}${files}`);
    }
  }

  return lines.join('\n');
}

function formatDiff(diff: SnapshotDiff, before: Snapshot, after: Snapshot): string {
  const lines: string[] = [
    'KB Change Report',
    '═'.repeat(40),
    `Before: ${before.timestamp.slice(0, 19)} (${before.gitHead.slice(0, 8)})`,
    `After:  ${after.timestamp.slice(0, 19)} (${after.gitHead.slice(0, 8)})`,
    `Summary: ${diff.summary}`,
  ];

  if (diff.alignmentDelta !== null) {
    const dir = diff.alignmentDelta > 0 ? 'improved' : diff.alignmentDelta < 0 ? 'degraded' : 'unchanged';
    lines.push(`Alignment: ${before.alignment!.composite.toFixed(2)} → ${after.alignment!.composite.toFixed(2)} (${dir})`);
  }

  if (diff.statusChanges.length > 0) {
    lines.push('', 'Status Changes:');
    for (const c of diff.statusChanges) {
      lines.push(`  ${c.entity}: ${c.from} → ${c.to}`);
    }
  }

  if (diff.addedEntities.length > 0) {
    lines.push('', 'New Entities:');
    for (const e of diff.addedEntities) lines.push(`  + ${e}`);
  }

  if (diff.removedEntities.length > 0) {
    lines.push('', 'Removed Entities:');
    for (const e of diff.removedEntities) lines.push(`  - ${e}`);
  }

  if (diff.newTestLinks.length > 0) {
    lines.push('', 'New Test Coverage:');
    for (const t of diff.newTestLinks) lines.push(`  + ${t.entity} ← ${t.file}`);
  }

  if (diff.newFileLinks.length > 0) {
    lines.push('', 'New File Links:');
    for (const f of diff.newFileLinks) lines.push(`  + ${f.entity} ← ${f.file}`);
  }

  if (diff.removedTestLinks.length > 0) {
    lines.push('', 'Removed Test Coverage:');
    for (const t of diff.removedTestLinks) lines.push(`  - ${t.entity} ← ${t.file}`);
  }

  if (diff.triplesDelta !== 0) {
    lines.push('', `Triple count: ${before.stats.totalTriples} → ${after.stats.totalTriples} (${diff.triplesDelta > 0 ? '+' : ''}${diff.triplesDelta})`);
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(join(WORKSPACE, 'kbs'))) {
    console.error('MCP workspace not found. Run: bash scripts/setup-mcp-workspace.sh');
    process.exit(1);
  }

  const kb = new MultiKBReader(WORKSPACE);

  if (COMPARE) {
    // Compare mode: load previous snapshot and diff
    if (!existsSync(COMPARE)) {
      console.error(`Snapshot file not found: ${COMPARE}`);
      process.exit(1);
    }

    const before: Snapshot = JSON.parse(readFileSync(COMPARE, 'utf8'));
    const after = captureSnapshot(kb);
    const diff = compareSnapshots(before, after);

    const report = formatDiff(diff, before, after);
    console.log(report);

    // Also output JSON for programmatic use
    if (OUTPUT) {
      writeFileSync(OUTPUT, JSON.stringify({ before, after, diff }, null, 2));
      console.error(`Full comparison written to ${OUTPUT}`);
    }
  } else {
    // Snapshot mode: capture current state
    const snapshot = captureSnapshot(kb);

    if (OUTPUT) {
      writeFileSync(OUTPUT, JSON.stringify(snapshot, null, 2));
      console.log(formatSnapshot(snapshot));
      console.error(`Snapshot written to ${OUTPUT}`);
    } else {
      // No output file → print human-readable to stdout, JSON to stderr
      console.log(formatSnapshot(snapshot));
    }
  }
}

main();
