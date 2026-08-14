---
title: "3D / 2D Knowledge Graph"
slug: "graph3-d"
order: 1000
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Interactive force-directed graph in WebGL (3D) or Canvas (2D fallback)."
generated: "docs-kb"
---

# 3D / 2D Knowledge Graph

*Concept*

Interactive force-directed graph in WebGL (3D) or Canvas (2D fallback). Per-entity icons from urn:kbase:predicate/icon2d statements with emoji fallback. Label overlap prevention sorts by degree and hides collisions. Hub emphasis, layout modes (force/focus/source/type/hub), filter chips.

## Details

**Note**

- Fixed known issue (PR #21): production builds rendered a black graph while hit-testing still worked. Root cause was Threlte's &lt;T.BufferAttribute&gt; resolving its THREE class by function name, which minification mangled, so the geometry got the class instead of an instance and the WebGL renderer threw every frame. A minified-build deploy gate (PR #24, tests/e2e/graph-render.test.ts + playwright.smoke.config.ts) now guards against regressions, since the bug only reproduces in a minified production build, never under `vite dev`.
