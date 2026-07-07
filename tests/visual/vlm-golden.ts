/**
 * VLM Gate Bench — labeled ground-truth dataset.
 *
 * Each check is a yes/no visual question with a known answer, verified by a
 * human (Opus) actually viewing the screenshot. Used by run-vlm-gate-bench.ts
 * to score local Ollama vision models on "does this appear" gate accuracy.
 *
 * Ground truth is authored ONLY from screenshots that were directly inspected —
 * do not add a case you have not eyeballed. Labels are the whole value here.
 *
 * Check `type` groups questions so the bench can report per-capability accuracy
 * (a model may ace presence checks but fail tab-state, etc.).
 */

export type YesNo = 'yes' | 'no';

export interface VlmCheck {
  /** Stable id, unique within an image. */
  id: string;
  /** Capability group, e.g. 'toast', 'mobile', 'graph'. */
  type: string;
  /** Self-contained yes/no question posed to the VLM. */
  q: string;
  /** Verified correct answer. */
  expect: YesNo;
}

export interface VlmGoldenCase {
  /** Path relative to tests/visual/screenshots/. */
  image: string;
  checks: VlmCheck[];
}

// Reusable question wordings (kept identical across images so the bench measures
// the model, not prompt variance).
const Q = {
  toast: "Is a popup notification card with the heading 'Meet Shelly' visible anywhere in this screenshot?",
  mobile: 'Is this UI laid out as a narrow, single-column mobile phone screen (tall and thin) rather than a wide desktop layout?',
  graph: 'Is a dense network graph with many teal spheres and orange diamond shapes connected by thin lines visible?',
  blank: 'Does a main panel show an empty state with text indicating there is nothing to preview or no pending items?',
  settings: "Is this a Settings or 'system configuration' page with tabs like BACKENDS and INTEGRATIONS?",
  kb: 'Does this page show a knowledge-base editor with counts of entities, statements, and sources?',
  alignTab: "In the right-hand review panel, is the 'align' tab the currently selected (highlighted) tab?",
} as const;

const c = (id: string, type: keyof typeof Q, expect: YesNo): VlmCheck => ({
  id,
  type,
  q: Q[type],
  expect,
});

export const VLM_GOLDEN: VlmGoldenCase[] = [
  {
    image: 'coding-workflow/02-production-graph.png',
    checks: [c('toast', 'toast', 'yes'), c('mobile', 'mobile', 'no'), c('graph', 'graph', 'yes'), c('blank', 'blank', 'no'), c('settings', 'settings', 'no')],
  },
  {
    image: 'coding-workflow/06b-alignment-cards-detail.png',
    checks: [c('toast', 'toast', 'no'), c('mobile', 'mobile', 'no'), c('graph', 'graph', 'yes'), c('align', 'alignTab', 'yes'), c('blank', 'blank', 'no')],
  },
  {
    image: 'cross-kb-align/01-all-three-imported.png',
    checks: [c('toast', 'toast', 'yes'), c('mobile', 'mobile', 'no'), c('graph', 'graph', 'no'), c('blank', 'blank', 'no')],
  },
  {
    image: 'cross-kb-align/09-mobile-stacked-layout.png',
    checks: [c('toast', 'toast', 'no'), c('mobile', 'mobile', 'yes'), c('graph', 'graph', 'no'), c('blank', 'blank', 'yes'), c('align', 'alignTab', 'no')],
  },
  {
    image: 'dev-sprint/09-no-artifacts.png',
    checks: [c('toast', 'toast', 'no'), c('mobile', 'mobile', 'no'), c('graph', 'graph', 'no'), c('blank', 'blank', 'yes'), c('align', 'alignTab', 'no'), c('kb', 'kb', 'no')],
  },
  {
    image: 'main-page-empty.png',
    checks: [c('toast', 'toast', 'yes'), c('mobile', 'mobile', 'no'), c('graph', 'graph', 'no'), c('blank', 'blank', 'no')],
  },
  {
    image: 'coding-workflow/04-align-tab.png',
    checks: [c('toast', 'toast', 'no'), c('mobile', 'mobile', 'no'), c('graph', 'graph', 'yes'), c('align', 'alignTab', 'yes'), c('blank', 'blank', 'no')],
  },
  {
    image: 'kb-page.png',
    checks: [c('toast', 'toast', 'no'), c('mobile', 'mobile', 'no'), c('graph', 'graph', 'no'), c('kb', 'kb', 'yes'), c('settings', 'settings', 'no')],
  },
  {
    image: 'settings-page.png',
    checks: [c('toast', 'toast', 'no'), c('mobile', 'mobile', 'no'), c('graph', 'graph', 'no'), c('settings', 'settings', 'yes'), c('kb', 'kb', 'no')],
  },
  {
    image: 'main-page-mobile.png',
    checks: [c('toast', 'toast', 'yes'), c('mobile', 'mobile', 'yes'), c('graph', 'graph', 'no'), c('settings', 'settings', 'no')],
  },
];

/** Flat count of labeled checks, for sanity output. */
export const TOTAL_CHECKS = VLM_GOLDEN.reduce((n, g) => n + g.checks.length, 0);
