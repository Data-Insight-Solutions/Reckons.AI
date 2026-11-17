"""Synthesize narration lines with Hume's open-source TADA (F275.8.3).

Run by tests/bench/run-narration-bench.ts inside the tada venv:
  python tada_synth.py <job.json>
The job names the model, the prompt clips (wav + transcript) and the lines; the result JSON lists, per line,
the output wav, synth wall time, and peak CUDA memory in MiB (null on CPU). A failing line is recorded, not fatal.
"""
import json
import sys
import time
import traceback

import torch
import torchaudio

from tada.modules.encoder import Encoder
from tada.modules.tada import TadaForCausalLM


def main(job_path: str) -> None:
    job = json.load(open(job_path))
    device = job.get("device", "cuda" if torch.cuda.is_available() else "cpu")
    cuda = device.startswith("cuda")
    out = {"model": job["model"], "device": device, "torch": torch.__version__, "items": [], "errors": []}

    # Encode every voice prompt once, then drop the encoder (the README: it is only needed for prompts).
    encoder = Encoder.from_pretrained("HumeAI/tada-codec").to(device)
    prompts = {}
    for p in job["prompts"]:
        audio, sr = torchaudio.load(p["wav"])
        audio = audio.mean(dim=0, keepdim=True)
        audio = (audio / audio.abs().max()).to(device)
        prompts[p["id"]] = encoder(audio, text=[p["text"]], sample_rate=sr)
    del encoder
    if cuda:
        torch.cuda.empty_cache()

    t0 = time.time()
    model = TadaForCausalLM.from_pretrained(job["model"], torch_dtype=torch.bfloat16).to(device)
    out["load_seconds"] = round(time.time() - t0, 2)

    for it in job["items"]:
        try:
            if cuda:
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
            t = time.time()
            res = model.generate(prompt=prompts[it["prompt"]], text=it["text"])
            if cuda:
                torch.cuda.synchronize()
            wall = time.time() - t
            wav = res.audio[0].detach().float().cpu()
            if wav.dim() == 1:
                wav = wav.unsqueeze(0)
            torchaudio.save(it["out"], wav, 24000)
            out["items"].append({
                "id": it["id"],
                "wall_seconds": round(wall, 3),
                "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 2**20, 1) if cuda else None,
                "prompt": it["prompt"],
            })
        except Exception as e:  # recorded, never fatal: the benchmark reports failures
            out["errors"].append({"id": it["id"], "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]})
    json.dump(out, open(job["result"], "w"), indent=2)


if __name__ == "__main__":
    main(sys.argv[1])
