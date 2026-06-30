/**
 * Visual scoring for generated landing pages.
 *
 * Renders HTML in a headless Chromium browser, takes a screenshot, and scores
 * visual properties: brand color presence, layout integrity, text visibility,
 * contrast, section count, and touch target compliance.
 *
 * Uses the same pixel/DOM/text analysis from tests/visual/vision-local.ts.
 */

import { chromium, type Browser, type Page } from 'playwright';

// ── Types ────────────────────────────────────────────────────────────────────

export interface VisualCheckResult {
  id: string;
  passed: boolean;
  weight: number;
  detail: string;
}

export interface VisualScore {
  score: number;
  maxScore: number;
  pct: number;
  checks: VisualCheckResult[];
  screenshotPath?: string;
  durationMs: number;
}

interface ColorSample {
  r: number;
  g: number;
  b: number;
  count: number;
}

// ── Color utilities ─────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

// ── Pixel analysis (inline, no pngjs dependency for bench portability) ──────

async function analyzeScreenshotColors(page: Page): Promise<{
  samples: ColorSample[];
  totalSampled: number;
  avgBrightness: number;
  uniqueColors: number;
}> {
  // Use canvas-based pixel sampling inside the browser — no pngjs needed
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const w = window.innerWidth;
    const h = Math.min(document.documentElement.scrollHeight, 4000); // cap at 4000px
    canvas.width = w;
    canvas.height = h;

    // Draw the page content to canvas via foreignObject SVG
    // Instead, sample computed background colors from DOM elements
    const colorCounts = new Map<string, number>();
    let totalSampled = 0;
    let brightnessSum = 0;

    // Sample background colors from a grid of points
    const stepX = Math.max(1, Math.floor(w / 40));
    const stepY = Math.max(1, Math.floor(h / 40));

    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        const style = window.getComputedStyle(el);
        const bg = style.backgroundColor;
        const color = style.color;

        for (const c of [bg, color]) {
          if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') continue;
          colorCounts.set(c, (colorCounts.get(c) ?? 0) + 1);
          totalSampled++;

          // Parse rgb/rgba
          const match = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (match) {
            const r = parseInt(match[1]);
            const g = parseInt(match[2]);
            const b = parseInt(match[3]);
            brightnessSum += (r + g + b) / 3;
          }
        }
      }
    }

    const samples: Array<{ r: number; g: number; b: number; count: number }> = [];
    for (const [c, count] of colorCounts) {
      const match = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        samples.push({
          r: parseInt(match[1]),
          g: parseInt(match[2]),
          b: parseInt(match[3]),
          count,
        });
      }
    }

    return {
      samples: samples.sort((a, b) => b.count - a.count),
      totalSampled,
      avgBrightness: totalSampled > 0 ? brightnessSum / totalSampled : 128,
      uniqueColors: colorCounts.size,
    };
  });
}

// ── DOM metrics ─────────────────────────────────────────────────────────────

interface DOMMetrics {
  sectionCount: number;
  headingCount: number;
  linkCount: number;
  imageCount: number;
  totalTextLength: number;
  viewportHeight: number;
  scrollHeight: number;
  hasOverflowX: boolean;
  smallTouchTargets: number;
  contrastIssues: number;
}

async function analyzeDOMMetrics(page: Page): Promise<DOMMetrics> {
  return page.evaluate(() => {
    const sections = document.querySelectorAll('section, [class*="section"], [class*="hero"], [class*="footer"]');
    const headings = document.querySelectorAll('h1, h2, h3, h4');
    const links = document.querySelectorAll('a, button');
    const images = document.querySelectorAll('img, svg, [class*="icon"]');

    // Text content length
    const bodyText = document.body.innerText || '';

    // Overflow detection
    const hasOverflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth + 5;

    // Touch target audit (44px minimum per WCAG 2.5.5)
    let smallTouchTargets = 0;
    for (const el of document.querySelectorAll('a, button, [role="button"], input, select')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) {
        smallTouchTargets++;
      }
    }

    // Contrast check: sample text elements
    let contrastIssues = 0;
    for (const el of document.querySelectorAll('p, h1, h2, h3, h4, span, a, li')) {
      const style = window.getComputedStyle(el as Element);
      const color = style.color;
      const bg = style.backgroundColor;
      if (!color || !bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;

      const parseRgb = (c: string) => {
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) } : null;
      };

      const fg = parseRgb(color);
      const bgc = parseRgb(bg);
      if (!fg || !bgc) continue;

      // Relative luminance (simplified)
      const lum = (c: { r: number; g: number; b: number }) => {
        const rs = c.r / 255, gs = c.g / 255, bs = c.b / 255;
        const rl = rs <= 0.03928 ? rs / 12.92 : ((rs + 0.055) / 1.055) ** 2.4;
        const gl = gs <= 0.03928 ? gs / 12.92 : ((gs + 0.055) / 1.055) ** 2.4;
        const bl = bs <= 0.03928 ? bs / 12.92 : ((bs + 0.055) / 1.055) ** 2.4;
        return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
      };

      const l1 = lum(fg), l2 = lum(bgc);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < 3.0) contrastIssues++; // Below WCAG AA for large text
    }

    return {
      sectionCount: sections.length,
      headingCount: headings.length,
      linkCount: links.length,
      imageCount: images.length,
      totalTextLength: bodyText.length,
      viewportHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      hasOverflowX,
      smallTouchTargets,
      contrastIssues,
    };
  });
}

