#!/usr/bin/env python3
# Computes the real numbers the "배니싱 그레디언트" wiki page's VRML scene
# needs, per its own written requirements:
#  - a real VGG11 with random (untrained) weights - not a pretrained model
#  - a real forward pass on the page's own attached input image
#  - a real loss between the output vector and a target vector (cross-entropy
#    against a cat ImageNet class, since the model is untrained and has no
#    real "output classes" of its own otherwise)
#  - a real backward pass (loss.backward()), and the real per-layer gradient
#    norm of every conv/linear layer's weights - the actual vanishing-
#    gradient data, not a decorative guess
#
# Output is a JSON file (data/vgg11_vanishing_gradient.json) that
# tools/build_vgg11_vrml.js reads to build the VRML scene - same
# python-computes/node-renders split as tools/train_lenet5.py +
# tools/build_lenet5_vrml.js.
import json
import os
import sys

import torch
import torch.nn as nn
import torchvision.models as models
import torchvision.transforms as T
from PIL import Image

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Same VAULT_PATH-env-override-else-default resolution as lib/wiki.js's own
# VAULT_DIR, since this script reads an attachment straight out of the vault.
VAULT_DIR = os.environ.get("VAULT_PATH") or os.path.join(os.environ["HOME"], "Documents", "Jungok_Stone")
IMAGE_PATH = os.path.join(VAULT_DIR, "_uploads", "53124_99734_5711.jpg")
OUT_PATH = os.path.join(PROJECT_DIR, "data", "vgg11_vanishing_gradient.json")

# ImageNet class 281 = "tabby, tabby cat" - a real, standard ImageNet class
# index (the page asked for "고양이(적당한 크래스를 골라)" - "cat, pick a
# reasonable class" - since the model's weights are random, no class is
# semantically meaningful yet, but the *index* still has to be a real valid
# ImageNet-1k class for cross-entropy to mean anything).
TARGET_CLASS = 281
TARGET_LABEL = "tabby cat"

SEED = 42


def main():
    torch.manual_seed(SEED)

    # weights=None -> Kaiming/normal random init, never loads any pretrained
    # checkpoint - this is the "랜덤 가중치를 발생" the page asks for.
    model = models.vgg11(weights=None)
    model.eval()  # deterministic (no dropout noise) for this one-shot measurement

    transform = T.Compose(
        [
            T.Resize((224, 224)),
            T.ToTensor(),
            T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ]
    )
    img = Image.open(IMAGE_PATH).convert("RGB")
    x = transform(img).unsqueeze(0)

    output = model(x)  # real forward pass through the real (random) VGG11
    target = torch.tensor([TARGET_CLASS])
    loss = nn.CrossEntropyLoss()(output, target)

    model.zero_grad()
    loss.backward()  # real backprop - this is what populates every layer's .weight.grad

    conv_layers = [m for m in model.features if isinstance(m, nn.Conv2d)]
    fc_layers = [m for m in model.classifier if isinstance(m, nn.Linear)]

    # Real per-conv-layer output spatial resolution (before any following
    # maxpool), computed the same way torch itself does (this VGG11 uses
    # kernel_size=3, padding=1, stride=1 everywhere, so output H/W == input
    # H/W for every conv) - tracked here so the VRML box for each layer can
    # be sized to its own real feature-map footprint, same principle as
    # tools/build_lenet5_vrml.js.
    spatial = 224
    layers = []
    conv_i = 0
    for m in model.features:
        if isinstance(m, nn.Conv2d):
            conv = conv_layers[conv_i]
            grad = conv.weight.grad
            layers.append(
                {
                    "name": f"Conv{conv_i + 1}",
                    "type": "conv",
                    "in_channels": conv.in_channels,
                    "out_channels": conv.out_channels,
                    "kernel_size": conv.kernel_size[0],
                    "spatial": spatial,
                    "grad_norm": grad.norm().item(),
                    # Real random-init weights, not decorative noise - capped
                    # to a representative sample since a full layer's weight
                    # array (e.g. 512*512*3*3 ~= 2.36M numbers) is far more
                    # than the display grid needs (lib/vrml.js samples
                    # cyclically to fill exactly w*h texels regardless).
                    "weight_sample": conv.weight.detach().flatten()[:4000].tolist(),
                }
            )
            conv_i += 1
        elif isinstance(m, nn.MaxPool2d):
            spatial = spatial // 2

    for i, fc in enumerate(fc_layers):
        grad = fc.weight.grad
        layers.append(
            {
                "name": f"FC{i + 1}",
                "type": "fc",
                "in_features": fc.in_features,
                "out_features": fc.out_features,
                "grad_norm": grad.norm().item(),
                "weight_sample": fc.weight.detach().flatten()[:4000].tolist(),
            }
        )

    result = {
        "target_class": TARGET_CLASS,
        "target_label": TARGET_LABEL,
        "predicted_class": int(output.argmax(dim=1).item()),
        "loss": loss.item(),
        "layers": layers,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(result, f)

    print("OK", OUT_PATH, "loss=", loss.item(), "layers=", len(layers))


if __name__ == "__main__":
    main()
