---
title: "Demo videos made from the same steps the tests play"
slug: "demo-videos"
order: 1015
section: "Features"
parent: "story-system"
template: doc
status: published
nav: sidebar
excerpt: "A demo video here is not a second script."
generated: "docs-kb"
---

# Demo videos made from the same steps the tests play

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

A demo video here is not a second script. It is a walk-through that already exists as a test, with a spoken line added to each step. Because the picture comes from the test running for real, a video can never show a step that the test did not pass: if a step fails, the recording stops and no video is made. SPEAKING. A step can carry one line to be spoken while it plays, and the walk-through can name a voice. Each line becomes one audio clip. If you have recorded the line yourself, your recording is used; otherwise the line is turned into speech, and a clip is reused until its words or voice change, so a re-render pays only for the lines you edited. Kokoro, a small voice model that runs on your own computer, speaks new and changed lines by default; a walk-through can still name a different voice, and one keeps its earlier voice from a hosted service (Hume). RECORDING. The walk-through runs in a browser at full-screen high-definition size, and each step holds until its line has finished plus a short pause. JOINING. One command, npm run demo:render -- --workflow=&lt;name of the walk-through&gt;, lays each clip over the recording at its step's start time and writes an ordinary video file, a captions file made from the same words, and a receipt: which version of the code and data it was made from, which voice spoke each line, and a fingerprint of the result. If any line used the hosted voice, the video's credits say so. ONE RUNNER FOR STORIES. A story (a guided tour stored with the facts it walks through) is played by a single runner. With recording off it is the browser test; with recording on it is the demo recorder. Every kind of step a story can declare, such as opening a page, clicking, typing, or checking that something is visible, is read the same way by both, and a check that fails stops the test and the recording together. SHOWING THE VIDEO ON A PAGE. A walk-through can point at a video file, and its documentation page, and the page of every feature it documents, then shows the video with captions and a still poster frame. A video over 10 MB is refused for the page, so pages stay light. WHICH VOICE. Several voices were compared on the same demo lines, including Kokoro and an openly licensed model from Hume called TADA, and the maintainer ranked them by ear without knowing which was which. Kokoro was chosen. That is one person's listening, not a measured quality score.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

WHAT IS NOT DONE YET, AS OF 2026-11-26. No finished video file is embedded on any documentation page: the page-embedding code has only been tested with test data and has never run on a built site, and the page-ready output has never been produced from a full recording, because that waits for the maintainer to approve the spoken lines. The story runner passes its own tests with named gaps: for example it can start a generation job only through the story's own controls and a stand-in for the local job runner, never with a real model. Making a video needs ffmpeg installed on your computer and is run from the command line; nothing here is a button in the app.
