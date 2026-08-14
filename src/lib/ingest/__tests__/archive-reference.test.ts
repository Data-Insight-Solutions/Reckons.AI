import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedReference } from '../../rdf/archive';
import { ArchivedReferenceRemapError } from '../../rdf/archive';
import type { Statement, Term } from '../../rdf/types';
import {
  resolveArchiveReferencesForIngest,
  type ArchiveReferenceDependencies,
} from '../archive-reference';

const iri = (value: string) => ({ kind: 'iri' as const, value });
const lit = (value: string): Term => ({ kind: 'literal', value });
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const statement = (
  id: string,
  subject: string,
  predicate: string,
  object: Term,
): Statement => ({
  id,
  s: iri(subject),
  p: iri(predicate),
  o: object,
  g: iri('urn:graph'),
  sourceId: 'source',
  confidence: 1,
  status: 'pending',
  createdAt: 1,
  updatedAt: 1,
});

let currentContext: ReturnType<typeof vi.fn>;
let findReferences: ReturnType<typeof vi.fn>;
let decide: ReturnType<typeof vi.fn>;
let restore: ReturnType<typeof vi.fn>;
let reloadWorkingStore: ReturnType<typeof vi.fn>;
let dependencies: ArchiveReferenceDependencies;

beforeEach(() => {
  currentContext = vi.fn(() => ({
    workingKbId: 'working-db',
    parentStableId: 'stable-parent',
  }));
  findReferences = vi.fn(async () => [] as ArchivedReference[]);
  decide = vi.fn(async () => 'keep-new' as const);
  restore = vi.fn(async () => ({}));
  reloadWorkingStore = vi.fn(async () => undefined);
  dependencies = {
    currentContext,
    findReferences,
    decide,
    restore,
    reloadWorkingStore,
  } as ArchiveReferenceDependencies;
});

