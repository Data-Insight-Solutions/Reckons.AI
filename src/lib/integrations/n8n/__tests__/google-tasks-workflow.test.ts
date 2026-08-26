/**
 * The Google Tasks workflow is part of the contract, not documentation.
 *
 * It runs on the user's own n8n and writes into the same table `fetchCurrentItems()` reads, so
 * the field names it emits and the field names the app expects live in two files, in two
 * languages, with nothing connecting them at runtime. A rename on either side produces a
 * current that polls happily and delivers nothing — and an empty pod view is indistinguishable
 * from "you had no notes". So the mapping is pinned here.
 *
 * The two Code nodes are executed rather than eyeballed. Between them they own the property
 * that actually matters: a dictated note must never be silently dropped. Everything else in
 * this workflow is recoverable by waiting five minutes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const workflow = JSON.parse(
  readFileSync(path.join(process.cwd(), 'static/n8n/google-tasks-current.workflow.json'), 'utf8'),
);

type Node = { name: string; type: string; parameters: Record<string, unknown> };
const node = (name: string): Node => {
  const found = (workflow.nodes as Node[]).find((n) => n.name === name);
  if (!found) throw new Error(`no node named "${name}"`);
  return found;
};

const CONFIG = { TASKLIST: '@default', GRAPH_STABLE_ID: 'graph-123', CURRENT_SLUG: 'google-tasks', OVERLAP_MINUTES: 2 };

/** Run the "Poll window" Code node against a given workflow static-data object. */
function runPollWindow(staticData: Record<string, unknown>) {
  const code = node('Poll window').parameters.jsCode as string;
  const $input = { first: () => ({ json: { ...CONFIG } }) };
  const $getWorkflowStaticData = () => staticData;
  return new Function('$input', '$getWorkflowStaticData', code)($input, $getWorkflowStaticData)[0].json;
}

/** Run the "Shape as CurrentItem" Code node over a list of raw Google tasks. */
function runShape(tasks: Array<Record<string, unknown>>) {
  const code = node('Shape as CurrentItem').parameters.jsCode as string;
  const $input = { all: () => tasks.map((t) => ({ json: t })) };
  const $ = () => ({ first: () => ({ json: { ...CONFIG } }) });
  return new Function('$input', '$', code)($input, $).map((r: { json: unknown }) => r.json);
}

describe('google-tasks workflow — structure', () => {
  it('is driven by a schedule, because Google Tasks has no push channel', () => {
    // Not a stylistic choice. The Tasks API exposes no `watch` method at all, so a webhook
    // trigger here would be a workflow that never fires.
    const types = (workflow.nodes as Node[]).map((n) => n.type);
    expect(types).toContain('n8n-nodes-base.scheduleTrigger');
    expect(types).not.toContain('n8n-nodes-base.webhook');
  });

  it('writes into the table the app reads, keyed so a re-poll cannot duplicate', () => {
    const store = node('Upsert reckons_currents_items');
    expect(store.parameters.tableName).toBe('reckons_currents_items');
    expect(store.parameters.operation).toBe('upsert');
    expect(store.parameters.matchingColumns).toEqual(['externalId', 'graphStableId']);
  });

  it('asks Google only for what changed', () => {
    const fetch = node('Google Tasks: get changed').parameters as {
      additionalFields: Record<string, unknown>;
    };
    expect(fetch.additionalFields.updatedMin).toBe('={{ $json.updatedMin }}');
    expect(fetch.additionalFields.showDeleted).toBe(false);
  });

  it('ships with the graph id unset, so a misfiled capture is loud rather than silent', () => {
    const assignments = (node('Config').parameters.assignments as {
      assignments: Array<{ name: string; value: unknown }>;
    }).assignments;
    const graphId = assignments.find((a) => a.name === 'GRAPH_STABLE_ID');
    expect(graphId?.value).toBe('PUT-YOUR-GRAPH-STABLE-ID-HERE');
  });
});

