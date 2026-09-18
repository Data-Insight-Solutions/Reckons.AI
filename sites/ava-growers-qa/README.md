# Ava Farmers Market — static site

Three pages: **home, about, contact**. No build step, no framework, no external requests, no
third-party scripts. Deploys to Cloudflare Pages by pointing a project at this folder.

It lives inside the Reckons.AI repository for now as a website-building example. Nothing here
imports from Reckons.AI, so `sites/ava-growers/` can be copied into its own repository at any
time and will work unchanged.

## Two folders, on purpose

- **`sites/ava-growers/`** is the Cloudflare Pages build output directory. Everything in it is
  PUBLISHED at the domain, so it holds the site and nothing else.
- **`sites/ava-growers-qa/`** holds this README and the QA sweep. They were briefly inside the
  site folder, which would have published a 4.8 MB screenshot archive and these maintainer notes
  at `/README.md`.

---

## Naming

- **Ava Farmers Market** is the public-facing name and what the Facebook page uses. It is the
  name people know, so it leads on the site.
- **Ava Growers Project, Inc.** is the 501(c)(3) nonprofit that runs and sponsors the market. It
  is named on every page and carries the copyright and the donation line.

---

## Where each fact came from

The previous avagrowers.com was lost with the domain, so nothing was taken on trust from it.
Where sources disagreed, the more recent and more authoritative one won.

| Fact | Source |
|---|---|
| Saturday mornings, **8am–12pm** | Facebook page About, the 2026 Chili Cook-Off poster, and the Ava Chamber member spotlight — three independent sources |
| Season **April through October** | Facebook page About + Chamber member spotlight |
| "Growers and makers market" | The market's own Facebook description |
| Ava Public Square, Ava, MO 65608 | Ava Chamber of Commerce business directory |
| Gazebo at 215 E. Jefferson St | 2026 Chili Cook-Off poster |
| Produce, plants, crafts, small animals | Ava Chamber directory listing |
| Meats, eggs, honey, baked goods, herbs, flowers | Chamber member spotlight + Missouri farmers market directories |
| Douglas County | MU Extension flyer (the specialist serves Douglas, Howell, Ozark, Texas, Webster, Wright) |
| Chili Cook-Off, 17 Oct 2026, $20 entry / $30 sponsorship | The Project's own 2026 poster |
| MU Extension agronomy visits | MU Extension flyer for Joshua Dunn |
| Phone **417-543-1766**, Matthew Roe | Matt directly, 2026-09-16 |
| avagrowers@gmail.com, used by Sarah Marker (VP) | Matt directly, 2026-09-16 |
| Board: Paul Chateauvert (Pres), Sarah Marker (VP), Matthew Roe (Sec-Treas) | Matt directly; corroborated by the poster's "contact Paul, Sarah or Matt" |

### Corrections made to what the old site said

- **Hours were wrong.** The old site said 8am–1pm. Three current sources say **8am–12pm**.
- **Season was wrong.** The old site said mid-April to mid-October. Current sources say
  **April through October**.
- **Phone was stale.** 417-291-3378 belonged to the previous secretary. Replaced.
- **The Vice-President was a literal `xxxx` placeholder.** It is Sarah Marker.

### Still unverified — check before or soon after launch

- [ ] **PO Box 501, Squires, MO 65755** — from the 2024 site only, no second source
- [ ] **501(c)(3) status wording** — stated on every page and in the structured data
- [ ] **Annual meeting in March** — from the 2024 site only
- [ ] **De Lynn Montez** — listed as Secretary-Treasurer in 2024, not listed now. Confirm whether
      she holds another role, so the board list is complete rather than merely current
- [ ] Bylaws and market rules are offered "on request" — make sure someone is watching the inbox

### Deliberately not carried over

- **The old testimonials.** Three quotes, one attributed to "Jim H. Doe". Template filler.
  Publishing invented reviews for a real nonprofit is not a small thing. Real quotes from real
  customers would be worth collecting.
