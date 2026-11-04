---
title: "Starter assets in the production build"
slug: "starter-asset-smoke"
order: 1029
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "The production smoke test opens Getting started and enables all previews."
generated: "docs-kb"
---

# Starter assets in the production build

The production smoke test opens Getting started and enables all previews. It checks that the GIF decodes and the video has real dimensions and duration, then finds each asset by its entity identifier through search before opening its viewer with a normal pointer click. Search centers an asset that the force layout may have placed behind the view controls. The GLB viewer must paint nonblank pixels. This runs against the minified build, where renderer failures can differ from the development server.

## Why it is this way

**Honest Note**

This checks the bundled synthetic starter assets and their viewers. It does not run image, video or splat generation, or establish that every layout leaves every preview unobstructed.

## Detail

**Command**

npm run test:e2e:smoke

**Tested By**

tests/e2e/graph-render.test.ts
