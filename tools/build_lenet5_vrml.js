// Builds an accurate LeNet-5 architecture VRML scene for the "MNIST Lenet5"
// wiki page, matching its own written requirements:
//  - 3D graphic of the LeNet-5 handwritten-digit classifier
//  - input is an image, output is 10 classes (0-9) - shown as 10 distinct
//    nodes, not one box merely sized "10"
//  - every layer (including the input image) shown as a box whose spatial
//    array size (X/Y) and channel depth (Z) are both quantitatively accurate
//  - each layer's box is textured with a grayscale pixel image of its own
//    real weights - REAL PRETRAINED weights now (data/lenet5_trained_weights
//    .json, produced by tools/train_lenet5.py: an actual LeNet5
//    trained a few epochs on real MNIST, ~98.4% test accuracy), not
//    untrained random init - this is what the user asked for explicitly
//    ("사전에 학습된 르넷5 모델을 가져와서 실제 가중치를 그래픽으로 입혀준후
//    실제 추론결과를 출력") after the random-weights version correctly
//    never predicted anything meaningful.
//  - those SAME weights drive a real forward-pass inference (lib/vrml.js's
//    runInference()) over the page's own attached input image
//    (images-1.png), lighting up the predicted output node - not just a
//    decorative animation, an actual conv/pool/fc computation client-side
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = '/Users/air/obsidian-squeak-wiki';
const wiki = require(path.join(PROJECT_DIR, 'lib/wiki'));
const vrml = require(path.join(PROJECT_DIR, 'lib/vrml'));

const PAGE = 'MNIST Lenet5';
const UPLOAD_DIR = path.join(wiki.VAULT_DIR, '_uploads');
const BASE_URL = 'http://localhost:3000';
const INPUT_IMAGE_URL = '/uploads/images-1.png';
const TRAINED_WEIGHTS_PATH = path.join(PROJECT_DIR, 'data/lenet5_trained_weights.json');
// tools/export_mnist_samples.py: 40 real MNIST *test*-set digits (the model
// never trained on these) the "재추론" button picks a fresh random one from
// on every click, per the user's explicit request - previously it always
// re-classified the same single attached image.
const SAMPLE_MANIFEST_PATH = path.join(PROJECT_DIR, 'data/mnist_sample_manifest.json');

const SPATIAL_SCALE = 0.12;   // pixels -> world units (X/Y footprint)
const FC_HEIGHT_SCALE = 0.03; // neuron count -> world units (vertical rod height)
const FC_THIN = 0.4;          // FC layer's thin fixed X/Z
const GAP = 1.0;
const NODE_RADIUS = 0.2;      // one output node's sphere radius
const NODE_GAP = 0.15;        // vertical gap between stacked output nodes

function squareGrid(n) {
  const w = Math.max(1, Math.round(Math.sqrt(n)));
  const h = Math.max(1, Math.ceil(n / w));
  return [w, h];
}

const trained = JSON.parse(fs.readFileSync(TRAINED_WEIGHTS_PATH, 'utf8'));
const sampleImages = JSON.parse(fs.readFileSync(SAMPLE_MANIFEST_PATH, 'utf8'));

const shapes = [];
let cursorX = 0;
let prevHalfX = 0;

// PER_CHANNEL_THICKNESS/CHANNEL_GAP: a conv/pool layer's C output channels
// are C independently-varying feature maps, not one blended signal - a
// single box averaging them together (the original design) hid real
// per-channel differences behind one shared brightness value, reported by
// the user directly. This instead stacks C thin slabs along Z (still
// centered on the layer's own X slot, so the rest of the row's layout is
// unaffected - only sizeX drives horizontal spacing, see cursorX below),
// one slab per channel, each with its own real weight slice (conv) or its
// own decorative noise (pooling) and its own independently-computed
// activation glow.
const PER_CHANNEL_THICKNESS = 0.09;
const CHANNEL_GAP = 0.025;

