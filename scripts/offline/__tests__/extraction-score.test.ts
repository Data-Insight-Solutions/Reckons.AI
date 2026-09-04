/**
 * THE SCORER'S OWN CORRECTNESS — because a broken gate is worse than no gate.
 *
 * extraction-score.ts is the instrument every future "extraction got better" claim will be measured
 * with, and F146 phase 1 states the requirement plainly: "IT MUST BE ABLE TO REPORT THAT A CHANGE
 * MADE THINGS WORSE. A harness that only ever confirms improvement is a marketing instrument."
 * So the assertions below are mostly about the scorer FAILING things — a matcher lenient enough to
 * pass everything would sail through a suite that only ever checked it passes the right answers.
 *
 * These run with NO model and NO network: the module guards its own main(), so importing it here
 * scores hand-written triples rather than firing six models at Ollama from inside vitest.
 */
import { describe, it, expect } from 'vitest';
import { norm, normPredicate, slotMatches, scoreOne, loadSpecs, type FileSpec } from '../extraction-score';

const t = (subject: string, predicate: string, object: string) => ({ subject, predicate, object });

describe('normalization — modest on purpose', () => {
  it('strips prefixes, punctuation and case so kb:Lumenpath and "Lumen Path" meet', () => {
    expect(norm('kb:Lumenpath')).toBe('lumenpath');
    expect(norm('urn:kbase:concept/lumenpath')).toBe('lumenpath');
    expect(norm('Lumen Path')).toBe('lumen-path');
    expect(norm('Northwind Analytics, LLC')).toBe('northwind-analytic-llc');
  });

  it('de-pluralizes, which is the fragmentation qwen3-coder produced live on 2026-09-04', () => {
    expect(norm('enterprise-cad-platforms')).toBe(norm('enterprise-cad-platform'));
    expect(norm('architecture-studios')).toBe(norm('architecture-studio'));
  });

  it('leaves words of 3 characters or fewer alone rather than mangling them into each other', () => {
    // A greedy de-pluralizer turns "is" into "i" and "gas" into "ga", and then unrelated things
    // start matching. The length guard is why the matcher can be trusted to say no.
    expect(norm('is')).toBe('is');
    expect(norm('gas')).toBe('gas');
    expect(norm('dam')).toBe('dam');
    // Above the guard it does de-pluralize, which is wanted: "dams" and "DAM" are the corpus's own
    // case, and they must meet.
    expect(norm('dams')).toBe('dam');
  });

  it('sheds copula prefixes on PREDICATES only', () => {
    expect(normPredicate('is-used-by')).toBe(normPredicate('used-by'));
    expect(normPredicate('has-interoperability-with')).toBe(normPredicate('interoperability-with'));
    // …but not on a subject or object, where "is-" could be part of a real name.
    expect(norm('is-used-by')).toBe('is-used-by');
  });
});

describe('slot matching — it must be able to say no', () => {
  it('accepts any listed alternate', () => {
    expect(slotMatches(['is-a', 'type', 'instance-of'], 'type', 'predicate')).toBe(true);
    expect(slotMatches(['is-a', 'type', 'instance-of'], 'rdf:type', 'predicate')).toBe(true);
  });

  it('REJECTS an unrelated value — the assertion that makes the score meaningful', () => {
    expect(slotMatches(['architecture-studio'], 'vantage-suite', 'object')).toBe(false);
    expect(slotMatches(['owns'], 'competes-with', 'predicate')).toBe(false);
    expect(slotMatches(['toronto'], 'kansas-city', 'object')).toBe(false);
  });

  it('rejects empty and missing values instead of matching everything', () => {
    expect(slotMatches(['lumenpath'], '', 'subject')).toBe(false);
    expect(slotMatches(['lumenpath'], '   ', 'subject')).toBe(false);
  });

  it('allows a prefix match only when both sides are long enough to mean something', () => {
    // "enterprise-cad" ~ "enterprise-cad-platform" is the same thing named at two lengths.
    expect(slotMatches(['enterprise-cad'], 'enterprise-cad-platform', 'object')).toBe(true);
    // "dam" ~ "damage" is not, and a shorter guard would have let it through.
    expect(slotMatches(['dam'], 'damage-report', 'object')).toBe(false);
  });
});

