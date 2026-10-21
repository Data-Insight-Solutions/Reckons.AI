---
title: "Physical scene simulator (early, command line only)"
slug: "physical-scene-simulator"
order: 1025
section: "Features"
parent: "story-system"
template: doc
status: published
nav: sidebar
excerpt: "A space can describe a small physical scene, and a command checks whether a goal comes true in it."
generated: "docs-kb"
---

# Physical scene simulator (early, command line only)

> **In progress** — actively being built. Parts of what follows may not work yet.

A space can describe a small physical scene, and a command checks whether a goal comes true in it. This is the first step of a larger plan and, today, it is a developer tool: it has no screen in the app, no replay, and the reckoning does not use it yet.

Each node with a shape (a box, sphere or capsule) is a rigid body with a mass, friction and bounciness, and a start position taken from the node's placement setting. A target node lists goals in a small fixed vocabulary, such as `inside(ball, cup-zone)` or `aboveFloor(all, -0.1)`. A goal that is misspelled or names a body that does not exist is reported and never run.

To try it, run `npm run sim:run -- --file=static/starter-sim-ramp-cup.ttl`. The command simulates 10 seconds, prints PASS or FAIL for each goal with the final position of every moving body, and exits with an error code if any goal fails. The example ball, as given, starts too low on the ramp to clear the cup's lip, so the run fails; moving it higher up the ramp makes the same run pass.

The physics engine is Rapier. The same run with the same inputs gives the same positions on the same build, which is tested; this is not a promise across different builds or browsers. Runs are limited in length and in the number of bodies. Later phases are planned to let a reckoning propose changes to a scene and test each one here, and to replay a run in the 3D graph view.

<p class="derived">This is being built now.</p>
