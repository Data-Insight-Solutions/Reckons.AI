---
title: "XSS Protection"
slug: "xss-protection"
order: 1019
section: "Tips"
parent: "security"
template: doc
status: published
nav: sidebar
excerpt: "All {@html} usages are safe: TurtleChatPanel uses escHtml() before markdown, SearchBar uses escHtml() on all segments, NavBar renders hardcoded SVG, extension popup/sidepanel use template literals with no user input."
generated: "docs-kb"
---

# XSS Protection

*Concept*

All {String.fromCharCode(123)}@html{String.fromCharCode(125)} usages are safe: TurtleChatPanel uses escHtml() before markdown, SearchBar uses escHtml() on all segments, NavBar renders hardcoded SVG, extension popup/sidepanel use template literals with no user input. Input validation: Turtle files parsed by N3.js, user text sent to LLMs for extraction has prompt injection mitigated by mandatory review step (all triples must be confirmed by user), file uploads handled by browser File API (no server upload).
