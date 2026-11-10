/**
 * F275 — title and end cards for a demo video, drawn as HTML in the app's own fonts, colors and logo,
 * then photographed at 1920x1080 by the Playwright the repository already uses.
 *
 * WHY AN END CARD IS NOT OPTIONAL: F275's constraint says a video narrated with Hume says so in its
 * credits, so the claim on screen stays true. The receipt alone is not "on screen"; the card is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Card = { heading: string; lines: string[] };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The card page. Pure: fonts and logo come from `root` (the repository), nothing is fetched. */
export function cardHtml(card: Card, root: string): string {
  const font = (p: string) => pathToFileURL(join(root, 'static/fonts', p)).href;
  const logo = readFileSync(join(root, 'static/svg/ReckonsAI-LogoText.svg'), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Bespoke Stencil'; src: url('${font('bespoke-stencil/BespokeStencil-Variable.woff2')}') format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Supreme'; src: url('${font('supreme/Supreme-Variable.woff2')}') format('woff2'); font-weight: 100 900; }
html, body { margin: 0; width: 100%; height: 100%; background: radial-gradient(ellipse at 50% 35%, #12303a 0%, #0a0f14 70%); color: #e6edf3; }
body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; font-family: 'Supreme', system-ui, sans-serif; text-align: center; }
.logo svg { width: 360px; height: auto; }
h1 { font-family: 'Bespoke Stencil', 'Supreme', sans-serif; font-weight: 700; font-size: 44px; line-height: 1.2; margin: 0; max-width: 1000px; }
p { margin: 0; font-size: 24px; line-height: 1.5; color: #a9b8c6; max-width: 980px; }
.rule { width: 96px; height: 3px; background: #1a9b8e; border-radius: 2px; }
</style></head><body>
<div class="logo">${logo}</div>
<div class="rule"></div>
<h1>${esc(card.heading)}</h1>
${card.lines.map((l) => `<p>${esc(l)}</p>`).join('\n')}
</body></html>`;
}

/** The end card's lines: what the video showed, then every credit the receipt carries. Pure. */
export function endCardLines(credits: string[]): string[] {
  // No claim about where the pictures were made: that is per-workflow, and no workflow data states it for the card.
  return [...credits, 'reckons.ai'];
}

/** Photograph each card at 1920x1080 (a 1280x720 layout at 1.5x, like the recording). */
export async function renderCards(cards: { html: string; out: string }[]): Promise<void> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
    for (const c of cards) {
      await page.setContent(c.html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: c.out });
    }
  } finally {
    await browser.close();
  }
}