describe('google-tasks workflow — poll window', () => {
  it('reaches back 24h on the very first run rather than pulling a lifetime of tasks', () => {
    const wf: Record<string, unknown> = {};
    const out = runPollWindow(wf);
    const since = Date.parse(out.updatedMin);
    const age = Date.now() - since;
    expect(age).toBeGreaterThan(23 * 3600 * 1000);
    expect(age).toBeLessThan(25 * 3600 * 1000);
  });

  it('overlaps the previous window, because an exact window drops notes written mid-run', () => {
    const last = new Date('2026-08-26T12:00:00.000Z').toISOString();
    const out = runPollWindow({ lastPollIso: last });
    expect(Date.parse(out.updatedMin)).toBe(Date.parse(last) - 2 * 60 * 1000);
  });

  it('stamps the new watermark as PENDING, never as committed', () => {
    // The whole no-lost-notes property rests on this: if the fetch throws, the run ends here
    // and lastPollIso is untouched, so the next run re-covers the same window.
    const wf: Record<string, unknown> = { lastPollIso: '2026-08-26T12:00:00.000Z' };
    runPollWindow(wf);
    expect(wf.pendingPollIso).toBeTruthy();
    expect(wf.lastPollIso).toBe('2026-08-26T12:00:00.000Z');
  });

  it('emits an RFC 3339 timestamp, which is what tasks.list requires', () => {
    const out = runPollWindow({});
    expect(out.updatedMin).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('google-tasks workflow — shaping', () => {
  const task = {
    id: 'task-abc',
    title: 'Ask about spring market stall fees',
    notes: 'before the deadline',
    updated: '2026-08-26T08:41:00.000Z',
    selfLink: 'https://www.googleapis.com/tasks/v1/lists/@default/tasks/task-abc',
  };

  it('maps a task onto the CurrentItem fields the app consumes', () => {
    const [item] = runShape([task]);
    expect(item).toMatchObject({
      externalId: 'task-abc',
      title: 'Ask about spring market stall fees',
      summary: 'before the deadline',
      publishedAt: '2026-08-26T08:41:00.000Z',
      currentSlug: 'google-tasks',
      graphStableId: 'graph-123',
      sourceLabel: 'Google Tasks',
      capturedVia: 'google-tasks',
    });
    expect(item.url).toContain('task-abc');
    expect(item.fetchedAt).toBeTruthy();
  });

  it('carries the title VERBATIM — the transcript is the fact, not a reading of it', () => {
    const odd = { ...task, title: '  call Sarah re: grant — Tues?  ' };
    const [item] = runShape([odd]);
    // Trimmed, never parsed. "Sarah", "grant" and "Tues" are things a human confirms in review;
    // a speech-to-text transcript is exactly where a misheard name becomes a confident triple.
    expect(item.title).toBe('call Sarah re: grant — Tues?');
  });

  it('drops a task with no title, which is a Google artifact rather than something said', () => {
    expect(runShape([{ ...task, title: '   ' }])).toHaveLength(0);
    expect(runShape([{ ...task, title: undefined }])).toHaveLength(0);
  });

  it('drops a row with no id, since dedupe is keyed on it', () => {
    expect(runShape([{ ...task, id: undefined }])).toHaveLength(0);
  });

  it('omits summary rather than emitting an empty one', () => {
    const [item] = runShape([{ ...task, notes: '   ' }]);
    expect(item.summary).toBeUndefined();
  });

  it('falls back through updated → due → now for the timestamp', () => {
    const [withDue] = runShape([{ ...task, updated: undefined, due: '2026-09-01T00:00:00.000Z' }]);
    expect(withDue.publishedAt).toBe('2026-09-01T00:00:00.000Z');
    const [withNeither] = runShape([{ ...task, updated: undefined, due: undefined }]);
    expect(withNeither.publishedAt).toBeTruthy();
  });

  it('survives an empty poll without throwing', () => {
    // alwaysOutputData is set on the fetch node, so a quiet five minutes reaches this code as
    // an empty list rather than not reaching it at all.
    expect(runShape([])).toEqual([]);
  });
});

describe('google-tasks workflow — commit', () => {
  it('advances the watermark only on the success path', () => {
    const code = node('Commit watermark').parameters.jsCode as string;
    const wf: Record<string, unknown> = { lastPollIso: 'old', pendingPollIso: 'new' };
    const $input = { all: () => [] };
    new Function('$input', '$getWorkflowStaticData', code)($input, () => wf);
    expect(wf.lastPollIso).toBe('new');
    expect(wf.pendingPollIso).toBeUndefined();
  });

  it('leaves the watermark alone when no poll was staged', () => {
    const code = node('Commit watermark').parameters.jsCode as string;
    const wf: Record<string, unknown> = { lastPollIso: 'old' };
    new Function('$input', '$getWorkflowStaticData', code)({ all: () => [] }, () => wf);
    expect(wf.lastPollIso).toBe('old');
  });
});
