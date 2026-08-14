/**
 * Tests for workspace KB discovery in MultiKBReader (dist/kb-reader.js).
 *
 * Covers the kbs/{name}/{name}.ttl naming convention:
 *  - named-file discovery
 *  - legacy kb.ttl fallback
 *  - both-exist preference (named file wins, stderr warning logged)
 *
 * Run via `npm test` (builds first, then `node --test test/`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MultiKBReader } from '../dist/kb-reader.js';

/** Overwrite a file and force a strictly-newer mtime so reload() cannot skip on a same-ms write. */
function rewrite(file, content) {
  writeFileSync(file, content);
  const ahead = new Date(Date.now() + 5000);
  utimesSync(file, ahead, ahead);
}

const TTL = (subject) => `<urn:test:${subject}> <urn:test:pred> "value" .\n`;

function mkWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'reckons-kb-reader-test-'));
  mkdirSync(join(ws, 'kbs'));
  return ws;
}

function mkKbFolder(ws, name) {
  const dir = join(ws, 'kbs', name);
  mkdirSync(dir);
  return dir;
}

test('discovers kbs/{name}/{name}.ttl (named file)', () => {
  const ws = mkWorkspace();
  try {
    const dir = mkKbFolder(ws, 'roadmap');
    writeFileSync(join(dir, 'roadmap.ttl'), TTL('named'));

    const reader = new MultiKBReader(ws);
    const kbs = reader.listKbs();
    assert.equal(kbs.length, 1);
    assert.equal(kbs[0].folderName, 'roadmap');
    assert.equal(kbs[0].stats.tripleCount, 1);
    assert.equal(reader.allTriples('roadmap')[0].subject, 'urn:test:named');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('falls back to legacy kbs/{name}/kb.ttl when named file is absent', () => {
  const ws = mkWorkspace();
  try {
    const dir = mkKbFolder(ws, 'legacy');
    writeFileSync(join(dir, 'kb.ttl'), TTL('legacy'));

    const reader = new MultiKBReader(ws);
    const kbs = reader.listKbs();
    assert.equal(kbs.length, 1);
    assert.equal(kbs[0].folderName, 'legacy');
    assert.equal(reader.allTriples('legacy')[0].subject, 'urn:test:legacy');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('prefers {name}.ttl over kb.ttl when both exist, and warns on stderr', () => {
  const ws = mkWorkspace();
  try {
    const dir = mkKbFolder(ws, 'both');
    writeFileSync(join(dir, 'both.ttl'), TTL('named'));
    writeFileSync(join(dir, 'kb.ttl'), TTL('legacy'));

    const warnings = [];
    const origError = console.error;
    console.error = (...args) => warnings.push(args.join(' '));
    let reader;
    try {
      reader = new MultiKBReader(ws);
    } finally {
      console.error = origError;
    }

    const triples = reader.allTriples('both');
    assert.equal(triples.length, 1);
    assert.equal(triples[0].subject, 'urn:test:named');
    assert.ok(
      warnings.some((w) => w.includes('both.ttl') && w.includes('kb.ttl')),
      `expected a stderr warning mentioning both files, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('skips folders with no TTL file', () => {
  const ws = mkWorkspace();
  try {
    mkKbFolder(ws, 'empty');
    const dir = mkKbFolder(ws, 'real');
    writeFileSync(join(dir, 'real.ttl'), TTL('real'));

    const reader = new MultiKBReader(ws);
    assert.deepEqual(reader.listKbs().map((k) => k.folderName), ['real']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('reload() picks up a migration from kb.ttl to {name}.ttl', () => {
  const ws = mkWorkspace();
  try {
    const dir = mkKbFolder(ws, 'migrating');
    writeFileSync(join(dir, 'kb.ttl'), TTL('old'));

    const reader = new MultiKBReader(ws);
    assert.equal(reader.allTriples('migrating')[0].subject, 'urn:test:old');

    // Simulate the setup script migration: named file appears, legacy removed
    writeFileSync(join(dir, 'migrating.ttl'), TTL('new'));
    rmSync(join(dir, 'kb.ttl'));
    reader.reload();

    assert.equal(reader.allTriples('migrating')[0].subject, 'urn:test:new');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('reports health: ok for a valid non-empty graph', () => {
  const ws = mkWorkspace();
  try {
    writeFileSync(join(mkKbFolder(ws, 'good'), 'good.ttl'), TTL('x'));
    const reader = new MultiKBReader(ws);
    assert.equal(reader.listKbs()[0].stats.health, 'ok');
    assert.equal(reader.stats().health, 'ok');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a corrupted file becomes parse-error and is flagged, not passed off as current', () => {
  const ws = mkWorkspace();
  try {
    const file = join(mkKbFolder(ws, 'corrupt'), 'corrupt.ttl');
    writeFileSync(file, TTL('valid'));
    const reader = new MultiKBReader(ws);
    assert.equal(reader.stats().health, 'ok');

    // Now break the file. The last-good triple is still served (a transient half-write must not
    // blank the graph), but health must flip so a caller knows it is stale.
    rewrite(file, '<<< this is not turtle at all @@@');
    reader.reload();

    const kb = reader.listKbs()[0];
    assert.equal(kb.stats.health, 'parse-error');
    assert.ok(kb.stats.error, 'expected an error message on a parse-error graph');
    assert.equal(reader.allTriples('corrupt')[0].subject, 'urn:test:valid'); // stale, but present
    assert.equal(reader.stats().health, 'parse-error');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('an emptied-but-valid file becomes empty, dropping stale triples', () => {
  const ws = mkWorkspace();
  try {
    const file = join(mkKbFolder(ws, 'emptying'), 'emptying.ttl');
    writeFileSync(file, TTL('gone-soon'));
    const reader = new MultiKBReader(ws);
    assert.equal(reader.allTriples('emptying').length, 1);

    rewrite(file, '# a valid but empty graph\n');
    reader.reload();

    assert.equal(reader.listKbs()[0].stats.health, 'empty');
    assert.equal(reader.allTriples('emptying').length, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a deleted KB is reconciled away, not left serving vanished facts', () => {
  const ws = mkWorkspace();
  try {
    const dir = mkKbFolder(ws, 'ephemeral');
    const file = join(dir, 'ephemeral.ttl');
    writeFileSync(file, TTL('here-now'));
    writeFileSync(join(mkKbFolder(ws, 'keep'), 'keep.ttl'), TTL('stays'));

    const reader = new MultiKBReader(ws);
    assert.deepEqual(reader.listKbs().map((k) => k.folderName).sort(), ['ephemeral', 'keep']);

    // Delete the graph file. On the next scan the vanished reader must be dropped entirely.
    rmSync(file);
    reader.reload();

    assert.deepEqual(reader.listKbs().map((k) => k.folderName), ['keep']);
    assert.deepEqual(reader.allTriples('ephemeral'), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('legacy single-file mode still works (--kb file.ttl)', () => {
  const ws = mkWorkspace();
  try {
    const file = join(ws, 'knowledge.ttl');
    writeFileSync(file, TTL('single'));

    const reader = new MultiKBReader(file);
    assert.equal(reader.isLegacy(), true);
    assert.equal(reader.allTriples()[0].subject, 'urn:test:single');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