function pushChannelStack(name, w, h, channelCount, color, channelWeightsFn, isInput) {
  const sizeX = w * SPATIAL_SCALE;
  const heightY = h * SPATIAL_SCALE;
  const halfX = sizeX / 2;
  const x = shapes.length === 0 ? 0 : cursorX + prevHalfX + GAP + halfX;
  cursorX = x;
  prevHalfX = halfX;

  const step = PER_CHANNEL_THICKNESS + CHANNEL_GAP;
  const totalDepth = channelCount * step - CHANNEL_GAP;
  const indices = [];
  for (let ch = 0; ch < channelCount; ch++) {
    const z = -totalDepth / 2 + ch * step + PER_CHANNEL_THICKNESS / 2;
    const weights = channelWeightsFn ? channelWeightsFn(ch) : null;
    const shape = {
      type: 'box',
      color,
      size: sizeX,
      heightY,
      thickness: PER_CHANNEL_THICKNESS,
      x,
      y: heightY / 2,
      z,
      interactive: false,
      // Only the first channel carries the layer's own name (HUD button)
      // and dimension label - one button/label per LAYER, not per channel,
      // keeps the HUD from exploding into dozens of near-duplicate entries
      // (same reasoning as OUTPUT's showButton:false, see below).
      ...(ch === 0 ? { name: `${name} ${w}x${h}x${channelCount}`, label3d: `${w}x${h}x${channelCount}` } : { showButton: false }),
    };
    if (weights) {
      // Real per-channel kernel weights, sized to the kernel's own true
      // shape (e.g. 5x5=25 for a single input channel) rather than the
      // much larger spatial feature-map footprint - an exact 1 texel = 1
      // real weight image, not cyclic tiling of a handful of real values
      // across hundreds of texels.
      shape.texture = 'weights';
      shape.weightGrid = squareGrid(weights.length);
      shape.weights = weights;
    } else if (isInput) {
      // INPUT: channelCount=1 (grayscale), no weights (it's the raw image,
      // not a learned layer) - texture it with the actual attached digit
      // image instead. Built through this same channel-stack function
      // (not a separate one-off box builder) so every layer, INPUT
      // included, is structurally the same "N channel slabs" shape - INPUT
      // is just the N=1 case. pickRandomInputImage() (lib/vrml.js) swaps
      // this same shape's texture on every re-infer click.
      shape.textureUrl = INPUT_IMAGE_URL;
    } else {
      // Pooling channel: no real weights - decorative noise, independently
      // random per channel (each shape's own construction-time Math.random()
      // fallback), sized to the spatial footprint since there's no "real"
      // small shape to be exact about.
      shape.texture = 'weights';
      shape.weightGrid = squareGrid(w * h);
    }
    shapes.push(shape);
    indices.push(shapes.length - 1);
  }
  return indices;
}

function pushFcBox(name, n, color, weights) {
  const sizeX = FC_THIN;
  const heightY = Math.max(0.4, n * FC_HEIGHT_SCALE);
  const thickness = FC_THIN;
  const halfX = sizeX / 2;
  const x = cursorX + prevHalfX + GAP + halfX;
  cursorX = x;
  prevHalfX = halfX;
  shapes.push({
    type: 'box',
    name: `${name} FC${n}`,
    label3d: `${n}`,
    color,
    size: sizeX,
    heightY,
    thickness,
    x,
    y: heightY / 2,
    z: 0,
    texture: 'weights',
    weightGrid: squareGrid(n),
    weights,
    interactive: false,
  });
  return shapes.length - 1;
}

// ---- real pretrained LeNet-5 weights (data/lenet5_trained_weights.json) ----
const c1Weights = trained.c1.weights;
const c1Bias = trained.c1.bias;
const c3Weights = trained.c3.weights;
const c3Bias = trained.c3.bias;
const c5Weights = trained.c5.weights;
const c5Bias = trained.c5.bias;
const f6Weights = trained.f6.weights;
const f6Bias = trained.f6.bias;
const outputBias = trained.output.bias;
const outputNodeWeights = trained.output.weights;

// ---- build shapes in forward-pass order ----
// C1/S2/C3/S4 each become one shape PER CHANNEL (pushChannelStack) instead
// of one shape for the whole layer - see PER_CHANNEL_THICKNESS's comment
// above for why. Each conv channel's own kernel slice is a contiguous chunk
// of the real trained weight array (PyTorch's (outC,inC,kH,kW) layout is
// already contiguous per output channel: channel ch occupies
// [ch*kernelSize, (ch+1)*kernelSize)).
// INPUT: channelCount=1 - built through the same pushChannelStack every
// other layer uses (the degenerate "N=1 channel" case), per the user's
// explicit request that it stay structurally consistent with the others.
const idxInputList = pushChannelStack('INPUT', 32, 32, 1, [0.82, 0.82, 0.82], null, true);
const idxInput = idxInputList[0];
const c1KernelSize = 1 * 5 * 5;
const idxC1List = pushChannelStack('C1', 28, 28, 6, [0.35, 0.55, 0.95], (ch) => c1Weights.slice(ch * c1KernelSize, (ch + 1) * c1KernelSize));
const idxS2List = pushChannelStack('S2', 14, 14, 6, [0.95, 0.65, 0.25], null);
const c3KernelSize = 6 * 5 * 5;
const idxC3List = pushChannelStack('C3', 10, 10, 16, [0.30, 0.50, 0.90], (ch) => c3Weights.slice(ch * c3KernelSize, (ch + 1) * c3KernelSize));
const idxS4List = pushChannelStack('S4', 5, 5, 16, [0.95, 0.65, 0.25], null);
const idxC5 = pushFcBox('C5', 120, [0.35, 0.85, 0.45], c5Weights);
const idxF6 = pushFcBox('F6', 84, [0.35, 0.85, 0.45], f6Weights);

