import { describe, it, expect } from 'vitest';
import { scoreIngest, scoreChat, formatReport, buildReport } from './scoring';
import type { ExtractedTriple } from '../../src/lib/integrations/llm/extractor';
import type { ChatTestCase } from './scoring';

// ── scoreIngest ──────────────────────────────────────────────────────────────

describe('scoreIngest', () => {
  const golden: ExtractedTriple[] = [
    { subject: 'common-octopus', predicate: 'is-a', object: 'marine-mollusk' },
    { subject: 'common-octopus', predicate: 'has-heart-count', object: '3', objectIsLiteral: true },
    { subject: 'common-octopus', predicate: 'has-predator', object: 'shark' },
  ];

  it('perfect match scores 1.0 across the board', () => {
    const output = [...golden];
    const score = scoreIngest(output, golden);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.f1).toBe(1);
  });

  it('empty output scores 0 recall', () => {
    const score = scoreIngest([], golden);
    expect(score.recall).toBe(0);
    expect(score.f1).toBe(0);
    expect(score.missedGolden).toHaveLength(3);
  });

  it('extra triples reduce precision but not recall', () => {
    const output = [
      ...golden,
      { subject: 'octopus', predicate: 'is-magical', object: 'yes' },
    ];
    const score = scoreIngest(output, golden);
    expect(score.recall).toBe(1);
    expect(score.precision).toBeLessThan(1);
    expect(score.unmatchedOutput).toHaveLength(1);
  });

  it('fuzzy matches work with similar slugs', () => {
    const output: ExtractedTriple[] = [
      { subject: 'octopus', predicate: 'is-a', object: 'mollusk' },
    ];
    const score = scoreIngest(output, golden);
    // Should fuzzy-match the first golden triple
    expect(score.matchedCount).toBeGreaterThanOrEqual(1);
  });

  it('reports missed golden triples', () => {
    const output: ExtractedTriple[] = [
      { subject: 'common-octopus', predicate: 'is-a', object: 'marine-mollusk' },
    ];
    const score = scoreIngest(output, golden);
    expect(score.missedGolden.length).toBe(2);
  });

  // ── Fact layer vs vocabulary layer ─────────────────────────────────────────
  //
  // Added 2026-08-15. Strict F1 conflates "the model could not find the fact" with "the model
  // found the fact and called the relation something else". Those need different fixes — a better
  // model versus grounding the prompt in the graph's existing predicates — so the score must tell
  // them apart.

  describe('fact recall vs vocabulary agreement', () => {
    it('THE REAL CASE: a right fact under a different predicate is not a miss', () => {
      // Measured 2026-08-15: qwen3.6 emitted has-number-of-hearts 3 where the golden set says
      // has-heart-count 3. Strict F1 scores that as a missed golden AND an unmatched output —
      // charged twice for being correct.
      const output: ExtractedTriple[] = [
        { subject: 'common-octopus', predicate: 'has-number-of-hearts', object: '3', objectIsLiteral: true },
      ];
      const score = scoreIngest(output, golden);

      // The strict pass still penalises it — that behaviour is unchanged and deliberate.
      expect(score.recall).toBeCloseTo(0, 5);
      expect(score.missedGolden.length).toBe(3);

      // The decomposition tells the truth: the fact WAS found, the word was ours to fix.
      expect(score.factRecall).toBeCloseTo(1 / 3, 5);
      expect(score.vocabularyAgreement).toBe(0);
      expect(score.vocabularyMismatches).toEqual([
        { golden: 'common-octopus · has-heart-count · 3', outputPredicate: 'has-number-of-hearts' },
      ]);
    });

    it('perfect vocabulary agreement when the model uses our words', () => {
      const score = scoreIngest([...golden], golden);
      expect(score.factRecall).toBe(1);
      expect(score.vocabularyAgreement).toBe(1);
      expect(score.vocabularyMismatches).toHaveLength(0);
    });

    it('factRecall is never below strict recall', () => {
      const output: ExtractedTriple[] = [
        { subject: 'common-octopus', predicate: 'is-a', object: 'marine-mollusk' },
        { subject: 'common-octopus', predicate: 'has-number-of-hearts', object: '3', objectIsLiteral: true },
      ];
      const score = scoreIngest(output, golden);
      expect(score.factRecall).toBeGreaterThanOrEqual(score.recall);
    });

    it('a model that finds nothing gets null agreement, not a flattering 100%', () => {
      // Dividing zero matches by zero would read as perfect vocabulary. It must read as unknown.
      const score = scoreIngest(
        [{ subject: 'unrelated-thing', predicate: 'whatever', object: 'nonsense' }],
        golden,
      );
      expect(score.factRecall).toBe(0);
      expect(score.vocabularyAgreement).toBeNull();
    });

    it('empty output gets null agreement too', () => {
      const score = scoreIngest([], golden);
      expect(score.vocabularyAgreement).toBeNull();
    });

    it('one output triple cannot satisfy two golden triples', () => {
      // Without consuming matched output, a single emitted triple could be counted against every
      // golden triple sharing its subject and inflate factRecall.
      const twoGolden: ExtractedTriple[] = [
        { subject: 'common-octopus', predicate: 'has-predator', object: 'shark' },
        { subject: 'common-octopus', predicate: 'has-predator', object: 'moray-eel' },
      ];
      const score = scoreIngest(
        [{ subject: 'common-octopus', predicate: 'hunted-by', object: 'shark' }],
        twoGolden,
      );
      expect(score.factRecall).toBe(0.5);
    });

    it('documents its own blind spot: an inverted relation still matches at fact level', () => {
      // feeds-on and is-eaten-by connect the same pair and mean opposite things. factRecall counts
      // this as found — which is exactly why it is an UPPER bound and is never reported alone.
      // Pinned so the limitation stays visible rather than being rediscovered as a bug.
      const feedGolden: ExtractedTriple[] = [
        { subject: 'common-octopus', predicate: 'feeds-on', object: 'crabs' },
      ];
      const score = scoreIngest(
        [{ subject: 'common-octopus', predicate: 'is-eaten-by', object: 'crabs' }],
        feedGolden,
      );
      expect(score.factRecall).toBe(1);
      expect(score.vocabularyAgreement).toBe(0);
    });
  });
});

