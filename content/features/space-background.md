---
title: "A background for a space"
slug: "space-background"
order: 1002
section: "Features"
parent: "graph3-d"
template: doc
status: published
nav: sidebar
excerpt: "A space can have a background behind its 3D graph."
generated: "docs-kb"
---

# A background for a space

> **Functional** — built and working, with rough edges still being smoothed.

A space can have a background behind its 3D graph. Choose Set as background on a node that carries a splat, or import a capture from your device (.ply, .spz or .sog files; it warns above 50 MB and refuses above 300 MB, and the file is stored on your device, never copied into the space's text). Then open View settings, the panel at the top left of the graph: choose whether the background sits behind the graph or all around you, turn it, change its size, position and opacity, or level its floor. Place in space puts a node's splat where you want it inside the background, at the size you want, without the large preview covering the graph. A scene from threejs.org can be a background too: it never loads until you press Load, runs in a sealed frame, and can be stopped from View settings or from the bar on the graph. A space has one background at a time.

<p class="derived">This is built and working. It has one part below, 1 of which is not built yet.</p>

## Why it is this way

**Honest Note**

A Three.js scene that crashes the browser's graphics driver can still take the page down; the sealed frame keeps it away from your data, not from the driver.

## In this section

**[The Your room example space](../features/your-room)** — **scaffolded**

Your room is an example space that walks through four steps: scan a room, import the capture, generate an object, and place it in the room.
