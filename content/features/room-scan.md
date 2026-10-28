---
title: "Turn a phone scan of a room into a splat, on your own machine"
slug: "room-scan"
order: 1050
section: "Features"
parent: "generation-setup"
template: doc
status: published
nav: sidebar
excerpt: "With the generation tools installed (see Generation tools and setup), npm run scan:room -- <folder or video> turns a phone recording of a room into a splat: it pulls frames from the video, works out where the camera was for each one, and trains the splat."
generated: "docs-kb"
---

# Turn a phone scan of a room into a splat, on your own machine

> **Functional** — built and working, with rough edges still being smoothed.

With the generation tools installed (see Generation tools and setup), npm run scan:room -- &lt;folder or video&gt; turns a phone recording of a room into a splat: it pulls frames from the video, works out where the camera was for each one, and trains the splat. The result and a receipt stay on your machine, outside the project. npm run scan:quality says how good a recording is (too fast, too shaky, too dark, parts of the room not covered) with one plain tip for each problem. npm run splat:compress makes a splat much smaller in the SPZ or SOG format, checks the copy against the original, and records that the copy is lossy.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

MEASURED ON ONE MACHINE. A 300-frame phone recording took about 19 minutes on one Linux computer with an NVIDIA RTX 3090. It runs on Linux only, the room's scale is arbitrary, and the quality tips use first-guess thresholds from one private scan.
