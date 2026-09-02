/**
 * An agent task, rendered as a markdown document.
 *
 * Matt, 2026-08-28: "the direct markdown within Handoff has been extremely difficult to remove
 * from this equation, so how about we make that a standard not a workaround."
 *
 * THAT IS THE RIGHT READING OF A LONG-RUNNING FAILURE. `kb:adopt-bounded-handoff` framed
 * HANDOFF.md as a document to compile and cap — a legacy artifact to be eliminated. But it has
 * survived every attempt to remove it, and things that refuse to die usually do a job nothing
 * else does. Triples are the STORE: addressable, diffable, reviewable, and hopeless at telling
 * one reader, in order, what is going on. Markdown is a PROJECTION for exactly that reader —
 * human or agent — and the project already treats it as one for documentation (F27: WebPage
 * nodes to content/*.md and back). This extends the same methodology to work.
 *
 * DETERMINISTIC AND ONE-WAY. Same triples in, same markdown out — no model, no ordering that
 * depends on store iteration. The document is DERIVED and never authoritative: the graph stays
 * the source, exactly as `kb:content-orchestration` insists a rendered artifact must ("the scene
 * is a graph, not a script"). Edit the task by editing the graph; regenerate the document.
 *
 * THE REFUSAL IS THE DOCUMENT'S STRUCTURE, and that is the point of rendering it at all. A task
 * dictated into a ring has no declared effects, no acceptance check and no command, so
 * `blockedReason` refuses it. As a triple that refusal is one string nobody reads. As a document
 * it is a checklist with the three missing fields named, each with what it is FOR — which is the
 * difference between a queue that blocks work and a queue that asks for what it needs.
 */

import type { AgentTask } from './agent-task';
import { blockedReason, isTaskEffect, TASK_EFFECTS } from './agent-task';
import { slugify } from './page';

