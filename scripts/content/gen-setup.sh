#!/usr/bin/env bash
# Install the local generation tools and model weights for scripts/content/gen-assets.ts (F58.9.1).
#
# Everything goes OUTSIDE the repository, into RECKONS_GEN_HOME (default ~/.local/share/reckons/gen),
# about 27 GB in all. Nothing here needs sudo. Tested on Ubuntu 24.04 with NVIDIA RTX 3090s,
# 2026-10-14; other systems are untested.
#
#   bin/sd-vulkan/        stable-diffusion.cpp (MIT), the prebuilt Linux Vulkan release
#   lib/vk/               a user-space Vulkan loader, if the system has none (Debian/Ubuntu `apt download`)
#   venv/                 Python 3.11 + torch (CUDA 12.8) for TripoSplat
#   src/TripoSplat/       TripoSplat (MIT), pinned commit
#   models/               Z-Image-Turbo, Qwen3-4B, Wan2.2 TI2V-5B, umt5-xxl (Apache-2.0); TripoSplat (MIT)
#
# Re-running resumes partial downloads and skips what is already there.
set -euo pipefail

G="${RECKONS_GEN_HOME:-$HOME/.local/share/reckons/gen}"
SD_RELEASE="master-964-1d0a58a"
SD_ZIP="sd-master-1d0a58a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip"
TRIPOSPLAT_COMMIT="d8db9e018b413dd9c4a9fe22463781bf98e8e68d"
mkdir -p "$G"/{bin,lib,models/zimage,models/wan22,src,dl}

echo "== stable-diffusion.cpp $SD_RELEASE (Vulkan)"
if [ ! -x "$G/bin/sd-vulkan/sd-cli" ]; then
  curl -fL --retry 5 -o "$G/dl/$SD_ZIP" "https://github.com/leejet/stable-diffusion.cpp/releases/download/$SD_RELEASE/$SD_ZIP"
  unzip -o -q "$G/dl/$SD_ZIP" -d "$G/bin/sd-vulkan"
fi

echo "== Vulkan loader"
if ! ldconfig -p | grep -q 'libvulkan.so.1 '; then
  if [ ! -e "$G/lib/vk/usr/lib/x86_64-linux-gnu/libvulkan.so.1" ]; then
    (cd "$G/dl" && apt download libvulkan1 && dpkg -x libvulkan1_*.deb "$G/lib/vk")
  fi
else
  echo "   system loader present"
fi

echo "== Python environment (uv) + torch"
if [ ! -x "$G/venv/bin/python" ]; then
  uv venv -q -p 3.11 "$G/venv"
  uv pip install -q -p "$G/venv/bin/python" torch torchvision --index-url https://download.pytorch.org/whl/cu128
  uv pip install -q -p "$G/venv/bin/python" numpy safetensors pillow tqdm
fi

echo "== TripoSplat $TRIPOSPLAT_COMMIT"
if [ ! -d "$G/src/TripoSplat/.git" ]; then
  git clone -q https://github.com/VAST-AI-Research/TripoSplat.git "$G/src/TripoSplat"
fi
git -C "$G/src/TripoSplat" -c advice.detachedHead=false checkout -q "$TRIPOSPLAT_COMMIT"

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
for p in background_removal/birefnet.safetensors clip_vision/dino_v3_vit_h.safetensors \
         diffusion_models/triposplat_fp16.safetensors vae/flux2-vae.safetensors \
         vae/triposplat_vae_decoder_fp16.safetensors vae/triposplat_vae_encoder_fp16.safetensors; do
  fetch VAST-AI/TripoSplat "triposplat/$p" "$p"
done

echo "== done: $G ($(du -sh "$G" | cut -f1)). Next: npm run gen:assets"
