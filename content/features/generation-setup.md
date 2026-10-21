---
title: "Generation tools and setup"
slug: "generation-setup"
order: 1012
section: "Features"
parent: "story-system"
template: doc
status: published
nav: sidebar
excerpt: "The Generated assets story works in two layers."
generated: "docs-kb"
---

# Generation tools and setup

> **Functional** — built and working, with rough edges still being smoothed.

The Generated assets story works in two layers. Viewing existing assets is included. Creating new files uses optional tools on your own generation machine.

| Capability | Available with the app | Additional setup |
| --- | --- | --- |
| Explore example images, videos and Gaussian splats | Bundled examples and viewers | None |
| View/import images, videos, GLB models and splats | Browser asset viewers | Your own compatible files |
| Prompt to image | Story interface | stable-diffusion.cpp with Z-Image-Turbo weights and the local runner |
| Image to video | Story interface | stable-diffusion.cpp with Wan2.2 TI2V-5B weights and the local runner |
| Image to Gaussian splat | Story interface | TripoSplat, Python/CUDA dependencies and the local runner |
| Generate GLB meshes or other derivations | Not implemented in this story | A future adapter; importing/viewing GLB does not generate one |
| Install tools/plugins through an agent | No installer bundled in the story | An external agent you configure and explicitly authorize |

### Set up local generation

1. Use a checkout of Reckons.AI with its npm dependencies installed. The current installer was tested on Ubuntu 24.04 with NVIDIA RTX 3090 GPUs; other operating systems and GPUs are unverified. It uses Linux x86-64 binaries, Vulkan for image/video, and Python 3.11 with CUDA for splats. Install prerequisites including Node.js, git, curl, unzip, tar and uv before running it. Allow about 27 GB for tools/model weights plus space for outputs; this is a download, not a small browser plugin.
2. Read [the setup script](https://github.com/Data-Insight-Solutions/Reckons.AI/blob/dev/scripts/content/gen-setup.sh), then run `bash scripts/content/gen-setup.sh`. It installs tools and downloads models outside the checkout, under `~/.local/share/reckons/gen` by default. Set `RECKONS_GEN_HOME` to choose another location and use the same value for the runner.
3. Choose a private workspace folder outside a Git checkout, or an ignored workspace folder. From the checkout, run `npm run gen:serve -- --workspace=/path/to/your/private-workspace`. Keep this process running. It accepts only image, video and splat requests and writes private job receipts.
4. In desktop Chrome or Edge, open Generated assets, choose **Create an asset with Shelly**, and connect that same folder. This file-queue adapter does not connect directly to a remote SSH server or work in browsers without folder access.
5. Enter an image prompt. The runner checks the output before Shelly adds it for review. After the image arrives, choose a video and describe its motion, or choose a Gaussian splat. A splat invents unseen geometry; it is not a measured scan.

The connected runner reports which stages have their tool and model files installed. Installed files do not guarantee enough GPU memory or a compatible driver; runtime failures are shown. Prompts, requests, receipts and outputs remain in `.reckons-generation` in the private workspace. Stop the runner with Ctrl+C. Closing Shelly leaves an active job running; Cancel generation prevents attachment and asks the runner to stop the process. After an unclean process kill, a runner lock may remain: verify that the previous runner and its job processes have stopped before removing that workspace's `.reckons-generation/runner.lock` directory.

### What it takes: measured, per stage

Measured on 2x RTX 3090 (24 GB each, one card used per run), driver 575.57.08, Ryzen 9 3900X with 31 GB RAM, Ubuntu 24.04, on 2026-10-20. GPU memory is the peak held by the run's own processes (nvidia-smi), not the whole card. System RAM is the peak resident size of the largest process. Time is wall clock from start to file, and the model-loading part is included.

| Stage | Peak GPU memory | Peak system RAM | Time | Weights to download (on disk) |
| --- | --- | --- | --- | --- |
| Image, standard (768 px, 8 steps) | 11,992 MiB (11.7 GiB) | 1.2 GiB | 15.6 s | 11.2 GB (Z-Image-Turbo weights) |
| Image, showcase (1024 px, 8 steps) | 13,258 MiB (12.9 GiB) | 1.2 GiB | 19.5 s | the same files |
| Video (49 frames, 512 px, 20 steps) | 17,356 MiB (16.9 GiB) | 1.5 GiB | 58.8 s | 12.9 GB (Wan2.2 weights) |
| Splat, standard (32,768 Gaussians, 20 steps) | 6,998 MiB (6.8 GiB) | 5.3 GiB | 31.5 s (11.2 s load + 20.3 s generate) | 4.5 GB (TripoSplat weights) |
| Splat, showcase (262,144 Gaussians, 20 steps) | 7,000 MiB (6.8 GiB) | 5.3 GiB | 33.7 s (11.0 s load + 22.7 s generate) | the same files |

All three models' weights together are 28.5 GB. Smaller GPUs are untested: nothing here was run on a card below 24 GB, so no minimum is claimed. The splat stage's peak is about 7 GB at both quality levels, because the Gaussian count only changes how many points the decoder writes out, so the video stage (about 17 GB) is the one a smaller card is most likely to fail. The image numbers include 1024 px because the splat model resizes its input to 1024 px anyway. System RAM was read as the largest single process, so a machine that also runs a browser and other tools needs more than this column alone.

### Tools and integration guides

- [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) and [Z-Image-Turbo weights](https://huggingface.co/leejet/Z-Image-Turbo-GGUF).
- [Wan2.2 weights](https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF).
- [TripoSplat](https://github.com/VAST-AI-Research/TripoSplat).
- [Agent setup and permissions](/docs/features/agent-setup).
- [Integration settings](/settings/integrations), [MCP setup](/docs/integrations-tech/mcp-server), and [Ollama setup](/docs/integrations-tech/ollama).

A local language model does not automatically supply image/video/splat generation. Those are distinct tools with separate model files. The universal integration/plugin SDK and in-app agent management are planned; this guide does not imply that either is available today.

<p class="derived">This is built and working.</p>
