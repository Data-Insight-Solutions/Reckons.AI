import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	resolveBreakpoint,
	initViewport,
	breakpoint,
	isMobile,
	isTablet,
	isDesktop,
	isCompact,
	isTouch,
	viewportReady,
} from '../viewport.svelte';

describe('resolveBreakpoint', () => {
	it('prefers mobile when the mobile range matches', () => {
		expect(resolveBreakpoint(true, false)).toBe('mobile');
		// mobile wins even if a (nonsensical) tablet match co-occurs
		expect(resolveBreakpoint(true, true)).toBe('mobile');
	});
	it('returns tablet when only the tablet range matches', () => {
		expect(resolveBreakpoint(false, true)).toBe('tablet');
	});
	it('falls back to desktop when neither range matches', () => {
		expect(resolveBreakpoint(false, false)).toBe('desktop');
	});
});

/**
 * Drive the store through a fake matchMedia so the reactive wiring is verified
 * without a real viewport (jsdom has no matchMedia). Each query string maps to a
 * controllable MediaQueryList whose `matches` we flip, then fire `change`.
 */
type FakeMQL = {
	matches: boolean;
	addEventListener: (t: string, cb: () => void) => void;
	removeEventListener: (t: string, cb: () => void) => void;
	_fire: () => void;
};

describe('initViewport (matchMedia wiring)', () => {
	let mqls: Record<string, FakeMQL>;

	beforeEach(() => {
		mqls = {};
		vi.stubGlobal('matchMedia', (query: string) => {
			const listeners = new Set<() => void>();
			const mql: FakeMQL = {
				matches: false,
				addEventListener: (_t, cb) => listeners.add(cb),
				removeEventListener: (_t, cb) => listeners.delete(cb),
				_fire: () => listeners.forEach((cb) => cb()),
			};
			mqls[query] = mql;
			return mql as unknown as MediaQueryList;
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function set(matcher: (q: string) => boolean) {
		for (const [q, mql] of Object.entries(mqls)) mql.matches = matcher(q);
		for (const mql of Object.values(mqls)) mql._fire();
	}

	it('classifies a phone viewport (mobile + touch) and marks ready', () => {
		const teardown = initViewport();
		set((q) => q.includes('max-width: 639') || q.includes('coarse'));
		expect(viewportReady()).toBe(true);
		expect(breakpoint()).toBe('mobile');
		expect(isMobile()).toBe(true);
		expect(isCompact()).toBe(true);
		expect(isTouch()).toBe(true);
		expect(isDesktop()).toBe(false);
		teardown();
	});

	it('reacts to a resize into the tablet band', () => {
		const teardown = initViewport();
		set((q) => q.includes('min-width: 640px'));
		expect(breakpoint()).toBe('tablet');
		expect(isTablet()).toBe(true);
		expect(isCompact()).toBe(true);
		expect(isMobile()).toBe(false);
		teardown();
	});

	it('reports desktop + no-touch when no range matches', () => {
		const teardown = initViewport();
		set(() => false);
		expect(breakpoint()).toBe('desktop');
		expect(isDesktop()).toBe(true);
		expect(isCompact()).toBe(false);
		expect(isTouch()).toBe(false);
		teardown();
	});
});