// ── scoreChat ────────────────────────────────────────────────────────────────

describe('scoreChat', () => {
  const testCase: ChatTestCase = {
    question: 'Tell me about the octopus',
    golden: '',
    maxWords: 50,
    mustReference: ['common-octopus', 'marine-mollusk'],
    mustNotClaim: ['amazing', 'incredible'],
  };

  it('good response scores high', () => {
    const response = 'Your KB shows common-octopus is a marine-mollusk in class Cephalopoda. It has 3 hearts.';
    const score = scoreChat(response, testCase);
    expect(score.groundingScore).toBe(1);
    expect(score.hallucinatedClaims).toHaveLength(0);
    expect(score.overall).toBeGreaterThan(0.8);
  });

  it('hallucinating response scores low', () => {
    const response = 'The octopus is an amazing and incredible creature that represents the beauty of nature. It is truly one of the most fascinating animals on Earth. The incredible octopus has been studied for centuries and continues to amaze scientists worldwide. It is a remarkable animal that has captured the imagination of people everywhere. The amazing octopus is one of the most incredible creatures in the ocean.';
    const score = scoreChat(response, testCase);
    expect(score.hallucinatedClaims.length).toBeGreaterThan(0);
    expect(score.tooLong).toBe(true);
    expect(score.overall).toBeLessThan(0.6);
  });

  it('detects missing references', () => {
    const response = 'The octopus is a sea creature.';
    const score = scoreChat(response, testCase);
    expect(score.missingReferences.length).toBeGreaterThan(0);
    expect(score.groundingScore).toBeLessThan(1);
  });

  it('detects repetition', () => {
    const response = 'The octopus is a marine mollusk. The octopus is a marine mollusk. The octopus is a marine mollusk.';
    const score = scoreChat(response, testCase);
    expect(score.repetitionRatio).toBeGreaterThan(0.5);
  });

  it('concise correct response scores perfectly', () => {
    const tc: ChatTestCase = {
      question: 'How many hearts?',
      golden: '',
      maxWords: 30,
      mustReference: ['3'],
      mustNotClaim: [],
    };
    const response = 'Your KB says the common octopus has 3 hearts.';
    const score = scoreChat(response, tc);
    expect(score.tooLong).toBe(false);
    expect(score.groundingScore).toBe(1);
    expect(score.overall).toBeGreaterThan(0.9);
  });
});

// ── formatReport (smoke test) ────────────────────────────────────────────────

describe('formatReport', () => {
  it('produces readable output', () => {
    const golden: ExtractedTriple[] = [
      { subject: 'a', predicate: 'b', object: 'c' },
    ];
    const report = buildReport('test-model', golden, golden, ['Test response.'], [{
      question: 'test?', golden: '', maxWords: 50, mustReference: [], mustNotClaim: [],
    }]);
    const output = formatReport(report);
    expect(output).toContain('test-model');
    expect(output).toContain('INGEST');
    expect(output).toContain('CHAT');
    expect(output).toContain('SUMMARY');
  });
});
