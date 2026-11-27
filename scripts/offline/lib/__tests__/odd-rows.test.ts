import { describe, expect, it } from 'vitest';
import { oddKinds, splitOdd } from '../odd-rows';

// A synthetic row with all possible fields for testing
type TestRow = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  needsObject?: boolean;
  confidence?: number;
  heldValue?: string;
  rivalSource?: string;
};

describe('oddKinds', () => {
  it('returns empty array when no odd fields are set', () => {
    const row: TestRow = {
      id: 'row1',
      subject: 'subject1',
      predicate: 'predicate1',
      object: 'object1'
    };
    expect(oddKinds(row)).toEqual([]);
  });

  it('identifies needs-answer when needsObject is true', () => {
    const row: TestRow = {
      id: 'row1',
      subject: 'subject1',
      predicate: 'predicate1',
      object: 'object1',
      needsObject: true
    };
    expect(oddKinds(row)).toEqual(['needs-answer']);
  });

  it('identifies disagrees when heldValue differs from object', () => {
    const row: TestRow = {
      id: 'row1',
      subject: 'subject1',
      predicate: 'predicate1',
      object: 'object1',
      heldValue: 'different-object'
    };
    expect(oddKinds(row)).toEqual(['disagrees']);
  });

  it('identifies low-confidence when confidence is under 0.5', () => {
    const row: TestRow = {
      id: 'row1',
      subject: 'subject1',
      predicate: 'predicate1',
      object: 'object1',
      confidence: 0.3
    };
    expect(oddKinds(row)).toEqual(['low-confidence']);
  });

  it('identifies rival-value when rivalSource is set', () => {
    const row: TestRow = {
      id: 'row1',
      subject: 'subject1',
      predicate: 'predicate1',
      object: 'object1',
      rivalSource: 'source1'
    };
    expect(oddKinds(row)).toEqual(['rival-value']);
  });

  it('identifies multiple odd kinds when multiple fields are set', () => {
    const row: TestRow = {
      id: 'row1',
      subject: 'subject1',
      predicate: 'predicate1',
      object: 'object1',
      needsObject: true,
      confidence: 0.3,
      heldValue: 'different-object'
    };
    expect(oddKinds(row)).toEqual(['needs-answer', 'disagrees', 'low-confidence']);
  });

  it('a held value equal to the object does not disagree', () => {
    const row: TestRow = { id: 'r', subject: 's', predicate: 'p', object: 'same', heldValue: 'same' };
    expect(oddKinds(row)).toEqual([]);
  });

  it('confidence exactly 0.5 is not low-confidence', () => {
    const row: TestRow = {
      id: 'row1',
      subject: 'subject1',
      predicate: 'predicate1',
      object: 'object1',
      confidence: 0.5
    };
    expect(oddKinds(row)).toEqual([]);
  });
});

describe('splitOdd', () => {
  it('splits rows correctly with no odd rows', () => {
    const rows: TestRow[] = [
      {
        id: 'row1',
        subject: 'subject1',
        predicate: 'predicate1',
        object: 'object1'
      },
      {
        id: 'row2',
        subject: 'subject2',
        predicate: 'predicate2',
        object: 'object2'
      }
    ];

    const result = splitOdd(rows);
    expect(result.odd).toHaveLength(0);
    expect(result.rest).toHaveLength(2);
    expect(result.rest).toEqual(rows);
  });

  it('splits rows correctly with odd rows', () => {
    const rows: TestRow[] = [
      {
        id: 'row1',
        subject: 'subject1',
        predicate: 'predicate1',
        object: 'object1'
      },
      {
        id: 'row2',
        subject: 'subject2',
        predicate: 'predicate2',
        object: 'object2',
        needsObject: true
      },
      {
        id: 'row3',
        subject: 'subject3',
        predicate: 'predicate3',
        object: 'object3',
        confidence: 0.3
      }
    ];

    const result = splitOdd(rows);
    expect(result.odd).toHaveLength(2);
    expect(result.rest).toHaveLength(1);

    // Check odd rows and their kinds
    expect(result.odd[0].row.id).toBe('row2');
    expect(result.odd[0].kinds).toEqual(['needs-answer']);

    expect(result.odd[1].row.id).toBe('row3');
    expect(result.odd[1].kinds).toEqual(['low-confidence']);

    // Check rest row
    expect(result.rest[0].id).toBe('row1');
  });

  it('preserves input order in both odd and rest arrays', () => {
    const rows: TestRow[] = [
      {
        id: 'row1',
        subject: 'subject1',
        predicate: 'predicate1',
        object: 'object1',
        confidence: 0.3
      },
      {
        id: 'row2',
        subject: 'subject2',
        predicate: 'predicate2',
        object: 'object2',
        needsObject: true
      },
      {
        id: 'row3',
        subject: 'subject3',
        predicate: 'predicate3',
        object: 'object3'
      }
    ];

    const result = splitOdd(rows);

    // Odd rows should preserve input order
    expect(result.odd[0].row.id).toBe('row1');
    expect(result.odd[1].row.id).toBe('row2');

    // Rest rows should preserve input order
    expect(result.rest[0].id).toBe('row3');
  });

  it('total length of odd + rest equals input length', () => {
    const rows: TestRow[] = [
      {
        id: 'row1',
        subject: 'subject1',
        predicate: 'predicate1',
        object: 'object1'
      },
      {
        id: 'row2',
        subject: 'subject2',
        predicate: 'predicate2',
        object: 'object2',
        needsObject: true
      },
      {
        id: 'row3',
        subject: 'subject3',
        predicate: 'predicate3',
        object: 'object3',
        confidence: 0.3
      },
      {
        id: 'row4',
        subject: 'subject4',
        predicate: 'predicate4',
        object: 'object4',
        heldValue: 'different-object'
      }
    ];

    const result = splitOdd(rows);
    expect(result.odd.length + result.rest.length).toBe(rows.length);
  });
});