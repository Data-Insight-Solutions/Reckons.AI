/**
 * Reactive viewport store — the single source of truth for responsive behaviour
 * (F36 Mobile UI/UX Architecture, phase 1 foundation).
 *
 * Everything mobile-aware keys off this instead of hand-rolling `@media` blocks
 * or reading `window.innerWidth` ad hoc. The breakpoints below MUST match the
 * pinned scale in `src/lib/styles/tailwind.css` (@theme --breakpoint-*), so the
 * `sm:`/`lg:` Tailwind utilities and this JS agree on where "mobile" ends.
 * Aligned to the UX rubric (kb:web-uiux-rubric): mobile is below 640px.
 *
 * No dependencies — native `matchMedia` only. SSR/prerender safe: on the server
 * there is no viewport, so we default to `desktop` + no-touch and mark the store
 * not-ready until the client wires listeners via `initViewport()`.
 */

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

/** Breakpoint edges in px — keep in lockstep with tailwind.css @theme tokens. */
export const BREAKPOINTS = { sm: 640, lg: 1024 } as const;

/** matchMedia queries. `.98` avoids the 1px overlap gap between max/min ranges. */
const QUERY = {
	mobile: `(max-width: ${BREAKPOINTS.sm - 0.02}px)`,
	tablet: `(min-width: ${BREAKPOINTS.sm}px) and (max-width: ${BREAKPOINTS.lg - 0.02}px)`,
	touch: '(pointer: coarse)',
} as const;

let _breakpoint = $state<Breakpoint>('desktop');
let _touch = $state(false);
let _ready = $state(false);

/** Current breakpoint band. */
export function breakpoint(): Breakpoint {
	return _breakpoint;
}
/** Viewport is narrower than the `sm` (640px) edge. */
export function isMobile(): boolean {
	return _breakpoint === 'mobile';
}
/** Viewport is between `sm` (640px) and `lg` (1024px). */
export function isTablet(): boolean {
	return _breakpoint === 'tablet';
}
/** Viewport is at or above the `lg` (1024px) edge. */
export function isDesktop(): boolean {
	return _breakpoint === 'desktop';
}
/** Mobile OR tablet — the range that gets adaptive (sheet/drawer) treatment. */
export function isCompact(): boolean {
	return _breakpoint !== 'desktop';
}
/**
 * Coarse pointer (finger/stylus). Independent of width: a touch laptop reports
 * desktop + touch, a phone reports mobile + touch. Gate drag/hover affordances
 * on this, not on width.
 */
export function isTouch(): boolean {
	return _touch;
}
/** True once `matchMedia` has been read on the client; false during SSR/prerender. */
export function viewportReady(): boolean {
	return _ready;
}

/**
 * Pure classifier from the two range queries' match state. Exported for tests
 * so the mobile/tablet/desktop decision is verifiable without a real viewport.
 */
export function resolveBreakpoint(mobileMatches: boolean, tabletMatches: boolean): Breakpoint {
	if (mobileMatches) return 'mobile';
	if (tabletMatches) return 'tablet';
	return 'desktop';
}

let _teardown: (() => void) | null = null;

/**
 * Wire `matchMedia` listeners so the store tracks the live viewport. Idempotent
 * and SSR-safe (no-op without `window.matchMedia`). Call once from the app
 * layout's `onMount`; returns a teardown for the `onMount` cleanup.
 */
export function initViewport(): () => void {
	if (_teardown) return _teardown;
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		return () => {};
	}
	const mqMobile = window.matchMedia(QUERY.mobile);
	const mqTablet = window.matchMedia(QUERY.tablet);
	const mqTouch = window.matchMedia(QUERY.touch);
	const sync = () => {
		_breakpoint = resolveBreakpoint(mqMobile.matches, mqTablet.matches);
		_touch = mqTouch.matches;
		_ready = true;
	};
	sync();
	mqMobile.addEventListener('change', sync);
	mqTablet.addEventListener('change', sync);
	mqTouch.addEventListener('change', sync);
	_teardown = () => {
		mqMobile.removeEventListener('change', sync);
		mqTablet.removeEventListener('change', sync);
		mqTouch.removeEventListener('change', sync);
		_teardown = null;
	};
	return _teardown;
}
