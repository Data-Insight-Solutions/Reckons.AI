---
title: "Making assets: a part you can cut, a tool you can start, a check with a known answer"
slug: "making-assets"
order: 1030
section: "Features"
parent: "generation-setup"
template: doc
status: published
nav: sidebar
excerpt: "Getting from 'said' to 'made' needs three different things, and this release has one of each, each checked against something that exists."
generated: "docs-kb"
---

# Making assets: a part you can cut, a tool you can start, a check with a known answer

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

Getting from 'said' to 'made' needs three different things, and this release has one of each, each checked against something that exists. FIRST, A PART THAT IS EXACT, NOT GUESSED. A part is described in words a machine can check — the kind of part and its dimensions — and a builder with no judgement of its own turns that description into a solid, writing the two file kinds a cutter or a 3D printer reads (called STEP and STL), with a receipt beside them: a code that identifies the description, the tool versions, the measured size, and a code for each file so you can tell if one changed. One bracket ships in the Generated assets example, labeled modelled from its parameters, and it has been checked: 60 by 35 by 40 millimetres, within 0.1 millimetre, and the codes in the receipt match the files. SECOND, A TOOL THAT STARTS ONLY WHEN A JOB ASKS. The Connect button — in Shelly's reply, in her chat strip, in the job list, and in Settings, Device — opens one popup with three steps: start the small background program that watches for work, choose the folder the finished files go to, and see each generation service on its own (for example, image generation: installed, will start when needed; splat generation, a 3D view built from many photos: not installed, with an Install link). A service has nothing running until a job asks for it, and it stops again after it has been idle, ten minutes by default. When the app is hosted rather than run on your machine, it shows the command to start the watcher instead of starting it, because a web page cannot start programs on your machine. THIRD, A TEST WITH A KNOWN ANSWER. The multi-scan step — joining several captures of one object into a single 3D model — is now exercised on captures where the true camera positions are known, so the result is a measured error against the truth (how far off the worked-out positions are, in angle and in distance) instead of a look-and-see. One real run rendered three captures of one object, ran the join, and measured against the known positions; the pass limits (2 degrees and 5 percent of the object's size) are proposed starting values from that one good run, not measured standards.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

WHAT IS NOT BUILT YET. The bracket has not been opened in the app's 3D viewer by a person, the larger enclosure part was only ever checked by a test and never rendered, and part-making cannot be reached from the app itself yet (it runs on a developer's machine, with an extra build tool installed outside the app). The popup has not been seen with a real folder picker or a real generation job, and a request-to-job run through the watcher has not been done; installing one service at a time is planned, not built, so the install today runs the whole setup. And the multi-scan numbers come from a rendered object, which is easier to see than a filmed one (no motion blur, no rolling shutter): a pass shows the joining logic is right, not that a real camera video will join — the ring videos remain the real test.
