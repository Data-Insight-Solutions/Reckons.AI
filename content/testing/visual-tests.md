---
title: "Visual Regression Tests"
slug: "visual-tests"
order: 1011
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "Playwright-based visual regression."
generated: "docs-kb"
---

# Visual Regression Tests

Playwright-based visual regression. 5 analysis layers (cheapest first): pixel analysis (solid fill, color anomaly), DOM overlap detection, text presence checks, Mistral OCR (if API key), Claude Vision semantic analysis (if API key). Screenshots saved to tests/visual/screenshots/.

## Detail

**Command**

npm run test:visual

**Framework**

playwright

## In this section

**[Page Screenshots](../testing/page-screenshots)**

Baseline visual regression screenshots for each major page.

### User Story Tests

End-to-end test scenarios that follow real user workflows. Each story imports graphs, navigates pages, takes screenshots at each step, and verifies UI state. Three stories: Dev Sprint Planning, User Docs Import, Cross-Graph Alignment.

#### Detail

**Command**

npm run test:stories
