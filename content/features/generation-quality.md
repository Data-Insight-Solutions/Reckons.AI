---
title: "Generated media: checks, retries, settings and what it costs"
slug: "generation-quality"
order: 1016
section: "Features"
parent: "generation-setup"
template: doc
status: published
nav: sidebar
excerpt: "Everything a local generation run produces can be checked."
generated: "docs-kb"
---

# Generated media: checks, retries, settings and what it costs

Everything a local generation run produces can be checked. Rule-based checks cover images, video and splats and now also PDFs (blank page, missing phrase, unembedded font, wrong page size, text off the page) and SVG drawings (does it render). A vision model on your machine can then review the asset and name defects from a fixed list; video is judged by its middle frame and a PDF by its first pages, and with no local model connected the report says the review was not run, not that the asset is clean. If a check fails or a defect is named, the runner tries again with the next seed within a budget, keeps the best attempt and records every attempt's seed, problems and score in the receipt. A private review collection compares generation settings: one prompt at the root and a branch for each setting, with the same seeds on each, so you can judge them side by side. A showcase splat was generated at the highest quality the local pipeline reached, with each run's settings, peak graphics memory, time and size recorded, and shrunk to a size the app can ship. A table in the generation setup guide lists, per stage (image, video, splat), peak graphics memory, RAM, disk for the model files and time, each measured on a named machine.

## Why it is this way

**Honest Note**

MEASURED ON ONE MACHINE: two RTX 3090 cards with 24 GB each. No run below 24 GB exists, so no minimum requirement is stated, and the RAM column is the largest single process, not the whole machine. The showcase splat has not been opened through the app, only rendered with the same library; it is invented from one picture, so its far side is a guess, and about 11 percent of its points had to be clamped. The vision model's score is a hint beside a result, never a pass or a fail; that is yours. The settings sweep used one subject and one seed per setting. The retry step is tested on sample failures, not a live one.
