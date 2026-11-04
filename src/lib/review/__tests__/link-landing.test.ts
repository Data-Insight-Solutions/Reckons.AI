import { describe, expect, it } from 'vitest';
import { isReviewLink, landingKind, type LandingInput } from '../link-landing';

const base: LandingInput = { fromLink: true, checked: true, state: 'connected', loading: false, supported: true };

describe('landingKind', () => {
  it('stays out of the way when the page was not opened from a link', () => {
    expect(landingKind({ ...base, fromLink: false, state: 'disconnected' })).toBe('none');
  });
  it('does not call an unchecked workspace "unlinked"', () => {
    expect(landingKind({ ...base, checked: false, state: 'none' })).toBe('checking');
  });
  it('offers one-click reconnect when permission lapsed', () => {
    expect(landingKind({ ...base, state: 'disconnected' })).toBe('reconnect');
  });
  it('says so plainly when this origin has no folder', () => {
    expect(landingKind({ ...base, state: 'none' })).toBe('unlinked');
  });
  it('does not offer to link a folder in a browser that cannot', () => {
    expect(landingKind({ ...base, state: 'none', supported: false })).toBe('none');
  });
  it('never reports ready while the first drain is running', () => {
    expect(landingKind({ ...base, loading: true })).toBe('loading');
    expect(landingKind({ ...base, loading: false })).toBe('ready');
  });
});

describe('isReviewLink', () => {
  it('is true for agent or kb, false otherwise', () => {
    expect(isReviewLink(new URLSearchParams('agent=x'))).toBe(true);
    expect(isReviewLink(new URLSearchParams('kb=roadmap'))).toBe(true);
    expect(isReviewLink(new URLSearchParams('tab=incoming'))).toBe(false);
  });
});
