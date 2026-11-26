---
title: "A showcase whose story plays from a link"
slug: "showcase-example"
order: 1004
section: "Features"
parent: "story-system"
template: doc
status: published
nav: sidebar
excerpt: "An example can be unlisted: it has no card and no tab in the app, so it appears only to someone who has its link."
generated: "docs-kb"
---

# A showcase whose story plays from a link

> **Functional** — built and working, with rough edges still being smoothed.

An example can be unlisted: it has no card and no tab in the app, so it appears only to someone who has its link. The showcase is one such example. Its link, /about?example=&lt;name&gt;&story=&lt;address of the story&gt;&autoplay=1, opens it and starts its story by itself, with no sound, so it plays without a click. Each of the story's eight steps has a caption, lights part of the canvas, and changes the filter and the layout, so a first-time viewer sees different views of one body of facts rather than one picture. The last step leaps to a second, much smaller unlisted example. Both were written only from facts their owner chose to publish; they carry no phone number, street address, email or private person's name, and no pictures of people. A script guards that: a test fails if any such detail appears in either example. HOW MUCH CLAUDE CODE WROTE, MEASURED. The showcase states how much of Reckons.AI was written together with Claude Code. That number is never typed. A script reads the project's git history at a named commit, counts the non-merge commits whose message carries a Co-Authored-By line naming Claude, divides by all non-merge commits, and writes the fraction, the commit and the date into the example. A second mode of the script recomputes the figure at the recorded commit and fails if the stored one differs, so a hand-edited number is caught. At the first measurement, 2026-11-24, that was 1,473 of 1,706 commits, 86.3 percent.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

WHAT THE FIGURE IS AND IS NOT. It is a count of commits, exactly as stated; it says nothing about how many lines, or how good, or who decided what. Its date is part of the claim: it describes the history at that commit and goes stale the moment more commits land. Unlisted examples are unlisted, not private: anyone given the link can open them, and the files ship with the app. The story's browser test plays it in the flat 2D drawing, because in 3D the label-hiding step can hide the very label a step is highlighting; 3D playback has not been shown to work step by step. If the owner later adds a scan of a hand-made object to the second example, it is not there yet.
