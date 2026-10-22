---
title: "Three.js examples on nodes"
slug: "threejs-examples"
order: 1040
section: "Features"
parent: "story-system"
template: doc
status: published
nav: sidebar
excerpt: "Attach an interactive example from [the Three.js gallery](https://threejs.org/examples/) to a node."
generated: "docs-kb"
---

# Three.js examples on nodes

> **In progress** — actively being built. Parts of what follows may not work yet.

Attach an interactive example from [the Three.js gallery](https://threejs.org/examples/) to a node. This opens a separate viewer; it does not turn the example's scene into geometry inside the graph.

1. Select an entity node and find **Three.js example** in its details.
2. Choose **Attach Three.js example**, paste a gallery link such as `https://threejs.org/examples/#webgl_animation_keyframes`, then choose **Attach example**. Direct `https://threejs.org/examples/webgl_animation_keyframes.html` links also work. Only official HTTPS WebGL and WebGPU example links are accepted; XR, arbitrary websites, query options and pasted JavaScript are not supported.
3. Choose **Open example viewer**, then **Load example**. Opening a space, selecting the node or importing its attachment does not execute the example. The explicit load contacts threejs.org and runs its third-party code on your graphics hardware.
4. Use **Stop example** or close the viewer to unload it. A failed example offers **Retry example**. Editing or removing the attachment is available in node details. An attached example takes precedence over that node's other asset previews until removed.

### As the graph background

With an example attached, choose **Set as background** in node details. A bar then appears in the graph view reading "Background: &lt;example name&gt;" with **Load**. Nothing starts until you choose Load, including after a reload or when you open an imported graph. Once running, the bar offers **Interact with background** (sends mouse and touch input to the example until you press the button again or Escape; Escape does not work while the example itself has keyboard focus, so use the button) and **Stop**. A failed background unloads and the bar shows the error and **Retry**. A space has one background: setting an example replaces a background splat, and setting a splat replaces the example.

The background is a separate scene. It does not share the graph's camera, depth or lighting, so nodes float in front of it instead of sitting inside it, and it does not follow the graph camera. It runs a second scene beside the graph, which roughly adds its GPU load to the graph's; stop it on a slow device. The same sandbox and failure-containment limits below apply.

### Loading protection and its limits

The viewer uses a sandboxed frame without same-origin privileges, forms, popups or top-level navigation. The example cannot read Reckons.AI's document or browser storage. Camera, microphone, location, clipboard, fullscreen and XR permissions are not granted. The frame allows scripts and assets from threejs.org; examples requiring other origins or permissions may fail.

Before downloading the example, the frame checks for graphics API availability. It reports script errors, failed asset loads, rejected promises and lost graphics contexts. The parent unloads a scene that has not submitted a GPU draw or WebGPU queue submission within 45 seconds, or whose heartbeat stops for 10 seconds while the app is visible. A document load alone is not success. GPU activity is not a guarantee of correct appearance; examples can still render incorrectly or use too much memory.

**This is failure containment, not guaranteed crash protection.** An iframe is not a dedicated operating-system process. A severe browser, shared rendering-thread or GPU-driver failure can still freeze or crash the tab before its watchdog runs. Use a lighter example if your device struggles. Example compatibility and upstream contents can change.

No local models, plugins or SSH setup are needed for these viewers. They require internet access to threejs.org and compatible browser graphics support. This does not generate or copy an asset into your space; the saved node metadata holds a link. See the [Three.js compatibility guide](https://threejs.org/manual/pages/webgl-compatibility-check.html), and [generation setup](/docs/features/generation-setup) for creating your own image, video or splat.

<p class="derived">This is being built now.</p>
