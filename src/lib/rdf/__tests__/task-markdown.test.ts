import { describe, it, expect } from 'vitest';
import { taskToMarkdown, taskFromMarkdown, queueToMarkdown, missingForExecution, taskTitle } from '../task-markdown';
import type { AgentTask } from '../agent-task';

const dictated: AgentTask = {
  iri: 'urn:reckons:task/note-2026-08-28T13-38-52-197Z-1',
  goal: 'run a research task for new grants or current grants that are, for city, uh, Parks and Rec, that have, uh, childhood activities, uh, like swim team.',
  tier: 'frontier',
  harness: 'any',
  effects: [],
  blockedBy: [],
  state: 'proposed',
};

const runnable: AgentTask = {
  ...dictated,
  iri: 'urn:reckons:task/align-site',
  goal: 'Regenerate every surface generated from the graph.',
  tier: 'script',
  effects: ['source-write'],
  doneWhen: 'npx tsx scripts/align.ts',
  command: 'npx tsx scripts/align.ts --fix',
  state: 'open',
};

describe('taskToMarkdown — the refusal is the document', () => {
  it('says it is not runnable, and why', () => {
    const doc = taskToMarkdown(dictated);
    expect(doc.markdown).toContain('**Not runnable.**');
    expect(doc.markdown).toContain('dictated note');
  });

  it('turns the missing fields into a checklist', () => {
    const doc = taskToMarkdown(dictated);
    expect(doc.markdown).toContain('## Before this can run');
    expect(doc.markdown).toContain('- [ ] `kpred:effect`');
    expect(doc.markdown).toContain('- [ ] `kpred:done-when`');
  });

  it('keeps the goal verbatim — fillers and all', () => {
    expect(taskToMarkdown(dictated).markdown).toContain(dictated.goal);
  });

  it('names its own source, so the document can be traced back', () => {
    const doc = taskToMarkdown(dictated);
    expect(doc.markdown).toContain(`task: "${dictated.iri}"`);
    expect(doc.markdown).toContain('The graph is the source');
  });

  it('is deterministic — same task in, same document out', () => {
    expect(taskToMarkdown(dictated).markdown).toBe(taskToMarkdown(dictated).markdown);
  });

  it('never publishes a task by accident', () => {
    const doc = taskToMarkdown(dictated);
    expect(doc.markdown).toContain('status: draft');
    expect(doc.markdown).toContain('nav: hidden');
  });

  it('drops the checklist once nothing is missing', () => {
    expect(taskToMarkdown(runnable).markdown).not.toContain('## Before this can run');
    expect(missingForExecution(runnable)).toEqual([]);
  });

  it('shows the command a reviewer would be approving', () => {
    expect(taskToMarkdown(runnable).markdown).toContain('npx tsx scripts/align.ts --fix');
  });

  it('titles from the goal without inventing words', () => {
    expect(taskTitle(dictated).toLowerCase()).toContain('run a research task');
    expect(taskTitle({ ...dictated, goal: '' })).toBe('Untitled task');
  });
});

describe('taskFromMarkdown — markdown in', () => {
  /** The loop this exists for: render a blocked task, fill the form, hand it back. */
  const filled = () =>
    taskToMarkdown(dictated)
      .markdown.replace('effect: []', 'effect: [external-read]')
      .replace('done_when: ""', 'done_when: "npx tsx scripts/grants-report.ts --check"');

  it('round-trips the task identity and the goal', () => {
    const parsed = taskFromMarkdown(taskToMarkdown(dictated).markdown);
    expect(parsed.iri).toBe(dictated.iri);
    expect(parsed.goal).toBe(dictated.goal);
    expect(parsed.issues).toEqual([]);
  });

  it('reads the fields an agent filled in', () => {
    const parsed = taskFromMarkdown(filled());
    expect(parsed.effects).toEqual(['external-read']);
    expect(parsed.doneWhen).toBe('npx tsx scripts/grants-report.ts --check');
    expect(parsed.issues).toEqual([]);
  });

  it('refuses an unknown effect instead of filtering it into apparent safety', () => {
    const md = taskToMarkdown(dictated).markdown.replace('effect: []', 'effect: [delete-everything]');
    const parsed = taskFromMarkdown(md);
    expect(parsed.effects).toEqual([]);
    expect(parsed.issues.join(' ')).toContain('delete-everything');
  });

  // The safety property: a file must not be able to assert that work happened.
  it('ignores a state the document has no business setting, and says so', () => {
    const md = taskToMarkdown(dictated).markdown.replace('task_state: "proposed"', 'task_state: "done"');
    const parsed = taskFromMarkdown(md);
    expect(parsed.issues.join(' ')).toContain('cannot claim, complete or fail');
  });

  it('flags a command with no declared authority boundary', () => {
    const md = taskToMarkdown(dictated).markdown.replace('command: ""', 'command: "rm -rf /"');
    expect(taskFromMarkdown(md).issues.join(' ')).toContain('no effect declared');
  });

  it('rejects a document that is not a task document', () => {
    expect(taskFromMarkdown('# Just some notes\n\nnothing here').issues.join(' ')).toContain('no frontmatter');
  });

  it('reports a document with frontmatter but no task IRI', () => {
    expect(taskFromMarkdown('---\ntitle: "x"\n---\n\n# x').issues.join(' ')).toContain('which task');
  });
});

describe('queueToMarkdown — bounded on purpose', () => {
  const many = (n: number): AgentTask[] =>
    Array.from({ length: n }, (_, i) => ({ ...dictated, iri: `urn:reckons:task/t${i}`, goal: `Task ${i}.` }));

  it('caps the document and says what it left out', () => {
    const md = queueToMarkdown(many(30), { limit: 5 });
    expect(md).toContain('30 tasks in the queue');
    expect(md).toContain('25 further tasks not shown');
  });

  it('says nothing about omissions when there are none', () => {
    expect(queueToMarkdown(many(3), { limit: 5 })).not.toContain('not shown');
  });

  it('marks each task runnable or blocked', () => {
    const md = queueToMarkdown([dictated, runnable]);
    expect(md).toContain('blocked:');
    expect(md).toContain('runnable');
  });
});
