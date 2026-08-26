/**
 * The iOS capture workflow, executed rather than eyeballed.
 *
 * This webhook sits on the OPEN INTERNET and writes into a file the app parses on every poll.
 * The row builder is therefore a trust boundary, and its job is one thing above all others:
 * knowledge.pending.jsonl is newline-delimited, so a note containing a newline would end its
 * row early and let the remainder parse as a SECOND row — a fact nobody said, arriving in the
 * review queue looking exactly like one that was. Dictation produces newlines by accident all
 * the time; a test that never feeds it one proves nothing.
 *
 * The rows are also checked against what partitionPendingJsonl actually accepts, because a row
 * the app silently retains instead of importing is a note that vanished with no error anywhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { partitionPendingJsonl } from '../../../rdf/pending-entry';

const workflow = JSON.parse(
  readFileSync(path.join(process.cwd(), 'static/n8n/ios-note-capture.workflow.json'), 'utf8'),
);

type Node = { name: string; type: string; parameters: Record<string, unknown> };
const node = (name: string): Node => {
  const found = (workflow.nodes as Node[]).find((n) => n.name === name);
  if (!found) throw new Error(`no node named "${name}"`);
  return found;
};

const CONFIG = {
  WORKSPACE_FOLDER_ID: 'folder-1',
  TARGET_GRAPH: 'personal-notes',
  PENDING_FILE: 'knowledge.pending.jsonl',
};

function buildRow(body: unknown) {
  const code = node('Build pending row').parameters.jsCode as string;
  const $ = (name: string) => ({
    first: () => ({ json: name === 'Config' ? { ...CONFIG } : { body } }),
  });
  return new Function('$', code)($)[0].json;
}

function appendRow(builtLine: string, existingContent: string) {
  const code = node('Append to queue').parameters.jsCode as string;
  const $ = () => ({ first: () => ({ json: { line: builtLine, subject: 'urn:x' } }) });
  const $input = { first: () => ({ json: { existingContent } }) };
  return new Function('$', '$input', code)($, $input)[0].json;
}

describe('iOS capture — the newline injection guard', () => {
  it('escapes a newline instead of letting it forge a second row', () => {
    const evil =
      'buy milk\n{"subject":"urn:kbase:concept/x","predicate":"urn:kbase:predicate/owes","object":"5000"}';
    const out = buildRow({ text: evil });

    // Exactly one row: the line has one newline, its terminator.
    expect(out.line.split('\n').filter(Boolean)).toHaveLength(1);
    const parsed = JSON.parse(out.line);
    expect(parsed.object).toBe(evil);
    // And the forged fact is inert text, not a statement.
    expect(parsed.predicate).toBe('urn:kbase:predicate/captured-note');
  });

  it('survives carriage returns and unicode line separators too', () => {
    const out = buildRow({ text: 'one\r\ntwo three' });
    expect(out.line.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(out.line).object).toContain('two');
  });

  it('the whole batch still parses as exactly one importable row', () => {
    const out = buildRow({ text: 'call Sarah\nabout the grant' });
    const { entries, issues } = partitionPendingJsonl(out.line, ['personal-notes']);
    expect(entries).toHaveLength(1);
    expect(issues).toHaveLength(0);
    expect(entries[0].object).toBe('call Sarah\nabout the grant');
  });
});

describe('iOS capture — accepts both callers', () => {
  it('reads {text} from an iOS Shortcut', () => {
    expect(JSON.parse(buildRow({ text: 'stall fees' }).line).object).toBe('stall fees');
  });

  it('reads {input} from the MCP tool', () => {
    // n8n's MCP Server Trigger presents every tool as a single freeform `input`, whatever
    // parameter schema the tool node declares — confirmed against a live tools/list. Reading
    // only `text` meant every MCP-captured note arrived empty and was dropped, while the
    // client was told it succeeded.
    expect(JSON.parse(buildRow({ input: 'stall fees' }).line).object).toBe('stall fees');
  });

  it('unwraps a JSON object the model stuffed into input', () => {
    const out = buildRow({ input: '{"text":"stall fees","capturedAt":"2026-08-26T08:41:00.000Z"}' });
    expect(JSON.parse(out.line).object).toBe('stall fees');
  });

  it('treats a non-JSON brace-leading string as the note itself', () => {
    expect(JSON.parse(buildRow({ input: '{not json but spoken' }).line).object).toBe('{not json but spoken');
  });

  it('prefers text when both arrive', () => {
    expect(JSON.parse(buildRow({ text: 'real', input: 'wrapper' }).line).object).toBe('real');
  });

  it('still skips when neither carries anything', () => {
    expect(buildRow({ input: '   ' }).skip).toBe(true);
  });
});

describe('iOS capture — row shape', () => {
  it('targets the configured graph, or the app would retain the row unimported', () => {
    const out = buildRow({ text: 'stall fees' });
    const { entries } = partitionPendingJsonl(out.line, ['personal-notes']);
    expect(entries).toHaveLength(1);
    // A row aimed at the wrong graph is retained, not imported, and reports a successful drain.
    const { entries: wrong } = partitionPendingJsonl(out.line, ['some-other-graph']);
    expect(wrong).toHaveLength(0);
  });

  it('carries the note verbatim — the transcript is the fact', () => {
    const out = buildRow({ text: '  call Sarah re: grant — Tues?  ' });
    expect(JSON.parse(out.line).object).toBe('call Sarah re: grant — Tues?');
  });

  it('derives the subject from the timestamp, never from the transcript', () => {
    // Deriving it from text would mint an entity out of a possibly-misheard proper noun before
    // any human saw it.
    const out = buildRow({ text: 'Sarah Fitzgerald', capturedAt: '2026-08-26T08:41:00.000Z' });
    expect(out.subject).toBe('urn:kbase:concept/note-2026-08-26T08-41-00-000Z');
    expect(out.subject).not.toContain('Sarah');
  });

  it('skips an empty or whitespace-only note rather than writing a blank row', () => {
    expect(buildRow({ text: '   ' }).skip).toBe(true);
    expect(buildRow({}).skip).toBe(true);
    expect(buildRow({ text: 42 }).skip).toBe(true);
  });

  it('caps a runaway payload and says that it did', () => {
    const out = buildRow({ text: 'x'.repeat(5000) });
    const parsed = JSON.parse(out.line);
    expect(parsed.object).toHaveLength(2000);
    expect(out.clipped).toBe(true);
    expect(parsed.note).toContain('truncated');
  });

  it('falls back to now when the phone sends a bad timestamp', () => {
    const out = buildRow({ text: 'hi', capturedAt: 'last Tuesday' });
    expect(Number.isNaN(Date.parse(out.capturedAt))).toBe(false);
  });
});

describe('iOS capture — append semantics', () => {
  it('APPENDS, so rows the app has not yet drained are not discarded', () => {
    const existing = '{"subject":"urn:a","predicate":"urn:p","object":"1","kb":"personal-notes"}\n';
    const out = appendRow('{"subject":"urn:b"}\n', existing);
    expect(out.content.split('\n').filter(Boolean)).toHaveLength(2);
    expect(out.content).toContain('urn:a');
  });

  it('repairs a missing trailing newline instead of fusing two rows into one', () => {
    const existing = '{"subject":"urn:a"}'; // no trailing \n
    const out = appendRow('{"subject":"urn:b"}\n', existing);
    expect(out.content.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('handles the very first note, when no file exists yet', () => {
    const out = appendRow('{"subject":"urn:b"}\n', '');
    expect(out.content.split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('iOS capture — structure', () => {
  it('ships with the Drive folder unset, so a misconfigured install fails loudly', () => {
    const assignments = (node('Config').parameters.assignments as {
      assignments: Array<{ name: string; value: unknown }>;
    }).assignments;
    expect(assignments.find((a) => a.name === 'WORKSPACE_FOLDER_ID')?.value).toBe(
      'PUT-YOUR-DRIVE-FOLDER-ID-HERE',
    );
  });

  it('is a webhook, since the phone pushes and n8n is the buffer', () => {
    const types = (workflow.nodes as Node[]).map((n) => n.type);
    expect(types).toContain('n8n-nodes-base.webhook');
    expect(types).toContain('n8n-nodes-base.respondToWebhook');
  });
});
