/**
 * The deploy payload filter, tested against the workflows we actually ship.
 *
 * n8n's public API rejects a workflow object carrying read-only fields, and every export carries
 * several. The failure is a 400 naming ONE field at a time, so getting this wrong turns a deploy
 * into a guessing game. Pinned against the real files in static/n8n/ rather than a fixture,
 * because the thing that breaks is a new export picking up a field nobody expected.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import {
  toCreatePayload,
  credentialGaps,
  unsetPlaceholders,
  webhookPaths,
  type WorkflowFile,
} from '../n8n-deploy';

const dir = path.join(process.cwd(), 'static/n8n');
const shipped = readdirSync(dir).filter((f) => f.endsWith('.workflow.json'));
const load = (f: string): WorkflowFile => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));

describe('toCreatePayload', () => {
  it.each(shipped)('%s: keeps only the four accepted fields', (f) => {
    const payload = toCreatePayload(load(f));
    expect(Object.keys(payload).sort()).toEqual(['connections', 'name', 'nodes', 'settings']);
  });

  it.each(shipped)('%s: strips every read-only field the API 400s on', (f) => {
    const payload = toCreatePayload(load(f));
    for (const banned of ['id', 'active', 'tags', 'meta', 'pinData', 'versionId', 'createdAt', 'updatedAt']) {
      expect(payload).not.toHaveProperty(banned);
    }
  });

  it('supplies settings when an export omitted them, since the API requires it', () => {
    const payload = toCreatePayload({ name: 'x', nodes: [], connections: {} });
    expect(payload.settings).toEqual({ executionOrder: 'v1' });
  });

  it('does not invent a name or nodes that were not there', () => {
    expect(toCreatePayload({})).toEqual({ settings: { executionOrder: 'v1' } });
  });

  it('leaves node contents untouched — only top-level keys are filtered', () => {
    const wf = load('ios-note-capture.workflow.json');
    const payload = toCreatePayload(wf) as { nodes: unknown[] };
    expect(payload.nodes).toEqual(wf.nodes);
  });
});

describe('credentialGaps', () => {
  it('names the Drive nodes the iOS workflow cannot run without', () => {
    const gaps = credentialGaps(load('ios-note-capture.workflow.json'));
    expect(gaps.join(' ')).toContain('googleDrive');
    expect(gaps).toHaveLength(2);
  });

  it('reports nothing once a credential is attached', () => {
    const wf: WorkflowFile = {
      nodes: [{ name: 'D', type: 'n8n-nodes-base.googleDrive', credentials: { googleDriveOAuth2Api: { id: '1' } } }],
    };
    expect(credentialGaps(wf)).toEqual([]);
  });

  it('ignores nodes that need no credential', () => {
    const wf: WorkflowFile = { nodes: [{ name: 'C', type: 'n8n-nodes-base.code' }] };
    expect(credentialGaps(wf)).toEqual([]);
  });
});

describe('unsetPlaceholders', () => {
  it('finds the deliberate placeholder in the shipped iOS workflow', () => {
    // Shipped unset ON PURPOSE so a half-configured deploy is caught before it silently
    // writes notes into the wrong Drive folder — or nowhere.
    const found = unsetPlaceholders(load('ios-note-capture.workflow.json'));
    expect(found.join(' ')).toContain('PUT-YOUR-DRIVE-FOLDER-ID-HERE');
  });

  it('finds one nested arbitrarily deep', () => {
    const wf: WorkflowFile = {
      nodes: [{ name: 'n', type: 't', ...({ parameters: { a: { b: [{ c: 'PUT-A-THING-HERE' }] } } } as object) }],
    };
    expect(unsetPlaceholders(wf)).toHaveLength(1);
  });

  it('does not flag ordinary text that merely shouts', () => {
    const wf: WorkflowFile = {
      nodes: [{ name: 'n', type: 't', ...({ parameters: { note: 'PUT THE KETTLE ON' } } as object) }],
    };
    expect(unsetPlaceholders(wf)).toEqual([]);
  });

  it('reports clean for a workflow with nothing left to fill in', () => {
    expect(unsetPlaceholders(load('contact-feedback.workflow.json'))).toEqual([]);
  });
});

describe('webhookPaths', () => {
  it('reads the path the iOS workflow will answer on', () => {
    expect(webhookPaths(load('ios-note-capture.workflow.json'))).toEqual(['reckons-note']);
  });

  it('returns nothing for a schedule-driven workflow', () => {
    const wf: WorkflowFile = { nodes: [{ name: 'S', type: 'n8n-nodes-base.scheduleTrigger' }] };
    expect(webhookPaths(wf)).toEqual([]);
  });
});
