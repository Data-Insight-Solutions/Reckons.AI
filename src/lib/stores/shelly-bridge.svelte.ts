/**
 * Shelly bridge — shared reactive state for:
 *   1. Opening TurtleChatPanel (from search bar button or search query forward)
 *   2. View adjustments Shelly proposes (select entity, change layout/filters)
 */

import type { GraphFilter } from '$lib/types/turtle-chat';
import type { GraphLayout } from '$lib/rdf/view-suggestions';

// ── Chat open state ───────────────────────────────────────────────────────────

let _chatOpen = $state(false);
let _openWithMessage = $state<string | null>(null);

export function shellyChatOpen(): boolean {
  return _chatOpen;
}
export function setShellyChatOpen(open: boolean) {
  _chatOpen = open;
  if (!open) _openWithMessage = null;
}
export function shellyOpenMessage(): string | null {
  return _openWithMessage;
}
/** Open Shelly chat, optionally forwarding a message. */
export function requestShellyChat(message?: string) {
  if (message) _openWithMessage = message;
  _chatOpen = true;
}
export function clearShellyOpen() {
  _openWithMessage = null;
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
   */
  layout?: GraphLayout;
  /** Filter chips to activate (replaces current set) */
  filters?: GraphFilter[];
  /** Entity IRIs to spotlight (highlighted) in the graph — used by explore mode */
  spotlight?: string[];
}

let _viewAdjust = $state<ViewAdjust | null>(null);
let _spotlight = $state<string[]>([]);

export function shellyViewAdjust(): ViewAdjust | null {
  return _viewAdjust;
}
export function shellySpotlight(): string[] {
  return _spotlight;
}
export function applyShellyViewAdjust(v: ViewAdjust) {
  _viewAdjust = v;
  if (v.spotlight !== undefined) _spotlight = v.spotlight.map(iri => `i:${iri}`);
}
export function clearShellyViewAdjust() {
  _viewAdjust = null;
}
export function clearShellySpotlight() {
  _spotlight = [];
}

// ── Explore mode ──────────────────────────────────────────────────────────────

let _exploring = $state(false);

export function exploreOpen(): boolean {
  return _exploring;
}
export function startExplore() {
  _exploring = true;
  _chatOpen = true;
}
export function stopExplore() {
  _exploring = false;
  _spotlight = [];
}

// ── Story mode ───────────────────────────────────────────────────────────────

let _storyId = $state<string | null>(null);
let _storyAutoPlay = $state(false);

export function activeStoryId(): string | null {
  return _storyId;
}
export function storyAutoPlayRequested(): boolean {
  return _storyAutoPlay;
}
export function clearStoryAutoPlay() {
  _storyAutoPlay = false;
}
export function startStory(storyId: string, autoPlay = false) {
  _storyId = storyId;
  _storyAutoPlay = autoPlay;
  _exploring = false;
  _chatOpen = true;
}
export function stopStory() {
  _storyId = null;
  _storyAutoPlay = false;
  _spotlight = [];
}
