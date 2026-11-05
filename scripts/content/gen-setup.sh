#!/usr/bin/env bash
# Install the local generation tools and model weights for scripts/content/gen-assets.ts (F58.9.1).
#
# Everything goes OUTSIDE the repository, into RECKONS_GEN_HOME (default ~/.local/share/reckons/gen),
# about 27 GB in all. Nothing here needs sudo. Tested on Ubuntu 24.04 with NVIDIA RTX 3090s,
# 2026-10-14. macOS on Apple Silicon is PREPARED BUT UNTESTED (F58.9.17, 2026-11-05): pictures and video
# with stable-diffusion.cpp's Metal build, rooms with Brush and pycolmap; no splats from a picture,
# because TripoSplat needs NVIDIA CUDA. Intel Macs, Windows and other Linux CPUs are not supported.
#
#   bin/sd-vulkan/        stable-diffusion.cpp (MIT), the prebuilt Linux Vulkan release
#   lib/vk/               a user-space Vulkan loader, if the system has none (Debian/Ubuntu `apt download`)
#   venv/                 Python 3.11 + torch (CUDA 12.8) for TripoSplat
#   bin/brush/            Brush (Apache-2.0), the prebuilt Linux x86_64 release, for scan:room (F58.9.6)
#   venv/ (pycolmap)      COLMAP (BSD-3) as the pycolmap wheel, for scan:room; CPU build, no CUDA toolkit needed
#   src/TripoSplat/       TripoSplat (MIT), pinned commit
#   models/               Z-Image-Turbo, Qwen3-4B, Wan2.2 TI2V-5B, umt5-xxl (Apache-2.0); TripoSplat (MIT)
#
# Re-running resumes partial downloads and skips what is already there.
set -euo pipefail

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64) PLATFORM=linux ;;
  Darwin/arm64) PLATFORM=mac ;;
  Darwin/*) echo "This Mac has an Intel CPU ($ARCH). Only Apple Silicon (M1 or later) is supported."; exit 1 ;;
  *) echo "Unsupported system: $OS/$ARCH. Supported: Linux x86-64 (tested) and macOS on Apple Silicon (untested)."
     echo "On Windows, WSL2 with Ubuntu might work but has never been tried."; exit 1 ;;
esac

missing=""
for c in curl unzip tar git uv node; do command -v "$c" >/dev/null || missing="$missing $c"; done
if [ -n "$missing" ]; then
  echo "Missing:$missing"
  if [ "$PLATFORM" = mac ]; then echo "Install with Homebrew: brew install$missing  (uv: brew install uv)";
  else echo "Install with your package manager (uv: https://docs.astral.sh/uv/getting-started/installation/)"; fi
  exit 1
fi
sha256_check() { # expected, file
  if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c -; else echo "$1  $2" | shasum -a 256 -c -; fi
}

G="${RECKONS_GEN_HOME:-$HOME/.local/share/reckons/gen}"
BRUSH_VERSION="v0.3.0"
BRUSH_SHA256="4f0f9a8785d1951c62df26aae247c02c5bba32b00f40b06df4e1c9b867399e20"
SD_RELEASE="master-964-1d0a58a"
SD_ZIP="sd-master-1d0a58a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip"
SD_ZIP_SHA256="bade142929edfa7aad56aba46376e55142d14390262b904f4a2deb3a03ceb21d"  # GitHub's published digest, 2026-11-05
SD_ZIP_MAC="sd-master-1d0a58a-bin-Darwin-macOS-26.6.2-arm64.zip"
SD_ZIP_MAC_SHA256="45001839e925f98ecd18ef5251725f74cff874eeac4599f1136acba65b26911e"
BRUSH_SHA256_MAC="65b2631398c839be3c1d4d7160fe2326389dec87830aac0710985e6690a1048c"
TRIPOSPLAT_COMMIT="d8db9e018b413dd9c4a9fe22463781bf98e8e68d"
mkdir -p "$G"/{bin,lib,models/zimage,models/wan22,src,dl}

if [ "$PLATFORM" = mac ]; then
  echo "== stable-diffusion.cpp $SD_RELEASE (Metal, Apple Silicon)"
  if [ ! -x "$G/bin/sd-metal/sd-cli" ]; then
    curl -fL --retry 5 -o "$G/dl/$SD_ZIP_MAC" "https://github.com/leejet/stable-diffusion.cpp/releases/download/$SD_RELEASE/$SD_ZIP_MAC"
    sha256_check "$SD_ZIP_MAC_SHA256" "$G/dl/$SD_ZIP_MAC"
    unzip -o -q "$G/dl/$SD_ZIP_MAC" -d "$G/bin/sd-metal"
  fi
fi

[ "$PLATFORM" = linux ] && echo "== stable-diffusion.cpp $SD_RELEASE (Vulkan)"
if [ "$PLATFORM" = linux ] && [ ! -x "$G/bin/sd-vulkan/sd-cli" ]; then
  curl -fL --retry 5 -o "$G/dl/$SD_ZIP" "https://github.com/leejet/stable-diffusion.cpp/releases/download/$SD_RELEASE/$SD_ZIP"
  sha256_check "$SD_ZIP_SHA256" "$G/dl/$SD_ZIP"
  unzip -o -q "$G/dl/$SD_ZIP" -d "$G/bin/sd-vulkan"
fi

if [ "$PLATFORM" = linux ]; then
echo "== Vulkan loader"
if ! ldconfig -p | grep -q 'libvulkan.so.1 '; then
  if [ ! -e "$G/lib/vk/usr/lib/x86_64-linux-gnu/libvulkan.so.1" ]; then
    (cd "$G/dl" && apt download libvulkan1 && dpkg -x libvulkan1_*.deb "$G/lib/vk")
  fi
else
  echo "   system loader present"
fi
fi

echo "== Python environment (uv)"
if [ ! -x "$G/venv/bin/python" ]; then
  uv venv -q -p 3.11 "$G/venv"
  uv pip install -q -p "$G/venv/bin/python" numpy safetensors pillow tqdm
fi
if [ "$PLATFORM" = linux ]; then  # torch with CUDA, for TripoSplat only
  "$G/venv/bin/python" -c 'import torch' 2>/dev/null || \
    uv pip install -q -p "$G/venv/bin/python" torch torchvision --index-url https://download.pytorch.org/whl/cu128
fi

echo "== pycolmap (COLMAP for scan:room)"
uv pip install -q -p "$G/venv/bin/python" pycolmap

echo "== Brush $BRUSH_VERSION"
if [ ! -x "$G/bin/brush/brush_app" ]; then
  if [ "$PLATFORM" = mac ]; then BRUSH_TAR="brush-app-aarch64-apple-darwin.tar.xz"; BRUSH_SUM="$BRUSH_SHA256_MAC";
  else BRUSH_TAR="brush-app-x86_64-unknown-linux-gnu.tar.xz"; BRUSH_SUM="$BRUSH_SHA256"; fi
  mkdir -p "$G/dl/brush" "$G/bin/brush"
  curl -fL --retry 5 -o "$G/dl/brush/$BRUSH_TAR" "https://github.com/ArthurBrussee/brush/releases/download/$BRUSH_VERSION/$BRUSH_TAR"
  sha256_check "$BRUSH_SUM" "$G/dl/brush/$BRUSH_TAR"
  tar -xJf "$G/dl/brush/$BRUSH_TAR" -C "$G/bin/brush" --strip-components=1
fi

if [ "$PLATFORM" = linux ]; then
echo "== TripoSplat $TRIPOSPLAT_COMMIT"
if [ ! -d "$G/src/TripoSplat/.git" ]; then
  git clone -q https://github.com/VAST-AI-Research/TripoSplat.git "$G/src/TripoSplat"
fi
git -C "$G/src/TripoSplat" -c advice.detachedHead=false checkout -q "$TRIPOSPLAT_COMMIT"
else
  echo "== TripoSplat: skipped on macOS (needs NVIDIA CUDA); splats from a picture are not available here"
fi

echo "== model weights"
fetch() { # repo, destination under models/, path in repo
  local out="$G/models/$2"
  mkdir -p "$(dirname "$out")"
  curl -fL -C - --retry 5 -o "$out" "https://huggingface.co/$1/resolve/main/$3" || { echo "FAILED: $2"; return 1; }
}
fetch leejet/Z-Image-Turbo-GGUF zimage/z_image_turbo-Q8_0.gguf z_image_turbo-Q8_0.gguf
fetch unsloth/Qwen3-4B-Instruct-2507-GGUF zimage/Qwen3-4B-Instruct-2507-Q8_0.gguf Qwen3-4B-Instruct-2507-Q8_0.gguf
fetch Comfy-Org/z_image_turbo zimage/ae.safetensors split_files/vae/ae.safetensors
fetch QuantStack/Wan2.2-TI2V-5B-GGUF wan22/Wan2.2-TI2V-5B-Q8_0.gguf Wan2.2-TI2V-5B-Q8_0.gguf
fetch QuantStack/Wan2.2-TI2V-5B-GGUF wan22/Wan2.2_VAE.safetensors VAE/Wan2.2_VAE.safetensors
fetch city96/umt5-xxl-encoder-gguf wan22/umt5-xxl-encoder-Q8_0.gguf umt5-xxl-encoder-Q8_0.gguf
[ "$PLATFORM" = linux ] && for p in background_removal/birefnet.safetensors clip_vision/dino_v3_vit_h.safetensors \
         diffusion_models/triposplat_fp16.safetensors vae/flux2-vae.safetensors \
         vae/triposplat_vae_decoder_fp16.safetensors vae/triposplat_vae_encoder_fp16.safetensors; do
  fetch VAST-AI/TripoSplat "triposplat/$p" "$p"
done

echo "== done: $G ($(du -sh "$G" | cut -f1)). Next: npm run gen:assets, or npm run scan:room -- <scan>"
