/**
 * Knowledge base backup, export, and auto-save utilities.
 *
 * Export variants:
 *  - Clean  (.ttl) — confirmed/refined triples only; standard RDF, no annotations
 *  - Full   (.ttl) — all statuses, annotated with status/confidence/sources via
 *                    RDF reification; round-trips via importTurtleFull()
 *  - Pending (.ttl) — pending statements only (preview before confirming)
 *  - Changelog (.csv) — full mutation history
 *
 * Auto-save uses the File System Access API (Chrome/Edge). The user picks a file
 * once per session; subsequent mutations trigger a debounced write with no prompts.
 */

import { db, getSettings, type SettingsRecord } from './db';
import { toTurtle, toTurtleFull } from '../rdf/serialize';
import { kbFileSlug } from './kb-registry';
import { redactSecrets } from '../safety/redact';

// ── Settings profile ─────────────────────────────────────────────────────────
//
// A portable, shareable snapshot of non-sensitive settings.
// API keys are intentionally excluded — users share model/UI preferences, not secrets.

export interface SettingsProfile {
  _format: 'reckons-settings-profile';
  _version: 1;
  exportedAt: string;
  // KB identity (informational, not a secret)
  kbTitle?: string;
  kbDescription?: string;
  // Backends
  preferredBackend: SettingsRecord['preferredBackend'];
  ingestBackend?: SettingsRecord['ingestBackend'];
  analyzeBackend?: SettingsRecord['analyzeBackend'];
  chatBackend?: SettingsRecord['chatBackend'];
  diffSummaryBackend?: SettingsRecord['diffSummaryBackend'];
  mergeAnalysisBackend?: SettingsRecord['mergeAnalysisBackend'];
  // Models
  claudeModel: string;
  openaiModel: string;
  geminiModel: string;
  ollamaModel: string;
  ollamaBaseUrl: string;
  wasmModel: string;
  wasmIngestModel?: string;
  wasmAnalyzeModel?: string;
  wasmChatModel?: string;
  openrouterModel: string;
  // Analysis
  autoAnalyzeOnImport: boolean;
  autoAnalyzeIntervalMinutes: number;
  embeddingThreshold: number;
  autoConfirmHighConfidence: boolean;
  // UI
  uiScale?: SettingsRecord['uiScale'];
  nodeLabelFontSize?: number;
  shellyCustomPrompt?: string;
  humeConfigId?: string;
  turtleSettings?: SettingsRecord['turtleSettings'];
  extensionHighlight?: SettingsRecord['extensionHighlight'];
}

/**
 * Build a settings profile JSON string from current settings.
 * Extracted so it can be reused for file download AND workspace writes.
 */
export async function buildSettingsProfileJson(): Promise<string> {
  const s = await getSettings();
  const profile: SettingsProfile = {
    _format: 'reckons-settings-profile',
    _version: 1,
    exportedAt: new Date().toISOString(),
    kbTitle: s.kbTitle,
    kbDescription: s.kbDescription,
    preferredBackend: s.preferredBackend,
    ingestBackend: s.ingestBackend,
    analyzeBackend: s.analyzeBackend,
    chatBackend: s.chatBackend,
    diffSummaryBackend: s.diffSummaryBackend,
    mergeAnalysisBackend: s.mergeAnalysisBackend,
    claudeModel: s.claudeModel,
    openaiModel: s.openaiModel,
    geminiModel: s.geminiModel,
    ollamaModel: s.ollamaModel,
    ollamaBaseUrl: s.ollamaBaseUrl,
    wasmModel: s.wasmModel,
    wasmIngestModel: s.wasmIngestModel,
    wasmAnalyzeModel: s.wasmAnalyzeModel,
    wasmChatModel: s.wasmChatModel,
    openrouterModel: s.openrouterModel,
    autoAnalyzeOnImport: s.autoAnalyzeOnImport ?? false,
    autoAnalyzeIntervalMinutes: s.autoAnalyzeIntervalMinutes ?? 0,
    embeddingThreshold: s.embeddingThreshold,
    autoConfirmHighConfidence: s.autoConfirmHighConfidence,
    uiScale: s.uiScale,
    nodeLabelFontSize: s.nodeLabelFontSize,
    shellyCustomPrompt: s.shellyCustomPrompt,
    humeConfigId: s.humeConfigId,
    turtleSettings: s.turtleSettings,
    extensionHighlight: s.extensionHighlight,
  };
  // Recursive final pass: the allowlist above excludes TOP-LEVEL secrets, but passes nested
  // objects (turtleSettings carries humeApiKey/humeSecretKey) through whole. Strip any
  // secret-named field at any depth so a "safe to share" profile truly carries no credential.
  return JSON.stringify(redactSecrets(profile), null, 2);
}

/**
 * Export the current settings (minus API keys) as a downloadable JSON profile.
 * Safe to share — no secrets included.
 */
export async function exportSettingsProfile(): Promise<void> {
  const json = await buildSettingsProfileJson();
  downloadText(json, `reckons_profile_${dateStr()}.json`, 'application/json');
}

/**
 * Parse a settings profile JSON string and return the applicable SettingsRecord patch.
 * Returns null if the file is not a valid Reckons settings profile.
 * API keys are never included in a profile — existing keys are preserved on import.
 */
export function parseSettingsProfile(json: string): Partial<SettingsRecord> | null {
  try {
    const p = JSON.parse(json) as Partial<SettingsProfile> & { _format?: string };
    if (p._format !== 'reckons-settings-profile') return null;
    // Strip profile metadata; return only SettingsRecord-compatible fields
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _format, _version, exportedAt, ...rest } = p;
    return rest as Partial<SettingsRecord>;
  } catch {
    return null;
  }
}

