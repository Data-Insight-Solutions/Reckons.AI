/**
 * A RENDERED check for the docs, because every other docs gate is a text gate.
 *
 * WHY THIS EXISTS, precisely. On 2026-09-06 the published docs shipped three faults at once:
 * every stage label printed the literal string "4 &middot; Use" at readers; the SVG normalizer had
 * stripped `width` from all 153 <rect> and all 55 <foreignObject> elements across nine diagrams and
 * set height="100%" on 107 children, so every node box was as tall as the whole diagram with no
 * width to give it shape; and a 420px cap scaled the tallest diagram to ~0.42, rendering its 16px
 * labels at about 7px. Throughout, graph-lint parsed, the diagram cache hit, md-align matched all
 * 316 files and all six align gates reported ALIGNED. Matt found all of it by looking at the page.
 *
 * So the assertions below are not generic smoke. Each one is a bug that shipped, expressed as a
 * rule a browser can check: an entity that reached a reader, a box with no width, text too small to
 * read. Screenshots are captured as evidence, but the screenshots are not the test — a picture
 * nobody opens is not a gate, which is the whole lesson of that day.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.DOCS_BASE_URL ?? 'http://localhost:5174';

/**
 * Representative pages, chosen for what each one exercises rather than for coverage:
 * a hub with a diagram and a child list, a path whose numbered steps are links, a page whose
 * thin children are folded into it, and a plain text page with no picture at all.
 */
const PAGES = [
  { path: '/docs/user-paths/user-paths', name: 'hub-with-diagram', diagram: true },
  { path: '/docs/user-paths/core-loop', name: 'path-with-steps', diagram: true },
  { path: '/docs/features/review-system', name: 'folded-children', diagram: false },
  { path: '/docs/guide/what-is-reckons-ai', name: 'text-only', diagram: false },
];

/** Entities that reached a reader as literal text. `&middot;` shipped; the rest are the family. */
const HTML_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/;

async function gotoDoc(page: Page, path: string): Promise<void> {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  expect(res?.status(), `${path} should be served`).toBeLessThan(400);
  await expect(page.locator('.doc-prose, main').first()).toBeVisible();
}

test.describe('docs render as documents', () => {
  for (const { path, name, diagram } of PAGES) {
    test(`${name} — no HTML entity reaches the reader`, async ({ page }) => {
      await gotoDoc(page, path);
      // Read the TEXT, not the HTML: `&middot;` in the source is correct when it is an entity and
      // wrong when it is content, and only the rendered text can tell those apart.
      const text = await page.locator('main').innerText();
      const found = text.match(HTML_ENTITY);
      expect(found?.[0], `"${found?.[0]}" is being printed at readers on ${path}`).toBeUndefined();
    });

    test(`${name} — the page is not empty`, async ({ page }) => {
      await gotoDoc(page, path);
      const words = (await page.locator('main').innerText()).trim().split(/\s+/).length;
      expect(words, `${path} rendered ${words} words`).toBeGreaterThan(25);
    });

    test(`${name} — the page does not scroll sideways`, async ({ page }) => {
      await gotoDoc(page, path);
      // A wide diagram must scroll inside its own figure, never take the page with it.
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
    });

    if (diagram) {
      test(`${name} — the diagram has a real box, and so do its nodes`, async ({ page }) => {
        await gotoDoc(page, path);
        const svg = page.locator('figure.diagram svg').first();
        await expect(svg).toBeVisible();

        const box = await svg.boundingBox();
        expect(box, 'the diagram has no layout box at all').not.toBeNull();
        expect(box!.width).toBeGreaterThan(200);
        // Catches COLLAPSE, not shortness. A wide left-to-right chain is legitimately short — the
        // core loop is 1001x122, so ~71px tall in the content column, and asserting 100px here
        // failed a diagram that renders perfectly. Whether a short diagram is still READABLE is a
        // different question, and the font-size test below is the one that answers it.
        expect(box!.height).toBeGreaterThan(40);

        // THE REGRESSION, stated as a rule. A node container stripped of `width` renders at zero,
        // and one given height="100%" renders as tall as the whole diagram. Both are visible here
        // and invisible to every text gate.
        const bad = await svg.evaluate((el) => {
          const out: string[] = [];
          for (const rect of Array.from(el.querySelectorAll('rect.label-container, rect.basic'))) {
            const r = (rect as SVGGraphicsElement).getBBox();
            if (r.width <= 1) out.push(`rect width=${r.width}`);
          }
          for (const fo of Array.from(el.querySelectorAll('foreignObject'))) {
            if (!fo.getAttribute('width')) out.push('foreignObject with no width');
          }
          if (el.querySelector('[height="100%"]:not(svg)')) out.push('child with height="100%"');
          return out.slice(0, 5);
        });
        expect(bad, `broken diagram geometry on ${path}`).toEqual([]);
      });

      test(`${name} — the diagram's text is large enough to read`, async ({ page }) => {
        await gotoDoc(page, path);
        const svg = page.locator('figure.diagram svg').first();
        await expect(svg).toBeVisible();

        // A cap on the figure scales the SVG down, and the labels with it. The first version
        // capped at 420px and rendered a 944x988 diagram's 16px labels at about 7px — present,
        // and unreadable. Effective size is the declared size times the rendering scale.
        const smallest = await svg.evaluate((node) => {
          const el = node as unknown as SVGSVGElement;
          const scale = el.getBoundingClientRect().width / (el.viewBox.baseVal.width || 1);
          const sizes = Array.from(el.querySelectorAll('text, .nodeLabel, foreignObject div'))
            .map((n) => parseFloat(getComputedStyle(n as Element).fontSize) * scale)
            .filter((n) => Number.isFinite(n) && n > 0);
          return sizes.length ? Math.min(...sizes) : 0;
        });
        expect(smallest, `smallest diagram text renders at ${smallest.toFixed(1)}px`)
          .toBeGreaterThan(9);
      });
    }
  }
});

test.describe('docs survive both themes and a phone', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the hub is legible in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gotoDoc(page, PAGES[0].path);
      const svg = page.locator('figure.diagram svg').first();
      await expect(svg).toBeVisible();

      // Mermaid bakes near-white plates behind edge labels. They are invisible in light and a pale
      // blob per label in dark, so the palette must be rewritten onto site variables, not shipped.
      const baked = await svg.evaluate((el) =>
        /rgba?\(\s*232\s*,\s*232\s*,\s*232|rgba?\(\s*185\s*,\s*185\s*,\s*185/.test(el.outerHTML));
      expect(baked, 'mermaid default greys survived into the shipped SVG').toBe(false);

      await page.screenshot({
        path: `tests/visual/screenshots/docs-hub-${scheme}.png`,
        fullPage: true,
      });
    });
  }

  test('a phone gets the docs without sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const { path } of PAGES) {
      await gotoDoc(page, path);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} overflows a 390px viewport by ${overflow}px`).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: 'tests/visual/screenshots/docs-mobile.png', fullPage: true });
  });
});
