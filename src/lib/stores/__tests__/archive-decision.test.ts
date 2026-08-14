import { afterEach, describe, expect, it } from 'vitest';
import type { ArchivedReference } from '../../rdf/archive';
import {
  ArchiveDecisionUnavailableError,
  mountArchiveDecisionDialog,
  pendingArchiveDecision,
  requestArchiveDecision,
  resolveArchiveDecision,
} from '../archive-decision.svelte';

const references: ArchivedReference[] = [{
  entity: 'urn:acme',
  label: 'Acme Corp',
  incoming: [],
}];

const teardowns: Array<() => void> = [];
const mount = () => {
  const teardown = mountArchiveDecisionDialog();
  teardowns.push(teardown);
  return teardown;
};

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
});

describe('archive restore decision queue (F97.3)', () => {
  it('fails closed immediately when no decision UI is mounted', () => {
    expect(() => requestArchiveDecision({ sourceTitle: 'Import', references }))
      .toThrow(ArchiveDecisionUnavailableError);
    expect(pendingArchiveDecision()).toBeNull();
  });

  it('settles concurrent requests in FIFO order without dropping either resolver', async () => {
    mount();
    const first = requestArchiveDecision({ sourceTitle: 'First', references });
    const second = requestArchiveDecision({ sourceTitle: 'Second', references });

    expect(pendingArchiveDecision()?.sourceTitle).toBe('First');
    resolveArchiveDecision('restore');
    await expect(first).resolves.toBe('restore');

    expect(pendingArchiveDecision()?.sourceTitle).toBe('Second');
    resolveArchiveDecision('keep-new');
    await expect(second).resolves.toBe('keep-new');
    expect(pendingArchiveDecision()).toBeNull();
  });

  it('cancels every queued request when the last dialog unmounts', async () => {
    const teardown = mount();
    const first = requestArchiveDecision({ sourceTitle: 'First', references });
    const second = requestArchiveDecision({ sourceTitle: 'Second', references });

    teardown();

    await expect(first).resolves.toBe('cancel');
    await expect(second).resolves.toBe('cancel');
    expect(pendingArchiveDecision()).toBeNull();
  });

  it('keeps the queue live while another mounted dialog remains', async () => {
    const firstTeardown = mount();
    mount();
    const decision = requestArchiveDecision({ sourceTitle: 'Import', references });

    firstTeardown();
    expect(pendingArchiveDecision()?.sourceTitle).toBe('Import');
    resolveArchiveDecision('cancel');
    await expect(decision).resolves.toBe('cancel');
  });
});
