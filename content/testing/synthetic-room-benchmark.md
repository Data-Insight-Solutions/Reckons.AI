---
title: "Synthetic room reconstruction quality"
slug: "synthetic-room-benchmark"
order: 1022
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "Render the seeded synthetic room with ROOM_BENCHMARK=1, then train against its exact Blender poses."
generated: "docs-kb"
---

# Synthetic room reconstruction quality

Render the seeded synthetic room with ROOM_BENCHMARK=1, then train against its exact Blender poses. Every eighth view belongs only to evaluation. bench:room hashes all images, camera poses and scene metadata; comparisons refuse different datasets or metric versions. Each evaluation image is scored with RGB PSNR and the mean SSIM of non-overlapping 8x8 luminance windows. result.json reports all views, mean pixel error, aggregate PSNR, mean/worst SSIM, training time, Gaussian count and SPZ size; review.html shows every reference/render pair. A missing image or failed stage fails the run. Identical pixels have infinite PSNR, serialized as null.

Run a second configuration in a new output directory with --baseline /outside/repo/room-run/result.json. Hold the dataset fixed and change one training setting. Use systemd-run --user --scope -p MemoryMax=12G for heavy local runs. Outputs stay outside the checkout; review the paired images before deciding whether to replace the shipped room.

## Why it is this way

**Honest Note**

Fidelity measures Brush evaluation of the trained PLY before compression. SPZ is structurally checked, not pixel-scored, and browser renderer quality is not measured. Exact poses bypass COLMAP; this is not evidence of phone capture quality. Manual local GPU job, not CI; no universal quality threshold and no automatic asset promotion.

## Detail

**Command**

- npm run bench:room -- --dataset /outside/repo/room-dataset --out /outside/repo/room-run --steps 30000 --max-splats 280000 --sh-degree 3 --seed 7
- npm run bench:room -- --prepare /outside/repo/room-dataset --frames 300 --width 1600 --samples 40 --seed 7

**Tested By**

scripts/content/__tests__/room-bench.test.ts
