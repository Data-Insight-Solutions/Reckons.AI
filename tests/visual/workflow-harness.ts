/**
 * Visual workflow harness (F34/F40) — run a user workflow across a DEVICE MATRIX,
 * capturing an annotated screenshot at every step and auto-detecting defects.
 *
 * The centrepiece is the bounding box: when a step is looking for a specific
 * control (the button to click, the field to fill), boxTarget() draws a labelled
 * highlight around it before the screenshot, so the review — a human or the local
 * VLM (vision-vlm.ts) — sees exactly what the step is verifying. Steps that just
 * check "is the graph visible" pass no target and get a plain screenshot.
 *
 * Auto-defect detection per step reuses the local (no-LLM) checks: horizontal
 * overflow, sub-44px touch targets, and DOM overlaps.
 */
import type { Page, Locator } from '@playwright/test';
import { writeFileSync, appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { screenshotTo } from './kb-seed';
import { auditTouchTargets, analyzeDOMOverlaps } from './vision-local';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');

// Records the ORDER steps are captured (per storyDir) so the visual-graph
// generator can lay the tour out in true workflow order, not alphabetical.
// Truncated on the first step of each storyDir per run, appended thereafter.
const _manifestStarted = new Set<string>();
function recordManifest(storyDir: string, step: string, label?: string): void {
  const dir = path.join(SHOTS, storyDir);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ step, label: label ?? step }) + '\n';
  const file = path.join(dir, '_manifest.jsonl');
  if (_manifestStarted.has(storyDir)) appendFileSync(file, line);
  else {
    writeFileSync(file, line);
    _manifestStarted.add(storyDir);
  }
}

/** Device viewports the workflows sweep. Phones → tablet → desktop. */
export const DEVICES = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'iphone', width: 390, height: 844 },
  { name: 'pixel', width: 412, height: 915 },
  { name: 'ipad', width: 834, height: 1194 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

export type Device = (typeof DEVICES)[number];

/**
 * Draw a labelled highlight box around `target` (a Playwright Locator), so the
 * screenshot shows the exact element under test. Returns a cleanup that removes
 * the overlay. No-op if the element has no box (hidden/detached).
 */
export async function boxTarget(page: Page, target: Locator, label?: string): Promise<() => Promise<void>> {
  const box = await target.boundingBox().catch(() => null);
  if (!box) return async () => {};
  await page.evaluate(
    ({ b, label }) => {
      const el = document.createElement('div');
      el.setAttribute('data-vtest-box', '1');
      Object.assign(el.style, {
        position: 'fixed',
        left: `${b.x}px`,
        top: `${b.y}px`,
        width: `${b.width}px`,
        height: `${b.height}px`,
        border: '3px solid #ff3b6b',
        borderRadius: '6px',
        boxShadow: '0 0 0 3px rgba(255,59,107,0.28), 0 0 14px rgba(255,59,107,0.55)',
        zIndex: '2147483647',
        pointerEvents: 'none',
        boxSizing: 'border-box',
      });
      if (label) {
        const tag = document.createElement('div');
        tag.textContent = label;
        Object.assign(tag.style, {
          position: 'absolute',
          left: '0',
          top: b.y > 26 ? '-22px' : '100%',
          background: '#ff3b6b',
          color: '#fff',
          font: '600 11px/1.5 monospace',
          padding: '1px 6px',
          borderRadius: '4px',
          whiteSpace: 'nowrap',
        });
        el.appendChild(tag);
      }
      document.body.appendChild(el);
    },
    { b: box, label },
  );
  return async () => {
    await page.evaluate(() => document.querySelectorAll('[data-vtest-box]').forEach((n) => n.remove()));
  };
}

/**
 * Screenshot a workflow step. If `opts.target` is given, box + label it first
 * (defaults the label to the step name), then remove the box after capture.
 * `storyDir` is typically `<workflow>/<device>` so device runs don't collide.
 */
export async function screenshotStep(
  page: Page,
  storyDir: string,
  name: string,
  opts?: { target?: Locator; label?: string },
): Promise<Buffer> {
  let cleanup = async () => {};
  if (opts?.target) cleanup = await boxTarget(page, opts.target, opts.label ?? name);
  const buf = await screenshotTo(page, storyDir, name);
  await cleanup();
  recordManifest(storyDir, name, opts?.label);
  return buf;
}

export interface StepDefects {
  overflow: boolean;
  smallTargets: { selector: string; text: string; width: number; height: number }[];
  overlaps: number;
}

/**
 * Local (no-LLM) defect scan for the current step: horizontal overflow, sub-44px
 * touch targets, and DOM overlaps. Cheap enough to run on every step of every
 * device — the fast layer beneath VLM review.
 */
export async function stepAudit(
  page: Page,
  overlapSelectors: string[] = ['nav', 'canvas', '[role="dialog"]', '.sheet-content', '.snap-panel'],
): Promise<StepDefects> {
  const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 2);
  const smallTargets = await auditTouchTargets(page);
  const dom = await analyzeDOMOverlaps(page, overlapSelectors);
  return { overflow, smallTargets, overlaps: dom.overlaps.length };
}

/**
 * Apply a device's viewport to the page. Call at the start of each device pass
 * of a workflow so every step is captured at that screen size.
 */
export async function useDevice(page: Page, device: Device): Promise<void> {
  await page.setViewportSize({ width: device.width, height: device.height });
}

/**
 * Wait for the app to finish booting before capturing — the shell shows a `.boot`
 * loader until the stores hydrate. A fixed timeout captured the loader instead of
 * the real UI on slower (dev) builds, so wait for `.boot` to detach + network
 * idle, then a short settle.
 */
export async function waitForAppReady(page: Page, timeout = 20_000): Promise<void> {
  await page.locator('.boot').waitFor({ state: 'detached', timeout }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
}
