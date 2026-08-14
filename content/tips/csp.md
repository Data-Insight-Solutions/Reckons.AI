---
title: "Content Security Policy"
slug: "csp"
order: 1002
section: "Tips"
parent: "security"
template: doc
status: published
nav: sidebar
excerpt: "The app enforces a strict CSP: no inline scripts beyond what SvelteKit requires, object-src none, form-action self."
generated: "docs-kb"
---

# Content Security Policy

*Concept*

The app enforces a strict CSP: no inline scripts beyond what SvelteKit requires, object-src none, form-action self. connect-src explicitly lists each allowed AI provider domain.
