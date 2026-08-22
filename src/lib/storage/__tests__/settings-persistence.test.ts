/**
 * `saveSettings` rebuilds an explicit allowlist object rather than writing the merged record, so a
 * field that is declared on SettingsRecord but forgotten there is dropped between the in-memory
 * store and Dexie. Nothing errors: the form writes it, the UI shows it set, and it is gone on
 * reload. `preferLocal` sat like that long enough that prefer-local routing could never engage,
 * and a diff of the type against the allowlist then found thirteen more.
 *
 * This test reads the SOURCE rather than exercising Dexie, because the defect is a missing line in
 * an object literal — the only way to catch it is to compare what the type promises against what
 * the function actually writes. A behavioural test would need one case per field and would miss
 * exactly the field nobody remembered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(resolve('src/lib/storage/db.ts'), 'utf8');

function declaredSettingsFields(): string[] {
  const block = SRC.match(/export (?:type|interface) SettingsRecord[^{]*\{([\s\S]*?)\n\}/);
  expect(block, 'SettingsRecord declaration not found — did db.ts move?').toBeTruthy();
  return [...block![1].matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]);
}

function persistedSettingsFields(): string[] {
  const block = SRC.match(/const toSave: SettingsRecord = \{([\s\S]*?)\n {4}\};/);
  expect(block, 'saveSettings allowlist not found — did its shape change?').toBeTruthy();
  return [...block![1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
}

describe('saveSettings persists every declared setting', () => {
  it('writes every field SettingsRecord declares', () => {
    const declared = declaredSettingsFields();
    const persisted = new Set(persistedSettingsFields());
    const dropped = declared.filter((f) => !persisted.has(f));

    expect(
      dropped,
      `These SettingsRecord fields are never written by saveSettings, so they silently fail to ` +
        `persist: ${dropped.join(', ')}. Add them to the toSave object in db.ts.`,
    ).toEqual([]);
  });

  it('has both halves to compare, so the test cannot pass by finding nothing', () => {
    // Guards the regexes above: if either stops matching, `dropped` is trivially empty and this
    // suite would report success while checking nothing at all.
    expect(declaredSettingsFields().length).toBeGreaterThan(50);
    expect(persistedSettingsFields().length).toBeGreaterThan(50);
  });

  it('persists preferLocal specifically — the field that exposed the class', () => {
    expect(persistedSettingsFields()).toContain('preferLocal');
  });
});
