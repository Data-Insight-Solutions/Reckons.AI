import { test, expect } from '@playwright/test';

/*
 * NOTHING BUT THE LANDING IS VISIBLE ON THE LANDING — asserted as a COMPLEMENT, deliberately.
 *
 * WHY THIS SHAPE. ?welcome let the marketing page render over a loaded graph, and the graph chrome
 * was gated on `visible.length > 0` — true only while the landing implied an empty graph. Every
 * overlay leaked onto it. It was then found one piece at a time, by a human looking at the screen:
 * first the filter panels, then the search bar, then the Statements/Sources toggle, then the
 * sources picker.
 *
 * Each time, my check confirmed the fix and missed the next one, because it ENUMERATED THE THINGS
 * I ALREADY SUSPECTED — "are panels hidden? is search hidden?". A test written from a hypothesis
 * can only ever confirm or deny that hypothesis; it cannot find what nobody thought to list. The
 * fourth report made the pattern obvious: the test was the problem, not the fixes.
 *
 * So this enumerates what IS VISIBLE and asks what it belongs to. Anything on screen that is not
 * part of the landing fails, including things that do not exist yet. That is the only version of
 * this test that can catch the fifth one.
 *
 * BOTH PERSPECTIVES, because the sources picker leaked in exactly the state the earlier check was
 * never in. A test that only visits one mode tests one mode.
 */
const ALLOWED = [
  /^skip to content$/i, // the a11y skip link belongs on every page
];

for (const perspective of ['statements', 'sources'] as const) {
  test(`no graph chrome leaks onto the landing (${perspective} perspective)`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Getting started/i }).click();
    await page.waitForTimeout(6000);

    if (perspective === 'sources') {
      const toggle = page.getByRole('button', { name: 'Sources', exact: true });
      if (await toggle.count()) await toggle.first().click();
      await page.waitForTimeout(1500);
    }

    await page.goto('/?welcome');
    await page.waitForTimeout(4000);

    const strays = await page.evaluate(() => {
      const landing = document.querySelector('.landing');
      const out: { tag: string; text: string; owner: string }[] = [];
      const seen = new Set<string>();
      for (const el of document.querySelectorAll('button, a[href], input, select, [role=group], canvas')) {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) continue;
        if (landing?.contains(el)) continue;
        let top: Element = el;
        while (top.parentElement && top.parentElement !== document.body && !landing?.contains(top.parentElement)) {
          top = top.parentElement;
        }
        const owner = (typeof top.className === 'string' && top.className.slice(0, 40)) || top.tagName;
        if (seen.has(owner)) continue;
        seen.add(owner);
        out.push({ tag: el.tagName.toLowerCase(), text: (el as HTMLElement).innerText?.trim().slice(0, 30) ?? '', owner });
      }
      return out;
    });

    const unexpected = strays.filter((s) => !ALLOWED.some((re) => re.test(s.text)));
    if (unexpected.length) {
      console.log('leaked onto the landing:', unexpected.map((s) => `${s.tag} "${s.text}" ← ${s.owner}`).join(' | '));
    }
    expect(unexpected, 'graph chrome is visible on the marketing landing').toEqual([]);

    // And the landing itself must actually be there — an empty page would pass the check above.
    await expect(page.locator('.alpha-badge')).toBeVisible();
  });
}
