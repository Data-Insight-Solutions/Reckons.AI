---
title: "Three.js example loading and isolation"
slug: "three-example-nodes"
order: 1024
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "Attach a synthetic official-host WebGL example through node details."
generated: "docs-kb"
---

# Three.js example loading and isolation

Attach a synthetic official-host WebGL example through node details. Before Load, there is no remote request or iframe. After a real WebGL draw, the viewer reports running. Verify parent-document and storage isolation, CSP network restrictions after document replacement, top-navigation denial, Stop/remove, HTTP and script errors, context loss, unsupported graphics APIs, a render deadline, forged-message refusal and a missing heartbeat. Desktop and phone Chromium use deterministic intercepted upstream responses, including the production SAMEORIGIN frame header.

## Why it is this way

**Honest Note**

Fixtures verify the viewer boundary, not compatibility with every changing upstream example. An iframe does not guarantee containment of GPU-driver or browser-process crashes. WebGPU-specific device behavior needs a compatible device; the deterministic scene uses WebGL2.

## Detail

**Command**

npx playwright test tests/e2e/three-example.test.ts --project=desktop-chrome --project=mobile-android

**Tested By**

tests/e2e/three-example.test.ts

<details class="log-archive"><summary>1 earlier entry</summary>

- src/lib/3d/__tests__/three-example.test.ts

</details>
