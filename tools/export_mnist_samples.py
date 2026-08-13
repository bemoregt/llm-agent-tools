import json
import os
import random

from PIL import Image, ImageOps
from torchvision import datasets

# "재추론 버튼을 누를 때마다 입력 이미지 숫자가 랜덤하게 바뀌어 입력되고 추론":
# exports a small, fixed pool of real MNIST test-set digits (not the
# training set - these are images the model never trained on, a fairer
# demo of real generalization) as PNGs the wiki app can serve directly, so
# lib/vrml.js's re-infer button can pick one at random client-side on every
# click instead of always reusing the one attached page image.
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_DIR, "data", "mnist_raw")
OUT_DIR = os.path.join(os.path.expanduser("~"), "Documents", "Jungok_Stone", "_uploads", "mnist-samples")
MANIFEST_PATH = os.path.join(PROJECT_DIR, "data", "mnist_sample_manifest.json")

PER_DIGIT = 4  # -> 40 sample images total, every digit reachable

random.seed(7)
os.makedirs(OUT_DIR, exist_ok=True)

test_set = datasets.MNIST(DATA_DIR, train=False, download=True)

by_digit = {d: [] for d in range(10)}
for idx in range(len(test_set)):
    _, label = test_set[idx]
    if len(by_digit[label]) < PER_DIGIT:
        by_digit[label].append(idx)
    if all(len(v) >= PER_DIGIT for v in by_digit.values()):
        break

manifest = []
for digit in range(10):
    for n, idx in enumerate(by_digit[digit]):
        img, label = test_set[idx]
        # Real MNIST is white-digit-on-black (28x28) - upscaled 4x with
        # NEAREST (not smoothed) to stay crisp/blocky at display size,
        # matching the existing attached-image's pixelated look. lib/vrml.js's
        # buildInputGrayscale un-inverts (1-luminance) assuming a dark-
        # stroke-on-light-paper source image (the page's own hand-drawn
        # attachment) - MNIST is the opposite polarity already, so these
        # samples are inverted here once at export time to the same
        # dark-on-light convention, not handled specially client-side.
        img128 = img.resize((128, 128), Image.NEAREST)
        img128 = ImageOps.invert(img128.convert("L")).convert("RGB")
        filename = "mnist-%d-%d.png" % (digit, n)
        img128.save(os.path.join(OUT_DIR, filename))
        manifest.append({"digit": digit, "url": "/uploads/mnist-samples/" + filename})

with open(MANIFEST_PATH, "w") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

print("Exported %d sample images to %s" % (len(manifest), OUT_DIR))
print("Manifest written to", MANIFEST_PATH)
