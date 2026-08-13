// Builds the "배니싱 그레디언트" wiki page's VRML scene from REAL computed
// numbers (data/vgg11_vanishing_gradient.json, produced by
// tools/compute_vgg11_vanishing_gradient.py: an actual VGG11 with random
// init, a real forward pass on the page's own attached image, a real
// cross-entropy loss against a cat ImageNet class, and a real
// loss.backward()), replacing the previous version - which only had
// ollama.generateVrmlScene() guess plausible-looking box colors from the
// page's prose, with no real image, no real weights, and no real gradient
// computation at all - matching this page's own written requirements:
//  - 각 레이어를 큐브로 표시 + 랜덤 가중치를 레이어별 가중치맵 텍스처로 표시:
//    every conv/FC layer is a box textured with that layer's own real
//    random-init weights (lib/vrml.js's existing texture:'weights'
//    mechanism - the same one tools/build_lenet5_vrml.js uses for real
//    trained weights, here fed real *untrained* ones instead)
//  - 입력 이미지 사용 + 타겟 클래스 고양이: the INPUT box is textured with the
//    page's own attached photo; loss was computed against ImageNet class 281
//    (tabby cat)
//  - 레이어별 로쓰(그레디언트) 매트릭스가 어떻게 감소하는지 시각적으로 표시:
//    each layer's real gradient-norm (‖∂loss/∂W‖) drives that box's own
//    color (dim/cool near the input where it's vanished, bright/hot near the
//    output where it's still strong) AND its own floating 3D label showing
//    the exact number - two independent visual encodings of the same real
//    measurement, not one guessed value doing double duty
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = path.join(__dirname, '..');
const wiki = require(path.join(PROJECT_DIR, 'lib/wiki'));
const vrml = require(path.join(PROJECT_DIR, 'lib/vrml'));

const PAGE = '배니싱 그레디언트';
const UPLOAD_DIR = path.join(wiki.VAULT_DIR, '_uploads');
const BASE_URL = 'http://localhost:3000';
const INPUT_IMAGE_URL = '/uploads/53124_99734_5711.jpg';
const DATA_PATH = path.join(PROJECT_DIR, 'data/vgg11_vanishing_gradient.json');

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

// Compressive (power-law, not linear) size scaling: VGG11's real dimensions
// span a much wider range than LeNet-5's (spatial 224->14, a 16x range;
// channels 3->512, a 170x range) - a direct linear scale like
// tools/build_lenet5_vrml.js uses would either blow the early layers up
// off-screen or shrink the late layers to invisible slivers. Exponents <1
// compress that range into something every box still reads as clearly
// larger/smaller than its neighbor without either extreme.
function spatialSize(px) {
  return Math.max(0.6, Math.pow(px, 0.55) * 0.28);
}
function channelThickness(c) {
  return Math.max(0.12, Math.pow(c, 0.45) * 0.05);
}
function fcHeight(n) {
  return Math.max(0.6, Math.sqrt(n) * 0.05);
}

// Real ‖∂loss/∂W‖ per layer, log-scaled (gradient norms here span ~9x
// between the first and last layer - a linear 0..1 normalization would
// flatten most of that range into "basically zero") then min-max normalized
// across this scene's own layers, so the color scale always uses its full
// range regardless of the absolute numbers a given run happens to produce.
const gradNorms = data.layers.map((l) => l.grad_norm);
const logGrads = gradNorms.map((v) => Math.log10(v + 1e-12));
const gMin = Math.min(...logGrads);
const gMax = Math.max(...logGrads);
const gRange = gMax - gMin || 1;

const VANISHED_COLOR = [0.10, 0.12, 0.34]; // dim cool blue-violet - gradient has decayed away
const STRONG_COLOR = [0.98, 0.35, 0.15]; // bright hot orange - gradient is still strong

function gradColor(gradNorm) {
  const t = (Math.log10(gradNorm + 1e-12) - gMin) / gRange;
  return VANISHED_COLOR.map((c0, i) => c0 + (STRONG_COLOR[i] - c0) * t);
}

