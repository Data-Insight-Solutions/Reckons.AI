/**
 * Extraction matrix — cell result shape, aggregation, and table rendering.
 *
 * Split out of run-extraction-matrix.ts so unit tests can exercise the
 * renderer and aggregation logic without importing the runner (whose module
 * body executes the live bench).
 */

import type { PromptVariantId } from './extraction-prompts';

export type Mode = 'structured' | 'plain';
export type ModelKind = 'ollama' | 'claude';
export type CellStatus = 'ok' | 'parse-failure' | 'error' | 'skipped';

export interface CellResult {
  model: string;
  modelKind: ModelKind;
  promptId: PromptVariantId;
  promptLabel: string;
  mode: Mode;
  status: CellStatus;
  latencyMs: number;
  outputTripleCount: number;
  precision: number;
  recall: number;
  f1: number;
  matchedCount: number;
  goldenCount: number;
  note?: string;
}

/** Column key: "<promptId>/<mode>" */
export function columnKey(promptId: PromptVariantId, mode: Mode): string {
  return `${promptId}/${mode}`;
}

export const ALL_MODES: Mode[] = ['structured', 'plain'];

export function buildColumns(promptIds: PromptVariantId[], modes: Mode[] = ALL_MODES): string[] {
  return promptIds.flatMap((p) => modes.map((m) => columnKey(p, m)));
}

export function findCell(
  results: CellResult[],
  model: string,
  promptId: PromptVariantId,
  mode: Mode
): CellResult | undefined {
  return results.find((r) => r.model === model && r.promptId === promptId && r.mode === mode);
}

/** Format one cell's F1 for table display. */
export function fmtF1(r: CellResult | undefined): string {
  if (!r) return '—';
  if (r.status === 'skipped') return 'skip';
  if (r.status === 'error') return 'ERR';
  if (r.status === 'parse-failure') return 'parse✗';
  return `${(r.f1 * 100).toFixed(0)}%`;
}

/** Highest-F1 successful cell for a model, or undefined if none succeeded. */
export function bestCellForModel(results: CellResult[], model: string): CellResult | undefined {
  const ok = results.filter((r) => r.model === model && r.status === 'ok');
  if (ok.length === 0) return undefined;
  return [...ok].sort((a, b) => b.f1 - a.f1)[0];
}

export function renderConsoleTable(results: CellResult[], rowModels: string[], columns: string[]): string {
  const lines: string[] = [];
  lines.push(`\n${'═'.repeat(100)}`);
  lines.push('  EXTRACTION PROMPT MATRIX — F1 by model × prompt × mode');
  lines.push(`${'═'.repeat(100)}`);

  const header = ['Model'.padEnd(26), ...columns.map((c) => c.padStart(13))].join(' │ ');
  lines.push(`  ${header}`);
  lines.push(`  ${'─'.repeat(header.length)}`);

  for (const model of rowModels) {
    const row = [
      model.slice(0, 26).padEnd(26),
      ...columns.map((c) => {
        const [p, m] = c.split('/') as [PromptVariantId, Mode];
        return fmtF1(findCell(results, model, p, m)).padStart(13);
      })
    ].join(' │ ');
    lines.push(`  ${row}`);
  }
  lines.push(`${'═'.repeat(100)}\n`);
  return lines.join('\n');
}

export function renderMarkdownTable(results: CellResult[], rowModels: string[], columns: string[]): string {
  const lines: string[] = [];
  lines.push('# Extraction Prompt Matrix Results');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(
    'F1 score by model (rows) × prompt variant / decoding mode (columns). ' +
      '`skip` = axis not applicable (e.g. Claude has no structured mode, or no API key present). ' +
      '`ERR` = request failed. `parse✗` = response did not parse as a JSON triple array.'
  );
  lines.push('');
  lines.push(`| Model | ${columns.join(' | ')} |`);
  lines.push(`| --- | ${columns.map(() => '---').join(' | ')} |`);
  for (const model of rowModels) {
    const cells = columns.map((c) => {
      const [p, m] = c.split('/') as [PromptVariantId, Mode];
      return fmtF1(findCell(results, model, p, m));
    });
    lines.push(`| ${model} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Best prompt per model');
  lines.push('');
  for (const model of rowModels) {
    const best = bestCellForModel(results, model);
    if (!best) {
      lines.push(`- **${model}**: no successful cells`);
    } else {
      lines.push(`- **${model}**: \`${best.promptId}\` / ${best.mode} — F1 ${(best.f1 * 100).toFixed(1)}%`);
    }
  }
  lines.push('');

  const failures = results.filter((r) => r.status === 'parse-failure' || r.status === 'error');
  if (failures.length > 0) {
    lines.push('## Parse failures / errors');
    lines.push('');
    for (const f of failures) {
      lines.push(`- ${f.model} / ${f.promptId} / ${f.mode} — ${f.status}: ${f.note ?? ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
