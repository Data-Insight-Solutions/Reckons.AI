/**
 * Shelly bridge — shared reactive state for:
 *   1. Opening TurtleChatPanel (from search bar button or search query forward)
 *   2. View adjustments Shelly proposes (select entity, change layout/filters)
 */

import type { GraphFilter } from '$lib/types/turtle-chat';
import type { GraphLayout } from '$lib/rdf/view-suggestions';

// ── Chat open state ───────────────────────────────────────────────────────────

let chatOpen = $state(false);
let openWithMessage = $state<string | null>(null);

export function shellyChatOpen(): boolean {
  return chatOpen;
}
export function setShellyChatOpen(open: boolean) {
  chatOpen = open;
  if (!open) openWithMessage = null;
}
export function shellyOpenMessage(): string | null {
  return openWithMessage;
}
/** Open Shelly chat, optionally forwarding a message. */
export function requestShellyChat(message?: string) {
  if (message) openWithMessage = message;
  chatOpen = true;
}
export function clearShellyOpen() {
  openWithMessage = null;
}

// ── View adjustments ──────────────────────────────────────────────────────────

export interface ViewAdjust {
  /** IRI of entity to select in the graph */
  selectEntity?: string;
  /**
   * Graph layout mode.
   *
   * Must stay in sync with KnowledgeGraph.svelte's `layout` prop. It previously omitted
   * 'timeline' and 'hierarchy', so Shelly could not request a timeline layout AT ALL —
   * the single most obvious thing to offer someone looking at dated facts. A view-control
   * API that cannot express the view is not an API.
      *
   * THE SAME BUG HAD A SECOND HALF, FOUND 2026-09-04. Widening the TYPE was not enough: the
   * adjust_view vocabulary in the PROMPT (turtle-chat.ts) still listed only force/focus/source/
   * type/hub, so timeline, hierarchy and order were requestable by the type system and unknown to
   * the model that had to name them. A capability is only real when every layer that mentions it
   * agrees — fixed alongside adding 'map'.
   */
  layout?: GraphLayout;
  /** Filter chips to activate (replaces current set) */
  filters?: GraphFilter[];
  /** Entity IRIs to spotlight (highlighted) in the graph — used by explore mode */
  spotlight?: string[];
}

let viewAdjust = $state<ViewAdjust | null>(null);
let spotlight = $state<string[]>([]);

export function shellyViewAdjust(): ViewAdjust | null {
  return viewAdjust;
}
export function shellySpotlight(): string[] {
  return spotlight;
}
export function applyShellyViewAdjust(v: ViewAdjust) {
  viewAdjust = v;
  if (v.spotlight !== undefined) spotlight = v.spotlight.map(iri => `i:${iri}`);
}
export function clearShellyViewAdjust() {
  viewAdjust = null;
}
export function clearShellySpotlight() {
  spotlight = [];
}

// ── Explore mode ──────────────────────────────────────────────────────────────

let exploring = $state(false);

export function exploreOpen(): boolean {
  return exploring;
}
export function startExplore() {
  exploring = true;
  chatOpen = true;
}
export function stopExplore() {
  exploring = false;
  spotlight = [];
}

// ── Story mode ───────────────────────────────────────────────────────────────

let _storyId = $state<string | null>(null);
let storyAutoPlay = $state(false);

export function activeStoryId(): string | null {
  return _storyId;
}
export function storyAutoPlayRequested(): boolean {
  return storyAutoPlay;
}
export function clearStoryAutoPlay() {
  storyAutoPlay = false;
}
export function startStory(storyId: string, autoPlay = false) {
  _storyId = storyId;
  storyAutoPlay = autoPlay;
  exploring = false;
  chatOpen = true;
}
export function stopStory() {
  _storyId = null;
  storyAutoPlay = false;
  spotlight = [];
}
