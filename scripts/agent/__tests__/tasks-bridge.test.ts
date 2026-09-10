import { describe, it, expect } from 'vitest';
import { needsAuthoring } from '../tasks-export';
import { rowsFor, sectionOf } from '../tasks-import';
import { taskToMarkdown, taskFromMarkdown } from '../../../src/lib/rdf/task-markdown';
import type { AgentTask } from '../../../src/lib/rdf/agent-task';

const dictated: AgentTask = {
  iri: 'urn:reckons:task/note-1',
  goal: 'run a research task for new grants for city Parks and Rec.',
  tier: 'frontier',
  harness: 'any',
  effects: [],
  blockedBy: [],
  state: 'proposed',
};

const authored: AgentTask = {
  ...dictated,
  iri: 'urn:reckons:task/align',
  goal: 'Regenerate every generated surface.',
  effects: ['source-write'],
  doneWhen: 'npx tsx scripts/align.ts',
  state: 'open',
};

describe('needsAuthoring — which tasks reach a person', () => {
  it('exports a task missing the fields only a person can supply', () => {
    expect(needsAuthoring([dictated]).map((t) => t.iri)).toEqual([dictated.iri]);
  });

  it('leaves an already-authored task alone', () => {
    expect(needsAuthoring([authored])).toEqual([]);
  });

  // The distinction the header argues for: a dependency does not need a human, it needs its
  // dependency to finish. Exporting it would put an unanswerable document in front of someone.
  it('does not export a task blocked only by a dependency', () => {
    const waiting: AgentTask = { ...authored, blockedBy: ['urn:reckons:task/other'] };
    expect(needsAuthoring([waiting])).toEqual([]);
  });

  it('never re-exports finished work', () => {
    expect(needsAuthoring([{ ...dictated, state: 'done' }, { ...dictated, state: 'failed' }])).toEqual([]);
  });
});

describe('the round trip', () => {
  const filled = () =>
    taskToMarkdown(dictated, { section: 'personal-notes' })
      .markdown.replace('effect: []', 'effect: [external-read]')
      .replace('done_when: ""', 'done_when: "npx tsx scripts/grants-check.ts"');

  it('carries the answer back to the graph that asked', () => {
    const md = filled();
    expect(sectionOf(md)).toBe('personal-notes');
    const rows = rowsFor(taskFromMarkdown(md), sectionOf(md)!);
    expect(rows.every((r) => r.kb === 'personal-notes')).toBe(true);
  });

  it('queues the supplied fields against the right task', () => {
    const rows = rowsFor(taskFromMarkdown(filled()), 'personal-notes');
    const byPred = new Map(rows.map((r) => [String(r.predicate).split('/').pop(), r.object]));
    expect(byPred.get('effect')).toBe('external-read');
    expect(byPred.get('done-when')).toBe('npx tsx scripts/grants-check.ts');
    expect(rows.every((r) => r.subject === dictated.iri)).toBe(true);
  });

  // The safety property the whole bridge rests on.
  it('proposes the promotion out of `proposed` rather than performing it', () => {
    const rows = rowsFor(taskFromMarkdown(filled()), 'personal-notes');
    const state = rows.find((r) => String(r.predicate).endsWith('task-state'));
    expect(state?.object).toBe('open');
    expect(String(state?.note)).toContain('Accept only after');
  });

  it('generates that promotion itself — a document cannot ask for one', () => {
    // The document says `proposed`; the row says `open`. The importer decided that, not the file.
    const md = filled();
    expect(md).toContain('task_state: "proposed"');
    const rows = rowsFor(taskFromMarkdown(md), 'personal-notes');
    expect(rows.find((r) => String(r.predicate).endsWith('task-state'))?.object).toBe('open');
  });

  it('queues nothing at all from an untouched document', () => {
    const blank = taskToMarkdown(dictated, { section: 'personal-notes' }).markdown;
    expect(rowsFor(taskFromMarkdown(blank), 'personal-notes')).toEqual([]);
  });

  it('proposes no promotion when nothing was supplied', () => {
    const blank = taskToMarkdown(dictated, { section: 'personal-notes' }).markdown;
    const rows = rowsFor(taskFromMarkdown(blank), 'personal-notes');
    expect(rows.some((r) => String(r.predicate).endsWith('task-state'))).toBe(false);
  });

  it('queues nothing for a document that names no task', () => {
    expect(rowsFor({ effects: ['read-only'], issues: [] }, 'personal-notes')).toEqual([]);
  });

  it('marks the authority rows high priority — they are what a reviewer must read', () => {
    const rows = rowsFor(taskFromMarkdown(filled()), 'personal-notes');
    const effect = rows.find((r) => String(r.predicate).endsWith('effect'));
    expect(effect?.priority).toBe('high');
  });

  it('every row is a proposal, attributed to the importer', () => {
    const rows = rowsFor(taskFromMarkdown(filled()), 'personal-notes');
    expect(rows.every((r) => r.agent === 'tasks-import' && r.type === 'suggestion')).toBe(true);
  });
});

describe('sectionOf', () => {
  it('reads a quoted section', () => {
    expect(sectionOf('---\nsection: "personal-notes"\n---')).toBe('personal-notes');
  });
  it('reads an unquoted one', () => {
    expect(sectionOf('---\nsection: tasks\n---')).toBe('tasks');
  });
  it('returns nothing when absent, rather than guessing a graph', () => {
    expect(sectionOf('---\ntitle: "x"\n---')).toBeUndefined();
  });
});
