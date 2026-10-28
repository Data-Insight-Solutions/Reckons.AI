---
title: "The reckoning simulator, first part"
slug: "reckoning-simulator"
order: 1047
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "A reckoning will be able to try a proposal in a physical scene before you choose it."
generated: "docs-kb"
---

# The reckoning simulator, first part

> **Functional** — built and working, with rough edges still being smoothed.

A reckoning will be able to try a proposal in a physical scene before you choose it. The first part reads a scene from the graph, steps it with a physics engine, and checks it against conditions such as 'the ball ends in the cup'. npm run sim:run runs the example in static/starter-sim-ramp-cup.ttl, which fails as written and passes once the ball starts higher on the ramp.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

COMMAND LINE ONLY. Nothing in the app uses it yet; trying proposals in a scene and replaying them in the 3D view are planned.
