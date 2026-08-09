#!/usr/bin/env python3
"""Generates an instrumental background-music clip with Meta's MusicGen
(facebook/musicgen-small) from a text prompt, run inside tts_env by
lib/musicgen.js for the "배경음악 넣기" feature. Deliberately a plain script
(not a long-lived worker like lib/kernel_worker.py) since this only runs
once per button click - the ~1.5GB model weights are cached by
huggingface_hub after the first run, so only the very first generation
pays the download cost.

Usage: python3 musicgen_worker.py '{"prompt": "...", "duration": 20, "outPath": "/tmp/out.wav"}'
Prints {"ok": true, "samplingRate": N} to stdout on success.
"""
import json
import sys


def main():
    args = json.loads(sys.argv[1])
    prompt = args["prompt"]
    duration = args["duration"]
    out_path = args["outPath"]

    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
    import scipy.io.wavfile

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    processor = AutoProcessor.from_pretrained("facebook/musicgen-small")
    model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small").to(device)

    inputs = processor(text=[prompt], padding=True, return_tensors="pt").to(device)
    # MusicGen's codebook runs at ~50 tokens/sec of audio (HF docs: 256 new
    # tokens ~= 5s), so token count is derived from the requested duration.
    max_new_tokens = max(int(duration * 50), 50)
    with torch.no_grad():
        audio_values = model.generate(
            **inputs, max_new_tokens=max_new_tokens, do_sample=True, guidance_scale=3.0
        )

    sampling_rate = model.config.audio_encoder.sampling_rate
    audio = audio_values[0, 0].to("cpu").float().numpy()
    scipy.io.wavfile.write(out_path, sampling_rate, audio)
    print(json.dumps({"ok": True, "samplingRate": sampling_rate}))


if __name__ == "__main__":
    main()
