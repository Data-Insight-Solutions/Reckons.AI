---
title: "Migration Memory Management"
slug: "conf-memory-management"
order: 1020
section: "Architecture"
parent: "mig-confluence-design"
template: doc
status: published
nav: sidebar
excerpt: "For large spaces (500+ pages): write each page's triples to IndexedDB immediately after extraction (already done via addStatements)."
generated: "docs-kb"
---

# Migration Memory Management

*Concept*

For large spaces (500+ pages): write each page's triples to IndexedDB immediately after extraction (already done via addStatements). Run normalisation in batches of 50 pages. Throttle queue with configurable delay between pages (default 600ms, same as vault mode).
