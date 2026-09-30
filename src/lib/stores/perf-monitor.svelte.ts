/**
 * Lightweight FPS sampler for the 3D graph renderer.
 *
 * KnowledgeGraph.svelte calls recordFrame(delta) on every Threlte useTask tick.
 * Reactive state updates ~once per second to avoid spamming Svelte's scheduler.
 * After 4+ consecutive seconds below 30 fps the store signals that the user
 * should consider switching to 2D view.
 */

const LOW_FPS_THRESHOLD   = 30;   // fps — below this is considered struggling
const SUGGEST_STREAK_SECS = 4;    // consecutive low-fps seconds before suggesting

// Rolling frame-time buffer (~2 s of history at 60 fps)
const BUFFER_SIZE = 128;
const _buf = new Float32Array(BUFFER_SIZE);
let head = 0;          // write index (circular)
let count = 0;         // how many valid samples

// Reactive state — updated at ~1 Hz so derived/effects don't fire 60×/s
let displayFps    = $state(0);
let lowFpsStreak  = $state(0);  // consecutive seconds under threshold
let dismissed     = $state(false);

let lastSecondTs  = 0;
let framesSinceLastSec = 0;
let secDeltaSum   = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call from KnowledgeGraph's useTask on every frame.
 * delta is seconds-per-frame as reported by Threlte.
 */
export function recordFrame(delta: number): void {
  // Clamp absurd deltas (tab hidden, first frame, etc.)
  const dt = Math.min(delta, 0.5);

  _buf[head % BUFFER_SIZE] = dt;
  head++;
  if (count < BUFFER_SIZE) count++;

  framesSinceLastSec++;
  secDeltaSum += dt;

  const now = performance.now();
  if (now - lastSecondTs >= 1000) {
    lastSecondTs = now;

    // Rolling FPS across the whole buffer
    if (count > 0) {
      let sum = 0;
      const n = Math.min(count, BUFFER_SIZE);
      for (let i = 0; i < n; i++) sum += _buf[i];
      displayFps = Math.round(n / sum);
    }

    // Streak tracking on the last full second
    if (framesSinceLastSec > 0) {
      const secFps = framesSinceLastSec / secDeltaSum;
      if (secFps < LOW_FPS_THRESHOLD) {
        lowFpsStreak = lowFpsStreak + 1;
      } else {
        lowFpsStreak = 0;
        // Performance recovered — allow suggestion again if it comes back
      }
    }

    framesSinceLastSec = 0;
    secDeltaSum = 0;
  }
}

/** Current rolling-average FPS (updates ~1 Hz). */
export function currentFps(): number { return displayFps; }

/**
 * True when FPS has been below threshold for SUGGEST_STREAK_SECS and the
 * user hasn't dismissed the suggestion.
 */
export function shouldSuggest2D(): boolean {
  return !dismissed && lowFpsStreak >= SUGGEST_STREAK_SECS;
}

/** User clicked "dismiss" — stop suggesting for this session. */
export function dismissPerfSuggestion(): void {
  dismissed = true;
}

/** Reset after the user switches to/from 2D — clear history and dismissal. */
export function resetPerfMonitor(): void {
  _buf.fill(0);
  head = 0;
  count = 0;
  displayFps = 0;
  lowFpsStreak = 0;
  dismissed = false;
  lastSecondTs = 0;
  framesSinceLastSec = 0;
  secDeltaSum = 0;
}
