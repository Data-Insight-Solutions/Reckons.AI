import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import SHACLValidator from 'rdf-validate-shacl';

/**
 * The shapes are DATA, so nothing type-checks them — a shape that targets the wrong class, or
 * whose regex is subtly wrong, fails silently by passing everything. Both happened while
 * writing this file: the first Feature shape required has-status outright and produced 38
 * violations against deliberate `moved-to` tombstones, and the first feature-id pattern
 * rejected the real ids F8b, R3, R4 and R5. These tests exist so a shape must demonstrate it
 * catches what it claims AND leaves valid data alone.
 */

const PREFIXES = `
@prefix ktype: <urn:kbase:type/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix kb:    <urn:kbase:concept/> .
`;

let validator: SHACLValidator;

beforeAll(() => {
  const shapes = new Parser().parse(readFileSync('static/shapes/reckons-shapes.ttl', 'utf8'));
  validator = new SHACLValidator(shapes);
});

async function check(ttl: string) {
  const data = validator.factory.dataset(new Parser().parse(PREFIXES + ttl));
  const report = await validator.validate(data);
  return {
    conforms: report.conforms,
    messages: report.results.map((r) => r.message.map((m) => m.value).join(' ')),
  };
}

describe('Feature shape', () => {
  it('accepts a well-formed feature', async () => {
    const r = await check(`kb:x a ktype:Feature ; rdfs:label "X" ; kpred:has-status "planned" ; kpred:feature-id "F27" .`);
    expect(r.conforms).toBe(true);
  });

  it('rejects a status outside the lifecycle', async () => {
    const r = await check(`kb:x a ktype:Feature ; rdfs:label "X" ; kpred:has-status "shipped" .`);
    expect(r.conforms).toBe(false);
    expect(r.messages.join(' ')).toMatch(/has-status must be one of/);
  });

  it('rejects a feature with no status and no moved-to', async () => {
    const r = await check(`kb:x a ktype:Feature ; rdfs:label "X" .`);
    expect(r.conforms).toBe(false);
  });

  it('ACCEPTS a moved-to tombstone with no status — 38 of these exist by design', async () => {
    // The regression this file was written for: requiring has-status outright flagged every
    // relocated feature as broken.
    const r = await check(`kb:x a ktype:Feature ; rdfs:label "X" ; kpred:moved-to "static/reckons-shipped.ttl" .`);
    expect(r.conforms).toBe(true);
  });

  it('rejects an unlabelled feature', async () => {
    const r = await check(`kb:x a ktype:Feature ; kpred:has-status "planned" .`);
    expect(r.conforms).toBe(false);
  });

  it.each(['F27', 'F108.2', 'F8b', 'R3'])('accepts the real feature-id %s', async (id) => {
    const r = await check(`kb:x a ktype:Feature ; rdfs:label "X" ; kpred:has-status "planned" ; kpred:feature-id "${id}" .`);
    expect(r.conforms).toBe(true);
  });

  it('rejects a malformed feature-id', async () => {
    const r = await check(`kb:x a ktype:Feature ; rdfs:label "X" ; kpred:has-status "planned" ; kpred:feature-id "twenty-seven" .`);
    expect(r.conforms).toBe(false);
  });

  it('does NOT target non-features — scoping matters as much as the rule', async () => {
    // kb:review-workflow carries has-status "pending -> confirmed/rejected/refined", which is
    // a state machine rather than a lifecycle. Targeting it would be a false positive.
    const r = await check(`kb:wf rdfs:label "Review Workflow" ; kpred:has-status "pending -> confirmed/rejected/refined" .`);
    expect(r.conforms).toBe(true);
  });
});

describe('PendingProposal shape', () => {
  it('rejects a priority value in the type field — three live entries had exactly this', async () => {
    const r = await check(`kb:p a ktype:PendingProposal ; kpred:proposal-type "normal" .`);
    expect(r.conforms).toBe(false);
    expect(r.messages.join(' ')).toMatch(/proposal type must be one of/);
  });

  it('accepts the real proposal types', async () => {
    for (const t of ['observation', 'question', 'suggestion', 'status-update', 'drift-warning']) {
      const r = await check(`kb:p a ktype:PendingProposal ; kpred:proposal-type "${t}" ; kpred:priority "high" .`);
      expect(r.conforms, t).toBe(true);
    }
  });

  it('rejects an unknown priority', async () => {
    const r = await check(`kb:p a ktype:PendingProposal ; kpred:priority "urgent" .`);
    expect(r.conforms).toBe(false);
  });
});

describe('GrantSeeker shape', () => {
  it('requires geography, because eligibility is jurisdiction-bound', async () => {
    const r = await check(`kb:g a ktype:GrantSeeker ; rdfs:label "Market" ; kpred:focus-area "farmers market" .`);
    expect(r.conforms).toBe(false);
    expect(r.messages.join(' ')).toMatch(/jurisdiction-bound/);
  });

  it('accepts a complete profile', async () => {
    const r = await check(
      `kb:g a ktype:GrantSeeker ; rdfs:label "Ava Growers Market" ; kpred:geography "Ava, Missouri" ; kpred:focus-area "farmers market" ; kpred:entity-type "nonprofit" .`,
    );
    expect(r.conforms).toBe(true);
  });

  it('rejects an unrecognised legal form', async () => {
    const r = await check(
      `kb:g a ktype:GrantSeeker ; rdfs:label "X" ; kpred:geography "Y" ; kpred:focus-area "Z" ; kpred:entity-type "charity-ish" .`,
    );
    expect(r.conforms).toBe(false);
  });
});

describe('GrantCall shape', () => {
  it('requires a link — an unverifiable funding claim is what this product refuses', async () => {
    const r = await check(`kb:c a ktype:GrantCall ; rdfs:label "Some grant" .`);
    expect(r.conforms).toBe(false);
    expect(r.messages.join(' ')).toMatch(/link to its source/);
  });

  it('accepts a call with a link', async () => {
    const r = await check(`kb:c a ktype:GrantCall ; rdfs:label "Some grant" ; kpred:link "https://example.org/call" .`);
    expect(r.conforms).toBe(true);
  });
});
