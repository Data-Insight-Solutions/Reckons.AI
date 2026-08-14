---
title: "Visual Regression Tests"
slug: "visual-tests"
order: 1012
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "Playwright-based visual regression."
generated: "docs-kb"
---

# Visual Regression Tests

*Concept*

Playwright-based visual regression. 5 analysis layers (cheapest first): pixel analysis (solid fill, color anomaly), DOM overlap detection, text presence checks, Mistral OCR (if API key), Claude Vision semantic analysis (if API key). Screenshots saved to tests/visual/screenshots/.

## Details

**Command**

- npm run test:visual

**Framework**

- playwright