const outputColor = [0.95, 0.30, 0.30];
const outputIndices = [];
for (let d = 0; d < 10; d++) {
  shapes.push({
    type: 'sphere',
    name: `OUTPUT ${d}`,
    label3d: `${d}`,
    // These 10 nodes sit in a tight vertical stack (see y below) - a label
    // centered above one (the default everywhere else) would sit right on
    // top of the next node up, unreadable. 'right' offsets it clear of the
    // column instead (lib/vrml.js's drawLabels()).
    labelSide: 'right',
    // 10 nearly-identical buttons added nothing once each node already
    // carries its own floating "0".."9" label right beside it in the 3D
    // view itself - hide the redundant flat-HUD button (still fully
    // clickable in 3D, and still reachable by camera-focus when it's the
    // one runInference() picks as the prediction).
    showButton: false,
    color: outputColor,
    size: NODE_RADIUS * 2,
    x: cursorX + prevHalfX + GAP + NODE_RADIUS,
    y: NODE_RADIUS + d * (NODE_RADIUS * 2 + NODE_GAP),
    z: 0,
    texture: 'weights',
    weightGrid: squareGrid(84),
    weights: outputNodeWeights[d],
    interactive: false,
  });
  outputIndices.push(shapes.length - 1);
}
cursorX = cursorX + prevHalfX + GAP + NODE_RADIUS;
prevHalfX = NODE_RADIUS;

const scene = {
  floor: true,
  background: { top: [0.05, 0.07, 0.10], bottom: [0.16, 0.19, 0.25], vertical: true },
  // Apparent on-screen size scales roughly as 1/distance for a perspective
  // camera, so halving radiusScale (0.7 -> 0.35) roughly doubles how big
  // everything (including the 3D dimension/class labels) reads at the
  // default view - the user reported the labels were too small to read.
  camera: { theta: 0.42, phi: 0.24, radiusScale: 0.55 },
  shapes,
  inference: {
    inputImageUrl: INPUT_IMAGE_URL,
    inputSize: 32,
    trained: true,
    inputShapeIndex: idxInput,
    sampleImages,
    layers: [
      { type: 'conv', shapeIndices: idxC1List, inC: 1, outC: 6, k: 5, bias: c1Bias },
      { type: 'avgpool', k: 2, shapeIndices: idxS2List },
      { type: 'conv', shapeIndices: idxC3List, inC: 6, outC: 16, k: 5, bias: c3Bias },
      { type: 'avgpool', k: 2, shapeIndices: idxS4List },
      { type: 'fc', shapeIndex: idxC5, inN: 400, outN: 120, bias: c5Bias },
      { type: 'fc', shapeIndex: idxF6, inN: 120, outN: 84, bias: f6Bias },
    ],
    output: { nodeShapeIndices: outputIndices, bias: outputBias },
  },
};

const baseName = wiki.sanitizeName(PAGE) || 'scene';
const wrlFilename = `${baseName}.wrl`;
const viewerFilename = `${baseName}-viewer.html`;

fs.writeFileSync(path.join(UPLOAD_DIR, wrlFilename), vrml.generateWrl(scene, BASE_URL));
fs.writeFileSync(path.join(UPLOAD_DIR, viewerFilename), vrml.generateViewerDocument(scene, PAGE));

// Attach the actual source of every step that produced this scene (real
// weights, real MNIST samples, the scene itself) so it isn't just described
// in prose - the reader can open and re-run the exact code, per the user's
// explicit request to also attach "생성된 ... 추가 코드들".
const sourceFiles = [
  { file: path.join(PROJECT_DIR, 'tools/train_lenet5.py'), label: 'train_lenet5.py (LeNet-5 실제 MNIST 학습)' },
  { file: path.join(PROJECT_DIR, 'tools/export_mnist_samples.py'), label: 'export_mnist_samples.py (재추론용 MNIST 샘플 추출)' },
  { file: path.join(PROJECT_DIR, 'tools/build_lenet5_vrml.js'), label: 'build_lenet5_vrml.js (이 VRML 장면 생성 스크립트)' },
];
sourceFiles.forEach(({ file }) => {
  fs.copyFileSync(file, path.join(UPLOAD_DIR, path.basename(file)));
});

