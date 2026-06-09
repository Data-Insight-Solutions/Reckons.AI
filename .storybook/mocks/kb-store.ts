/**
 * Mock for $lib/stores/kb.svelte
 *
 * Returns static seed data so graph stories render a real-looking KB
 * without any IndexedDB dependency. Seed data mirrors the fixture used
 * in tests/visual/fixtures.ts so screenshots are consistent.
 */
import type { Statement, Source } from '$lib/rdf/types';
import { SEED_STATEMENTS, SEED_SOURCES } from '../fixtures';

export function statements(): Statement[] { return SEED_STATEMENTS; }
export function confirmedStatements(): Statement[] {
  return SEED_STATEMENTS.filter(s => s.status === 'confirmed' || s.status === 'refined');
}
export function pendingStatements(): Statement[] {
  return SEED_STATEMENTS.filter(s => s.status === 'pending');
}
export function sources(): Source[] { return SEED_SOURCES; }
export function statementsForSource(id: string): Statement[] {
  return SEED_STATEMENTS.filter(s => s.sourceId === id);
}
export function allStatements(): Statement[] { return SEED_STATEMENTS; }

// No-op mutations — stories don't need to persist
export async function addStatements(_s: Statement[]) {}
export async function setStatus(_id: string, _status: string) {}
export async function deleteSource(_id: string) {}
export async function updateStatement(_id: string, _patch: Partial<Statement>) {}
export async function confirmSource(_id: string) {}
export async function rejectSource(_id: string) {}
