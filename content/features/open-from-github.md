---
title: "Open a .ttl file from a GitHub link"
slug: "open-from-github"
order: 1040
section: "Features"
parent: "multi-kb"
template: doc
status: published
nav: sidebar
excerpt: "A collection saved as a .ttl file in a public GitHub repository can be opened in Reckons.AI from a link."
generated: "docs-kb"
---

# Open a .ttl file from a GitHub link

> **Functional** — built and working, with rough edges still being smoothed.

A collection saved as a .ttl file in a public GitHub repository can be opened in Reckons.AI from a link. The link looks like /about?gh=&lt;owner&gt;/&lt;repo&gt;/&lt;path to the file&gt;.ttl, with @&lt;branch or tag&gt; added at the end to pick a version; the address of the file's page on github.com, or its raw link, works too. The app first shows what it is about to open and asks. Only when you press Open does your browser fetch the file straight from GitHub, with no Reckons.AI server in between, and store it as its own collection on this device, then open it with Shelly ready. Press Cancel and nothing is fetched or stored. This works for files too large for GitHub to display: the project's own plan, over 2 MB, opens this way.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

LIMITS. Public repositories only, and no sign-in; the path must be plain folder and file names. Anyone can write such a link, which is why it always asks first. The copy on your device is a snapshot: reopening it does not yet fetch a newer version, and it is not yet a read-only open. A button or badge for it in the project's README is not there yet, and would work only once this release is live. Built and tested with 4 unit tests and 4 browser tests as of 2026-11-25.
