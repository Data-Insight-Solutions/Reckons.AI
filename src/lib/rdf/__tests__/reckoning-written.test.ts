import { describe, expect, it } from 'vitest';
import type { Statement } from '../types';
import { storedDecisions, writtenOptions } from '../reckoning-written';
import { reckoningStatements } from '../reckoning-entity';

// The proposal round trip (stored rows -> options with pictures) is exercised with real generated rows in
// the option-review generator test (scripts/__tests__); this file holds the edges that need no proposal.
describe('reading a stored proposal for display', () => {
  const none: Statement[] = [];
  it('finds nothing in an empty knowledge base', () => {
    expect(storedDecisions(none)).toEqual([]);
    expect(writtenOptions(none, 'missing', new Map())).toEqual([]);
  });
  it('does not list a Reckoning that has no proposal yet', () => {
    const rows = reckoningStatements('abc', [], 'A situation worth a reckoning', 1);
    expect(storedDecisions(rows)).toEqual([]);
    expect(writtenOptions(rows, 'abc', new Map())).toEqual([]);
  });
});
