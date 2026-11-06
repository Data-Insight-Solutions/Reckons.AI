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

This takes about an hour, most of it waiting for downloads. You need a terminal (the command-line window: Terminal on a Mac, any terminal on Linux), about 30 GB of free disk space, and desktop Chrome or Edge. Safari and Firefox cannot connect a folder, which the story needs.

**What runs where.** The browser only asks for a picture, clip or splat. A small program on your own computer, the runner, does the work with open models and writes the result into a folder you choose. Nothing is sent to a cloud service.

| Your computer | Pictures | Video clips | Splats from a picture | Room scans | Tested |
| --- | --- | --- | --- | --- | --- |
| Linux, x86-64, NVIDIA GPU with 24 GB | yes | yes | yes | yes | yes, Ubuntu 24.04 with RTX 3090s |
| Mac with Apple Silicon (M1 or later) | yes | yes, slow | **no**: the splat model needs an NVIDIA GPU | yes | **no, not yet run on a Mac** |
| Intel Mac | no | no | no | no | not supported |
| Windows | no | no | no | no | not supported; Linux inside WSL2 has never been tried |

**On a Mac, read this first.** The Mac steps are prepared but nobody has run them on a Mac yet, so expect rough edges and please report what happens. Video needs a lot of memory: on an NVIDIA card a clip used about 17 GB, and on a Mac the same memory also serves every other app, so a Mac with 16 GB is very likely too small for video. 32 GB or more is the safer starting point. These Mac numbers are estimates, not measurements.

#### Step 1. Install the basics

On a **Mac**: open Terminal and install [Homebrew](https://brew.sh) by following the one-line instruction on its page. Then run:

```
xcode-select --install
brew install node git uv ffmpeg
```

On **Linux (Ubuntu)**: run `sudo apt install git curl unzip ffmpeg`, install the JavaScript runtime at version 22 or later (for example with [nvm](https://github.com/nvm-sh/nvm)), and install [uv](https://docs.astral.sh/uv/getting-started/installation/). Install the NVIDIA driver for your card if it is not already there.

#### Step 2. Get Reckons.AI

```
git clone https://github.com/Data-Insight-Solutions/Reckons.AI.git
cd Reckons.AI
npm ci
```

#### Step 3. Install the generation tools and models

Read [the setup script](https://github.com/Data-Insight-Solutions/Reckons.AI/blob/main/scripts/content/gen-setup.sh) first; it is short. Then run `bash scripts/content/gen-setup.sh`. It checks your system, says what is missing and how to install it, and stops before downloading anything it cannot use. It installs into `~/.local/share/reckons/gen`, outside the Reckons.AI folder; set `RECKONS_GEN_HOME` to choose another place and use the same value when you start the runner. The programs it downloads from GitHub are checked against pinned fingerprints (SHA-256); the model files from Hugging Face are not checked yet. If it stops part-way, run it again: it resumes and skips what is already there.

On a Mac it installs the Apple Silicon (Metal) build of stable-diffusion.cpp for pictures and video, and Brush and COLMAP for room scans, and skips the splat model, about 4.5 GB less. On Linux it installs the Vulkan build, the CUDA version of PyTorch and the splat model as well.

#### Step 4. Start the runner

Make an empty folder for your generated files, outside the Reckons.AI folder (for example `~/Documents/reckons-assets`). Then, from the Reckons.AI folder, run:

```
npm run gen:serve -- --no-recurring --workspace="$HOME/Documents/reckons-assets"
```

Leave that terminal open; the runner works only while it runs. It takes one request at a time and writes each result with a private receipt, a saved record of how the file was made and checked. `--no-recurring` makes it run only what you ask for; without it, it also runs the project's own scheduled maintenance jobs, which are meant for the developers' machines.

#### Step 5. Make something

Open Reckons.AI in desktop Chrome or Edge, open the Generated assets example, choose **Create an asset with Shelly**, and connect the same folder. The runner tells the app which kinds of file this computer can make, and the app offers only those: on a Mac, there is no splat choice. Type what picture you want; when it arrives, choose a video and describe its motion, or (on Linux) a Gaussian splat. A splat invents the sides the picture does not show; it is not a measured scan.

#### If something goes wrong

- *The setup script says something is missing*: install what it names and run it again.
- *A stage says files are missing*: run the setup script again; a download may have been interrupted.
- *A video fails part-way on a Mac*: the computer probably ran out of memory. Close other apps and try again; if it still fails, video needs a Mac with more memory.
- *The app cannot connect the folder*: use desktop Chrome or Edge, not Safari or Firefox.

#### Step 6. Test it and tell us what happened

If you are trying this for us, these four checks are the test. Write down the time each one takes.

1. **A picture.** Ask for something simple, for example *a ceramic teapot on a wooden table, soft daylight*. It should appear within a minute or two.
2. **A video from that picture.** Choose the video option and describe a small movement, for example *the camera slowly circles the teapot*. On a Mac this is the slow, memory-hungry step; let it run.
3. **The splat choice.** On a Mac it should not be offered at all, and the app should say why. On Linux, make one.
4. **Look at the results.** Open each one. Does the picture match the prompt? Does the clip move?

Then send back:

- your computer: chip and memory (on a Mac: Apple menu, About This Mac) and the operating system version;
- which of the four checks worked, and how long each took;
- for anything that failed: which step, and the last 30 or so lines of the terminal window where it failed (the setup script, or the one running `npm run gen:serve`).

Send it to whoever invited you, or open an issue at [github.com/Data-Insight-Solutions/Reckons.AI/issues](https://github.com/Data-Insight-Solutions/Reckons.AI/issues). Nothing you generate leaves your computer unless you choose to send it.

#### Remove everything afterwards

1. Stop the runner: press Ctrl+C in its terminal, or close it.
2. Delete the tools and models, about 25 to 30 GB: `rm -rf ~/.local/share/reckons/gen` (or the folder you chose with `RECKONS_GEN_HOME`).
3. Delete the Reckons.AI folder and your generated-files folder if you no longer want them.
4. Optional, on a Mac: `brew uninstall ffmpeg uv` removes the tools Homebrew installed for this. Leave them if other software uses them.

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
