/**
 * Two sources, one named comparison (F306.1, kb:two-source-ingest).
 *
 * This does NOT add a second pipeline. Each side goes through the same `ingest()` every other
 * mode uses (source corpus, extraction, the diff against the space), one after the other so a
 * local model is never asked to hold two extractions at once and the elapsed time of each side is
 * its own. A side that fails is recorded as failed WITH ITS REASON; the other side still
 * completes and the comparison is still recorded (kb:honest-status: a failure is shown, not hidden).
 */
import { v4 as uuid } from 'uuid';
import type { IngestInput, IngestResult, IngestProgress } from '../stores/ingest.svelte';
import {
  buildComparisonStatements,
  comparisonId,
  comparisonLink,
  type ComparisonSide,
} from '../rdf/source-comparison';
import type { Statement } from '../rdf/types';

/** What a person hands one side: a web page address, or a file (PDF or plain text). */
export type SourceSpec = { kind: 'url'; url: string } | { kind: 'file'; file: File };

export type SideState = {
  label: 'A' | 'B';
  /** What the person gave: the address or file name. */
  what: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  /** The pipeline stage now running, as `ingest()` reports it. */
  phase: string;
  startedAt: number | null;
  endedAt: number | null;
  sourceId: string | null;
  statementCount: number;
  error: string | null;
};

export type TwoSourceResult = {
  comparisonId: string;
  a: SideState;
  b: SideState;
  /** Direct link to the comparison layout; null only when both sides failed. */
  link: string | null;
  /** Whole-run wall clock, ms. */
  totalMs: number;
};

export type TwoSourceDeps = {
  ingest: (input: IngestInput, onProgress?: (p: IngestProgress) => void) => Promise<IngestResult>;
  record: (statements: Statement[]) => Promise<void>;
  /** Turns a chosen file into an ingest input; throws with a readable reason when it cannot. */
  readFile: (file: File) => Promise<IngestInput>;
  now: () => number;
};

const describeSpec = (s: SourceSpec) => (s.kind === 'url' ? s.url : s.file.name);

export function blankSide(label: 'A' | 'B', spec: SourceSpec): SideState {
  return {
    label, what: describeSpec(spec), status: 'waiting', phase: '',
    startedAt: null, endedAt: null, sourceId: null, statementCount: 0, error: null,
  };
}

/**
 * Default file reader: plain text is read directly; a PDF goes through the existing Mistral OCR
 * parser, so without a key it fails with the same sentence the Document tab shows.
 */
export async function readFileForIngest(file: File): Promise<IngestInput> {
  const title = file.name.replace(/\.[^.]+$/, '');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) return { kind: 'document', title, text: await file.text(), filename: file.name };
  const { settings } = await import('../stores/settings.svelte');
  const key = settings().mistralApiKey;
  if (!key) throw new Error('PDF text extraction needs a Mistral API key (Settings → Integrations).');
  const { parsePdfWithMistralOCR } = await import('../integrations/parsers/mistral-ocr');
  const text = await parsePdfWithMistralOCR(file, key);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    kind: 'document', title, text, filename: file.name,
    original: { bytes, filename: file.name, mediaType: 'application/pdf' },
  };
}

export async function runTwoSourceComparison(
  req: { name: string; a: SourceSpec; b: SourceSpec },
  onUpdate: (sides: { a: SideState; b: SideState }) => void,
  deps: TwoSourceDeps,
): Promise<TwoSourceResult> {
  const t0 = deps.now();
  const sides = { a: blankSide('A', req.a), b: blankSide('B', req.b) };
  const emit = () => onUpdate({ a: { ...sides.a }, b: { ...sides.b } });
  emit();

  async function runSide(key: 'a' | 'b', spec: SourceSpec) {
    const side = sides[key];
    side.status = 'running';
    side.startedAt = deps.now();
    side.phase = spec.kind === 'file' ? 'reading file' : 'fetching';
    emit();
    try {
      const input: IngestInput = spec.kind === 'url' ? { kind: 'url', url: spec.url } : await deps.readFile(spec.file);
      const result = await deps.ingest(input, (p) => {
        side.phase = p.phase;
        emit();
      });
      if (result.phase !== 'done') throw new Error(`stopped before finishing (${result.reason})`);
      side.sourceId = result.source.id;
      side.statementCount = result.statements.length;
      side.status = 'done';
    } catch (e) {
      side.status = 'failed';
      side.error = e instanceof Error ? e.message : String(e);
    }
    side.endedAt = deps.now();
    side.phase = '';
    emit();
  }

  await runSide('a', req.a);
  await runSide('b', req.b);

  const sideRecord = (s: SideState): ComparisonSide =>
    s.status === 'done' && s.sourceId ? { sourceId: s.sourceId } : { failed: s.error ?? 'did not finish' };
  const id = comparisonId(req.name, uuid().slice(0, 6));
  await deps.record(buildComparisonStatements({
    id, name: req.name, a: sideRecord(sides.a), b: sideRecord(sides.b), makeId: uuid, now: deps.now(),
  }));
  return {
    comparisonId: id,
    a: sides.a, b: sides.b,
    link: comparisonLink({ a: sides.a.sourceId, b: sides.b.sourceId }),
    totalMs: deps.now() - t0,
  };
}
