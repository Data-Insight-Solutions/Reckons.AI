/**
 * Local visual analysis tools — no API calls needed.
 *
 * Analysis tiers (cheapest → most capable):
 *  1. Pixel statistics  — detect solid fills, blank screens, color anomalies
 *  2. DOM analysis      — bounding box overlaps, z-index audit, element visibility
 *  3. Text extraction   — DOM text presence checks (no OCR needed for DOM content)
 *  4. OCR (optional)    — canvas/image text readability via tesseract.js
 *  5. CLIP (optional)   — semantic similarity via transformers.js
 *
 * All functions are designed to run fast (<50ms for tiers 1-3) so they can
 * gate whether expensive API calls are needed.
 */

import { evalStable } from './eval-stable';
import type { Page } from '@playwright/test';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PixelAnalysis {
  width: number;
  height: number;
  dominantColor: string;
  dominantColorRatio: number;
  averageBrightness: number;
  uniqueColorCount: number;
  isSolidFill: boolean;
  isBlank: boolean;
  hasColorAnomaly: boolean;
  anomalyDetails: string[];
}

export interface OverlapResult {
  element1: string;
  element2: string;
  rect1: { x: number; y: number; width: number; height: number };
  rect2: { x: number; y: number; width: number; height: number };
  overlapArea: number;
  overlapPercent: number;
}