const snippet =
  `\n## \u{1F9CA} VRML 장면\n\n` +
  `- LeNet-5 구조(입력 포함 7개 레이어 + 출력 10개 노드, 채널별로 쪼갠 상자 포함 총 ${scene.shapes.length}개 도형): INPUT(32x32x1, 첨부 이미지 텍스처), C1(28x28, 채널 6개 각각 별도 상자), S2(14x14, 채널 6개), C3(10x10, 채널 16개 각각 별도 상자), S4(5x5, 채널 16개), C5(FC120), F6(FC84), OUTPUT(10개 노드, 숫자 0~9 각각 1개)\n` +
  `- **채널별로 완전히 분리된 상자**: C1·S2·C3·S4는 레이어 전체를 상자 하나로 뭉치지 않고, 필터/채널 개수만큼 얇은 상자를 Z축(채널 방향)으로 쌓아 표시 - OUTPUT을 10개 노드로 쪼갠 것과 같은 원리. 채널마다 반응(밝기)이 다 다르기 때문\n` +
  `- 합성곱/풀링 레이어(INPUT~S4): 상자 가로/세로 = 실제 배열 크기 그대로 축척 반영\n` +
  `- 완전연결 레이어(C5, F6): 세로 막대 높이 = 뉴런 수(120, 84)에 비례\n` +
  `- 최종 출력층(OUTPUT): 숫자 0~9에 대응하는 10개의 개별 구체 노드로 표시\n` +
  `- 바닥: 체크보드 있음 / 배경: 그러데이션 있음\n` +
  `- **사전학습된 실제 가중치**: PyTorch로 실제 MNIST 6만 장을 5 epoch 학습(tools/train_lenet5.py, 테스트 정확도 98.45%)한 진짜 LeNet-5 가중치를 사용 - 랜덤 초기화 아님. C1·C3의 각 채널 상자는 그 채널만의 진짜 5x5(C1) / 6x5x5(C3) 커널 가중치를, C5·F6·OUTPUT은 각자의 실제 학습된 가중치를 그대로 그레이스케일 픽셀 이미지 텍스처로 표시 (텍셀 하나 = 진짜 가중치 값 하나, 장식용 노이즈 아님)\n` +
  `- **채널별 실제 활성화**: 재추론할 때마다 C1·S2·C3·S4의 각 채널 상자가 "그 채널이 이번 입력에 실제로 얼마나 세게 반응했는지"에 따라 서로 다른 밝기로 빛남 - 레이어 전체 평균이 아니라 채널 하나하나의 진짜 계산값\n` +
  `- 우측 상단 "🔄 재추론" 버튼: 학습된 가중치는 그대로 두고, 실제 MNIST 테스트셋 숫자 이미지 ${sampleImages.length}장(tools/export_mnist_samples.py로 추출, 모델이 학습 때 보지 않은 이미지) 중 하나를 매번 랜덤으로 뽑아 INPUT 텍스처를 바꿔 끼우고 그 숫자로 다시 추론\n` +
  `- 입력·각 레이어 상자 위, 그리고 출력 10개 노드 옆에 각각 치수/클래스 숫자를 3D 공간에 떠 있는 라벨로 항상 표시 (카메라를 어느 각도로 돌려도 항상 정면으로 보임)\n` +
  `- 좌측 상단 시점 버튼 5개(기본/정면/측면/위/대각선)로 장면을 다른 각도에서 바로 조망 가능. 출력 10개 노드는 이제 각각 버튼으로 나열하지 않고 3D 라벨과 클릭만으로 구분\n\n` +
  `[${wrlFilename}](/uploads/${encodeURIComponent(wrlFilename)})\n\n` +
  `[${viewerFilename}](/uploads/${encodeURIComponent(viewerFilename)})\n\n` +
  `**생성/학습 코드** (위 결과를 실제로 만든 코드 원본):\n\n` +
  sourceFiles
    .map(({ file, label }) => `[${label}](/uploads/${encodeURIComponent(path.basename(file))})`)
    .join('\n\n') +
  `\n`;

function replaceSection(name, headingText, snippetText) {
  const current = wiki.readPage(name).body;
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRe = new RegExp(`\\n##\\s+${escaped}[\\s\\S]*?(?=\\n##\\s|$)`, 'u');
  const withoutOld = current.replace(sectionRe, '');
  wiki.writePage(name, `${withoutOld.replace(/\s+$/, '')}\n${snippetText}`);
}

replaceSection(PAGE, '\u{1F9CA} VRML 장면', snippet);

console.log('OK', { wrlFilename, viewerFilename, shapes: scene.shapes.length, outputIndices });
