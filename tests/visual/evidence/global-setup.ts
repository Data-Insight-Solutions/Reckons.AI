import { mkdir, rm } from 'node:fs/promises';
import { EVIDENCE_ROOT } from '../../../scripts/visual-evidence-contract';

export default async function globalSetup(): Promise<void> {
  // Generated and gitignored. Starting from an empty, exact directory prevents
  // removed projects or interrupted prior runs from appearing in a new report.
  await rm(EVIDENCE_ROOT, { recursive: true, force: true });
  await mkdir(EVIDENCE_ROOT, { recursive: true });
}
