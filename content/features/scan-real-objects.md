---
title: "Scanning real objects and places, more carefully"
slug: "scan-real-objects"
order: 1046
section: "Features"
parent: "room-scan"
template: doc
status: published
nav: sidebar
excerpt: "Three additions to the phone-scan pipeline, all run from the command line on your own machine."
generated: "docs-kb"
---

# Scanning real objects and places, more carefully

Three additions to the phone-scan pipeline, all run from the command line on your own machine. Picking frames: npm run scan:keyframes reads a video, scores each frame by how sharp the OBJECT is (a box you give it, or a track of where the object is over time), splits the video into equal stretches so every stretch of the orbit keeps its sharpest frame, and writes the kept frames plus a report listing every frame's score and any stretch left with no good frame. Several captures of one place: the aim is one splat of a place made from several recordings. Only the first step is built: one capture becomes one splat. Attaching the result: scan:room can be told which collection the result belongs to, copy the finished splat into that collection's folder and queue a review row linking it; the row is refused if it names no collection, so a scan can never land in whichever collection happens to be open.

## Why it is this way

**Honest Note**

ALL THREE ARE EARLY (scaffolded). Frame picking did not beat picking frames by hand in the one comparison run, so it is a tool, not a default; you must supply the object's box or track, because the object is not detected; and the frames it keeps are not yet the same code scan:room uses on its own. Combining several recordings is not built or measured beyond one capture, and the garden trial it was tried on is private. Auto-attach passes its unit tests, but its browser test could not be run in the last session, and there is no undo for a link that replaced another. A generated splat is a guess on the side the camera never saw.
