import type { Statement } from './types';
import { validateProposal, ACTION_STATUS, type Proposal, type ProposalIssue } from './proposal';
import { reckoningEntity, reckoningSourceId, reckoningStatementIri, targetShapeFor, type ReadReckoning } from './reckoning-entity';
import { GENERATION_STAGES, STAGE_LABELS, type GenerationStage } from '../generation/protocol';
import { JOB_TYPE, JOB_PREDICATES } from '../generation/job-node';
import { filterBlockedStatements } from '../safety/content-policy';

/**
 * F223.12.3: the proposal of a Reckoning is written into the space, as pending statements.
 *
 * Matt, 2026-11-17: "The summary of Reckoning should be proposing new statements, potentially job nodes, and
 * detailing its proposal, in the space's graph. The sources could also have suggestions, like 'input image of
 * logo' or other pending sources."
 *
 * Two pure halves, no model and no storage:
 *   parseProposalReply  the model's JSON reply, or a stated reason why it is refused (nothing is written).
 *   buildProposalRows   the accepted reply as pending statements, each carrying Statement.proposalOption.
 *
 * AN AGENT MAY NOT SETTLE ITS OWN PROPOSAL (advanceProposal). Every row written here is pending, the Proposal
 * stays potential, and a proposed job is a RECORD in the state `proposed`, which the generation queue never
 * reads: it queues only what submitJobs is given, and nothing here calls it.
 */

export const PROPOSAL_LIMITS = { statements: 6, jobs: 3, missingSources: 3, text: 300 } as const;

export type ProposedStatement = { s: string; p: string; o: string };
export type ProposedJob = { kind: GenerationStage; prompt: string };
export type MissingSource = { about: string; question: string };
export type ParsedOption = {
  /** 'a', 'b', ... in the order the model gave them. */
  key: string;
  label: string;
  rationale: string;
  statements: ProposedStatement[];
  jobs: ProposedJob[];
  missingSources: MissingSource[];
  /** Ids of statements from the chosen situation. */
  citations: string[];
};
export type ParsedProposal = { options: ParsedOption[]; recommendedKey: string };

export type ParseResult = { ok: true; proposal: ParsedProposal; warnings: ProposalIssue[] } | { ok: false; reason: string };

export const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const KEYS = 'abcd';

/** The shape the model is asked for, written into the prompt. */
export const PROPOSAL_REPLY_SHAPE = `{
  "recommended": "a",
  "options": [
    {
      "label": "short plain-language title",
      "rationale": "one or two sentences: why this option, and its main tradeoff",
      "statements": [ { "s": "an entity name", "p": "a relationship name", "o": "a value or entity name" } ],
      "jobs": [ { "kind": "image | video | splat", "params": { "prompt": "what to generate" } } ],
      "missingSources": [ { "about": "an entity name", "question": "what is missing, e.g. Upload an image of the logo" } ],
      "citations": [ "ids copied from the numbered situation statements, e.g. st-1" ]
    }
  ]
}`;

/** Marker the prompt carries so the mock provider knows a structured proposal is wanted. */
export const STRUCTURED_PROPOSAL_MARKER = 'RECKONING-STRUCTURED-PROPOSAL';