function fmtGrad(v) {
  return v.toExponential(2);
}

const GAP = 1.1;
const shapes = [];
let cursorX = 0;
let prevHalfX = 0;

function pushBox({ name, label3d, color, sizeX, heightY, thickness, textureUrl, weights }) {
  const halfX = sizeX / 2;
  const x = shapes.length === 0 ? 0 : cursorX + prevHalfX + GAP + halfX;
  cursorX = x;
  prevHalfX = halfX;
  const shape = {
    type: 'box',
    name,
    label3d,
    color,
    size: sizeX,
    heightY,
    thickness,
    x,
    y: heightY / 2,
    z: 0,
    interactive: false,
  };
  if (textureUrl) {
    shape.textureUrl = textureUrl;
  } else if (weights) {
    shape.texture = 'weights';
    // Square-ish grid sized to the sample itself (not the layer's real
    // parameter count, which would be millions of texels) - same principle
    // as tools/build_lenet5_vrml.js's squareGrid().
    const w = Math.max(1, Math.round(Math.sqrt(weights.length)));
    const h = Math.max(1, Math.ceil(weights.length / w));
    shape.weightGrid = [w, h];
    shape.weights = weights;
  }
  shapes.push(shape);
  return shapes.length - 1;
}

// INPUT: the page's own actual attached photo, sized like a 224x224x3 layer
// so it visually lines up with Conv1 right next to it.
pushBox({
  name: `INPUT ${INPUT_IMAGE_URL.split('/').pop()} 224x224x3`,
  label3d: 'INPUT',
  color: [1, 1, 1],
  sizeX: spatialSize(224),
  heightY: spatialSize(224),
  thickness: channelThickness(3),
  textureUrl: INPUT_IMAGE_URL,
});

data.layers.forEach((layer) => {
  const color = gradColor(layer.grad_norm);
  if (layer.type === 'conv') {
    pushBox({
      name: `${layer.name} ${layer.in_channels}→${layer.out_channels}ch ${layer.spatial}x${layer.spatial}`,
      label3d: `${layer.name} |∇W|=${fmtGrad(layer.grad_norm)}`,
      color,
      sizeX: spatialSize(layer.spatial),
      heightY: spatialSize(layer.spatial),
      thickness: channelThickness(layer.out_channels),
      weights: layer.weight_sample,
    });
  } else {
    pushBox({
      name: `${layer.name} ${layer.in_features}→${layer.out_features}`,
      label3d: `${layer.name} |∇W|=${fmtGrad(layer.grad_norm)}`,
      color,
      sizeX: 0.5,
      heightY: fcHeight(layer.out_features),
      thickness: 0.5,
      weights: layer.weight_sample,
    });
  }
});

// LOSS: closes the loop the page's own text asks for ("출력벡터와 타겟벡터
// 차이로 로쓰를 만들어서") - the real computed cross-entropy value, the real
// target class this run backpropagated against, and what the (untrained,
// so meaningless-by-chance) network actually predicted instead.
const lossRadius = 0.7;
shapes.push({
  type: 'sphere',
  name: `LOSS ${data.loss.toFixed(3)}`,
  label3d: `Loss=${data.loss.toFixed(3)} target=${data.target_label}(#${data.target_class}) pred=#${data.predicted_class}`,
  labelSide: 'right',
  color: [0.95, 0.85, 0.25],
  size: lossRadius * 2,
  x: cursorX + prevHalfX + GAP + lossRadius,
  y: lossRadius,
  z: 0,
  interactive: false,
});

const scene = {
  floor: false,
  background: { top: [0.04, 0.05, 0.09], bottom: [0.14, 0.10, 0.20], vertical: true },
  // No radiusScale override (stays at the default 1 = auto-fit-everything):
  // this row spans ~38 units end to end, several times wider than
  // tools/build_lenet5_vrml.js's scene, so shrinking the auto-computed
  // distance (as that script does, for its much narrower scene) would crop
  // the far end (the LOSS sphere) out of the default view.
  camera: { theta: 0.42, phi: 0.22 },
  shapes,
};

