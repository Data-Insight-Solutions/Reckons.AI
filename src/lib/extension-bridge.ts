/**
 * Extension bridge — exposes a window.__reckonsKB object so the browser
 * extension's content script can sync a KB snapshot without a server.
 *
 * Called once from +layout.svelte after the KB loads.
 */
import { confirmedStatements, addSource, addStatements } from './stores/kb.svelte';
import { typeMap } from './stores/entity-types.svelte';
import { ingest } from './stores/ingest.svelte';
import { triplesToStatements } from './integrations/llm/extractor';
import type { Source } from './rdf/types';
import { v4 as uuid } from 'uuid';
import { RDF_TYPE } from './rdf/entity-types';
import type { KBSnapshot, KBEntity, HighlightSettings } from '../extension/types';
import { DEFAULT_HIGHLIGHT_SETTINGS } from '../extension/types';
import { getSettings } from './storage/db';

function buildSnapshot(): KBSnapshot {
  const stmts = confirmedStatements();
  const tm = typeMap();

  const bySubject = new Map<string, typeof stmts>();
  for (const st of stmts) {
    if (st.s.kind !== 'iri') continue;
    if (!bySubject.has(st.s.value)) bySubject.set(st.s.value, []);
    bySubject.get(st.s.value)!.push(st);
  }

  const entities: KBEntity[] = [...bySubject.entries()]
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 200)
    .map(([iri, sts]) => {
      const typeStmt = sts.find(s => s.p.value === RDF_TYPE);
      const typeIri = typeStmt?.o.value ?? null;
      const typeDef = typeIri ? tm.get(typeIri) : null;
      const labelStmt = sts.find(s => s.p.value === 'http://www.w3.org/2000/01/rdf-schema#label');
      const label = labelStmt?.o.value ?? iri.split('/').pop() ?? iri;
      const predicates = sts
        .filter(s => s.p.value !== RDF_TYPE)
        .slice(0, 6)
        .map(s => `${s.p.value.split('/').pop() ?? s.p.value} → ${s.o.value.slice(0, 50)}`);
      return { iri, label, type: typeDef?.label ?? null, predicates };
    });

  return { entities, entityCount: entities.length, capturedAt: Date.now() };
}

export function initExtensionBridge() {
  if (typeof window === 'undefined') return;
  (window as any).__reckonsKB = {
    /** Called by the extension content script when the user clicks "Sync KB" */
    getSnapshot(): KBSnapshot {
      return buildSnapshot();
    },
    /**
     * Ingest pre-extracted triples from the extension side panel.
     * Avoids re-analyzing the page — uses the triples the extension already extracted.
     */
    async ingestTriples(
      pageUrl: string,
      pageTitle: string,
      rawTriples: Array<{ subject: string; predicate: string; object: string; kind: string }>
    ): Promise<{ sourceId: string; count: number }> {
      const source: Source = {
        id: uuid(),
        title: pageTitle || pageUrl,
        uri: pageUrl,
        kind: 'url',
        trustLevel: 'review',
        trustScore: 0.5,
        ingestedAt: Date.now(),
      };
      const appTriples = rawTriples.map(t => ({
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        gloss: `${t.subject} — ${t.predicate} — ${t.object}`,
        confidence: t.kind === 'reinforce' ? 0.9 : t.kind === 'conflict' ? 0.5 : 0.75,
      }));
      const statements = triplesToStatements(appTriples, source);
      await addSource(source);
      await addStatements(statements);
      return { sourceId: source.id, count: statements.length };
    },

    /** Fallback: full re-ingest via the app's LLM pipeline */
    async ingestUrl(url: string): Promise<{ sourceId: string; count: number }> {
      const result = await ingest({ kind: 'url', url });
      return { sourceId: result.source.id, count: result.statements.length };
    },

    /** Returns the highlight settings stored in the main app for the extension to consume */
    async getHighlightSettings(): Promise<HighlightSettings> {
      const s = await getSettings();
      return { ...DEFAULT_HIGHLIGHT_SETTINGS, ...(s.extensionHighlight ?? {}) };
    },
  };
}
