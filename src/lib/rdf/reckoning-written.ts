import type { Statement } from './types';
import { RECKONING_TYPE, statementIdOfIri } from './reckoning-entity';
import { readStoredProposal, proposedStatements } from './reckoning-accept';
import { PROPOSAL_PREDICATES, optionEntity } from './reckoning-proposal';
import { JOB_PREDICATES } from '../generation/job-node';

/**
 * F312: a proposal that was written earlier (by a generator, or by an earlier session) read back for display.
 *
 * The Reckoning page used to show a proposal only in the session that generated it; opening a knowledge base that already
 * held decisions showed nothing. Two pure readers, no storage:
 *   storedDecisions   the Reckonings of a knowledge base that hold a proposal, with where each stands.
 *   writtenOptions    one proposal's options as the card shows them, with the picture of each option's candidate.
 */

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

export type StoredDecision = { id: string; label: string; status: string };
export type WrittenOptionView = {
  id: string; label: string; rationale: string; recommended: boolean;
  statements: number; jobs: number; missing: number; cites: string[];
  /** The picture (an icon override value) of the first entity in this option's proposed statement that has one; '' when none. */
  image: string;
};

const liveRow = (st: Statement) => st.status !== 'rejected' && st.status !== 'superseded';

/** Every Reckoning of the knowledge base that holds a stored proposal, in label order. */
export function storedDecisions(all: readonly Statement[]): StoredDecision[] {
  const out: StoredDecision[] = [];
  for (const st of all) {
    if (st.p.value !== RDF_TYPE || st.o.value !== RECKONING_TYPE || st.s.kind !== 'iri' || !liveRow(st)) continue;
    const id = st.s.value.replace(/^urn:kbase:concept\/reckoning-/, '');
    const stored = readStoredProposal(all, id);
    if (!stored) continue;
    const label = all.find((r) => r.s.value === st.s.value && r.p.value === LABEL)?.o.value ?? id;
    out.push({ id, label: label.replace(/^Reckoning: /, ''), status: stored.proposal.status });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** The options of one stored proposal, as the Reckoning page card lists them. Empty when there is none. */
export function writtenOptions(all: readonly Statement[], reckoningId: string, icons: ReadonlyMap<string, string>): WrittenOptionView[] {
  const stored = readStoredProposal(all, reckoningId);
  if (!stored) return [];
  return stored.proposal.options.map((o) => {
    const key = o.id.slice(o.id.lastIndexOf('-') + 1);
    const entity = optionEntity(reckoningId, key);
    const rows = all.filter((st) => st.proposalOption === o.id);
    const rationale = rows.find((st) => st.s.value === entity && st.p.value === PROPOSAL_PREDICATES.rationale)?.o.value ?? '';
    const proposed = proposedStatements(rows);
    const pictured = proposed.flatMap((st) => (st.o.kind === 'iri' ? [st.s.value, st.o.value] : [st.s.value])).find((iri) => icons.has(iri));
    return {
      id: o.id, label: o.label, rationale,
      recommended: o.id === stored.proposal.recommendedId,
      statements: proposed.length,
      jobs: rows.filter((st) => st.p.value === JOB_PREDICATES.state).length,
      missing: rows.filter((st) => st.needsObject).length,
      cites: rows.filter((st) => st.p.value === PROPOSAL_PREDICATES.cites).map((st) => statementIdOfIri(st.o.value)).filter((v): v is string => v !== null),
      image: pictured ? icons.get(pictured) ?? '' : '',
    };
  });
}

