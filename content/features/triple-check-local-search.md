---
title: "Triple Check with your own search server"
slug: "triple-check-local-search"
order: 1058
section: "Features"
parent: "triple-check"
template: doc
status: published
nav: sidebar
excerpt: "Triple Check can use a third way to search the web: a SearXNG server you run yourself, which needs no account and no key."
generated: "docs-kb"
---

# Triple Check with your own search server

Triple Check can use a third way to search the web: a SearXNG server you run yourself, which needs no account and no key. The claim being checked is still sent from your machine to public search engines, so this keeps it from a search company's account but is not offline.

## Why it is this way

**Honest Note**

EARLY, NEVER RUN AGAINST A REAL SERVER. The setting and the connection code are built and tested against a pretend reply only; no SearXNG server runs where it was written. Your server must turn on JSON output and allow the app's address, which the app cannot change for you, and the published https site may be blocked by the browser from calling a plain http server on your own computer. A fully offline option, such as an offline copy of Wikipedia, is the next step and is not built.
