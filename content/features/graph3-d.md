---
title: "3D / 2D Knowledge Graph"
slug: "graph3-d"
order: 1000
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Interactive force-directed graph (a map where linked facts pull toward each other and unrelated ones drift apart) in WebGL (3D) or Canvas (2D fallback)."
generated: "docs-kb"
---

# 3D / 2D Knowledge Graph

> **Production** — built, tested, and in use.

Interactive force-directed graph (a map where linked facts pull toward each other and unrelated ones drift apart) in WebGL (3D) or Canvas (2D fallback). Per-entity icons from urn:kbase:predicate/icon2d statements with emoji fallback. Label overlap prevention sorts by degree and hides collisions. Hub emphasis, layout modes (force/focus/source/type/hub), filter chips.

<p class="derived">This is built, working, and in daily use here. It has 2 parts below.</p>

## Why it is this way

**Note**

Fixed known issue (PR #21): production builds rendered a black graph while hit-testing still worked. Root cause was Threlte's &lt;T.BufferAttribute&gt; resolving its THREE class by function name, which minification mangled, so the geometry got the class instead of an instance and the WebGL renderer threw every frame. A minified-build deploy gate (PR #24, tests/e2e/graph-render.test.ts + playwright.smoke.config.ts) now guards against regressions, since the bug only reproduces in a minified production build, never under `vite dev`.

## In this section

**[3D captures on a node](../features/splats)**

A node can carry a Gaussian splat: a 3D object or scene drawn as many small, soft points of color.

**[A background for a space](../features/space-background)**

A space can have a background behind its 3D graph.
