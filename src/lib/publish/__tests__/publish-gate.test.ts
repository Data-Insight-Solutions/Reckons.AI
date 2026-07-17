/**
 * F66 publish safety gate.
 *
 * The tests that matter most here are the NEGATIVE ones: a novelist writing explicit
 * fiction must never be blocked from authoring or exporting, and must not be treated
 * as a wrongdoer when we decline to carry their work. If this suite ever starts
 * blocking export, the policy has been broken.
 */
import { describe, it, expect } from 'vitest';
import { gatePublish, PublishRefusedError } from '../publish-gate';
import { classifyForDistribution } from '../../safety/content-policy';
import type { Statement } from '../../rdf/types';
import { iri, lit } from '../../rdf/types';

function stmt(objectText: string, id = 's1'): Statement {
  return {
    id,
    s: iri('urn:kbase:concept/thing'),
    p: iri('urn:kbase:predicate/note'),
    o: lit(objectText),
    g: iri('urn:kbase:source/test'),
    sourceId: 'src',
    confidence: 1,
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('classifyForDistribution — the three tiers', () => {
  it('allows ordinary content', () => {
    expect(classifyForDistribution('The mitochondria is the powerhouse of the cell.').verdict).toBe('allow');
  });

  it('DECLINES adult content (Tier 2) — not refused, not blocked', () => {
    const r = classifyForDistribution('Chapter 7 is an explicit romance scene between the two leads.');
    expect(r.verdict).toBe('decline');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('REFUSES the coercion signature (Tier 1) even without explicit prose', () => {
    const r = classifyForDistribution(
      "Pay me $5000 or I will post the photos I have of you to your employer.",
    );
    expect(r.verdict).toBe('refuse');
  });

  it('refuses non-consensual intimate imagery', () => {
    expect(classifyForDistribution('A revenge porn archive.').verdict).toBe('refuse');
  });

  it('refuses CSAM regardless of framing', () => {
    expect(classifyForDistribution('child sexual images').verdict).toBe('refuse');
  });

  it('detects coercion by STRUCTURE, not by explicitness — the whole point', () => {
    // No explicit prose whatsoever. Still refused, because a real person is targeted.
    const sextortion = "Send me the money or everyone at your school will see your nudes.";
    expect(classifyForDistribution(sextortion).verdict).toBe('refuse');

    // Explicit prose, but nobody is targeted. Merely declined — we won't carry it.
    const fiction = 'An erotic story about two consenting adults on a rainy afternoon.';
    expect(classifyForDistribution(fiction).verdict).toBe('decline');
  });
});

describe('gatePublish', () => {
  it('allows a clean site bundle', () => {
    const r = gatePublish([stmt('A note about birds.')], {
      'content/pages/birds.md': '---\ntitle: Birds\n---\nBirds are dinosaurs.',
    });
    expect(r.verdict).toBe('allow');
    expect(r.message).toBe('');
  });

  it('scans the RENDERED page bodies, not just statements (the old bug)', () => {
    // No statement carries it; only the rendered markdown does. This is exactly the
    // hole in the previous code, which filtered knowledge.ttl but built pages from
    // unfiltered statements.
    const r = gatePublish([], {
      'content/pages/x.md': 'Pay me or I will leak the videos of you to your family.',
    });
    expect(r.verdict).toBe('refuse');
    expect(r.refusals[0].where).toBe('content/pages/x.md');
  });

  it('declines adult content with a message that helps rather than accuses', () => {
    const r = gatePublish([], { 'content/pages/ch7.md': 'An explicit sex scene.' });
    expect(r.verdict).toBe('decline');
    // It must tell them what to do next, and must not demand a justification.
    expect(r.message).toMatch(/host it\s+yourself/i);
    expect(r.message).toMatch(/not asking you to justify/i);
    expect(r.message).not.toMatch(/violation|prohibited|banned/i);
  });

  it('refuses Tier 1 with an explanation, never a silent drop', () => {
    const r = gatePublish([stmt('revenge porn collection')], {});
    expect(r.verdict).toBe('refuse');
    expect(r.message).toMatch(/will not publish/i);
    expect(r.message).toMatch(/did not consent/i);
    // The user keeps their data. That promise is load-bearing.
    expect(r.message).toMatch(/export still works/i);
  });

  it('ignores admin scaffolding and graph.json', () => {
    const r = gatePublish([], {
      'admin/config.yml': 'explicit sex scene',   // CMS config, not user prose
      'graph.json': '{"explicit sex scene":1}',
    });
    expect(r.verdict).toBe('allow');
  });

  it('PublishRefusedError carries the full result', () => {
    const r = gatePublish([], { 'content/pages/x.md': 'An erotic story.' });
    const err = new PublishRefusedError(r);
    expect(err.result.verdict).toBe('decline');
    expect(err.message).toBe(r.message);
  });
});
