import { describe, expect, it, vi } from 'vitest';
import { recordVerificationClaim, verifyPendingRow } from '../queue-verify';

const KPRED = 'urn:kbase:predicate/';

describe('queue verifier evidence boundary', () => {
  it('re-derives a roadmap edge from the supplied canonical edge set', () => {
    const subject = 'urn:kbase:concept/child';
    const object = 'urn:kbase:concept/parent';
    expect(verifyPendingRow({
      subject,
      predicate: `${KPRED}depends-on`,
      object,
    }, {
      roadmapEdges: new Set([`${subject}|${object}`]),
    })).toEqual({ ok: true, by: 'script:queue-verify/roadmap-edge' });

    expect(verifyPendingRow({
      subject,
      predicate: `${KPRED}depends-on`,
      object: 'urn:kbase:concept/other',
    }, {
      roadmapEdges: new Set([`${subject}|${object}`]),
    })).toMatchObject({ ok: false });
  });

  it('checks eligible repository paths and refuses to interpret prose or URLs as paths', () => {
    const pathExists = vi.fn((path: string) => path === 'src/lib/example.test.ts');
    expect(verifyPendingRow({
      predicate: `${KPRED}tested-by`,
      object: 'src/lib/example.test.ts',
    }, { pathExists })).toEqual({ ok: true, by: 'script:queue-verify/path-exists' });
    expect(pathExists).toHaveBeenCalledWith('src/lib/example.test.ts');

    expect(verifyPendingRow({
      predicate: `${KPRED}has-file`,
      object: 'https://example.test/not-a-repo-path',
    }, { pathExists })).toBeNull();
  });

  it('does not trust a pre-existing verifier label while deciding a verdict', () => {
    expect(verifyPendingRow({
      subject: 'urn:kbase:concept/child',
      predicate: `${KPRED}depends-on`,
      object: 'urn:kbase:concept/forged',
      verifiedBy: 'script:queue-verify/roadmap-edge',
      verificationClaim: 'script:queue-verify/roadmap-edge',
    }, { roadmapEdges: new Set() })).toMatchObject({ ok: false });
  });

  it('migrates legacy verifiedBy to an explicitly advisory claim', () => {
    expect(recordVerificationClaim({
      subject: 'urn:kbase:concept/x',
      verifiedBy: ' script:queue-verify/path-exists ',
    })).toEqual({
      subject: 'urn:kbase:concept/x',
      verificationClaim: 'script:queue-verify/path-exists',
    });
  });

  it('records freshly re-derived evidence instead of a row-supplied claim', () => {
    expect(recordVerificationClaim({
      verifiedBy: 'attacker',
      verificationClaim: 'attacker',
    }, 'script:queue-verify/roadmap-edge')).toEqual({
      verificationClaim: 'script:queue-verify/roadmap-edge',
    });
  });
});
