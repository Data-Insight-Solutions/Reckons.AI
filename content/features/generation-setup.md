---
title: "Generation tools and setup"
slug: "generation-setup"
order: 1015
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

The connected runner reports which stages have their tool and model files installed. Installed files do not guarantee enough GPU memory or a compatible driver; runtime failures are shown. Prompts, requests, receipts and outputs remain in `.reckons-generation` in the private workspace. Stop the runner with Ctrl+C or by closing its terminal. Closing Shelly leaves an active job running; Cancel generation prevents attachment and asks the runner to stop the process. If a runner was killed without stopping cleanly, the next one to start takes over its lock once it finds that runner is gone; it refuses while another runner is still running on the same workspace.

### Tools and integration guides

- [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) and [Z-Image-Turbo weights](https://huggingface.co/leejet/Z-Image-Turbo-GGUF).
- [Wan2.2 weights](https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF).
- [TripoSplat](https://github.com/VAST-AI-Research/TripoSplat).
- [Agent setup and permissions](/docs/features/agent-setup).
- [Integration settings](/settings/integrations), [MCP setup](/docs/integrations-tech/mcp-server), and [Ollama setup](/docs/integrations-tech/ollama).

A local language model does not automatically supply image/video/splat generation. Those are distinct tools with separate model files. The universal integration/plugin SDK and in-app agent management are planned; this guide does not imply that either is available today.

<p class="derived">This is built and working. It has one part below.</p>

## In this section

**[Turn a phone scan of a room into a splat, on your own machine](../features/room-scan)**

With the generation tools installed (see Generation tools and setup), npm run scan:room -- &lt;folder or video&gt; turns a phone recording of a room into a splat: it pulls frames from the video, works out where the camera was for each one, and trains the splat.
