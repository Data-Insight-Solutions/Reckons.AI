---
title: "Build a website from your notes"
slug: "site-builder"
order: 1005
section: "Features"
parent: "published-docs"
template: doc
status: published
nav: sidebar
excerpt: "A website kept as a folder of plain text pages can be built into ordinary web pages with one command: npm run site:build -- --site=<site folder> --out=<output folder>."
generated: "docs-kb"
---

# Build a website from your notes

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

A website kept as a folder of plain text pages can be built into ordinary web pages with one command: npm run site:build -- --site=&lt;site folder&gt; --out=&lt;output folder&gt;. It reads every page under the site's content folder, writes each as a page you can host anywhere, and copies the site's images and admin files beside them. A page marked as a draft is left out. Pages under content/blog/ become blog posts: a blog index with the newest first (date, excerpt and cover image), one page per category, and, when a post asks for it, a short note saying its references were gathered with Triple Check and reviewed by the author. A page can use the landing layout, a soft color-wash front page with cards and a contact form; its colors, fonts and form address come from the site's own settings, so any site can use it. If the site's settings give its public address, the build also writes robots.txt, sitemap.xml, a canonical link on each page and a full address for social-preview images; without an address it writes none of those and says so rather than guessing one. A fact in a page can carry a valid-until date, for example a certification: the build warns when one is within 60 days of expiring and refuses to publish any page that states an expired one, naming the fact and the page. The Data Insight Solutions website is also shipped as an example collection (open About, then its card): each published page and post appears in it as a box, linked to its neighbours, with a link to the live site.

<p class="derived">This exists in outline, with gaps.</p>

GETTING IT ONLINE. Once the pages are built, putting them on the web is a workflow in the site's own repository: when a change is proposed, the site is built and a preview link is deployed for you to look at, and when the main line moves, the production site is deployed. The build is the same one-command build above; the deployment step lives in the site's repository, not in this app, and it uses the site owner's own cloud account to put the files where the web can find them.

## Why it is this way

**Honest Note**

WHAT IS NOT DONE YET. Publishing that folder now has a door: a workflow in the site's own repository builds the site when a change is proposed and deploys a preview link, and deploys the production site when the main line moves, and that workflow is green on the site's own pull request 3. But the preview link serving the finished pages has not been verified, the login token that lets the workflow deploy has not been confirmed to stay out of the logs, nothing has been deployed to production, and pointing the domain at the finished site is the site owner's, in the dashboard. It still does not publish the facts in your collection: the build never writes a knowledge file, because publishing facts is a privacy decision. A fact without a valid-until date never expires, and an unknown expiry date is only listed as an open question. The example collection holds published pages and posts only (never drafts, settings or the contact address), and its posts crowd together on the canvas.