// ── Text visibility check ───────────────────────────────────────────────────

async function checkVisibleText(page: Page, expected: string[]): Promise<{ found: string[]; missing: string[] }> {
  const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase());
  const found = expected.filter(t => bodyText.includes(t.toLowerCase()));
  const missing = expected.filter(t => !bodyText.includes(t.toLowerCase()));
  return { found, missing };
}

// ── Main scoring function ───────────────────────────────────────────────────

export interface VisualScoreOptions {
  /** Brand colors to check for (hex strings) */
  brandColors: { id: string; hex: string; weight: number }[];
  /** Text that must be visible in the rendered page */
  expectedText: { id: string; text: string; weight: number }[];
  /** Path to save screenshot (optional) */
  screenshotPath?: string;
  /** Viewport width */
  viewportWidth?: number;
  /** Viewport height */
  viewportHeight?: number;
}

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!_browser) {
    _browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

export async function scoreVisual(html: string, opts: VisualScoreOptions): Promise<VisualScore> {
  const start = Date.now();
  const checks: VisualCheckResult[] = [];
  const vw = opts.viewportWidth ?? 1280;
  const vh = opts.viewportHeight ?? 800;

  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });

  try {
    await page.setContent(html, { waitUntil: 'networkidle' });

    // 1. Brand color presence
    const colorData = await analyzeScreenshotColors(page);
    for (const bc of opts.brandColors) {
      const target = hexToRgb(bc.hex);
      const found = colorData.samples.some(s => colorDistance(target, s) < 40);
      checks.push({
        id: `color:${bc.id}`,
        passed: found,
        weight: bc.weight,
        detail: found ? `${bc.hex} found in rendered page` : `${bc.hex} not detected in computed styles`,
      });
    }

    // 2. Text visibility
    const textCheck = await checkVisibleText(page, opts.expectedText.map(t => t.text));
    for (const et of opts.expectedText) {
      const found = textCheck.found.some(f => f === et.text.toLowerCase());
      checks.push({
        id: `text:${et.id}`,
        passed: found,
        weight: et.weight,
        detail: found ? `"${et.text}" visible` : `"${et.text}" not visible in rendered page`,
      });
    }

    // 3. DOM metrics
    const dom = await analyzeDOMMetrics(page);

    // Not blank
    checks.push({
      id: 'not-blank',
      passed: dom.totalTextLength > 100,
      weight: 1.0,
      detail: dom.totalTextLength > 100
        ? `${dom.totalTextLength} chars of text content`
        : `Only ${dom.totalTextLength} chars — page appears empty`,
    });

    // Has multiple sections (landing page should have 3+)
    checks.push({
      id: 'section-count',
      passed: dom.sectionCount >= 3,
      weight: 0.5,
      detail: `${dom.sectionCount} sections detected (need 3+)`,
    });

    // Has headings
    checks.push({
      id: 'has-headings',
      passed: dom.headingCount >= 2,
      weight: 0.5,
      detail: `${dom.headingCount} headings (h1-h4)`,
    });

    // Has interactive elements (CTA buttons/links)
    checks.push({
      id: 'has-cta',
      passed: dom.linkCount >= 1,
      weight: 0.5,
      detail: `${dom.linkCount} links/buttons`,
    });

    // No horizontal overflow
    checks.push({
      id: 'no-overflow-x',
      passed: !dom.hasOverflowX,
      weight: 0.75,
      detail: dom.hasOverflowX ? 'horizontal scroll detected' : 'no horizontal overflow',
    });

    // Scrollable (multi-section landing page should be taller than viewport)
    checks.push({
      id: 'scrollable',
      passed: dom.scrollHeight > vh * 1.5,
      weight: 0.25,
      detail: `scroll height ${dom.scrollHeight}px (viewport ${vh}px)`,
    });

    // Contrast
    checks.push({
      id: 'contrast',
      passed: dom.contrastIssues <= 3,
      weight: 0.5,
      detail: dom.contrastIssues === 0
        ? 'no contrast issues'
        : `${dom.contrastIssues} elements below WCAG AA contrast`,
    });

    // Touch targets (mobile-readiness)
    checks.push({
      id: 'touch-targets',
      passed: dom.smallTouchTargets <= 2,
      weight: 0.25,
      detail: dom.smallTouchTargets === 0
        ? 'all touch targets >= 44px'
        : `${dom.smallTouchTargets} targets below 44px`,
    });

    // Save screenshot
    if (opts.screenshotPath) {
      const ss = await page.screenshot({ fullPage: true });
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(opts.screenshotPath), { recursive: true });
      writeFileSync(opts.screenshotPath, ss);
    }
  } finally {
    await page.close();
  }

  let score = 0;
  let maxScore = 0;
  for (const c of checks) {
    maxScore += c.weight;
    if (c.passed) score += c.weight;
  }

  return {
    score,
    maxScore,
    pct: maxScore > 0 ? score / maxScore : 1,
    checks,
    screenshotPath: opts.screenshotPath,
    durationMs: Date.now() - start,
  };
}