describe('scoring', () => {
  const spec: FileSpec = {
    title: 'test',
    expected: [
      { id: 'A', s: ['lumenpath'], p: ['is-a'], o: ['enterprise-cad'] },
      { id: 'B', s: ['jordan-veil'], p: ['owns'], o: ['northwind-analytics'] },
      { id: 'C', knownBroken: true, s: ['enterprise-dam'], p: ['is-a'], o: ['software'] },
    ],
    forbidden: { slugs: ['comparison-document'], why: 'the source only requested it' },
  };

  it('counts a full match strict and loose', () => {
    const s = scoreOne(spec, [t('lumenpath', 'is-a', 'enterprise-cad')]);
    expect(s.strict).toEqual(['A']);
    expect(s.loose).toEqual(['A']);
    expect(s.missed).toEqual(['B']);
  });

  it('THE VOCABULARY GAP — right fact, wrong predicate name, counts loose but NOT strict', () => {
    // This is the F136 problem sized: on 2026-08-15 a model emitted `has-number-of-hearts` where
    // the graph says `has-heart-count`. That is a naming failure, not a recall failure, and a
    // scorer that cannot separate them cannot tell you which one to go and fix.
    const s = scoreOne(spec, [t('lumenpath', 'belongs-to-category', 'enterprise-cad')]);
    expect(s.strict).toEqual([]);
    expect(s.loose).toEqual(['A']);
    expect(s.missed).toEqual(['B']);
  });

  it('scores a known-broken expectation separately and never as a regression', () => {
    const none = scoreOne(spec, [t('lumenpath', 'is-a', 'enterprise-cad')]);
    expect(none.brokenStillBroken).toEqual(['C']);
    expect(none.missed).not.toContain('C');
    expect(none.strict).not.toContain('C');

    const fixed = scoreOne(spec, [t('enterprise-dam', 'is-a', 'software')]);
    expect(fixed.brokenFixed).toEqual(['C']);
  });

  it('INVENTION — asserting what the source only asked for', () => {
    const s = scoreOne(spec, [t('comparison-document', 'compares', 'lumenpath')]);
    expect(s.invented).toHaveLength(1);
    expect(s.misrouted).toHaveLength(0);
  });

  it('MISROUTING is not invention — the distinction the first live run forced', () => {
    // qwen3-coder emitted `user | request-to-generate | comparison-document` on 2026-09-04. It
    // understood the intent exactly; what failed is that note-intent.ts never moved it out of the
    // fact stream. Counting that as invented history would inflate the one number that has to stay
    // trustworthy, and would send someone to fix the wrong module.
    const s = scoreOne(spec, [t('user', 'request-to-generate', 'comparison-document')]);
    expect(s.invented).toHaveLength(0);
    expect(s.misrouted).toHaveLength(1);
  });

  it('VERBATIM STORAGE is neither — the third bucket the first full sweep forced', () => {
    // devstral emitted `note-<id> | note-text | "Generate a comparison document…"`. That stores the
    // source sentence under a provenance predicate: it asserts nothing about the world, so scoring
    // it as invented history was wrong and inflated the number that has to stay trustworthy. It is
    // still a finding — nothing was EXTRACTED from that note — just not a lie.
    const s = scoreOne(spec, [t('note-2026-09-02T11-40-13-902Z', 'note-text', 'Generate a comparison document about X')]);
    expect(s.invented).toHaveLength(0);
    expect(s.misrouted).toHaveLength(0);
    expect(s.verbatim).toHaveLength(1);
  });

  it('still calls a FABRICATED CAPABILITY invented — the failure the corpus exists to catch', () => {
    // Real sweep output: `lumenpath | can-genrate-comparison-documents | true`. A request to
    // generate a document became a claim that the product can generate documents. Nobody said that.
    const s = scoreOne(spec, [t('lumenpath', 'can-genrate-comparison-documents', 'true')]);
    expect(s.invented).toHaveLength(1);
    expect(s.verbatim).toHaveLength(0);
  });

  it('flags a sentence-shaped subject as a guard regression', () => {
    const s = scoreOne(spec, [t('lumen-path-is-an-enterprise-cad-platform', 'is-a', 'platform')]);
    expect(s.shapeViolations).toHaveLength(1);
  });

  it('flags one entity minted twice in a single run', () => {
    const s = scoreOne(spec, [
      t('lumenpath', 'is-a', 'enterprise-cad-platform'),
      t('enterprise-cad-platforms', 'used-by', 'studio'),
    ]);
    expect(s.fragments).toHaveLength(1);
    expect(s.fragments[0][1].sort()).toEqual(['enterprise-cad-platform', 'enterprise-cad-platforms']);
  });

  it('an empty extraction scores zero rather than throwing or passing vacuously', () => {
    const s = scoreOne(spec, []);
    expect(s.yield).toBe(0);
    expect(s.strict).toEqual([]);
    expect(s.missed).toEqual(['A', 'B']);
  });
});