export const PROPOSAL_SYSTEM_PROMPT = `${STRUCTURED_PROPOSAL_MARKER}
You are Reckons.AI's decision advisor. Reply with ONE JSON object and nothing else: no prose, no markdown fence.
Offer 2 to 4 options for reaching the TARGET from the SITUATION, using only what the situation statements say.
Shape:
${PROPOSAL_REPLY_SHAPE}
Rules:
- "recommended" is the letter of one option: a, b, c or d, in the order listed.
- Each option proposes at least one of: statements, jobs, missingSources. Up to ${PROPOSAL_LIMITS.statements} statements, ${PROPOSAL_LIMITS.jobs} jobs, ${PROPOSAL_LIMITS.missingSources} missing sources.
- "statements" are NEW claims the option would add. They are proposals; a person decides.
- "jobs" are work the option needs. Kinds: ${GENERATION_STAGES.join(', ')}. Each needs a prompt.
- "missingSources" name what you would need but do not have (an image, a document, a figure) as a question.
- "citations" are ids written in {{ }} before each situation statement. Cite only those.
- Every text is under ${PROPOSAL_LIMITS.text} characters. Plain language, no raw IRIs.`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function text(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Refusal(`${what} is missing or not text.`);
  const t = v.trim();
  if (!t) throw new Refusal(`${what} is empty.`);
  if (t.length > PROPOSAL_LIMITS.text) throw new Refusal(`${what} is longer than ${PROPOSAL_LIMITS.text} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) throw new Refusal(`${what} holds control characters.`);
  return t;
}
function list(v: unknown, what: string, max: number): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Refusal(`${what} is not a list.`);
  if (v.length > max) throw new Refusal(`${what} has ${v.length} entries; at most ${max}.`);
  return v;
}
class Refusal extends Error {}

/** The first JSON object in a reply, with a Markdown fence and surrounding words tolerated. */
function jsonOf(raw: string): unknown {
  const body = raw.replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Refusal('The reply holds no JSON object.');
  try { return JSON.parse(body.slice(start, end + 1)); } catch { throw new Refusal('The reply is not valid JSON.'); }
}

/**
 * Read the model's reply. Refuses, with a reason a person can read, anything that is not a well-formed proposal:
 * wrong option count, missing recommendation, an option that proposes nothing, a job kind that does not exist,
 * a citation that is not one of the chosen situation statements. It never repairs: a partly good reply is
 * refused whole, so nothing half-formed reaches the space.
 */
export function parseProposalReply(raw: string, situationIds: readonly string[]): ParseResult {
  try {
    const root = jsonOf(raw);
    if (!isObj(root)) throw new Refusal('The reply is not a JSON object.');
    const rawOptions = root.options;
    if (!Array.isArray(rawOptions)) throw new Refusal('The reply has no list of options.');
    const known = new Set(situationIds);
    const options: ParsedOption[] = rawOptions.slice(0, 8).map((o, i): ParsedOption => {
      const where = `Option ${i + 1}`;
      if (!isObj(o)) throw new Refusal(`${where} is not an object.`);
      const statements = list(o.statements, `${where} statements`, PROPOSAL_LIMITS.statements).map((x, j) => {
        if (!isObj(x)) throw new Refusal(`${where} statement ${j + 1} is not an object.`);
        const parsed = { s: text(x.s, `${where} statement ${j + 1} subject`), p: text(x.p, `${where} statement ${j + 1} relationship`), o: text(x.o, `${where} statement ${j + 1} value`) };
        if (!slugOf(parsed.s) || !slugOf(parsed.p)) throw new Refusal(`${where} statement ${j + 1} has a subject or relationship with no letters or digits.`);
        return parsed;
      });
      const jobs = list(o.jobs, `${where} jobs`, PROPOSAL_LIMITS.jobs).map((x, j): ProposedJob => {
        if (!isObj(x)) throw new Refusal(`${where} job ${j + 1} is not an object.`);
        if (!(GENERATION_STAGES as readonly unknown[]).includes(x.kind)) {
          throw new Refusal(`${where} job ${j + 1} has kind "${String(x.kind)}"; the kinds are ${GENERATION_STAGES.join(', ')}.`);
        }
        const params = isObj(x.params) ? x.params : {};
        return { kind: x.kind as GenerationStage, prompt: text(params.prompt, `${where} job ${j + 1} prompt`) };
      });
      const missingSources = list(o.missingSources, `${where} missing sources`, PROPOSAL_LIMITS.missingSources).map((x, j): MissingSource => {
        if (!isObj(x)) throw new Refusal(`${where} missing source ${j + 1} is not an object.`);
        const about = text(x.about, `${where} missing source ${j + 1} subject`);
        if (!slugOf(about)) throw new Refusal(`${where} missing source ${j + 1} has a subject with no letters or digits.`);
        return { about, question: text(x.question, `${where} missing source ${j + 1} question`) };
      });
      if (statements.length + jobs.length + missingSources.length === 0) throw new Refusal(`${where} proposes nothing: no statements, jobs or missing sources.`);
      const citations = list(o.citations, `${where} citations`, 20).map((c, j) => {
        if (typeof c !== 'string' || !known.has(c)) throw new Refusal(`${where} citation ${j + 1} is not one of the chosen situation statements.`);
        return c;
      });
      return {
        key: KEYS[i] ?? String(i), label: text(o.label, `${where} label`), rationale: text(o.rationale, `${where} rationale`),
        statements, jobs, missingSources, citations: [...new Set(citations)],
      };
    });
    const recommendedKey = typeof root.recommended === 'string' ? root.recommended.trim().toLowerCase() : '';
    const shaped: Proposal = {
      id: 'check', status: ACTION_STATUS.potential, targetShape: { id: 'check', requirements: [{ s: 'x', p: 'y' }] },
      options: options.map((o) => ({ id: o.key, label: o.label, citations: o.citations })),
      recommendedId: recommendedKey || null,
    };
    const issues = validateProposal(shaped);
    const fatal = issues.filter((i) => i.code !== 'option-without-citation');
    if (fatal.length > 0) throw new Refusal(fatal.map((i) => i.message).join(' '));
    return { ok: true, proposal: { options, recommendedKey }, warnings: issues.filter((i) => i.code === 'option-without-citation') };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message };
    throw e;
  }
}

// ── Building the rows ───────────────────────────────────────────────────────────

const P = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
export const PROPOSAL_TYPE = 'urn:kbase:type/Proposal';
export const PROPOSAL_OPTION_TYPE = 'urn:kbase:type/ProposalOption';
export const PROPOSAL_PREDICATES = {
  proposal: `${P}proposal`,
  hasOption: `${P}has-option`,
  recommended: `${P}recommended-option`,
  rationale: `${P}rationale`,
  cites: `${P}cites`,
  needsSource: `${P}needs-source`,
  proposesJob: `${P}proposes-job`,
} as const;
/** The state a proposed job is recorded in; JOB_STATES (the queue's states) does not include it, so nothing runs it. */
export const PROPOSED_JOB_STATE = 'proposed';

export const proposalEntity = (reckoningId: string) => `urn:kbase:concept/reckoning-${reckoningId}-proposal`;
export const optionId = (reckoningId: string, key: string) => `reckoning-${reckoningId}-option-${key}`;
export const optionEntity = (reckoningId: string, key: string) => `urn:kbase:concept/${optionId(reckoningId, key)}`;
export const proposedJobEntity = (reckoningId: string, key: string, n: number) => `urn:kbase:concept/${optionId(reckoningId, key)}-job-${n + 1}`;
/** Row ids of the proposal start with this, so the Reckoning's own save can leave them alone. */
export const proposalRowPrefix = (reckoningId: string) => `${reckoningSourceId(reckoningId)}-opt-`;

export type BuiltProposal = {
  proposal: Proposal;
  rows: Statement[];
  /** Groups the safety filter refused, with the reasons; their rows are not in `rows`. */
  blocked: { what: string; reasons: string[] }[];
  warnings: ProposalIssue[];
};

export function buildProposalRows(
  parsed: ParsedProposal,
  ctx: { reckoning: Pick<ReadReckoning, 'id' | 'target'>; at: number; all: readonly Statement[]; warnings?: ProposalIssue[] },
): BuiltProposal {
  const { reckoning, at, all } = ctx;
  const sourceId = reckoningSourceId(reckoning.id);
  const prefix = proposalRowPrefix(reckoning.id);
  const byLabel = new Map<string, string>();
  for (const st of all) {
    if (st.p.value === LABEL && st.s.kind === 'iri' && st.status !== 'rejected' && !byLabel.has(st.o.value.toLowerCase())) byLabel.set(st.o.value.toLowerCase(), st.s.value);
  }
  const entityFor = (name: string) => (/^(urn:|https?:)/.test(name) ? name : byLabel.get(name.toLowerCase()) ?? `urn:kbase:concept/${slugOf(name)}`);

  type Group = { what: string; rows: Statement[] };
  const groups: Group[] = [];
  let seq = 0;
  const row = (optKey: string | null, key: string, s: string, p: string, o: { iri?: string; literal?: string }, extra: Partial<Statement> = {}): Statement => ({
    id: `${prefix}${optKey ?? 'p'}-${key}-${seq++}`, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p },
    o: o.iri !== undefined ? { kind: 'iri', value: o.iri } : { kind: 'literal', value: o.literal ?? '' },
    g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` }, sourceId, status: 'pending', confidence: 0.5,
    createdAt: at, updatedAt: at, ...(optKey ? { proposalOption: optionId(reckoning.id, optKey) } : {}), ...extra,
  });

  const proposalIri = proposalEntity(reckoning.id);
  const options = parsed.options;
  const head: Statement[] = [
    row(null, 'type', proposalIri, RDF_TYPE, { iri: PROPOSAL_TYPE }),
    row(null, 'label', proposalIri, LABEL, { literal: 'Proposal' }),
    row(null, 'for', reckoningEntity(reckoning.id), PROPOSAL_PREDICATES.proposal, { iri: proposalIri }),
  ];
  for (const o of options) {
    head.push(row(null, `has-${o.key}`, proposalIri, PROPOSAL_PREDICATES.hasOption, { iri: optionEntity(reckoning.id, o.key) }));
  }
  head.push(row(null, 'recommended', proposalIri, PROPOSAL_PREDICATES.recommended, { iri: optionEntity(reckoning.id, parsed.recommendedKey) }));
  groups.push({ what: 'the proposal record', rows: head });

  for (const o of options) {
    const k = o.key;
    const oe = optionEntity(reckoning.id, k);
    const meta: Statement[] = [
      row(k, 'type', oe, RDF_TYPE, { iri: PROPOSAL_OPTION_TYPE }),
      row(k, 'label', oe, LABEL, { literal: o.label }),
      row(k, 'rationale', oe, PROPOSAL_PREDICATES.rationale, { literal: o.rationale }),
      ...o.citations.map((c, i) => row(k, `cites-${i}`, oe, PROPOSAL_PREDICATES.cites, { iri: reckoningStatementIri(c) })),
    ];
    groups.push({ what: `option ${k.toUpperCase()}`, rows: meta });
    o.statements.forEach((st, i) => {
      const obj = byLabel.get(st.o.toLowerCase());
      groups.push({
        what: `a statement of option ${k.toUpperCase()}`,
        rows: [row(k, `st-${i}`, entityFor(st.s), `${P}${slugOf(st.p)}`, obj ? { iri: obj } : { literal: st.o }, { gloss: `${st.s} ${st.p} ${st.o}` })],
      });
    });
    o.jobs.forEach((j, i) => {
      const je = proposedJobEntity(reckoning.id, k, i);
      groups.push({
        what: `a job of option ${k.toUpperCase()}`,
        rows: [
          row(k, `job-${i}-type`, je, RDF_TYPE, { iri: JOB_TYPE }),
          row(k, `job-${i}-label`, je, LABEL, { literal: `${STAGE_LABELS[j.kind]} job: ${j.prompt.slice(0, 60)}` }),
          row(k, `job-${i}-prompt`, je, COMMENT, { literal: j.prompt }),
          row(k, `job-${i}-stage`, je, JOB_PREDICATES.stage, { literal: j.kind }),
          row(k, `job-${i}-state`, je, JOB_PREDICATES.state, { literal: PROPOSED_JOB_STATE }),
          row(k, `job-${i}-by`, je, JOB_PREDICATES.requestedBy, { literal: `Reckoning proposal, option ${k.toUpperCase()}: waits for your acceptance` }),
          row(k, `job-${i}-link`, oe, PROPOSAL_PREDICATES.proposesJob, { iri: je }),
        ],
      });
    });
    o.missingSources.forEach((m, i) => {
      groups.push({
        what: `a missing source of option ${k.toUpperCase()}`,
        rows: [row(k, `missing-${i}`, entityFor(m.about), PROPOSAL_PREDICATES.needsSource, { literal: '?' }, { needsObject: true, question: m.question, gloss: m.question })],
      });
    });
  }

  // Safety: a group with one refused row is dropped whole, so a job never keeps a label without its prompt.
  const kept: Statement[] = [];
  const blocked: BuiltProposal['blocked'] = [];
  for (const g of groups) {
    const { blocked: bad, blockReasons } = filterBlockedStatements(g.rows);
    if (bad.length > 0) blocked.push({ what: g.what, reasons: [...new Set(bad.flatMap((b) => blockReasons[b.id] ?? ['blocked']))] });
    else kept.push(...g.rows);
  }

  const shaped: Proposal = {
    id: `reckoning-${reckoning.id}-proposal`, proposedBy: 'reckoning-agent', status: ACTION_STATUS.potential,
    targetShape: targetShapeFor(reckoning, all),
    options: options.map((o) => ({ id: optionId(reckoning.id, o.key), label: o.label, citations: o.citations })),
    recommendedId: optionId(reckoning.id, parsed.recommendedKey),
  };
  return { proposal: shaped, rows: kept, blocked, warnings: ctx.warnings ?? [] };
}

/** A deterministic, synthetic reply for the mock provider: two options, each with one of every kind of row. */
export function mockProposalReply(citations: readonly string[]): string {
  const cite = citations.slice(0, 1);
  return JSON.stringify({
    recommended: 'a',
    options: [
      {
        label: 'Start from a new logo', rationale: 'Quickest to try; the cost is that it ignores the older marks.',
        statements: [{ s: 'Sample Company', p: 'brand direction', o: 'Modern wordmark' }],
        jobs: [{ kind: 'image', params: { prompt: 'A simple modern wordmark logo for a sample company' } }],
        missingSources: [{ about: 'Sample Company', question: 'Upload an image of the current logo' }],
        citations: cite,
      },
      {
        label: 'Refresh the existing logo', rationale: 'Keeps recognition; the cost is a smaller change.',
        statements: [{ s: 'Sample Company', p: 'brand direction', o: 'Refreshed existing mark' }],
        jobs: [{ kind: 'image', params: { prompt: 'A refreshed version of a simple existing logo' } }],
        missingSources: [{ about: 'Sample Company', question: 'Add the brand colors that must stay' }],
        citations: cite,
      },
    ],
  });
}