- **"Sample Page"**, a leftover WordPress default in the old navigation.
- **Any link to avagrowers.com.** The domain was taken over and the site there is not the
  Project's.

---

## Two things to fix outside this repo

1. **The Facebook page still links to avagrowers.com**, which now points at the stolen site. That
   link sends 4.3k followers to someone else. Change it as soon as the new domain is live.
2. **The Ava Chamber directory** still lists 417-291-3378 and hours of 6:30am–12pm.

---

## Checking it before you deploy

```bash
cd sites/ava-growers && python3 -m http.server 4183 &
node ../ava-growers-qa/visual-check.mjs http://localhost:4183
```

Exits non-zero on any failure, so it can gate a deploy. It runs every page at five
viewports from 320px up, plus three passes that a screenshot cannot cover:

- **JavaScript disabled.** The scroll reveal once hid seven blocks of real text in any
  preview that did not run JS. The check now fails if anything is hidden without it.
- **Reduced motion.** Leaves off, nothing left invisible.
- **Links, SEO and deploy files.** Every internal link resolved, `title`, description,
  canonical, viewport, `lang`, one `<h1>` per page, and `robots.txt` / `sitemap.xml` /
  the stylesheet all reachable.

It also flags horizontal overflow with the culprit element named, images missing `alt`,
text under 11px, and tap targets under 40px — excluding links inline in a sentence, which
WCAG 2.5.8 exempts and which cannot be padded without wrecking the paragraph.

Screenshots land in `ava-growers-qa/screenshots/` (gitignored) at phone and laptop width.

---

## Deploy to Cloudflare Pages

No build is needed; these are finished files.

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git
2. Pick this repository
3. Build settings: framework preset **None**, build command **empty**, output directory
   `sites/ava-growers`
4. Deploy, then add the custom domain once purchased

Or: `npx wrangler pages deploy sites/ava-growers --project-name ava-farmers-market`

`_headers` sets a content security policy and the usual security headers; Pages applies it
automatically. `404.html` is served for unknown paths.

### Domain

No domain is hardcoded — every link is relative — so the site works on the `.pages.dev` preview
URL and on whatever domain is bought, with no edits. Once a domain exists, add absolute `og:url`
tags and a `sitemap.xml`; both need the real hostname, which is why they are not here yet.

Register the new domain to **the organization**, with auto-renew on and more than one board
member holding registrar access. That is how the last one was lost.

---

## Images

| File | Use | Note |
|---|---|---|
| `Logo.jpg` | Header mark and favicon | The market's round basket logo |
| `market.jpg` | Hero and about photo | The square on a market morning |
| `Chili_Cook-off.jpg` | Featured event | 2026 poster. **Replace or remove after 17 October 2026** |
| `ava_chamber_market_spotlight.jpg` | Not used on the site | Kept as a source document; carries the "naturally local" alternate logo |
| `Extension_event_soil_cover.jpg` | Not used on the site | Kept as a source document for the MU Extension paragraph |

The two unused files are references, not decoration. They are the evidence behind claims on the
About page and are worth keeping in the repository for that reason.

---

## The contact form

`contact.html` has no backend. A static site cannot accept a POST, so rather than pretending to
submit and silently dropping messages, the form composes a `mailto:` — the sender's own email app
opens with the message ready and they keep a copy in their sent items. If no mail client opens,
the form says so and shows the address and phone number instead.

**To upgrade to real submissions**, add a Cloudflare Pages Function at
`sites/ava-growers/functions/api/contact.js` that accepts the POST and forwards it (MailChannels,
Resend, or an n8n webhook), then point the form's `action` at `/api/contact` with `method="post"`.
The CSP in `_headers` already allows `form-action 'self'`.

## A blog later

Sveltia CMS works against a static site in git and would suit market news. It is deliberately not
set up here: the Sveltia configuration in this repository is for Reckons.AI's own content, and
mixing another organization's editors and content into it is the wrong shape. Do it when this
site moves to its own repository, with its own config and its own editors.
