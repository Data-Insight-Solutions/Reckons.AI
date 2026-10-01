/**
 * F239 WALKING-SKELETON FLOW TEST (2026-09-30) — what exists, and what does not.
 *
 * kb:supervised-compute-sharing is `speculative` and NOTHING of the flow is built. This file walks
 * the ten stages with a temp directory standing in for the shared space folder. Where real code
 * exists it is CALLED (task-templates.ts, pending-entry.ts); where it does not, an `it.todo` names
 * the gap and the roadmap entity that owns it. No stub implementation is written to make a stage
 * pass: a green stage here means real code ran.
 *
 * Fixtures are synthetic (scripts/agent/fixtures/collab/requests.json).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEMPLATES, assertAdmissible, matchTemplate } from '../task-templates.js';
import { partitionPendingJsonl, parsePendingEntryLine } from '../../../src/lib/rdf/pending-entry.js';

const FIXTURES = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts/agent/fixtures/collab/requests.json'), 'utf8'),
) as Record<string, { request: string; attachment?: { name: string; text: string } }>;

let space: string;

beforeAll(() => {
  space = mkdtempSync(join(tmpdir(), 'collab-flow-'));
  mkdirSync(join(space, 'requests'), { recursive: true });
  // TEST HELPER ONLY (not a requester implementation): lays fixtures down as the files the
  // requester's app WOULD write, so later stages have something real to read.
  for (const [id, f] of Object.entries(FIXTURES)) {
    if (id.startsWith('_')) continue;
    writeFileSync(join(space, 'requests', `${id}.request.txt`), f.request);
    if (f.attachment) writeFileSync(join(space, 'requests', `${id}.${f.attachment.name}`), f.attachment.text);
  }
});
afterAll(() => rmSync(space, { recursive: true, force: true }));

describe('stage 1 — requester writes a plain-language request + file into the space', () => {
  it('fixtures are laid down as files in the temp space (helper, not product code)', () => {
    expect(readdirSync(join(space, 'requests')).length).toBeGreaterThanOrEqual(8);
  });
  it.todo('GAP 1: no requester-side writer exists (app or form that writes a request file plus attachment into a synced space folder, with id/asker/status per the task-file lifecycle) — owned by F239 phase 1 (kb:supervised-compute-sharing)');
});

describe('stage 2 — consent record in the space is checked; no record means refused', () => {
  it.todo('GAP 2: no consent-record format, no Connect-to-support flow, no watcher check — owned by F239 phase 2. Assertion when built: a space folder with no current record (host, scope, from, until) makes the host refuse every request in it, and an expired record does too');
});

describe('stage 3 — host notices the new request in the synced folder', () => {
  it.todo('GAP 3: no host watcher over a synced space folder (the MCP file watcher watches KBs, not request folders); polling cadence/cost is F239 R2 question — owned by F239 phase 1 + phase 3');
});

describe('stage 4 — a local model drafts a PLAN mapping the request to registered task types', () => {
  it('the F99.4 registry exists and every shipped template passes admission (REAL code)', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
    expect(() => assertAdmissible(TEMPLATES)).not.toThrow();
  });

  it('GAP 4a (measured): NONE of the registered types matches requests A, B or C, so the registry cannot serve the first test case', () => {
    // The only templates are owner-emailing voice commands (generate-document-email-me,
    // review-requirements, summarise-graph). There is no build-graph-from-source, no
    // transcript-to-statements, no spec-review type. Real matchTemplate, real answer.
    for (const id of ['A', 'B', 'C']) {
      expect(matchTemplate(FIXTURES[id].request), `request ${id}`).toBeNull();
    }
  });

  it.todo('GAP 4b: no register of COLLABORATION task types (build-graph-from-grant-call, transcript-to-statements F240, spec-gap-review) with the F99.4 admission test adapted: those templates assume recipient owner = the host; a requester is a third party — owned by F239 phase 1 (registry) but the admission test for requester-facing types is unowned');
  it.todo('GAP 4c: no planner. Assertion when built — plan(A) lists exactly one registry type id with data {source: grant-call.txt}; plan(B) lists the transcript type; plan(C) the spec-review type; every id is a member of the registry; the plan is a proposal file, never executed — owned by F239 phase 1 (host runner drafts plan locally; scripts/offline harness shape ground->prompt->validate->emit)');

  it('D: a request matching no type is NOT improvised (REAL matcher returns null)', () => {
    expect(matchTemplate(FIXTURES.D.request)).toBeNull();
  });
  it.todo('GAP 4d (stage D): no planning step to emit the verdict. Assertion when built — plan(D) === { status: "needs-host", types: [], reason: non-empty } and no model call is made to invent a type');

  it('E: hostile text matches no registry type, so nothing is selected from it (REAL matcher)', () => {
    expect(matchTemplate(FIXTURES.E.request)).toBeNull();
  });

  // FINDING, measured with real code: a hostile argument that DOES start with a registered phrase
  // flows into command(), and command() wraps it in JSON.stringify, which yields a double-quoted
  // string. Bash still expands $() and backticks inside double quotes, and runner.ts executes the
  // command with execSync(..., { shell: '/bin/bash' }). task-templates.ts says "never interpolated
  // into a shell string" but it was. FIXED by #342 (F99.4): arguments are now shell-quoted, so this
  // runs as a plain `it` and guards the fix.
  it('E (arg path, fixed in #342): command(arg) neutralises shell metacharacters in the argument', () => {
    const m = matchTemplate('generate a document about $(touch HOSTILE_MARKER) and `id`');
    expect(m, 'phrase-anchored hostile text does match a registry template').not.toBeNull();
    const cmd = m!.template.command(m!.arg);
    const live = /\$\(|`/.test(cmd.replace(/'[^']*'/g, ''));
    expect(live, `command is: ${cmd}`).toBe(false);
  });
});

describe('stage 5 — overseer check of the plan', () => {
  it.todo('GAP 5: no overseer step (a Sonnet/second-model check that a plan names only registry types, stays inside the consented scope, and widens nothing) — owned by F239 text + F89 (merge queue for code deliverables); the plan-level overseer itself has no phase and is UNOWNED');
});

describe('stage 6 — host approval (instance gate)', () => {
  it.todo('GAP 6: the INSTANCE gate exists for LOCAL tasks (runner.ts: proposed -> open by a human) but nothing connects a requester plan to it; assertion when built — an unapproved plan produces no execution and no deliverable file — owned by F99.4 (gate) + F239 phase 1 (bridge)');
});

describe('stage 7 — execution by a local model (MOCKED)', () => {
  it.todo('GAP 7: no host runner that claims a task, grounds it by script, calls the local model and writes status queued->claimed->done/refused; the ethics preamble must be injected on these prompts (F239 constraint) — owned by F239 phase 1');
});

describe('stage 8 — deliverable lands as pending statements with provenance, in the app-drained queue shape', () => {
  // A hand-written queue is used because no producer exists. What IS real is the consumer
  // validation: partitionPendingJsonl is the code drainWorkspacePending runs.
  const entities = {
    kb: 'collab-demo-space',
    subject: 'urn:kbase:concept/harbour-light-fund',
    agent: 'host:workstation-1/model:mock-local/task:build-graph-from-source/person:host-operator',
    type: 'observation' as const,
  };
  const rows = [
    { ...entities, predicate: 'urn:kbase:predicate/deadline', object: '2027-03-15' },
    // Partial fact (F32): unknown award size becomes an open question, not an invented value.
    { ...entities, predicate: 'urn:kbase:predicate/award-size', question: 'What is the award size? The call does not state it.', type: 'question' as const },
  ];

  it('rows in the pending.jsonl shape validate and address the space graph (REAL parser)', () => {
    const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(join(space, 'knowledge.pending.jsonl'), jsonl);
    const p = partitionPendingJsonl(readFileSync(join(space, 'knowledge.pending.jsonl'), 'utf8'), ['collab-demo-space']);
    expect(p.issues).toEqual([]);
    expect(p.entries).toHaveLength(2);
    expect(p.entries[1].question).toMatch(/award size/);
  });

  it('a row without a destination graph is retained, never guessed (REAL)', () => {
    const noKb = JSON.stringify({ subject: 'urn:kbase:concept/x', predicate: 'urn:kbase:predicate/y', object: 'z' });
    expect(parsePendingEntryLine(noKb, { requireKb: true }).ok).toBe(false);
  });

  it('PARTIAL — provenance survives the parser only as free-form extra keys; the importer keeps just `agent`', () => {
    const withProv = JSON.stringify({ ...rows[0], person: 'host-operator', machine: 'workstation-1', model: 'mock-local', taskType: 'build-graph-from-source' });
    const r = parsePendingEntryLine(withProv, { requireKb: true });
    expect(r.ok && r.entry.model).toBe('mock-local');
    // drainAndImportPendingOnce (workspace.svelte.ts) reads e.agent for the source title and no
    // person/machine/model/taskType field; verified by reading the function on 2026-09-30.
  });

  it.todo('GAP 8a: no deliverable producer — nothing turns a request + attachment into rows for A (entities + partial-fact questions), B (statements attributed to speaker labels), C (what is missing) — owned by F239 phase 1; B depends on F240 (kb:meeting-transcription)');
  it.todo('GAP 8b: provenance (person, machine, model, task type) is not a first-class field of PendingEntry and is not persisted on the imported Statement (only `agent` becomes the source title) — F239 principle names it, no phase owns the schema change: UNOWNED');
  it.todo('GAP 8c (stage B): speaker labels must be flagged UNCONFIRMED on each statement (F240 constraint); no field or marker exists in the queue shape — owned by F240');
  it.todo('GAP 8d: ONE WRITER PER FILE — nothing enforces that the host writes only its own proposals file; knowledge.pending.jsonl is shared with the app, and the app\'s drain rewrites it (acknowledge), so the host and app are two writers of one file — F239 principle, layout unowned in any phase beyond the format line');
});

describe('stage 9 — requester sees status and deliverables (pending review)', () => {
  it.todo('GAP 9: no status file read-back in the requester UI (received / queued / claimed / done / refused) and no "deliverables awaiting review" view scoped to a request — owned by F239 text (requester sees three things); review itself exists (Review tab) for rows that drain');
});

describe('stage 10 — revocation stops the host', () => {
  it.todo('GAP 10: no revocation. Assertion when built — deleting the consent record from the person\'s side makes the next host poll refuse and write nothing, and the scoped storage credential is invalid — owned by F239 phase 2 + phase 3');
});
