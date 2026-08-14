import { describe, it, expect } from 'vitest';
import {
  classifyFinding,
  explainClass,
  isFindingClass,
  FINDING_CLASSES,
  classifyScope,
  isScopeClass,
  SCOPE_CLASSES,
} from '../finding-class';

describe('classifyFinding', () => {
  it('calls a shape violation FORM — a parser settles it, no world knowledge needed', () => {
    expect(classifyFinding({ decidableFromArtifactAlone: true })).toBe('form');
  });

  it('calls a false claim DRIFT when repairing the world would not make it true', () => {
    // SAFETY.md said "we gate publishing" while F66 was merely planned. Nothing could be
    // built quickly enough to make that sentence true; the sentence had to change.
    expect(
      classifyFinding({ decidableFromArtifactAlone: false, graphWouldBecomeTrue: false }),
    ).toBe('drift');
  });

  it('calls a blocked-but-correct claim DEFECT when repairing the world makes it true', () => {
    // "repo-ingest is functional" while CSP blocked every request. Adding the origin to
    // connect-src made the graph true WITHOUT editing the graph.
    expect(
      classifyFinding({ decidableFromArtifactAlone: false, graphWouldBecomeTrue: true }),
    ).toBe('defect');
  });

  it('defaults to DRIFT when the discriminating question is unanswered', () => {
    // The honest default: drift routes to a human. Guessing defect would silently assert
    // that the graph is already right.
    expect(classifyFinding({ decidableFromArtifactAlone: false })).toBe('drift');
  });

  it('treats FORM as decidable even when the world question is also answered', () => {
    expect(
      classifyFinding({ decidableFromArtifactAlone: true, graphWouldBecomeTrue: true }),
    ).toBe('form');
  });
});

describe('routing consequences', () => {
  it('never allows DRIFT to block a build', () => {
    // Blocking would force a fast answer to the question that most needs a slow one —
    // which side is wrong.
    expect(FINDING_CLASSES.drift.blockable).toBe(false);
  });

  it('allows FORM and DEFECT to block, because neither requires judging intent', () => {
    expect(FINDING_CLASSES.form.blockable).toBe(true);
    expect(FINDING_CLASSES.defect.blockable).toBe(true);
  });

  it('says where the fix lands, which is what makes the classes actionable', () => {
    expect(FINDING_CLASSES.form.fixLands).toMatch(/artifact/);
    expect(FINDING_CLASSES.defect.fixLands).toMatch(/code|infrastructure/);
    expect(FINDING_CLASSES.drift.fixLands).toMatch(/graph|world/);
  });
});

describe('the three real cases this project hit', () => {
  const cases: Array<[string, Parameters<typeof classifyFinding>[0], string]> = [
    [
      'SHACL: kb:design-system has no rdfs:label',
      { decidableFromArtifactAlone: true },
      'form',
    ],
    [
      'CSP blocked api.github.com while repo-ingest was marked shipped',
      { decidableFromArtifactAlone: false, graphWouldBecomeTrue: true },
      'defect',
    ],
    [
      'SAFETY.md claimed a publishing gate that was never built',
      { decidableFromArtifactAlone: false, graphWouldBecomeTrue: false },
      'drift',
    ],
  ];

  it.each(cases)('%s -> %s', (_name, input, expected) => {
    expect(classifyFinding(input)).toBe(expected);
  });
});

describe('classifyScope — the second axis', () => {
  it('calls predicted work PLANNED', () => {
    expect(classifyScope({ wasPredicted: true, servesStatedIntent: true })).toBe('planned');
  });

  it('calls an unpredicted-but-necessary dependency EXPANDED-ALIGNED', () => {
    // Real case: F128 said "add SHACL" and said nothing about rdf-validate-shacl. Adding the
    // dependency was unpredicted and entirely in service of the stated intent.
    expect(classifyScope({ wasPredicted: false, servesStatedIntent: true })).toBe('expanded-aligned');
  });

  it('calls work that left the intent EXPANDED-UNALIGNED', () => {
    expect(classifyScope({ wasPredicted: false, servesStatedIntent: false })).toBe('expanded-unaligned');
  });

  it('flags ONLY the unaligned case', () => {
    // The flaw this axis fixes: kb-align's scopeScore penalises every unmatched change
    // equally, so legitimate discovery scores the same as a wander.
    expect(SCOPE_CLASSES.planned.flag).toBe(false);
    expect(SCOPE_CLASSES['expanded-aligned'].flag).toBe(false);
    expect(SCOPE_CLASSES['expanded-unaligned'].flag).toBe(true);
  });

  it('responds to aligned expansion by amending the PLAN, not by docking a score', () => {
    // F114: "design completeness is relative to the use cases known at the time."
    expect(SCOPE_CLASSES['expanded-aligned'].response).toMatch(/amend the plan/);
    expect(SCOPE_CLASSES['expanded-unaligned'].response).toMatch(/split it|revert/);
  });
});

describe('real scope calls from this session', () => {
  const cases: Array<[string, Parameters<typeof classifyScope>[0], string]> = [
    [
      'adding rdf-validate-shacl to build F128',
      { wasPredicted: false, servesStatedIntent: true },
      'expanded-aligned',
    ],
    [
      'touching serialize.ts + import-ttl.ts so F129 attribution could survive export',
      { wasPredicted: false, servesStatedIntent: true },
      'expanded-aligned',
    ],
    [
      'fixing the 2D scrub-range bug found while building the undated lane',
      { wasPredicted: false, servesStatedIntent: true },
      'expanded-aligned',
    ],
    [
      'landing the CSP fix on a branch cut for Indico reachability',
      { wasPredicted: false, servesStatedIntent: false },
      'expanded-unaligned',
    ],
  ];

  it.each(cases)('%s -> %s', (_name, input, expected) => {
    expect(classifyScope(input)).toBe(expected);
  });
});

describe('isScopeClass', () => {
  it('accepts the three scope classes', () => {
    expect(isScopeClass('expanded-aligned')).toBe(true);
    expect(isScopeClass('expanded-unaligned')).toBe(true);
    expect(isScopeClass('drift')).toBe(false);
  });
});

describe('isFindingClass', () => {
  it('accepts the three classes and rejects the old conflated label', () => {
    expect(isFindingClass('form')).toBe(true);
    expect(isFindingClass('drift')).toBe(true);
    expect(isFindingClass('defect')).toBe(true);
    expect(isFindingClass('drift-warning')).toBe(false);
    expect(isFindingClass('constructor')).toBe(false);
  });
});

describe('explainClass', () => {
  it('states who settles it and where the fix lands', () => {
    expect(explainClass('drift')).toMatch(/WHICH SIDE is wrong/);
    expect(explainClass('form')).toMatch(/no judgement required/);
  });
});