// ---- Auto-save state (in-memory; lost on page reload) ----

let _autoSaveHandle: FileSystemFileHandle | null = null;
let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function isAutoSaveSupported(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export function hasAutoSaveFile(): boolean {
  return _autoSaveHandle !== null;
}

export function getAutoSaveFileName(): string | null {
  return _autoSaveHandle?.name ?? null;
}

/**
 * Prompt the user to pick a .ttl file for auto-save.
 * Returns true if the user selected a file, false if cancelled.
 */
export async function pickAutoSaveFile(): Promise<boolean> {
  if (!isAutoSaveSupported()) return false;
  try {
    _autoSaveHandle = await (window as Window & typeof globalThis & {
      showSaveFilePicker(opts?: unknown): Promise<FileSystemFileHandle>
    }).showSaveFilePicker({
      suggestedName: `${kbFileSlug()}.ttl`,
      types: [{ description: 'Turtle RDF', accept: { 'text/turtle': ['.ttl'] } }]
    });
    return true;
  } catch {
    return false; // user cancelled
  }
}

export function clearAutoSaveFile(): void {
  _autoSaveHandle = null;
  if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
}

/**
 * Schedule an auto-save with 2 s debounce.
 * Call this after every KB mutation (setStatus, addStatements, etc.)
 */
export function scheduleAutoSave(): void {
  if (!_autoSaveHandle) return;
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    _autoSaveTimer = null;
    triggerAutoSave();
  }, 2000);
}

async function triggerAutoSave(): Promise<void> {
  if (!_autoSaveHandle) return;
  try {
    const [statements, sources, settings] = await Promise.all([
      db.statements.toArray(),
      db.sources.toArray(),
      db.settings.get('main')
    ]);
    const turtle = toTurtleFull(statements, sources, { header: 'auto-save', kbStableId: settings?.kbStableId });
    const writable = await _autoSaveHandle.createWritable();
    await writable.write(turtle);
    await writable.close();
  } catch (err) {
    console.error('[AutoSave] write failed:', err);
  }
}

// ---- Export functions ----

/** Clean export — confirmed/refined triples only, no annotations. */
export async function exportKBClean(filename?: string): Promise<void> {
  const statements = await db.statements.toArray();
  downloadText(toTurtle(statements), filename ?? `kb_${dateStr()}.ttl`, 'text/turtle');
}

/** Full export — all statuses, annotated with status/confidence/sources + persona. */
export async function exportKBFull(filename?: string): Promise<void> {
  const [statements, sources, settings] = await Promise.all([
    db.statements.toArray(),
    db.sources.toArray(),
    db.settings.get('main')
  ]);
  const ts = settings?.turtleSettings;
  const shellyPersona = ts ? {
    name: ts.name !== 'Shelly' ? ts.name : undefined,
    greeting: ts.greeting || undefined,
    personality: ts.personality !== 'helpful' ? ts.personality : undefined,
    systemPrompt: ts.systemPrompt || undefined,
    responseStyle: ts.responseStyle !== 'concise' ? ts.responseStyle : undefined,
    maxWords: ts.maxResponseWords > 0 ? ts.maxResponseWords : undefined
  } : undefined;
  const hasPersoanl = shellyPersona && Object.values(shellyPersona).some(v => v !== undefined);
  downloadText(
    toTurtleFull(statements, sources, { shellyPersona: hasPersoanl ? shellyPersona : undefined, kbStableId: settings?.kbStableId }),
    filename ?? `kb_full_${dateStr()}.ttl`,
    'text/turtle'
  );
}

/**
 * Pending preview — pending statements from one source (or all sources).
 * Useful for reviewing an ingest batch before committing.
 */
export async function exportPendingPreview(sourceId?: string, filename?: string): Promise<void> {
  const [allStatements, allSources] = await Promise.all([
    db.statements.toArray(),
    db.sources.toArray()
  ]);
  const pending = allStatements.filter(
    s => s.status === 'pending' && (!sourceId || s.sourceId === sourceId)
  );
  if (pending.length === 0) return;

  const involvedIds = new Set(pending.map(s => s.sourceId));
  const involvedSources = allSources.filter(s => involvedIds.has(s.id));
  const header = sourceId ? `pending preview — source ${sourceId}` : 'pending preview — all sources';

  const label = sourceId ? `pending_${sourceId.slice(0, 8)}` : 'pending_all';
  downloadText(
    toTurtleFull(pending, involvedSources, { header }),
    filename ?? `${label}_${dateStr()}.ttl`,
    'text/turtle'
  );
}

/** Changelog CSV — full mutation history. */
export async function exportChangelog(filename?: string): Promise<void> {
  const entries = await db.changelog.orderBy('timestamp').toArray();
  const rows = [
    'id,timestamp,iso_time,action,statementId,sourceId,entityKey,before,after,note',
    ...entries.map(e => [
      e.id ?? '',
      e.timestamp,
      new Date(e.timestamp).toISOString(),
      e.action,
      e.statementId ?? '',
      e.sourceId ?? '',
      e.entityKey ?? '',
      csvEscape(e.before ?? ''),
      csvEscape(e.after ?? ''),
      csvEscape(e.note ?? '')
    ].join(','))
  ];
  downloadText(rows.join('\n'), filename ?? `kb_changelog_${dateStr()}.csv`, 'text/csv');
}

// ---- Helpers ----

function dateStr(): string {
  return new Date().toISOString().split('T')[0];
}

function csvEscape(v: string): string {
  if (/[,"\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function downloadText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