export interface DOMAnalysis {
  visibleElements: Array<{
    selector: string;
    visible: boolean;
    rect: { x: number; y: number; width: number; height: number } | null;
  }>;
  overlaps: OverlapResult[];
  offscreenElements: Array<{
    selector: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  zIndexIssues: string[];
}

export interface TextAnalysis {
  visibleTexts: string[];
  expectedFound: string[];
  expectedMissing: string[];
}

export interface TouchTargetIssue {
  selector: string;
  text: string;
  width: number;
  height: number;
}

export interface LocalAnalysis {
  pixel: PixelAnalysis;
  dom: DOMAnalysis;
  text: TextAnalysis;
  touchTargets: TouchTargetIssue[];
  durationMs: number;
}

// ── Pixel Analysis ───────────────────────────────────────────────────────────

const ARTIFACT_COLORS = [
  { r: 255, g: 0,   b: 255, name: 'magenta' },
  { r: 230, g: 0,   b: 255, name: 'accent-magenta' },
  { r: 0,   g: 255, b: 0,   name: 'solid-green' },
  { r: 255, g: 0,   b: 0,   name: 'solid-red' },
  { r: 0,   g: 0,   b: 255, name: 'solid-blue' },
  { r: 255, g: 255, b: 0,   name: 'solid-yellow' },
];

export async function analyzePixels(screenshot: Buffer): Promise<PixelAnalysis> {
  // @ts-expect-error pngjs has no bundled type declarations
  const pngjs = await import('pngjs');
  const png = pngjs.PNG.sync.read(screenshot) as { width: number; height: number; data: Buffer };
  const { width, height, data } = png;

  // Sample every Nth pixel for speed (target ~40k samples)
  const totalPixels = width * height;
  const step = Math.max(1, Math.floor(totalPixels / 40_000));
  const colorCounts = new Map<number, number>();
  let totalSampled = 0;
  let brightnessSum = 0;

  for (let i = 0; i < totalPixels; i += step) {
    const idx = i * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    // Quantize to 32-level bins to reduce noise
    const qr = (r >> 3) << 3;
    const qg = (g >> 3) << 3;
    const qb = (b >> 3) << 3;
    const key = (qr << 16) | (qg << 8) | qb;
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
    brightnessSum += (r + g + b) / 3;
    totalSampled++;
  }

  // Find dominant color
  let dominantKey = 0;
  let dominantCount = 0;
  for (const [key, count] of colorCounts) {
    if (count > dominantCount) {
      dominantKey = key;
      dominantCount = count;
    }
  }

  const dr = (dominantKey >> 16) & 0xff;
  const dg = (dominantKey >> 8) & 0xff;
  const db = dominantKey & 0xff;
  const dominantColor = `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;
  const dominantColorRatio = totalSampled > 0 ? dominantCount / totalSampled : 0;
  const averageBrightness = totalSampled > 0 ? brightnessSum / totalSampled : 0;
  const uniqueColorCount = colorCounts.size;

  const isSolidFill = dominantColorRatio > 0.85;
  const isBlank =
    (averageBrightness < 5 || averageBrightness > 250) &&
    uniqueColorCount < 15;

  // Check for artifact colors
  const anomalyDetails: string[] = [];
  let hasColorAnomaly = false;

  if (isSolidFill) {
    for (const ac of ARTIFACT_COLORS) {
      const dist = Math.sqrt(
        (dr - ac.r) ** 2 + (dg - ac.g) ** 2 + (db - ac.b) ** 2,
      );
      if (dist < 50) {
        hasColorAnomaly = true;
        anomalyDetails.push(
          `Solid ${ac.name} fill detected (${dominantColor}, ${(dominantColorRatio * 100).toFixed(1)}% of pixels)`,
        );
        break;
      }
    }
    if (!hasColorAnomaly) {
      anomalyDetails.push(
        `Solid fill: ${dominantColor} covers ${(dominantColorRatio * 100).toFixed(1)}% of pixels`,
      );
    }
  }

  if (isBlank) {
    anomalyDetails.push(
      `Blank screen: avg brightness ${averageBrightness.toFixed(0)}, ${uniqueColorCount} unique colors`,
    );
  }

  return {
    width,
    height,
    dominantColor,
    dominantColorRatio,
    averageBrightness,
    uniqueColorCount,
    isSolidFill,
    isBlank,
    hasColorAnomaly,
    anomalyDetails,
  };
}

// ── DOM Analysis ─────────────────────────────────────────────────────────────

export async function analyzeDOMOverlaps(
  page: Page,
  selectors: string[],
): Promise<DOMAnalysis> {
  const viewport = page.viewportSize()!;

  const elements = await Promise.all(
    selectors.map(async (sel) => {
      const el = page.locator(sel).first();
      const visible = await el.isVisible().catch(() => false);
      const rect = visible
        ? await el.boundingBox().catch(() => null)
        : null;
      return { selector: sel, visible, rect };
    }),
  );

  // Detect overlaps between visible elements
  const overlaps: OverlapResult[] = [];
  const visibleEls = elements.filter((e) => e.visible && e.rect);

  for (let i = 0; i < visibleEls.length; i++) {
    for (let j = i + 1; j < visibleEls.length; j++) {
      const a = visibleEls[i].rect!;
      const b = visibleEls[j].rect!;

      const overlapX = Math.max(
        0,
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
      );
      const overlapY = Math.max(
        0,
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
      );
      const overlapArea = overlapX * overlapY;

      if (overlapArea > 100) {
        // >100px² to ignore sub-pixel overlaps
        const smallerArea = Math.min(
          a.width * a.height,
          b.width * b.height,
        );
        overlaps.push({
          element1: visibleEls[i].selector,
          element2: visibleEls[j].selector,
          rect1: a,
          rect2: b,
          overlapArea,
          overlapPercent: smallerArea > 0 ? overlapArea / smallerArea : 0,
        });
      }
    }
  }

  // Off-screen elements
  const offscreenElements = visibleEls
    .filter((e) => {
      const r = e.rect!;
      return (
        r.x + r.width < 0 ||
        r.y + r.height < 0 ||
        r.x > viewport.width ||
        r.y > viewport.height
      );
    })
    .map((e) => ({ selector: e.selector, rect: e.rect! }));

  // Z-index audit
  const zIndexIssues = await evalStable(page, (sels: string[]) => {
    const issues: string[] = [];
    const positioned: Array<{
      sel: string;
      z: number;
      rect: DOMRect;
    }> = [];

    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const style = window.getComputedStyle(el);
      if (style.position !== 'static') {
        const z = parseInt(style.zIndex) || 0;
        positioned.push({ sel, z, rect: el.getBoundingClientRect() });
      }
    }

    for (let i = 0; i < positioned.length; i++) {
      for (let j = i + 1; j < positioned.length; j++) {
        const a = positioned[i],
          b = positioned[j];
        if (a.z === b.z && a.z > 0) {
          const ox = Math.max(
            0,
            Math.min(a.rect.right, b.rect.right) -
              Math.max(a.rect.left, b.rect.left),
          );
          const oy = Math.max(
            0,
            Math.min(a.rect.bottom, b.rect.bottom) -
              Math.max(a.rect.top, b.rect.top),
          );
          if (ox > 0 && oy > 0) {
            issues.push(
              `z-index collision: ${a.sel} and ${b.sel} both at z=${a.z}`,
            );
          }
        }
      }
    }

    return issues;
  }, selectors);

  return { visibleElements: elements, overlaps, offscreenElements, zIndexIssues };
}

// ── Text Analysis (DOM-based) ────────────────────────────────────────────────

export async function analyzeText(
  page: Page,
  expectedLabels: string[],
): Promise<TextAnalysis> {
  const visibleTexts: string[] = await evalStable(page, () => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const el = node.parentElement;
          if (!el) return NodeFilter.FILTER_REJECT;
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          )
            return NodeFilter.FILTER_REJECT;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0)
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    const texts: string[] = [];
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent?.trim();
      if (t && t.length > 0) texts.push(t);
    }
    return texts;
  });

  const allText = visibleTexts.join(' ').toLowerCase();
  const expectedFound = expectedLabels.filter((l) =>
    allText.includes(l.toLowerCase()),
  );
  const expectedMissing = expectedLabels.filter(
    (l) => !allText.includes(l.toLowerCase()),
  );

  return { visibleTexts, expectedFound, expectedMissing };
}

// ── Touch Target Audit ───────────────────────────────────────────────────────

const MIN_TOUCH_TARGET = 44; // WCAG 2.5.5

export async function auditTouchTargets(
  page: Page,
): Promise<TouchTargetIssue[]> {
  return evalStable(page, (minSize: number) => {
    const interactive = document.querySelectorAll(
      'button, a, [role="button"], input, select, textarea, [tabindex]',
    );
    const issues: Array<{
      selector: string;
      text: string;
      width: number;
      height: number;
    }> = [];

    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // hidden
      if (r.width < minSize || r.height < minSize) {
        const text = (el as HTMLElement).innerText?.trim().slice(0, 30) || el.tagName;
        // Build a minimal selector
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className
          ? `.${String(el.className).split(' ')[0]}`
          : '';
        issues.push({
          selector: `${el.tagName.toLowerCase()}${id || cls}`,
          text,
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      }
    }

    return issues;
  }, MIN_TOUCH_TARGET);
}

// ── Combined Local Analysis ──────────────────────────────────────────────────

export async function runLocalAnalysis(
  page: Page,
  opts: {
    selectors?: string[];
    expectedLabels?: string[];
  } = {},
): Promise<LocalAnalysis> {
  const start = Date.now();

  const screenshot = await page.screenshot();
  const [pixel, dom, text, touchTargets] = await Promise.all([
    analyzePixels(screenshot),
    analyzeDOMOverlaps(page, opts.selectors ?? ['nav', 'canvas', 'main', 'aside']),
    analyzeText(page, opts.expectedLabels ?? []),
    auditTouchTargets(page),
  ]);

  return {
    pixel,
    dom,
    text,
    touchTargets,
    durationMs: Date.now() - start,
  };
}

// ── Tier 4: OCR (tesseract.js) ────────────────────────────────────────────────
//
// Read the actual RENDERED text off a screenshot, for exact-text assertions the
// DOM can't give you (canvas labels, and confirming what a user really sees).
// Dark-theme UIs are low-contrast for Tesseract, so `invert` (default) flips to
// dark-on-light + upscales 2x — which recovers body text reliably. Stylized
// display fonts stay noisy, so assert on SUBSTRINGS via screenshotHasText, not
// exact matches.

/** Invert → grayscale → 2x upscale a PNG in-memory (helps Tesseract on dark UIs). */
async function preprocessForOcr(screenshot: Buffer): Promise<Buffer> {
  // @ts-expect-error pngjs has no bundled type declarations
  const pngjs = await import('pngjs');
  const png = pngjs.PNG.sync.read(screenshot) as { width: number; height: number; data: Buffer };
  const { width, height, data } = png;
  const scale = 2;
  const out = new pngjs.PNG({ width: width * scale, height: height * scale });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const g = 255 - Math.round((data[i] + data[i + 1] + data[i + 2]) / 3); // invert to dark-on-light
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const oi = (((y * scale + dy) * width * scale) + (x * scale + dx)) * 4;
          out.data[oi] = out.data[oi + 1] = out.data[oi + 2] = g;
          out.data[oi + 3] = 255;
        }
      }
    }
  }
  return pngjs.PNG.sync.write(out);
}

/** OCR a screenshot buffer → raw text. `invert` (default true) preprocesses for dark UIs. */
export async function ocrScreenshot(screenshot: Buffer, opts: { invert?: boolean } = {}): Promise<string> {
  const input = opts.invert === false ? screenshot : await preprocessForOcr(screenshot);
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(input);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

/** Normalize OCR text for robust substring matching (lowercase, alnum, collapsed spaces). */
export function normalizeOcr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when every `needle` appears in the screenshot's OCR'd text (order-independent). */
export async function screenshotHasText(screenshot: Buffer, needles: string | string[]): Promise<boolean> {
  const text = normalizeOcr(await ocrScreenshot(screenshot));
  const list = Array.isArray(needles) ? needles : [needles];
  return list.every((n) => text.includes(normalizeOcr(n)));
}