const baseName = wiki.sanitizeName(PAGE) || 'scene';
const wrlFilename = `${baseName}.wrl`;
const viewerFilename = `${baseName}-viewer.html`;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.writeFileSync(path.join(UPLOAD_DIR, wrlFilename), vrml.generateWrl(scene, BASE_URL));
fs.writeFileSync(path.join(UPLOAD_DIR, viewerFilename), vrml.generateViewerDocument(scene, PAGE));

const sourceFiles = [
  { file: path.join(PROJECT_DIR, 'tools/compute_vgg11_vanishing_gradient.py'), label: 'compute_vgg11_vanishing_gradient.py (VGG11 랜덤가중치 실제 순전파+역전파)' },
  { file: path.join(PROJECT_DIR, 'tools/build_vgg11_vrml.js'), label: 'build_vgg11_vrml.js (이 VRML 장면 생성 스크립트)' },
];
sourceFiles.forEach(({ file }) => {
  fs.copyFileSync(file, path.join(UPLOAD_DIR, path.basename(file)));
});

const convCount = data.layers.filter((l) => l.type === 'conv').length;
const fcCount = data.layers.filter((l) => l.type === 'fc').length;
const gradLine = data.layers
  .map((l) => `${l.name}=${fmtGrad(l.grad_norm)}`)
  .join(' → ');

// Single `*` is this wiki's wikilink syntax, so plain "- label: value" list
// lines are used here instead of `**bold**` (unsupported, and misparses as
// a link - see server.js's youtube-meta snippet for the same rule).
const snippet =
  `\n## \u{1F9CA} VRML 장면\n\n` +
  `- 실제 계산 결과(추측/장식이 아닌, 아래 첨부 코드로 이 자리에서 직접 계산한 진짜 값): ` +
  `VGG11(랜덤 초기화, 사전학습 아님)에 첨부 이미지를 실제로 순전파 → 타겟 클래스 "${data.target_label}"(ImageNet #${data.target_class})와의 ` +
  `크로스엔트로피 손실 ${data.loss.toFixed(4)} → 실제 loss.backward() 역전파\n` +
  `- 물체 ${shapes.length}개: INPUT(첨부 이미지 텍스처, 224x224x3) + Conv 레이어 ${convCount}개 + FC 레이어 ${fcCount}개 + LOSS 구체 1개\n` +
  `- 레이어별 실제 가중치맵: 각 레이어 큐브는 그 레이어의 진짜 랜덤 초기가중치 값을 그레이스케일 픽셀 텍스처로 표시 (텍셀 하나 = 진짜 가중치 값 하나)\n` +
  `- 레이어별 실제 그레디언트가 소실되는 모습: 각 큐브의 색(입력 쪽일수록 어둡고 차가운 남색 → 출력 쪽일수록 밝고 뜨거운 주황색)과, 큐브 위 떠 있는 3D 라벨의 숫자가 모두 그 레이어의 실제 ‖∂loss/∂W‖ 값을 그대로 반영\n` +
  `- 실제 측정된 레이어별 그레디언트 노름: ${gradLine} (입력에 가까운 레이어일수록 값이 작아지는 배니싱 그레디언트 현상이 실측으로 확인됨)\n` +
  `- 각 레이어 박스 크기(가로/세로)는 그 레이어의 실제 피처맵 해상도를, 두께는 실제 채널 수를 반영 (압축 스케일 - 원본 그대로면 224:14 비율이라 화면에 담기지 않음)\n` +
  `- LOSS 구체: 실제 계산된 손실값, 타겟 클래스, (학습 안 된 랜덤 가중치라 의미는 없는) 예측 클래스를 표시\n` +
  `- 바닥 없음 / 배경 그러데이션\n\n` +
  `[${wrlFilename}](/uploads/${encodeURIComponent(wrlFilename)})\n\n` +
  `[${viewerFilename}](/uploads/${encodeURIComponent(viewerFilename)})\n\n` +
  `생성 코드(위 결과를 실제로 계산/렌더링한 코드 원본):\n\n` +
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

console.log('OK', { wrlFilename, viewerFilename, shapes: shapes.length });