/** YAML-encode a scalar. Mirrors `yamlStr` in publish/site-export.ts. */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A short title from a goal sentence, without inventing words that were not said. */
export function taskTitle(task: AgentTask, maxLength = 72): string {
  const goal = task.goal.trim();
  if (!goal) return 'Untitled task';
  const first = goal.split(/(?<=[.!?])\s/)[0] ?? goal;
  const trimmed = first.length > maxLength ? `${first.slice(0, maxLength - 1).trimEnd()}…` : first;
  // Capitalised for a heading; the GOAL below stays verbatim, fillers and all.
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** What a task still needs before any harness may take it, in the order a person supplies them. */
export function missingForExecution(task: AgentTask): { field: string; why: string }[] {
  const missing: { field: string; why: string }[] = [];
  if ((task.effects?.length ?? 0) === 0) {
    missing.push({
      field: 'kpred:effect',
      why: `the authority boundary this may cross — one or more of ${TASK_EFFECTS.join(', ')}`,
    });
  }
  if (!task.doneWhen?.trim()) {
    missing.push({
      field: 'kpred:done-when',
      why: 'a command whose exit code decides whether it worked — without one, completion is the agent\'s opinion of its own work',
    });
  }
  if (!task.goal.trim()) {
    missing.push({ field: 'kpred:goal', why: 'what to do, in words a harness can act on' });
  }
  return missing;
}

export type TaskDocument = {
  /** Repo-relative-ish filename, stable across renders of the same task. */
  filename: string;
  slug: string;
  title: string;
  markdown: string;
};

/**
 * Render one task as a markdown document with the same frontmatter shape F27 publishes, so it
 * travels through the pipeline that already exists rather than needing a second one.
 *
 * `nav: hidden` and `status: draft` are deliberate: a task document is working material, not a
 * page of the site, and publishing the queue by accident would be a real leak.
 */
export function taskToMarkdown(
  task: AgentTask,
  opts: { noteIri?: string; capturedAt?: string; section?: string } = {},
): TaskDocument {
  const slug = slugify(task.iri.split('/').pop() ?? task.iri);
  const title = taskTitle(task);
  const blocked = blockedReason(task, { now: Date.now(), resolved: () => true });
  const missing = missingForExecution(task);

  const lines: string[] = ['---'];
  lines.push(`title: ${yamlStr(title)}`);
  lines.push(`slug: ${yamlStr(slug)}`);
  lines.push('order: 0');
  if (opts.section) lines.push(`section: ${yamlStr(opts.section)}`);
  lines.push('template: doc');
  lines.push('status: draft');
  lines.push('nav: hidden');
  // The IRI is carried so the document can be traced back to the fact it renders. A rendered
  // artifact that cannot name its source is the thing this product exists to replace.
  lines.push(`task: ${yamlStr(task.iri)}`);
  lines.push(`task_state: ${yamlStr(task.state)}`);
  // THE DOCUMENT IS ALSO A FORM (Matt, 2026-08-28: "markdown in markdown out"). These three keys
  // are emitted EMPTY when the task lacks them, so the file an agent receives is the same file it
  // fills in and hands back. A checklist in prose tells a reader what is missing; an empty key
  // tells them where to put it, and `taskFromMarkdown` reads exactly these.
  lines.push(`effect: ${task.effects.length ? `[${task.effects.join(', ')}]` : '[]'}`);
  lines.push(`done_when: ${yamlStr(task.doneWhen ?? '')}`);
  lines.push(`command: ${yamlStr(task.command ?? '')}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');

  if (blocked) {
    lines.push(`> **Not runnable.** ${blocked}`);
    lines.push('');
  }

  lines.push('## Goal');
  lines.push('');
  // Verbatim. A transcript is the record; tidying it here would put words in someone's mouth.
  lines.push(task.goal.trim() || '_No goal recorded._');
  lines.push('');

  if (missing.length > 0) {
    lines.push('## Before this can run');
    lines.push('');
    for (const m of missing) lines.push(`- [ ] \`${m.field}\` — ${m.why}`);
    lines.push('');
  }

  lines.push('## State');
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  lines.push(`| state | \`${task.state}\` |`);
  lines.push(`| tier | \`${task.tier}\` |`);
  lines.push(`| harness | \`${task.harness}\` |`);
  if (task.effects.length > 0) lines.push(`| effects | \`${task.effects.join('`, `')}\` |`);
  if (task.doneWhen) lines.push(`| done-when | \`${task.doneWhen}\` |`);
  if (task.model) lines.push(`| model | \`${task.model}\` |`);
  if (task.claimedBy) lines.push(`| claimed by | ${task.claimedBy} |`);
  if (task.outcome) lines.push(`| outcome | ${task.outcome} |`);
  lines.push('');

  if (task.blockedBy.length > 0) {
    lines.push('## Blocked by');
    lines.push('');
    for (const b of task.blockedBy) lines.push(`- \`${b}\``);
    lines.push('');
  }

  if (opts.noteIri || opts.capturedAt) {
    lines.push('## Provenance');
    lines.push('');
    if (opts.capturedAt) lines.push(`- Dictated ${opts.capturedAt}`);
    if (opts.noteIri) lines.push(`- Read from \`${opts.noteIri}\``);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `_Generated from \`${task.iri}\`. The graph is the source; edit the task there and regenerate._`,
  );
  lines.push('');

  return { filename: `${slug}.md`, slug, title, markdown: lines.join('\n') };
}

/**
 * Render a whole queue as one bounded document.
 *
 * BOUNDED IS THE FEATURE, not a limitation — `kb:adopt-bounded-handoff` recorded the evidence:
 * HANDOFF.md reached 107,738 bytes and the session instructed to read it first grepped its
 * headers instead. An unread document is not continuity. `limit` caps what is rendered and the
 * document SAYS what it left out, so the cap is visible rather than silent.
 */
