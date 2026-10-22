"""One image -> one Gaussian splat PLY with TripoSplat (F58.9.1 / kb:splat-local-pipeline).

Called by scripts/content/gen-assets.ts with the Python of an isolated environment that has torch
and the TripoSplat source (MIT, code and weights). Kept tiny on purpose: the tool knows nothing
about Reckons.AI; it takes an image and writes a file, and the caller's independent check decides
whether that file is acceptable.

  python -I triposplat_run.py --src <TripoSplat checkout> --ckpts <weights dir> \
      --image in.png --out out.ply --gaussians 32768 --seed 42 [--prepared prepared.webp]

Prints one JSON line: the settings it used and how long loading and generating took.
"""
import argparse
import json
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument('--src', required=True)
ap.add_argument('--ckpts', required=True)
ap.add_argument('--image', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--gaussians', type=int, default=32768)
ap.add_argument('--seed', type=int, default=42)
ap.add_argument('--steps', type=int, default=20)
ap.add_argument('--guidance', type=float, default=3.0)
ap.add_argument('--shift', type=float, default=3.0)
ap.add_argument('--canvas', type=int, default=1024)  # TripoSplat's preprocessing square (upstream constant _CANVAS_SIZE)
ap.add_argument('--prepared')
a = ap.parse_args()

sys.path.insert(0, a.src)
import torch  # noqa: E402
import triposplat  # noqa: E402
from triposplat import TripoSplatPipeline  # noqa: E402

triposplat._CANVAS_SIZE = a.canvas


# TripoSplat (commit d8db9e0) writes opacity as log(x / (1 - x)) of an opacity that has ALREADY been
# through a sigmoid, so every Gaussian that saturated at 1.0 is written as +inf: a third of them on
# the first run (2026-10-14), found by the independent splat check. Renderers disagree about what
# sigmoid(+inf) means, so clamp to the logit of 0.9999 and report how many were repaired.
OPACITY_LOGIT_MAX = 9.21


def repair_opacity(path):
    import numpy as np
    raw = open(path, 'rb').read()
    end = raw.index(b'end_header\n') + len(b'end_header\n')
    props = [ln.split()[2] for ln in raw[:end].decode().splitlines() if ln.startswith('property')]
    body = np.frombuffer(raw[end:], dtype='<f4').reshape(-1, len(props)).copy()
    k = props.index('opacity')
    bad = ~np.isfinite(body[:, k])
    if bad.any():
        body[:, k] = np.nan_to_num(body[:, k], nan=-OPACITY_LOGIT_MAX, posinf=OPACITY_LOGIT_MAX, neginf=-OPACITY_LOGIT_MAX)
        with open(path, 'wb') as f:
            f.write(raw[:end])
            f.write(body.astype('<f4').tobytes())
    return int(bad.sum())


t0 = time.time()
c = a.ckpts
pipe = TripoSplatPipeline(
    ckpt_path=f'{c}/diffusion_models/triposplat_fp16.safetensors',
    decoder_path=f'{c}/vae/triposplat_vae_decoder_fp16.safetensors',
    dinov3_path=f'{c}/clip_vision/dino_v3_vit_h.safetensors',
    flux2_vae_encoder_path=f'{c}/vae/flux2-vae.safetensors',
    rmbg_path=f'{c}/background_removal/birefnet.safetensors',
    device='cuda',
)
t1 = time.time()
gaussian, prepared = pipe.run(a.image, num_gaussians=a.gaussians, seed=a.seed, steps=a.steps,
                            guidance_scale=a.guidance, shift=a.shift)
gaussian.save_ply(a.out)
repaired = repair_opacity(a.out)
if a.prepared:
    prepared.save(a.prepared)
t2 = time.time()
print(json.dumps({
    'gaussians': a.gaussians, 'seed': a.seed, 'steps': a.steps,
    'loadS': round(t1 - t0, 1), 'generateS': round(t2 - t1, 1),
    'peakGiB': round(torch.cuda.max_memory_allocated() / 2**30, 2),
    'torch': torch.__version__,
    'opacityRepaired': repaired,
    'guidance': a.guidance, 'shift': a.shift, 'canvas': a.canvas,
    # Process peak resident memory (Linux reports KiB): the system-RAM half of the requirements table.
    'peakRssGiB': round(__import__('resource').getrusage(__import__('resource').RUSAGE_SELF).ru_maxrss / 2**20, 2),
}))