describe('connection — the metric the first sweep was missing', () => {
  const spec: FileSpec = { title: 'test', expected: [{ id: 'A', s: ['x'], p: ['p'], o: ['y'] }] };
  const shown = {
    offered: new Set(['lumenpath', 'enterprise-cad']),
    offeredPredicates: new Set(['used-by']),
  };

  it('counts an entity the model REUSED from what it was shown', () => {
    const s = scoreOne(spec, [t('lumenpath', 'is-a', 'enterprise-cad')], shown);
    expect(s.entitiesEmitted).toBe(2);
    expect(s.entitiesReused).toBe(2);
  });

  it('does not credit an entity that was never offered — that is coincidence, not grounding', () => {
    const s = scoreOne(spec, [t('vantage-suite', 'is-a', 'competitor')], shown);
    expect(s.entitiesEmitted).toBe(2);
    expect(s.entitiesReused).toBe(0);
  });

  it('counts predicate reuse separately — F136 is about the WORDS, not the facts', () => {
    const reused = scoreOne(spec, [t('a', 'is-used-by', 'b')], shown);
    expect(reused.predicatesReused).toBe(1);
    const drifted = scoreOne(spec, [t('a', 'serves', 'b')], shown);
    expect(drifted.predicatesReused).toBe(0);
  });

  it('matches through normalization, so a plural or a prefix still counts as connected', () => {
    const s = scoreOne(spec, [t('kb:Lumenpath', 'has-used-by', 'Enterprise CAD')], shown);
    expect(s.entitiesReused).toBe(2);
    expect(s.predicatesReused).toBe(1);
  });

  it('reports zero denominators with an empty context rather than a misleading 0%', () => {
    // With no graph shown, reuse is undefined, not failed. A 0% here would read as "grounding
    // achieved nothing" when nothing was offered to reuse.
    const s = scoreOne(spec, [t('a', 'p', 'b')]);
    expect(s.entitiesReused).toBe(0);
    expect(s.predicatesReused).toBe(0);
  });
});

describe('the shipped ground truth', () => {
  const specs = loadSpecs('tests/fixtures/notes-corpus');

  it('loads, and covers the three committed corpus files', () => {
    expect(Object.keys(specs).sort()).toEqual(['01-note-single.txt', '02-notes-batch.txt', '03-doc-medium.md']);
  });

  it('every expectation has a stable id and all three slots populated', () => {
    for (const [file, spec] of Object.entries(specs)) {
      for (const e of spec.expected) {
        expect(e.id, `${file} expectation missing id`).toMatch(/^\d+\.\d+$/);
        expect(e.s.length, `${e.id} subject`).toBeGreaterThan(0);
        expect(e.p.length, `${e.id} predicate`).toBeGreaterThan(0);
        expect(e.o.length, `${e.id} object`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps enough scoreable expectations that the number can actually move', () => {
    const scoreable = Object.values(specs).flatMap((s) => s.expected.filter((e) => !e.knownBroken));
    // Guards against the failure the header warns about: quietly demoting expectations to
    // knownBroken until the score looks good.
    expect(scoreable.length).toBeGreaterThanOrEqual(15);
  });

  it('does not forbid a slug that the correct answer also contains', () => {
    // The 03 forbidden list said "recommendation" until 2026-09-04, which wrongly flagged
    // `has-no-recommendation true` — the model correctly recording the document's refusal to
    // recommend. A forbidden slug must not collide with any accepted answer in the same file.
    for (const [file, spec] of Object.entries(specs)) {
      for (const slug of spec.forbidden?.slugs ?? []) {
        for (const e of spec.expected) {
          for (const slot of [e.s, e.o]) {
            expect(
              slot.some((v) => norm(v) === norm(slug)),
              `${file}: forbidden slug "${slug}" collides with expectation ${e.id}`,
            ).toBe(false);
          }
        }
      }
    }
  });
});