export function queueToMarkdown(
  tasks: AgentTask[],
  opts: { limit?: number; title?: string } = {},
): string {
  const { limit = 20, title = 'Task queue' } = opts;
  const shown = tasks.slice(0, limit);
  const omitted = tasks.length - shown.length;

  const lines = [`# ${title}`, ''];
  lines.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} in the queue.`);
  lines.push('');
  for (const task of shown) {
    const blocked = blockedReason(task, { now: Date.now(), resolved: () => true });
    lines.push(`## ${taskTitle(task)}`);
    lines.push('');
    lines.push(`\`${task.state}\` · \`${task.tier}\`${blocked ? ` · blocked: ${blocked}` : ' · runnable'}`);
    lines.push('');
    lines.push(task.goal.trim() || '_No goal recorded._');
    lines.push('');
  }
  if (omitted > 0) {
    lines.push(`_${omitted} further task${omitted === 1 ? '' : 's'} not shown — raise the limit to see ${omitted === 1 ? 'it' : 'them'}._`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Markdown IN ──────────────────────────────────────────────────────────────

/**
 * Read a task document back.
 *
 * Matt, 2026-08-28: "this increases interoperability even further, allowing for a markdown in,
 * markdown out process for agents utilizing Reckons.AI." F27 already round-trips PAGES this way
 * (site-export / site-import), so this is the same methodology applied to work — and it is what
 * lets an agent supply the three fields a dictated task cannot contain: fill the form, hand it
 * back, and the graph gains a runnable task without anyone hand-editing TTL.
 *
 * WHAT THIS PARSES IS FRONTMATTER, NOT PROSE, and that is a safety property rather than laziness.
 * Reading `effect` out of a sentence means an agent's phrasing decides an authority boundary.
 * A key with a value is unambiguous, diffable, and cannot be smuggled past a reviewer inside a
 * paragraph.
 *
 * IT RETURNS A PROPOSAL, NEVER AN AUTHORITY. Everything here is agent- or user-supplied input:
 * it is turned into facts that enter review like any other, and three things are refused
 * outright — an unknown effect, a state this document has no business setting, and a missing
 * task IRI. Parsing a file must never be a way around the gate that `blockedReason` enforces.
 */
export type ParsedTaskDocument = {
  /** The task this document addresses. Absent means the document is not about a known task. */
  iri?: string;
  goal?: string;
  effects: string[];
  doneWhen?: string;
  command?: string;
  /** Anything refused, in words a reviewer can act on. Never silently dropped. */
  issues: string[];
};

function frontmatterBlock(markdown: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown.trimStart());
  return m ? m[1] : null;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

/** The `## Goal` section, verbatim, so a transcript survives the round trip unchanged. */
function goalSection(markdown: string): string | undefined {
  const m = /^##\s+Goal\s*$([\s\S]*?)(?=^##\s|\Z)/m.exec(markdown);
  if (!m) return undefined;
  const body = m[1].trim();
  return body && body !== '_No goal recorded._' ? body : undefined;
}

export function taskFromMarkdown(markdown: string): ParsedTaskDocument {
  const issues: string[] = [];
  const fm = frontmatterBlock(markdown);
  if (!fm) {
    return { effects: [], issues: ['no frontmatter — this is not a task document'] };
  }

  const fields = new Map<string, string>();
  for (const line of fm.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (m) fields.set(m[1], m[2]);
  }

  const iri = fields.has('task') ? unquote(fields.get('task')!) : undefined;
  if (!iri) issues.push('no `task:` key — the document does not say which task it is about');

  const rawEffects = (fields.get('effect') ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((e) => unquote(e))
    .filter(Boolean);
  const effects: string[] = [];
  for (const effect of rawEffects) {
    if (isTaskEffect(effect)) effects.push(effect);
    // Refused, not filtered into apparent safety: a typo'd effect must block, not vanish.
    else issues.push(`unknown effect "${effect}" — expected one of ${TASK_EFFECTS.join(', ')}`);
  }

  const doneWhen = unquote(fields.get('done_when') ?? '') || undefined;
  const command = unquote(fields.get('command') ?? '') || undefined;

  // A document may DESCRIBE a state but must never SET one. State transitions are claims about
  // what happened — a lease taken, work finished — and letting a file assert them would let any
  // writer of that file mark work done that nobody did.
  const declaredState = unquote(fields.get('task_state') ?? '');
  if (declaredState && declaredState !== 'proposed' && declaredState !== 'open') {
    issues.push(
      `document declares state "${declaredState}" — ignored; a file cannot claim, complete or fail a task`,
    );
  }

  if (command && effects.length === 0) {
    issues.push('a command is given with no effect declared — the runner cannot choose an authority boundary');
  }

  return { iri, goal: goalSection(markdown), effects, doneWhen, command, issues };
}
