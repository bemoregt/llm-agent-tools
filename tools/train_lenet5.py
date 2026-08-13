import json
import os
import time

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader
from torchvision import datasets, transforms

torch.manual_seed(0)

# Same input pipeline the browser-side inference (lib/vrml.js's
# buildInputGrayscale) uses: resize straight to 32x32 (no zero-padding
# border), plain 0..1 pixel values (no mean/std normalization) - so a
# trained weight and a client-side forward pass agree on what the numbers
# mean.
transform = transforms.Compose([
    transforms.Resize((32, 32)),
    transforms.ToTensor(),
])

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "mnist_raw")

print("Downloading/loading MNIST...", flush=True)
train_set = datasets.MNIST(DATA_DIR, train=True, download=True, transform=transform)
test_set = datasets.MNIST(DATA_DIR, train=False, download=True, transform=transform)
train_loader = DataLoader(train_set, batch_size=128, shuffle=True)
test_loader = DataLoader(test_set, batch_size=256, shuffle=False)
print("Loaded: %d train, %d test" % (len(train_set), len(test_set)), flush=True)


class LeNet5(nn.Module):
    # Mirrors exactly the architecture lib/vrml.js's runInference() computes
    # client-side: conv1(1->6,5x5)+ReLU -> avgpool2 -> conv2(6->16,5x5)+ReLU
    # -> avgpool2 -> flatten(400) -> fc1(120)+ReLU -> fc2(84)+ReLU ->
    # fc3(10) logits. ReLU + average pooling (not the original 1998 paper's
    # tanh/subsampling) to match what the JS side already implements.
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(1, 6, 5)
        self.conv2 = nn.Conv2d(6, 16, 5)
        self.fc1 = nn.Linear(16 * 5 * 5, 120)
        self.fc2 = nn.Linear(120, 84)
        self.fc3 = nn.Linear(84, 10)

    def forward(self, x):
        x = F.avg_pool2d(F.relu(self.conv1(x)), 2)
        x = F.avg_pool2d(F.relu(self.conv2(x)), 2)
        x = x.flatten(1)
        x = F.relu(self.fc1(x))
        x = F.relu(self.fc2(x))
        return self.fc3(x)


device = torch.device("cpu")
model = LeNet5().to(device)
optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)

EPOCHS = 5
for epoch in range(1, EPOCHS + 1):
    model.train()
    t0 = time.time()
    total_loss = 0.0
    for imgs, labels in train_loader:
        imgs, labels = imgs.to(device), labels.to(device)
        optimizer.zero_grad()
        out = model(imgs)
        loss = F.cross_entropy(out, labels)
        loss.backward()
        optimizer.step()
        total_loss += loss.item() * imgs.size(0)
    train_loss = total_loss / len(train_set)

    model.eval()
    correct = 0
    with torch.no_grad():
        for imgs, labels in test_loader:
            imgs, labels = imgs.to(device), labels.to(device)
            pred = model(imgs).argmax(dim=1)
            correct += (pred == labels).sum().item()
    acc = correct / len(test_set)
    print("epoch %d: loss=%.4f test_acc=%.4f (%.1fs)" % (epoch, train_loss, acc, time.time() - t0), flush=True)

# ---- export weights in the exact flat layout lib/vrml.js's runInference()
# expects (see build_lenet5_vrml.js): PyTorch's own Conv2d weight layout
# (outC,inC,kH,kW) and Linear layout (outN,inN), row-major-flattened, are
# already index-for-index identical to what the JS conv2d/fcForward index
# math assumes - no reordering needed, just .flatten().tolist().
def flat(t):
    return t.detach().cpu().numpy().flatten().tolist()


sd = model.state_dict()
weights = {
    "c1": {"weights": flat(sd["conv1.weight"]), "bias": flat(sd["conv1.bias"])},
    "c3": {"weights": flat(sd["conv2.weight"]), "bias": flat(sd["conv2.bias"])},
    "c5": {"weights": flat(sd["fc1.weight"]), "bias": flat(sd["fc1.bias"])},
    "f6": {"weights": flat(sd["fc2.weight"]), "bias": flat(sd["fc2.bias"])},
    # OUTPUT is 10 separate nodes in the scene (each its own sphere/weight
    # vector, see build_lenet5_vrml.js), not one shared matrix - split
    # fc3's (10,84) weight matrix into 10 length-84 rows here so the build
    # script can hand each output shape its own vector directly.
    "output": {
        "weights": [flat(sd["fc3.weight"][d]) for d in range(10)],
        "bias": flat(sd["fc3.bias"]),
    },
}

out_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "lenet5_trained_weights.json")
with open(out_path, "w") as f:
    json.dump(weights, f)
print("Saved trained weights to", out_path, flush=True)