describe('resolveArchiveReferencesForIngest (F97.3)', () => {
  it('does not query storage before the working graph has a stable identity', async () => {
    currentContext.mockReturnValue(null);
    const incoming = [statement('one', 'urn:new', 'urn:p', lit('value'))];

    const result = await resolveArchiveReferencesForIngest({
      sourceTitle: 'Import',
      statements: incoming,
    }, dependencies);

    expect(result.decision).toBe('none');
    expect(result.statements).toBe(incoming);
    expect(findReferences).not.toHaveBeenCalled();
  });

  it('does not ask for consent when the archive has no matching entity', async () => {
    const incoming = [statement('one', 'urn:new', 'urn:p', lit('value'))];
    const phases: string[] = [];

    const result = await resolveArchiveReferencesForIngest({
      sourceTitle: 'Import',
      statements: incoming,
      onPhase: (phase) => phases.push(phase),
    }, dependencies);

    expect(findReferences).toHaveBeenCalledWith('stable-parent', incoming);
    expect(decide).not.toHaveBeenCalled();
    expect(result.decision).toBe('none');
    expect(phases).toEqual(['checking']);
  });

  it.each(['keep-new', 'cancel'] as const)(
    '%s leaves both graphs untouched',
    async (choice) => {
      const incoming = [statement('one', 'urn:acme', 'urn:p', lit('value'))];
      const references: ArchivedReference[] = [{
        entity: 'urn:acme',
        label: 'Acme',
        incoming,
      }];
      findReferences.mockResolvedValue(references);
      decide.mockResolvedValue(choice);

      const result = await resolveArchiveReferencesForIngest({
        sourceTitle: 'Import',
        statements: incoming,
      }, dependencies);

      expect(result.decision).toBe(choice);
      expect(result.statements).toBe(incoming);
      expect(restore).not.toHaveBeenCalled();
      expect(reloadWorkingStore).not.toHaveBeenCalled();
    },
  );

  it('restores every matched entity, refreshes once, and remaps the minted label IRI', async () => {
    const label = statement('label', 'urn:new-acme', LABEL, lit('Acme Corp'));
    const fact = statement('fact', 'urn:new-acme', 'urn:p/employees', lit('50'));
    const exact = statement('exact', 'urn:zeta', 'urn:p/value', lit('active'));
    findReferences.mockResolvedValue([
      { entity: 'urn:zeta', label: 'Zeta', incoming: [exact] },
      { entity: 'urn:acme', label: 'Acme Corp', incoming: [label] },
    ]);
    decide.mockResolvedValue('restore');
    const phases: string[] = [];

    const result = await resolveArchiveReferencesForIngest({
      sourceTitle: 'Quarterly import',
      statements: [label, fact, exact],
      onPhase: (phase) => phases.push(phase),
    }, dependencies);

    expect(restore.mock.calls.map(([input]) => input.entity)).toEqual(['urn:acme', 'urn:zeta']);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({
      workingKbId: 'working-db',
      parentStableId: 'stable-parent',
      actor: 'human',
    }));
    expect(reloadWorkingStore).toHaveBeenCalledTimes(1);
    expect(result.restoredEntities).toEqual(['urn:acme', 'urn:zeta']);
    expect(result.statements[0].s).toEqual(iri('urn:acme'));
    expect(result.statements[1].s).toEqual(iri('urn:acme'));
    expect(phases).toEqual(['checking', 'awaiting-decision', 'restoring']);
  });

  it('reloads reactive state even when the first restore attempt rejects', async () => {
    const incoming = [statement('one', 'urn:acme', 'urn:p', lit('value'))];
    findReferences.mockResolvedValue([{
      entity: 'urn:acme',
      label: 'Acme',
      incoming,
    }]);
    decide.mockResolvedValue('restore');
    restore.mockRejectedValue(new Error('final journal commit failed'));

    await expect(resolveArchiveReferencesForIngest({
      sourceTitle: 'Import',
      statements: incoming,
    }, dependencies)).rejects.toThrow('final journal commit failed');
    expect(reloadWorkingStore).toHaveBeenCalledTimes(1);
  });

  it('validates conflicting label remaps before attempting any restore', async () => {
    const first = statement('first', 'urn:new', LABEL, lit('First'));
    const second = statement('second', 'urn:new', LABEL, lit('Second'));
    findReferences.mockResolvedValue([
      { entity: 'urn:first', label: 'First', incoming: [first] },
      { entity: 'urn:second', label: 'Second', incoming: [second] },
    ]);
    decide.mockResolvedValue('restore');

    await expect(resolveArchiveReferencesForIngest({
      sourceTitle: 'Import',
      statements: [first, second],
    }, dependencies)).rejects.toThrow(ArchivedReferenceRemapError);
    expect(restore).not.toHaveBeenCalled();
    expect(reloadWorkingStore).not.toHaveBeenCalled();
  });

  it('serializes concurrent check-to-restore boundaries instead of only queueing their dialogs', async () => {
    const incoming = [statement('one', 'urn:acme', 'urn:p', lit('value'))];
    findReferences.mockResolvedValue([{
      entity: 'urn:acme',
      label: 'Acme',
      incoming,
    }]);
    let settleFirst!: (decision: 'keep-new') => void;
    decide
      .mockImplementationOnce(() => new Promise((resolve) => { settleFirst = resolve; }))
      .mockResolvedValueOnce('keep-new');

    const first = resolveArchiveReferencesForIngest({
      sourceTitle: 'First',
      statements: incoming,
    }, dependencies);
    const second = resolveArchiveReferencesForIngest({
      sourceTitle: 'Second',
      statements: incoming,
    }, dependencies);

    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(findReferences).toHaveBeenCalledTimes(1);

    settleFirst('keep-new');
    await expect(first).resolves.toMatchObject({ decision: 'keep-new' });
    await expect(second).resolves.toMatchObject({ decision: 'keep-new' });
    expect(findReferences).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledTimes(2);
  });
});
