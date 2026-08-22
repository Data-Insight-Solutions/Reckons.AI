import { db } from './db';
import type { ExtractionRun } from '../rdf/types';

/** Persist only structured-clone-safe run metadata; callers never pass raw source/model traces. */
export async function saveExtractionRun(run: ExtractionRun): Promise<void> {
  await db.extractionRuns.put(JSON.parse(JSON.stringify(run)) as ExtractionRun);
}

export async function getExtractionRun(id: string): Promise<ExtractionRun | undefined> {
  return db.extractionRuns.get(id);
}

export async function extractionRunsForSource(sourceId: string): Promise<ExtractionRun[]> {
  return db.extractionRuns.where('sourceId').equals(sourceId).sortBy('startedAt');
}
