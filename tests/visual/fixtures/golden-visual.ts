/**
 * Golden truth fixtures for visual analysis benchmarking.
 *
 * Each test case defines a page, viewport, and expected analysis results.
 * The bench runner captures screenshots and compares each analysis tier
 * against these golden expectations.
 */

import type { VisualTestCase } from '../vision-scoring';

export const VISUAL_TEST_CASES: VisualTestCase[] = [
  // ── Main graph page (empty KB) ───────────────────────────────────────────
  {
    id: 'main-page-empty',
    pageUrl: '/',
    description: 'Main graph page with empty knowledge base',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['graph', 'ingest', 'review'],
      semanticFeatures: ['navigation bar', 'dark theme'],
      description: 'Dark-themed app with a bottom navigation bar',
    },
  },

  // ── Ingest page ──────────────────────────────────────────────────────────
  {
    id: 'ingest-page',
    pageUrl: '/ingest',
    description: 'Ingest page with input form',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['ingest'],
      semanticFeatures: ['navigation bar', 'input form', 'dark theme'],
      description: 'Ingest page with text input area and form controls',
    },
  },

  // ── Review page (split view) ─────────────────────────────────────────────
  {
    id: 'review-split-view',
    pageUrl: '/review',
    description: 'Review page with split-view layout (graph + panel)',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['.graph-pane', '.review-panel', '.resize-handle'],
      mustNotOverlap: [['.graph-pane', '.review-panel']],
      mustContainText: ['review', 'preview', 'incoming'],
      semanticFeatures: ['split view', 'graph area', 'review panel', 'tab bar'],
      description: 'Split-view layout with graph on left and review panel on right',
    },
  },

  // ── Settings page ────────────────────────────────────────────────────────
  {
    id: 'settings-page',
    pageUrl: '/settings',
    description: 'Settings page with configuration panels',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['settings'],
      semanticFeatures: ['settings form', 'dark theme'],
      description: 'Settings page with configuration options',
    },
  },

  // ── KB page ──────────────────────────────────────────────────────────────
  {
    id: 'kb-page',
    pageUrl: '/kb',
    description: 'Knowledge base management page',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['kb'],
      semanticFeatures: ['navigation bar', 'dark theme'],
      description: 'KB management page with knowledge base controls',
    },
  },

  // ── Mobile: Main page ────────────────────────────────────────────────────
  {
    id: 'main-page-mobile',
    pageUrl: '/',
    description: 'Main page on mobile viewport (Pixel 7)',
    viewport: { width: 412, height: 915 },
    device: 'Pixel 7',
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['graph'],
      semanticFeatures: ['navigation bar', 'dark theme'],
      description: 'Mobile view of the main graph page',
    },
  },

  // ── Mobile: Review page ──────────────────────────────────────────────────
  {
    id: 'review-page-mobile',
    pageUrl: '/review',
    description: 'Review page on mobile viewport (stacked layout)',
    viewport: { width: 412, height: 915 },
    device: 'Pixel 7',
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['.graph-pane', '.review-panel'],
      mustNotOverlap: [],
      mustContainText: ['review', 'incoming'],
      semanticFeatures: ['stacked layout', 'graph area', 'review panel'],
      description: 'Mobile review page with vertically stacked graph and panel',
    },
  },

  // ── Tablet: Main page ────────────────────────────────────────────────────
  {
    id: 'main-page-tablet',
    pageUrl: '/',
    description: 'Main page on tablet viewport (iPad Pro 11)',
    viewport: { width: 834, height: 1194 },
    device: 'iPad Pro 11',
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['graph'],
      semanticFeatures: ['navigation bar', 'dark theme'],
      description: 'Tablet view of the main graph page',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // User-Story derived test cases
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Review page: Align tab ────────────────────────────────────────────────
  {
    id: 'review-align-tab',
    pageUrl: '/review',
    description: 'Review page with align tab for cross-KB alignment',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['.graph-pane', '.review-panel'],
      mustNotOverlap: [['.graph-pane', '.review-panel']],
      mustContainText: ['review', 'incoming', 'align'],
      semanticFeatures: ['split view', 'tab bar', 'align tab'],
      description: 'Review page with align tab visible in the tab bar',
    },
  },

  // ── KB page: multiple KBs ────────────────────────────────────────────────
  {
    id: 'kb-page-multi',
    pageUrl: '/kb',
    description: 'KB page showing multiple knowledge bases in registry',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['kb'],
      semanticFeatures: ['navigation bar', 'knowledge base list', 'dark theme'],
      description: 'KB management page with multiple KB entries',
    },
  },

  // ── Ingest page: KB import tab ────────────────────────────────────────────
  {
    id: 'ingest-kb-tab',
    pageUrl: '/ingest',
    description: 'Ingest page with KB tab for TTL file import',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['ingest', 'kb'],
      semanticFeatures: ['navigation bar', 'tab bar', 'file upload', 'dark theme'],
      description: 'Ingest page showing KB import tab with file upload area',
    },
  },

  // ── Mobile: Review page with align tab ─────────────────────────────────────
  {
    id: 'review-align-mobile',
    pageUrl: '/review',
    description: 'Review page align tab on mobile (stacked layout)',
    viewport: { width: 412, height: 915 },
    device: 'Pixel 7',
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['.graph-pane', '.review-panel'],
      mustNotOverlap: [],
      mustContainText: ['review'],
      semanticFeatures: ['stacked layout', 'review panel', 'mobile viewport'],
      description: 'Mobile review page with graph and panel stacked vertically',
    },
  },

  // ── Mobile: KB page ───────────────────────────────────────────────────────
  {
    id: 'kb-page-mobile',
    pageUrl: '/kb',
    description: 'KB management page on mobile viewport',
    viewport: { width: 412, height: 915 },
    device: 'Pixel 7',
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['kb'],
      semanticFeatures: ['navigation bar', 'mobile layout', 'dark theme'],
      description: 'Mobile KB page with touch-friendly layout',
    },
  },

  // ── Mobile: Ingest page ───────────────────────────────────────────────────
  {
    id: 'ingest-page-mobile',
    pageUrl: '/ingest',
    description: 'Ingest page on mobile viewport',
    viewport: { width: 412, height: 915 },
    device: 'Pixel 7',
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['ingest'],
      semanticFeatures: ['navigation bar', 'mobile layout', 'dark theme'],
      description: 'Mobile ingest page with responsive input form',
    },
  },

  // ── Tablet: Review page ───────────────────────────────────────────────────
  {
    id: 'review-page-tablet',
    pageUrl: '/review',
    description: 'Review page on tablet viewport',
    viewport: { width: 834, height: 1194 },
    device: 'iPad Pro 11',
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['.graph-pane', '.review-panel'],
      mustNotOverlap: [],
      mustContainText: ['review', 'incoming'],
      semanticFeatures: ['split or stacked view', 'review panel', 'tablet layout'],
      description: 'Tablet review page with adaptive layout',
    },
  },
];

// ── Storybook story fixtures (for visual regression against Storybook) ─────

export const STORYBOOK_TEST_CASES: VisualTestCase[] = [
  {
    id: 'navbar-graph-active',
    pageUrl: '/iframe.html?id=shell-navbar--graph-active&viewMode=story',
    description: 'NavBar component with graph tab active',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: false, // may be mostly dark background
      mustBeVisible: ['nav'],
      mustNotOverlap: [],
      mustContainText: ['graph', 'review'],
      semanticFeatures: ['navigation bar', 'active tab'],
      description: 'Bottom navigation bar with graph tab highlighted',
    },
  },
  {
    id: 'graph2d-force',
    pageUrl: '/iframe.html?id=graph-knowledgegraph2d--force-layout&viewMode=story',
    description: 'KnowledgeGraph2D force layout with seed data',
    viewport: { width: 1280, height: 720 },
    golden: {
      noSolidFill: true,
      notBlank: true,
      mustBeVisible: ['canvas'],
      mustNotOverlap: [],
      mustContainText: [], // canvas content — text is rendered on canvas, not DOM
      semanticFeatures: ['graph nodes', 'edges', 'force-directed layout'],
      description: 'A 2D force-directed knowledge graph with colored nodes and edges',
    },
  },
];
