---
title: "3D captures on a node"
slug: "splats"
order: 1001
section: "Features"
parent: "graph3-d"
template: doc
status: published
nav: sidebar
excerpt: "A node can carry a Gaussian splat: a 3D object or scene drawn as many small, soft points of color."
generated: "docs-kb"
---

# 3D captures on a node

> **Functional** — built and working, with rough edges still being smoothed.

A node can carry a Gaussian splat: a 3D object or scene drawn as many small, soft points of color. In the 3D graph the splat is drawn at the node, and the nodes, lines and labels behind it are hidden, so it reads as a solid thing. Open it in the viewer to turn it and look from any side. Pictures, clips, 3D models and splats are built-in types (Image, Video, 3D model, Gaussian splat), alongside Prompt and License. How an asset was made, and under which license, shows in its details rather than as extra nodes, while the link to what it was made from stays a visible line.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

3D ONLY. The 2D view does not draw splats. Hiding what sits behind a splat was measured in software rendering, not on a real graphics card. Image, Video and License share a shape with other types and are told apart by color and icon.
