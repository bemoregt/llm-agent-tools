// "VRML 만들기": turns a scene description - produced by lib/ollama.js's
// generateVrmlScene() from whatever free-form text the page's own author
// wrote - into a real VRML97 (.wrl) file and a self-contained WebGL viewer,
// both embedded back into the page. This module only renders an already-
// structured `scene` object (shapes/floor/background); interpreting text
// into that shape lives in lib/ollama.js.
//
// scene = {
//   floor: boolean,
//   background: null | { top: [r,g,b], bottom: [r,g,b], vertical: boolean },
//   camera?: { theta?: number, phi?: number, centerY?: number }, // initial
//              // orbit angle override (radians; defaults 0.5/0.32) - a wide
//              // row of near-flat shapes reads its own front faces as
//              // squashed rectangles under the default angle, worse the
//              // farther a shape sits from the row's own center, so a scene
//              // like that can ask for a flatter default. centerY overrides
//              // where the camera's own look-at point sits vertically
//              // (defaults to a demo-cube-scale heuristic that aims too high
//              // above a scene of near-flat, near-ground shapes, shrinking
//              // them toward the bottom of the frame).
//   shapes: [{ type: 'box'|'sphere'|'cylinder'|'cone', color: [r,g,b],
//              size: number, x: number, y: number, z: number, interactive: boolean,
//              thickness?: number, heightY?: number,
//              texture?: 'weights', weightGrid?: [w,h], weights?: number[],
//              label3d?: string, labelSide?: 'right' }]
//              // label3d is a floating camera-facing text billboard next to
//              // this shape (see drawLabels()) - centered above it by
//              // default, or offset to the shape's own right (along the
//              // camera's current right vector, so it stays clear of the
//              // shape regardless of view angle) when labelSide:'right' -
//              // useful for shapes stacked tightly along Y, where a label
//              // centered above one would sit on top of the next.
//              // box-only independent-axis overrides: `size` is X, `heightY`
//              // is Y (defaults to `size`), `thickness` is Z (defaults to
//              // `size`) - e.g. a feature-map layer's channel count as Z, or
//              // a fully-connected layer's neuron count as an elongated X
//              // "rod" next to a thin fixed Y/Z. Omitted => uniform cube.
//              // `weights`, when given alongside texture:'weights', is this
//              // shape's own real weight array (min/max-normalized, sampled
//              // cyclically to fill weightGrid) instead of independent
//              // per-texel noise - the same array scene.inference below
//              // multiplies against, so what's drawn and what's computed
//              // agree.
//   inference?: { inputImageUrl: string, inputSize: number, trained?: boolean,
//                 inputShapeIndex?: number, sampleImages?: (string|{url})[],
//                 layers: [{ type: 'conv', shapeIndices, inC, outC, k, bias } |
//                          { type: 'avgpool', k, shapeIndices? } |
//                          { type: 'fc', shapeIndex, inN, outN, bias }],
//              // conv/avgpool take shapeIndices - one shape PER OUTPUT
//              // CHANNEL (a layer's C independent feature maps are C
//              // independently-varying signals, not one blended average -
//              // collapsing them into a single shape hid genuine
//              // per-channel differences, reported by the user directly).
//              // Each conv channel's own weight slice lives on that
//              // channel's own shapes[i].weights (PyTorch's (outC,inC,kH,kW)
//              // layout is already contiguous per output channel, so
//              // runInference() concatenates the slices back in order to
//              // get the real full kernel for the actual conv2d math).
//              // fc stays single-shapeIndex - a layer's N neurons aren't
//              // separable "channels" the way a conv/pool layer's feature
//              // maps are.
//                 output: { nodeShapeIndices: number[], bias: number[] } },
//              // trained: true marks the weights as a real pretrained model
//              // (not a random-init demo) - the "재추론" button then just
//              // re-runs the same forward pass instead of re-randomizing
//              // weights first, and the result HUD says so instead of
//              // "미학습 초기가중치". sampleImages, when given alongside
//              // inputShapeIndex (which scene.shapes entry displays the
//              // current input), lets that same button pick a fresh random
//              // image from the pool each click and swap it onto that
//              // shape's own texture too - see pickRandomInputImage().
//              // A real forward pass run client-side once on
//              // load: loads inputImageUrl, grayscales/resizes it to
//              // inputSize, and threads it through `layers` in order, each
//              // weight-bearing entry reading its weights from
//              // scene.shapes[shapeIndex].weights. `output` has no shared
//              // weight matrix - each of its node shapes (nodeShapeIndices)
//              // carries its own independent incoming-weight vector,
//              // dotted with the last hidden layer's activations plus that
//              // node's own bias. Result drives each shape's `activation`
//              // (0..1) at runtime, reusing the click-focus glow uniform so
//              // a layer/output node visibly lights up proportional to how
//              // hard it fired - see runInference() in viewerEngineScript.
// }

const GRAVITY = 9.8;
const RESTITUTION = 0.42;
const ROLL_KICK = 2.0;
const FRICTION = 3.0;
const SETTLE_VY = 0.35;

function restHeightFor(type, size, heightY) {
  // All four VRML primitives are generated centered on their own origin, so
  // "resting on the floor" is always half the shape's extent along Y - which
  // for a box is `heightY` when that's been set independently of `size`
  // (size is the X extent), not `size` itself.
  return (type === 'box' && Number.isFinite(heightY) ? heightY : size) / 2;
}

// ---------------------------------------------------------------------
// VRML97 (.wrl) generation
// ---------------------------------------------------------------------

const CHECKER_TEXTURE_VRML = `    texture PixelTexture {
      image 8 8 1
        0x00 0xff 0x00 0xff 0x00 0xff 0x00 0xff
        0xff 0x00 0xff 0x00 0xff 0x00 0xff 0x00
        0x00 0xff 0x00 0xff 0x00 0xff 0x00 0xff
        0xff 0x00 0xff 0x00 0xff 0x00 0xff 0x00
        0x00 0xff 0x00 0xff 0x00 0xff 0x00 0xff
        0xff 0x00 0xff 0x00 0xff 0x00 0xff 0x00
        0x00 0xff 0x00 0xff 0x00 0xff 0x00 0xff
        0xff 0x00 0xff 0x00 0xff 0x00 0xff 0x00
    }`;

// An untrained network's weights, before any training step, are just
// independent random noise (e.g. Xavier/He init) - not a meaningful pattern -
// so "이 레이어의 학습안된 초기가중치" is rendered as literal per-pixel random
// grayscale, one PixelTexture row per texel row of that layer's own array
// dimensions (baked once at generation time so the downloaded .wrl is a
// static snapshot, same as every other node in this file). Each grayscale
// value is tinted by the shape's own required color (3-component RGB, not
// 1-component luminance) so the per-layer color from the scene's own "물체
// N개: box(#hex)" requirement survives underneath the noise instead of the
// texture just replacing it with flat gray.
//
// `values`, when given, is the shape's own real weight array (the exact
// numbers a forward pass through this layer would use, e.g. lib/wiki.js
// callers building a real model) rather than throwaway noise - this is what
// lets "학습 안 된 초기가중치를 그레이스케일 픽셀 이미지로 표시" and "그 가중
// 치로 실제 추론을 수행" both point at the same numbers instead of two
// unrelated random draws. It's min/max-normalized per shape (real init
// weights cluster in a narrow range, e.g. He-init ~[-0.3, 0.3], which would
// otherwise render as near-uniform gray) and sampled cyclically to fill
// exactly w*h texels regardless of how the array's own length compares to
// that count (a 400x120 FC weight matrix is far larger than its display
// grid; a 5x5x6 conv kernel is far smaller).
function weightPixelTextureVrml(w, h, color, values) {
  const [cr, cg, cb] = color;
  let sample;
  if (Array.isArray(values) && values.length) {
    let min = Infinity, max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    const range = max - min || 1;
    sample = (i) => Math.round(((values[i % values.length] - min) / range) * 255);
  } else {
    sample = () => Math.floor(Math.random() * 256);
  }
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const v = sample(y * w + x);
      const hex = (n) => Math.round(v * n).toString(16).padStart(2, '0');
      row.push('0x' + hex(cr) + hex(cg) + hex(cb));
    }
    rows.push('        ' + row.join(' '));
  }
  return `    texture PixelTexture {\n      image ${w} ${h} 3\n${rows.join('\n')}\n    }`;
}

function vrmlGeometryNode(shape) {
  const s = shape.size;
  switch (shape.type) {
    case 'sphere':
      return `Sphere { radius ${(s / 2).toFixed(3)} }`;
    case 'cylinder':
      return `Cylinder { radius ${(s * 0.4).toFixed(3)} height ${s.toFixed(3)} }`;
    case 'cone':
      return `Cone { bottomRadius ${(s * 0.4).toFixed(3)} height ${s.toFixed(3)} }`;
    default: {
      // `heightY`/`thickness` are optional independent Y/Z overrides - e.g. a
      // CNN feature-map layer where `size` is the spatial array footprint
      // (X/Y) and `thickness` is the channel depth (Z), or a fully-connected
      // layer's 1xN neuron vector as an elongated X "rod" (`size`) next to a
      // thin fixed Y/Z - quantities a single uniform cube can't represent.
      const height = Number.isFinite(shape.heightY) ? shape.heightY : s;
      const depth = Number.isFinite(shape.thickness) ? shape.thickness : s;
      return `Box { size ${s.toFixed(3)} ${height.toFixed(3)} ${depth.toFixed(3)} }`;
    }
  }
}

function floorSizeFor(scene) {
  let spread = 10;
  for (const s of scene.shapes) {
    spread = Math.max(spread, Math.abs(s.x) * 2 + s.size + 4, Math.abs(s.z) * 2 + s.size + 4);
  }
  return Math.min(40, spread);
}

// Generates real VRML97 source: a TouchSensor + TimeSensor + Script node per
// interactive shape reproduces the same y(t) = y0 - 0.5*g*t^2 single-drop
// physics as the original hand-written falling_cube.wrl (the richer
// bounce/roll simulation only exists in the WebGL viewer below - porting it
// into VRML's per-tick fraction_changed would need its own closed-form
// per-bounce timing table, which isn't worth it for a legacy format most
// browsers can no longer even open).
function generateWrl(scene, baseUrl) {
  const lines = [];
  lines.push('#VRML V2.0 utf8');
  lines.push(`# VRML_SCENE: ${JSON.stringify(scene)}`);
  lines.push('# 자동 생성: 텍스트 설명을 분석해 만든 장면입니다.');
  lines.push('');
  if (scene.background) {
    // VRML97's Background node natively supports a multi-stop sky/ground
    // gradient via parallel skyColor/skyAngle arrays (color-per-angle-from-
    // zenith) - a real match for "배경을 초록-검정 그레디언트로", not a
    // workaround.
    const top = scene.background.top.map((v) => v.toFixed(3)).join(' ');
    const bottom = scene.background.bottom.map((v) => v.toFixed(3)).join(' ');
    lines.push('Background {');
    lines.push(`  skyColor [ ${top} ${bottom} ]`);
    lines.push('  skyAngle [ 1.5708 ]');
    lines.push(`  groundColor [ ${bottom} ]`);
    lines.push('}');
  } else {
    lines.push('Background {');
    lines.push('  skyColor [ 0.6 0.75 0.9 ]');
    lines.push('}');
  }
  lines.push('');
  lines.push('NavigationInfo {');
  lines.push('  type "EXAMINE"');
  lines.push('  headlight TRUE');
  lines.push('}');
  lines.push('');
  lines.push('Viewpoint {');
  lines.push('  position 0 4 12');
  lines.push('  description "Main View"');
  lines.push('}');
  lines.push('');

  if (scene.floor) {
    const floorSize = floorSizeFor(scene);
    lines.push('Shape {');
    lines.push('  appearance Appearance {');
    lines.push('    material Material { diffuseColor 1 1 1 ambientIntensity 0.4 }');
    lines.push(CHECKER_TEXTURE_VRML);
    lines.push('  }');
    lines.push(`  geometry Box { size ${floorSize} 0.2 ${floorSize} }`);
    lines.push('}');
    lines.push('');
  }

  scene.shapes.forEach((shape, i) => {
    const rgb = shape.color.map((v) => v.toFixed(3)).join(' ');
    const restY = restHeightFor(shape.type, shape.size, shape.heightY);
    // A downloaded standalone .wrl can't resolve a relative /uploads/... URL
    // on its own - it needs the wiki server's own origin to still find the
    // image (the procedural earth/moon presets have no VRML equivalent at
    // all, so those just keep the plain material color here).
    const imageUrl = shape.textureUrl && baseUrl ? `${baseUrl}${shape.textureUrl}` : null;
    let appearance;
    if (imageUrl) {
      appearance = `Appearance { material Material { diffuseColor 1 1 1 } texture ImageTexture { url "${imageUrl}" } }`;
    } else if (shape.texture === 'weights' && shape.weightGrid) {
      const [w, h] = shape.weightGrid;
      appearance = `Appearance {\n    material Material { diffuseColor 1 1 1 ambientIntensity 0.6 }\n${weightPixelTextureVrml(w, h, shape.color, shape.weights)}\n  }`;
    } else {
      appearance = `Appearance { material Material { diffuseColor ${rgb} } }`;
    }

    lines.push(`DEF SHAPE_T${i} Transform {`);
    lines.push(`  translation ${shape.x} ${shape.y} ${shape.z}`);
    lines.push('  children [');
    if (shape.interactive) lines.push(`    DEF TOUCH${i} TouchSensor {}`);
    lines.push('    Shape {');
    lines.push(`      appearance ${appearance}`);
    lines.push(`      geometry ${vrmlGeometryNode(shape)}`);
    lines.push('    }');
    lines.push('  ]');
    lines.push('}');
    lines.push('');

    if (!shape.interactive) return;

    const fallDist = Math.max(0.1, shape.y - restY);
    const totalTime = Math.sqrt((2 * fallDist) / GRAVITY);

    lines.push(`DEF CLOCK${i} TimeSensor {`);
    lines.push(`  cycleInterval ${totalTime.toFixed(4)}`);
    lines.push('  loop FALSE');
    lines.push('}');
    lines.push('');
    lines.push(`DEF FALL_SCRIPT${i} Script {`);
    lines.push('  eventIn SFFloat set_fraction');
    lines.push('  eventOut SFVec3f translation_changed');
    lines.push(`  field SFVec3f startPos ${shape.x} ${shape.y} ${shape.z}`);
    lines.push(`  field SFVec3f restPos ${shape.x} ${restY} ${shape.z}`);
    lines.push(`  field SFFloat totalTime ${totalTime.toFixed(4)}`);
    lines.push(`  field SFFloat gravity ${GRAVITY}`);
    lines.push('  url "javascript:');
    lines.push('    function set_fraction(value, ts) {');
    lines.push('      t = value * totalTime;');
    lines.push('      dy = 0.5 * gravity * t * t;');
    lines.push('      newY = startPos.y - dy;');
    lines.push('      if (newY <= restPos.y) { newY = restPos.y; }');
    lines.push('      translation_changed = new SFVec3f(startPos.x, newY, startPos.z);');
    lines.push('    }');
    lines.push('  "');
    lines.push('}');
    lines.push('');
    lines.push(`ROUTE TOUCH${i}.touchTime TO CLOCK${i}.set_startTime`);
    lines.push(`ROUTE CLOCK${i}.fraction_changed TO FALL_SCRIPT${i}.set_fraction`);
    lines.push(`ROUTE FALL_SCRIPT${i}.translation_changed TO SHAPE_T${i}.set_translation`);
    lines.push('');
  });

  scene.shapes.forEach((shape, i) => {
    if (shape.spin || shape.orbit) lines.push(...vrmlMotionScript(i, shape));
    if (shape.orbit && shape.orbit.trailColor) lines.push(...vrmlOrbitTrail(shape.orbit));
  });

  return lines.join('\n');
}

// Continuous ambient motion (spin around Y, and/or a circular orbit around
// another point) - independent of the click-to-fall Script above, driven by
// its own always-looping TimeSensor. cycleInterval is set arbitrarily long
// (an hour) purely so `value * cycleInterval` inside the script reads as
// real elapsed seconds; a real VRML browser still sends fraction_changed
// many times a second regardless of how long the nominal cycle is.
function vrmlMotionScript(i, shape) {
  const orbit = shape.orbit;
  const angle0 = orbit ? Math.atan2(shape.z - orbit.center[2], shape.x - orbit.center[0]) : 0;
  const lines = [];
  lines.push(`DEF MOTION_CLOCK${i} TimeSensor { cycleInterval 3600 loop TRUE }`);
  lines.push(`DEF MOTION_SCRIPT${i} Script {`);
  lines.push('  eventIn SFFloat set_fraction');
  lines.push('  eventOut SFVec3f translation_changed');
  lines.push('  eventOut SFRotation rotation_changed');
  lines.push('  field SFFloat cycleInterval 3600');
  lines.push(`  field SFVec3f basePos ${shape.x} ${shape.y} ${shape.z}`);
  lines.push(`  field SFFloat spinSpeed ${shape.spin || 0}`);
  lines.push(`  field SFBool hasOrbit ${orbit ? 'TRUE' : 'FALSE'}`);
  lines.push(`  field SFVec3f orbitCenter ${orbit ? orbit.center.join(' ') : '0 0 0'}`);
  lines.push(`  field SFFloat orbitRadius ${orbit ? orbit.radius : 0}`);
  lines.push(`  field SFFloat orbitSpeed ${orbit ? orbit.speed : 0}`);
  lines.push(`  field SFFloat orbitAngle0 ${angle0}`);
  lines.push('  url "javascript:');
  lines.push('    function set_fraction(value, ts) {');
  lines.push('      t = value * cycleInterval;');
  lines.push('      if (hasOrbit) {');
  lines.push('        ang = orbitAngle0 + t * orbitSpeed;');
  lines.push('        x = orbitCenter.x + orbitRadius * Math.cos(ang);');
  lines.push('        z = orbitCenter.z + orbitRadius * Math.sin(ang);');
  lines.push('        translation_changed = new SFVec3f(x, basePos.y, z);');
  lines.push('      }');
  lines.push('      if (spinSpeed != 0) {');
  lines.push('        rotation_changed = new SFRotation(0, 1, 0, t * spinSpeed);');
  lines.push('      }');
  lines.push('    }');
  lines.push('  "');
  lines.push('}');
  lines.push('');
  lines.push(`ROUTE MOTION_CLOCK${i}.fraction_changed TO MOTION_SCRIPT${i}.set_fraction`);
  lines.push(`ROUTE MOTION_SCRIPT${i}.translation_changed TO SHAPE_T${i}.set_translation`);
  lines.push(`ROUTE MOTION_SCRIPT${i}.rotation_changed TO SHAPE_T${i}.set_rotation`);
  lines.push('');
  return lines;
}

// A thin ring at the orbit's radius, drawn as a plain IndexedLineSet circle -
// legacy VRML has no built-in "torus" or line-thickness control, but a
// self-lit (emissive) line loop is exactly what a real VRML browser renders
// for "가느다란 적색선" anyway.
function vrmlOrbitTrail(orbit) {
  const segments = 64;
  const points = [];
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const x = orbit.center[0] + orbit.radius * Math.cos(a);
    const z = orbit.center[2] + orbit.radius * Math.sin(a);
    points.push(`${x.toFixed(3)} ${orbit.center[1].toFixed(3)} ${z.toFixed(3)}`);
  }
  const coordIndex = [...Array(segments).keys(), 0, -1].join(', ');
  const rgb = orbit.trailColor.map((v) => v.toFixed(3)).join(' ');
  return [
    'Shape {',
    `  appearance Appearance { material Material { emissiveColor ${rgb} diffuseColor 0 0 0 } }`,
    '  geometry IndexedLineSet {',
    `    coord Coordinate { point [ ${points.join(', ')} ] }`,
    `    coordIndex [ ${coordIndex} ]`,
    '  }',
    '}',
    '',
  ];
}

function parseSceneFromWrl(wrlText) {
  const m = typeof wrlText === 'string' ? wrlText.match(/^#\s*VRML_SCENE:\s*(.+)$/m) : null;
  if (!m) return null;
  try {
    const scene = JSON.parse(m[1]);
    if (scene && Array.isArray(scene.shapes)) return scene;
  } catch {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------
// WebGL viewer (shared by the embedded in-page viewer and the standalone
// downloadable HTML file - both just wrap this same fragment)
// ---------------------------------------------------------------------

function viewerEngineScript(uid, scene) {
  // Mesh builders, camera, physics and rendering below are a generalization
  // of the single-cube WebGL demo built earlier in this session: N shapes of
  // 4 VRML-native primitive types instead of one hardcoded box, each with
  // its own independent fall/bounce/roll state.
  return `(function () {
  "use strict";
  var SCENE = ${JSON.stringify(scene)};
  var root = document.getElementById(${JSON.stringify(uid)});
  if (!root) return;
  var canvas = root.querySelector("canvas");
  var statusEl = root.querySelector("[data-vrml-status]");
  var resetBtn = root.querySelector("[data-vrml-reset]");
  var predictEl = root.querySelector("[data-vrml-predict]");
  var reinferBtn = root.querySelector("[data-vrml-reinfer]");

  var GRAVITY = ${GRAVITY}, RESTITUTION = ${RESTITUTION}, ROLL_KICK = ${ROLL_KICK}, FRICTION = ${FRICTION}, SETTLE_VY = ${SETTLE_VY};
  var FOVY = 0.95;

  function m4Identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
  function m4Multiply(a, b) {
    var out = new Float32Array(16);
    for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) { var s=0; for (var k=0;k<4;k++) s+=a[k*4+j]*b[i*4+k]; out[i*4+j]=s; }
    return out;
  }
  function m4Perspective(fovy, aspect, near, far) {
    var f = 1/Math.tan(fovy/2), nf = 1/(near-far);
    var out = new Float32Array(16);
    out[0]=f/aspect; out[5]=f; out[10]=(far+near)*nf; out[11]=-1; out[14]=2*far*near*nf;
    return out;
  }
  function m4LookAt(eye, center, up) {
    var zx=eye[0]-center[0], zy=eye[1]-center[1], zz=eye[2]-center[2];
    var zl=Math.hypot(zx,zy,zz)||1; zx/=zl; zy/=zl; zz/=zl;
    var xx=up[1]*zz-up[2]*zy, xy=up[2]*zx-up[0]*zz, xz=up[0]*zy-up[1]*zx;
    var xl=Math.hypot(xx,xy,xz)||1; xx/=xl; xy/=xl; xz/=xl;
    var yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
    var out=new Float32Array(16);
    out[0]=xx; out[1]=yx; out[2]=zx; out[3]=0;
    out[4]=xy; out[5]=yy; out[6]=zy; out[7]=0;
    out[8]=xz; out[9]=yz; out[10]=zz; out[11]=0;
    out[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
    out[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
    out[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
    out[15]=1;
    return out;
  }
  function m4Invert(a) {
    var a00=a[0],a01=a[1],a02=a[2],a03=a[3],a10=a[4],a11=a[5],a12=a[6],a13=a[7],
        a20=a[8],a21=a[9],a22=a[10],a23=a[11],a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    var b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10,b03=a01*a12-a02*a11,
        b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,
        b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
    var det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if (!det) return null;
    det=1/det;
    var out=new Float32Array(16);
    out[0]=(a11*b11-a12*b10+a13*b09)*det; out[1]=(a02*b10-a01*b11-a03*b09)*det;
    out[2]=(a31*b05-a32*b04+a33*b03)*det; out[3]=(a22*b04-a21*b05-a23*b03)*det;
    out[4]=(a12*b08-a10*b11-a13*b07)*det; out[5]=(a00*b11-a02*b08+a03*b07)*det;
    out[6]=(a32*b02-a30*b05-a33*b01)*det; out[7]=(a20*b05-a22*b02+a23*b01)*det;
    out[8]=(a10*b10-a11*b08+a13*b06)*det; out[9]=(a01*b08-a00*b10-a03*b06)*det;
    out[10]=(a30*b04-a31*b02+a33*b00)*det; out[11]=(a21*b02-a20*b04-a23*b00)*det;
    out[12]=(a11*b07-a10*b09-a12*b06)*det; out[13]=(a00*b09-a01*b07+a02*b06)*det;
    out[14]=(a31*b01-a30*b03-a32*b00)*det; out[15]=(a20*b03-a21*b01+a22*b00)*det;
    return out;
  }
  function m4Translate(x,y,z){ var out=m4Identity(); out[12]=x; out[13]=y; out[14]=z; return out; }
  function m4RotateZ(t){ var out=m4Identity(); var c=Math.cos(t),s=Math.sin(t); out[0]=c; out[1]=s; out[4]=-s; out[5]=c; return out; }
  function m4RotateY(t){ var out=m4Identity(); var c=Math.cos(t),s=Math.sin(t); out[0]=c; out[2]=-s; out[8]=s; out[10]=c; return out; }
  function m4TransformVec4(m,v){
    var x=v[0],y=v[1],z=v[2],w=v[3];
    return [m[0]*x+m[4]*y+m[8]*z+m[12]*w, m[1]*x+m[5]*y+m[9]*z+m[13]*w, m[2]*x+m[6]*y+m[10]*z+m[14]*w, m[3]*x+m[7]*y+m[11]*z+m[15]*w];
  }
  function vSub(a,b){ return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
  function vNorm(a){ var l=Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; }

  var gl = canvas.getContext("webgl", { alpha: true }) || canvas.getContext("experimental-webgl", { alpha: true });
  if (!gl) { if (statusEl) statusEl.textContent = "이 브라우저는 WebGL을 지원하지 않습니다."; return; }
  // With no requested background the canvas stays fully opaque (its own
  // dark void color, cleared with alpha 1). A requested gradient instead
  // clears to alpha 0 so the CSS gradient painted behind the canvas (see
  // viewerFragmentCss) shows through the empty sky - only the floor/shapes
  // stay opaque, and their distance fog fades toward the gradient's own
  // bottom color so the horizon blends into it instead of seaming.
  var HAS_BG = !!SCENE.background;
  var VOID_COLOR = HAS_BG ? SCENE.background.bottom : [0.039, 0.051, 0.071];

  var vsSrc = ["attribute vec3 aPosition;","attribute vec3 aNormal;","attribute vec2 aUv;",
    "uniform mat4 uModel, uView, uProj;","varying vec3 vNormal, vWorldPos;","varying vec2 vUv;",
    "void main() {","  vec4 wp = uModel * vec4(aPosition, 1.0);","  vWorldPos = wp.xyz;",
    "  vNormal = mat3(uModel) * aNormal;","  vUv = aUv;","  gl_Position = uProj * uView * wp;","}"].join("\\n");
  var fsSrc = ["precision mediump float;","varying vec3 vNormal, vWorldPos;","varying vec2 vUv;",
    "uniform float uUseTexture;","uniform sampler2D uTex;","uniform vec3 uBaseColor, uEye, uVoidColor, uLightDir;",
    "uniform vec2 uFogRange;","uniform float uHighlight;",
    "void main() {","  vec3 N = normalize(vNormal);","  float diff = max(dot(N, uLightDir), 0.0);",
    "  vec3 albedo = uBaseColor;","  if (uUseTexture > 0.5) { albedo = texture2D(uTex, vUv).rgb; }",
    // Low ambient (0.08) so the unlit side reads as genuine shadow instead of
    // the old flat "never fully dark" look, like a distant point-source sun
    // rather than soft ambient studio light. A tight Blinn-Phong specular
    // lobe (masked to the lit hemisphere via the diff>0 step) adds the sun
    // glint "강한 태양광" asked for, without a full shadow-map pass - between
    // the two, a sphere shows a clear bright hemisphere and dark hemisphere.
    // uHighlight (0 or 1, set per-draw from JS) is "조명이 비추는" the clicked
    // object: a much higher ambient floor so even its shadowed side lifts
    // toward lit rather than staying dark (a real added light fills shadows
    // in, a flat color tint wouldn't), plus a brighter/tighter specular for
    // a visibly shinier, spotlit look.
    "  float ambient = 0.08 + uHighlight * 0.45;",
    "  vec3 diffuseLit = albedo * (ambient + (1.0 - ambient) * diff);",
    "  vec3 viewDir = normalize(uEye - vWorldPos);","  vec3 halfDir = normalize(uLightDir + viewDir);",
    "  float spec = pow(max(dot(N, halfDir), 0.0), 28.0) * step(0.04, diff);",
    // The ambient/specular boost above reads as "a bit brighter under the
    // sun" - too subtle to notice at a glance, which is exactly what made
    // the inference result invisible in practice (reported by the user: an
    // activated output node just wasn't visibly different from the other
    // nine). This adds a genuine additive glow on top, independent of
    // lighting angle entirely, so a fully-activated shape (uHighlight near
    // 1 - the predicted digit) reads as unmistakably lit up even from its
    // own shadow side. Squared so partial layer-activation glow (0.3-0.6,
    // just "this layer fired somewhat") stays subtle while only a value
    // near 1 (the actual winning output node, or a manual click-focus)
    // gets the full glow.
    "  vec3 lit = diffuseLit + vec3(spec * (0.4 + uHighlight * 0.7)) + uHighlight * uHighlight * vec3(1.0, 0.82, 0.35) * 0.9;",
    "  float dist = length(vWorldPos - uEye);",
    // Fog range is scene-scale-relative (uFogRange, set from the camera's
    // own current distance each frame - see frame() below), not a fixed
    // constant - a fixed 16..34 window looks fine at demo scale but silently
    // washes out anything at astronomical scale where the camera has to sit
    // much farther back just to fit the scene in frame.
    "  float fog = clamp((dist - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);",
    "  gl_FragColor = vec4(mix(lit, uVoidColor, fog), 1.0);","}"].join("\\n");

  function compile(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  var program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  var loc = {
    aPosition: gl.getAttribLocation(program, "aPosition"),
    aNormal: gl.getAttribLocation(program, "aNormal"),
    aUv: gl.getAttribLocation(program, "aUv"),
    uModel: gl.getUniformLocation(program, "uModel"),
    uView: gl.getUniformLocation(program, "uView"),
    uProj: gl.getUniformLocation(program, "uProj"),
    uUseTexture: gl.getUniformLocation(program, "uUseTexture"),
    uTex: gl.getUniformLocation(program, "uTex"),
    uBaseColor: gl.getUniformLocation(program, "uBaseColor"),
    uEye: gl.getUniformLocation(program, "uEye"),
    uVoidColor: gl.getUniformLocation(program, "uVoidColor"),
    uLightDir: gl.getUniformLocation(program, "uLightDir"),
    uFogRange: gl.getUniformLocation(program, "uFogRange"),
    uHighlight: gl.getUniformLocation(program, "uHighlight"),
  };

  // "클래스숫자/디멘전을 3차원으로 표시": a second, much simpler unlit+
  // alpha-blended program for camera-facing text billboards (a layer's own
  // dimension string, an output node's own digit) - separate from the main
  // lit program above since text needs neither normals nor lighting, only
  // straight alpha-blended texture sampling.
  var textVsSrc = ["attribute vec3 aPosition;","attribute vec2 aUv;",
    "uniform mat4 uView, uProj;","varying vec2 vUv;",
    "void main() {","  vUv = aUv;","  gl_Position = uProj * uView * vec4(aPosition, 1.0);","}"].join("\\n");
  var textFsSrc = ["precision mediump float;","varying vec2 vUv;","uniform sampler2D uTex;",
    "void main() {","  vec4 c = texture2D(uTex, vUv);","  if (c.a < 0.05) discard;","  gl_FragColor = c;","}"].join("\\n");
  var textProgram = gl.createProgram();
  gl.attachShader(textProgram, compile(gl.VERTEX_SHADER, textVsSrc));
  gl.attachShader(textProgram, compile(gl.FRAGMENT_SHADER, textFsSrc));
  gl.linkProgram(textProgram);
  if (!gl.getProgramParameter(textProgram, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(textProgram));
  var textLoc = {
    aPosition: gl.getAttribLocation(textProgram, "aPosition"),
    aUv: gl.getAttribLocation(textProgram, "aUv"),
    uView: gl.getUniformLocation(textProgram, "uView"),
    uProj: gl.getUniformLocation(textProgram, "uProj"),
    uTex: gl.getUniformLocation(textProgram, "uTex"),
  };

  function makeBuffer(data, elementArray) {
    var buf = gl.createBuffer();
    gl.bindBuffer(elementArray ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER, buf);
    gl.bufferData(elementArray ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER,
      elementArray ? new Uint16Array(data) : new Float32Array(data), gl.STATIC_DRAW);
    return buf;
  }

  // ---- mesh builders (positions/normals/uv interleaved, indices) ----
  function pushVert(arr, p, n, uv) {
    var u = uv || [0,0];
    arr.push(p[0],p[1],p[2], n[0],n[1],n[2], u[0],u[1]);
  }

  function buildBoxMesh(sizeX, heightY, depth) {
    // heightY (Y extent) and depth (Z extent) each default to sizeX, giving
    // the original uniform cube - independent Y/Z let a shape show a second
    // or third quantity a single cube can't: e.g. a CNN feature-map layer's
    // channel thickness as Z, or a fully-connected layer's 1xN neuron vector
    // as an elongated X "rod" next to a thin fixed Y/Z.
    var hx = sizeX/2;
    var hy = (typeof heightY === "number" ? heightY : sizeX)/2;
    var hz = (typeof depth === "number" ? depth : sizeX)/2;
    var faces = [
      { n:[0,0,1],  v:[[-hx,-hy,hz],[hx,-hy,hz],[hx,hy,hz],[-hx,hy,hz]] },
      { n:[0,0,-1], v:[[hx,-hy,-hz],[-hx,-hy,-hz],[-hx,hy,-hz],[hx,hy,-hz]] },
      { n:[1,0,0],  v:[[hx,-hy,hz],[hx,-hy,-hz],[hx,hy,-hz],[hx,hy,hz]] },
      { n:[-1,0,0], v:[[-hx,-hy,-hz],[-hx,-hy,hz],[-hx,hy,hz],[-hx,hy,-hz]] },
      { n:[0,1,0],  v:[[-hx,hy,hz],[hx,hy,hz],[hx,hy,-hz],[-hx,hy,-hz]] },
      { n:[0,-1,0], v:[[-hx,-hy,-hz],[hx,-hy,-hz],[hx,-hy,hz],[-hx,-hy,hz]] },
    ];
    // Each face is wound BL,BR,TR,TL, so the same 4 UV corners map onto
    // every face in order - not just a placeholder, this is what actually
    // lets a texture (e.g. the weight-noise grid below) show up as an image
    // rather than a single sampled texel smeared across the whole box.
    // V=1 at the BOTTOM (BL/BR) and V=0 at the TOP (TR/TL): WebGL uploads a
    // canvas/image's own row 0 (its visual TOP) to texture row v=0 with no
    // flip - since here V increases with local +Y (up), leaving V=0 at the
    // bottom would sample the image's top row at the box's bottom edge,
    // rendering any real photo (e.g. the INPUT layer's attached digit
    // image) upside-down - reported by the user directly. Random noise
    // textures (the weights visualization) never revealed this since noise
    // looks the same flipped or not.
    var FACE_UV = [[0,1],[1,1],[1,0],[0,0]];
    var verts = [], idx = [], vi = 0;
    faces.forEach(function (f) {
      f.v.forEach(function (p, vidx) { pushVert(verts, p, f.n, FACE_UV[vidx]); });
      idx.push(vi,vi+1,vi+2, vi,vi+2,vi+3); vi += 4;
    });
    return { verts: verts, idx: idx, restY: hy };
  }

  function buildSphereMesh(size) {
    var r = size/2, W = 28, H = 18;
    var verts = [], idx = [];
    for (var i = 0; i <= H; i++) {
      var theta = (i/H) * Math.PI;
      for (var j = 0; j <= W; j++) {
        var phi = (j/W) * Math.PI * 2;
        var x = r*Math.sin(theta)*Math.cos(phi), y = r*Math.cos(theta), z = r*Math.sin(theta)*Math.sin(phi);
        pushVert(verts, [x,y,z], vNorm([x,y,z]), [j/W, i/H]);
      }
    }
    for (var ii = 0; ii < H; ii++) {
      for (var jj = 0; jj < W; jj++) {
        var a = ii*(W+1)+jj, b = a+W+1;
        idx.push(a,b,a+1, a+1,b,b+1);
      }
    }
    return { verts: verts, idx: idx, restY: r };
  }

  function buildCylinderMesh(size) {
    var r = size*0.4, h = size, half = h/2, W = 20;
    var verts = [], idx = [];
    for (var i = 0; i <= W; i++) {
      var phi = (i/W)*Math.PI*2, x = r*Math.cos(phi), z = r*Math.sin(phi);
      var n = vNorm([x,0,z]);
      pushVert(verts, [x,-half,z], n);
      pushVert(verts, [x, half,z], n);
    }
    for (var s = 0; s < W; s++) {
      var a = s*2, b = a+2;
      idx.push(a,a+1,b, a+1,b+1,b);
    }
    var baseStart = verts.length/8;
    pushVert(verts, [0,-half,0], [0,-1,0]);
    for (var j = 0; j <= W; j++) { var p=(j/W)*Math.PI*2; pushVert(verts, [r*Math.cos(p),-half,r*Math.sin(p)], [0,-1,0]); }
    for (var k = 0; k < W; k++) idx.push(baseStart, baseStart+1+k, baseStart+2+k);
    var topStart = verts.length/8;
    pushVert(verts, [0,half,0], [0,1,0]);
    for (var j2 = 0; j2 <= W; j2++) { var p2=(j2/W)*Math.PI*2; pushVert(verts, [r*Math.cos(p2),half,r*Math.sin(p2)], [0,1,0]); }
    for (var k2 = 0; k2 < W; k2++) idx.push(topStart, topStart+2+k2, topStart+1+k2);
    return { verts: verts, idx: idx, restY: half };
  }

  function buildConeMesh(size) {
    var r = size*0.4, h = size, half = h/2, W = 20;
    var verts = [], idx = [];
    for (var i = 0; i <= W; i++) {
      var phi = (i/W)*Math.PI*2, x = Math.cos(phi), z = Math.sin(phi);
      var n = vNorm([h*x, r, h*z]);
      pushVert(verts, [r*x,-half,r*z], n);
      pushVert(verts, [0,half,0], n);
    }
    for (var s = 0; s < W; s++) { var a=s*2, b=a+2; idx.push(a,a+1,b, a+1,b+1,b); }
    var baseStart = verts.length/8;
    pushVert(verts, [0,-half,0], [0,-1,0]);
    for (var j = 0; j <= W; j++) { var p=(j/W)*Math.PI*2; pushVert(verts, [r*Math.cos(p),-half,r*Math.sin(p)], [0,-1,0]); }
    for (var k = 0; k < W; k++) idx.push(baseStart, baseStart+1+k, baseStart+2+k);
    return { verts: verts, idx: idx, restY: half };
  }

  function buildMesh(type, size, thickness, heightY) {
    if (type === "sphere") return buildSphereMesh(size);
    if (type === "cylinder") return buildCylinderMesh(size);
    if (type === "cone") return buildConeMesh(size);
    return buildBoxMesh(size, heightY, thickness);
  }

  // A plain ring of points for an orbit trail, drawn as GL_LINE_LOOP (not a
  // filled/extruded shape) - built in local space centered on the orbit's
  // own center, translated into place at draw time. A constant up-normal on
  // every vertex keeps the whole ring evenly lit rather than shading unevenly
  // around its circumference.
  function buildOrbitLineMesh(radius) {
    var segments = 96;
    var verts = [], idx = [];
    for (var i = 0; i < segments; i++) {
      var a = (i/segments) * Math.PI * 2;
      pushVert(verts, [radius*Math.cos(a), 0, radius*Math.sin(a)], [0,1,0]);
      idx.push(i);
    }
    return { verts: verts, idx: idx };
  }

  function shapeColor(c) {
    return Array.isArray(c) && c.length === 3 ? c : [0.55, 0.55, 0.58];
  }

  function makeTexture(canvas) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // Procedural stand-ins, not real satellite imagery - this pipeline has no
  // way to fetch or bundle an actual photo, so "textured like Earth/the Moon"
  // means "plausibly patterned like one" (blue oceans + green continents +
  // ice caps; grey cratered surface), not a real map.
  function buildEarthTextureCanvas() {
    var c = document.createElement("canvas");
    c.width = 256; c.height = 128;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#1c5c96"; ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = "#3f8f4a";
    for (var i = 0; i < 22; i++) {
      var cx = Math.random()*256, cy = 20+Math.random()*88, r = 10+Math.random()*22;
      [cx-256, cx, cx+256].forEach(function (wx) {
        ctx.beginPath(); ctx.ellipse(wx, cy, r, r*0.6, Math.random()*Math.PI, 0, Math.PI*2); ctx.fill();
      });
    }
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillRect(0, 0, 256, 6);
    ctx.fillRect(0, 122, 256, 6);
    return c;
  }

  function buildMoonTextureCanvas() {
    var c = document.createElement("canvas");
    c.width = 256; c.height = 128;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#9c9a92"; ctx.fillRect(0, 0, 256, 128);
    for (var i = 0; i < 90; i++) {
      var cx = Math.random()*256, cy = Math.random()*128, r = 1+Math.random()*7;
      var shade = 60 + Math.floor(Math.random()*45);
      ctx.fillStyle = "rgb(" + shade + "," + shade + "," + (shade-3) + ")";
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
      [cx-256, cx+256].forEach(function (wx) {
        ctx.beginPath(); ctx.arc(wx, cy, r, 0, Math.PI*2); ctx.fill();
      });
    }
    return c;
  }

  // An untrained network's weights are just independent random noise (e.g.
  // Xavier/He init), not a meaningful pattern - one texel of literal random
  // grayscale per weight, at that layer's own array dimensions, is exactly
  // "그레이스케일 픽셀로 만든 이미지 텍스쳐" for "학습안된 초기가중치". Each
  // texel's grayscale value is scaled by the shape's own required color
  // (shapeColor, 0..1 per channel) rather than left neutral gray, so the
  // scene's own per-layer color requirement still reads through the noise -
  // the fragment shader fully replaces base color with texture color when a
  // texture is bound, so the tint has to be baked into the texture itself.
  // values, when given, is this shape's own real weight array - the exact
  // numbers runInference() below actually multiplies against - instead of
  // throwaway per-texel noise, so what's drawn on the layer and what it
  // computes with are the same numbers. Real init weights cluster in a
  // narrow range (e.g. He-init ~[-0.3, 0.3]) so it's min/max-normalized
  // across the array first, then sampled cyclically (index % length) to
  // fill exactly w*h texels regardless of how the array's own length
  // compares to that count.
  function buildWeightTextureCanvas(w, h, color, values) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    var img = ctx.createImageData(w, h);
    var sample;
    if (values && values.length) {
      var min = Infinity, max = -Infinity;
      for (var vi = 0; vi < values.length; vi++) { if (values[vi] < min) min = values[vi]; if (values[vi] > max) max = values[vi]; }
      var range = (max - min) || 1;
      sample = function (i) { return Math.round(((values[i % values.length] - min) / range) * 255); };
    } else {
      sample = function () { return Math.floor(Math.random() * 256); };
    }
    for (var i = 0; i < w * h; i++) {
      var v = sample(i);
      img.data[i*4] = Math.round(v * color[0]);
      img.data[i*4+1] = Math.round(v * color[1]);
      img.data[i*4+2] = Math.round(v * color[2]);
      img.data[i*4+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // NEAREST + CLAMP (not makeTexture's LINEAR/REPEAT) so each weight stays a
  // crisp, individually-readable texel instead of blurring into its
  // neighbors - these grids are often just a handful of pixels across.
  function makeWeightTexture(w, h, color, values) {
    var canvas = buildWeightTextureCanvas(w, h, color, values);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // Renders a shape's own label3d string (a layer's dimensions, e.g.
  // "28x28x6", or an output node's own digit, e.g. "3") to a padded canvas
  // with a dark outline for legibility against any background color, then
  // uploads it as a texture for the billboard quad drawLabels() below draws
  // it on. aspect (width/height) is returned alongside so the billboard
  // quad can be sized to the text's own real proportions instead of always
  // being square.
  function buildLabelTexture(text) {
    var fontPx = 64, padX = 20, padY = 14;
    var measureCanvas = document.createElement("canvas");
    var mctx = measureCanvas.getContext("2d");
    mctx.font = "bold " + fontPx + "px -apple-system, BlinkMacSystemFont, sans-serif";
    var textW = Math.ceil(mctx.measureText(text).width);
    var c = document.createElement("canvas");
    c.width = textW + padX * 2;
    c.height = fontPx + padY * 2;
    var ctx = c.getContext("2d");
    ctx.font = "bold " + fontPx + "px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = fontPx * 0.16;
    ctx.strokeStyle = "rgba(8,10,14,0.95)";
    ctx.strokeText(text, c.width / 2, c.height / 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, c.width / 2, c.height / 2);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex: tex, aspect: c.width / c.height };
  }

  function texturePreset(s) {
    if (s.texture === "earth") return makeTexture(buildEarthTextureCanvas());
    if (s.texture === "moon") return makeTexture(buildMoonTextureCanvas());
    if (s.texture === "weights") {
      var grid = s.weightGrid || [8, 8];
      return makeWeightTexture(grid[0], grid[1], shapeColor(s.color), s.weights);
    }
    return null;
  }

  // A real image the page's own author attached (lib/ollama.js only ever
  // hands back a same-origin /uploads/... path, validated server-side).
  // Textures load asynchronously - starts as a solid grey placeholder so the
  // shape is never invisible/untextured-black while the real file is still
  // downloading, then the same GL texture object is updated in place once it
  // arrives (no need to touch the shape's own state). Uploaded images are
  // essentially never power-of-two, so wrap must stay CLAMP_TO_EDGE (WebGL1
  // forbids REPEAT/mipmaps on NPOT textures) - harmless here anyway since
  // this mesh's UVs never leave the 0..1 range.
  function textureFromUrl(url) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([120,120,120,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var img = new Image();
    img.onload = function () {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    img.src = url;
    return tex;
  }

  function textureFor(s) {
    if (s.textureUrl) return textureFromUrl(s.textureUrl);
    return texturePreset(s);
  }

  var shapes = SCENE.shapes.map(function (s) {
    var mesh = buildMesh(s.type, s.size, s.thickness, s.heightY);
    var orbit = s.orbit ? {
      center: s.orbit.center, radius: s.orbit.radius, speed: s.orbit.speed,
      angle0: Math.atan2(s.z - s.orbit.center[2], s.x - s.orbit.center[0]),
    } : null;
    // Half-extent on every axis (X from size, Z from thickness when a box
    // has one, Y from the mesh's own already-computed restY) combined into
    // one bounding radius - lets the click-to-focus camera below frame this
    // shape's true 3D footprint, not a single shared guess, so a thin
    // elongated shape (e.g. a fully-connected layer's long rod) fills the
    // frame exactly like a small flat one does instead of one of them
    // sitting tiny/cut-off.
    var hx = s.size / 2;
    var hz = (s.type === "box" && Number.isFinite(s.thickness) ? s.thickness : s.size) / 2;
    var boundingRadius = Math.sqrt(hx * hx + mesh.restY * mesh.restY + hz * hz);
    return {
      color: shapeColor(s.color),
      tex: textureFor(s),
      buf: makeBuffer(mesh.verts, false),
      idxBuf: makeBuffer(mesh.idx, true),
      count: mesh.idx.length,
      restY: mesh.restY,
      boundingRadius: boundingRadius,
      startX: s.x, startY: s.y, startZ: s.z,
      x: s.x, y: s.y, z: s.z,
      vY: 0, vX: 0, angle: 0, hasBounced: false,
      interactive: s.interactive, falling: false, landed: false,
      spin: s.spin || 0, spinAngle: 0,
      orbit: orbit,
      activation: 0,
    };
  });

  // "클래스숫자/디멘전을 3차원으로 표시": one floating camera-facing text
  // billboard per shape that asked for one (SCENE.shapes[i].label3d) -
  // positioned just above that shape and re-read from the runtime shapes
  // entry every frame (not baked in once), so a label still tracks its own
  // shape correctly even if that shape later moves (falls/orbits).
  var labels = SCENE.shapes
    .map(function (s, i) { return s.label3d ? { shape: shapes[i], text: String(s.label3d), side: s.labelSide } : null; })
    .filter(Boolean)
    .map(function (l) {
      var built = buildLabelTexture(l.text);
      l.tex = built.tex;
      l.aspect = built.aspect;
      return l;
    });
  var labelBuf = labels.length ? gl.createBuffer() : null;

  function vAdd(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
  function vScale(a, k) { return [a[0]*k, a[1]*k, a[2]*k]; }
  function vCross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }

  // "실제 딥러닝모델 추론기능": SCENE.inference (when present) is a real,
  // if untrained, LeNet-5 forward pass wired to this same scene's own shapes
  // - every conv/FC layer's weights live on SCENE.shapes[shapeIndex].weights
  // (the exact array already driving that shape's texture above, see
  // buildWeightTextureCanvas), so the numbers rendered on a layer's surface
  // are the numbers it actually computes with, not a separate decorative
  // random draw. Runs once against the page's own attached input image and
  // lights up each layer/output node (via the shared uHighlight glow used
  // for click-focus) proportional to how hard it actually fired.
  function buildInputGrayscale(img, size) {
    var c = document.createElement("canvas");
    c.width = size; c.height = size;
    var ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, size, size);
    var data = ctx.getImageData(0, 0, size, size).data;
    var out = new Array(size * size);
    for (var i = 0; i < size * size; i++) {
      var lum = (data[i*4] + data[i*4+1] + data[i*4+2]) / 3 / 255;
      out[i] = 1 - lum; // dark stroke on light paper -> high activation, like MNIST
    }
    return out;
  }

  function conv2d(input, inC, inH, inW, weights, bias, outC, k) {
    var outH = inH - k + 1, outW = inW - k + 1;
    var out = new Array(outC * outH * outW);
    for (var oc = 0; oc < outC; oc++) {
      for (var oy = 0; oy < outH; oy++) {
        for (var ox = 0; ox < outW; ox++) {
          var sum = bias[oc] || 0;
          for (var ic = 0; ic < inC; ic++) {
            for (var ky = 0; ky < k; ky++) {
              for (var kx = 0; kx < k; kx++) {
                var iv = input[ic*inH*inW + (oy+ky)*inW + (ox+kx)];
                var wv = weights[((oc*inC+ic)*k+ky)*k+kx];
                sum += iv * wv;
              }
            }
          }
          out[(oc*outH+oy)*outW+ox] = Math.max(0, sum); // ReLU
        }
      }
    }
    return { data: out, c: outC, h: outH, w: outW };
  }

  function avgPool2(input, c, h, w) {
    var outH = h >> 1, outW = w >> 1;
    var out = new Array(c * outH * outW);
    for (var ch = 0; ch < c; ch++) {
      for (var oy = 0; oy < outH; oy++) {
        for (var ox = 0; ox < outW; ox++) {
          var sum = 0;
          for (var dy = 0; dy < 2; dy++) {
            for (var dx = 0; dx < 2; dx++) sum += input[ch*h*w + (oy*2+dy)*w + (ox*2+dx)];
          }
          out[(ch*outH+oy)*outW+ox] = sum / 4;
        }
      }
    }
    return { data: out, c: c, h: outH, w: outW };
  }

  function fcForward(input, weights, bias, inN, outN, relu) {
    var out = new Array(outN);
    for (var o = 0; o < outN; o++) {
      var sum = bias[o] || 0;
      var base = o * inN;
      for (var i = 0; i < inN; i++) sum += input[i] * weights[base+i];
      out[o] = relu ? Math.max(0, sum) : sum;
    }
    return out;
  }

  function meanAbs(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += Math.abs(arr[i]);
    return arr.length ? s / arr.length : 0;
  }

  // A conv/pool layer's real output is C independent feature maps, not one
  // blended number - collapsing them all into a single meanAbs (as the
  // layer used to) hid genuine per-channel differences (one filter reacts
  // strongly to this digit's strokes, another barely at all) behind one
  // shared average, reported by the user directly. data is flat
  // [c,h,w]-order (conv2d/avgPool2's own layout) - this slices out each
  // channel's own h*w block and returns one meanAbs per channel.
  function meanAbsPerChannel(data, c, h, w) {
    var per = h * w;
    var out = new Array(c);
    for (var ch = 0; ch < c; ch++) out[ch] = meanAbs(data.slice(ch * per, ch * per + per));
    return out;
  }

  // "재추론 버튼 - 실시간으로 재추론": re-running the exact same fixed
  // weights against the exact same fixed input image would just repeat the
  // identical result on every click, which isn't much of a button. Instead
  // this re-rolls a brand new He-init random draw for every weight-bearing
  // layer (fan-in per layer taken from the same inf.layers metadata
  // runInference() already uses, so the scale matches what was originally
  // generated) and rebuilds each shape's own weights-texture from the new
  // values in place - keeping this module's own rule that a layer's texture
  // and what it actually computes with are always the same numbers, even
  // across re-rolls.
  function randomWeightsFor(count, fanIn) {
    var scale = Math.sqrt(2 / fanIn);
    var out = new Array(count);
    for (var i = 0; i < count; i++) out[i] = (Math.random() * 2 - 1) * scale;
    return out;
  }

  function refreshShapeWeights(shapeIndex, newWeights) {
    var sceneShape = SCENE.shapes[shapeIndex];
    sceneShape.weights = newWeights;
    var runtimeShape = shapes[shapeIndex];
    var grid = sceneShape.weightGrid || [8, 8];
    if (runtimeShape.tex) gl.deleteTexture(runtimeShape.tex);
    runtimeShape.tex = makeWeightTexture(grid[0], grid[1], shapeColor(sceneShape.color), newWeights);
  }

  function reinitWeights() {
    var inf = SCENE.inference;
    if (!inf) return;
    inf.layers.forEach(function (layer) {
      if (layer.type === "conv") {
        // One shape per output channel (shapeIndices, not a single
        // shapeIndex) - each gets its own fan-in-scaled kernel
        // (inC*k*k weights), matching how the build script sliced the
        // real trained kernel per channel in the first place.
        var fanIn = layer.inC * layer.k * layer.k;
        layer.shapeIndices.forEach(function (shapeIndex) {
          refreshShapeWeights(shapeIndex, randomWeightsFor(fanIn, fanIn));
        });
      } else if (layer.type === "fc") {
        refreshShapeWeights(layer.shapeIndex, randomWeightsFor(layer.outN * layer.inN, layer.inN));
      }
    });
    inf.output.nodeShapeIndices.forEach(function (shapeIndex) {
      var fanIn = SCENE.shapes[shapeIndex].weights.length;
      refreshShapeWeights(shapeIndex, randomWeightsFor(fanIn, fanIn));
    });
  }

  // avgpool (S2/S4-style) layers have no weights at all, trained or
  // otherwise - their texture is decorative noise from the start (see
  // pushConvBox in the build script), never something reinitWeights()'s
  // "don't touch a real trained model" guard needs to protect. There was
  // no actual reason left to leave them frozen after page load, so a
  // re-infer click re-rolls their noise fresh too - reported directly by
  // the user ("s는 풀링레이어라면 재추론하면 그래픽이 달라져야 하는거
  // 아냐?"), and they were right.
  function refreshDecorativeTexture(shapeIndex) {
    var sceneShape = SCENE.shapes[shapeIndex];
    var runtimeShape = shapes[shapeIndex];
    if (!sceneShape || !runtimeShape || sceneShape.texture !== "weights") return;
    var grid = sceneShape.weightGrid || [8, 8];
    if (runtimeShape.tex) gl.deleteTexture(runtimeShape.tex);
    runtimeShape.tex = makeWeightTexture(grid[0], grid[1], shapeColor(sceneShape.color));
  }

  // Persists across every runInference() call (including re-infer button
  // clicks) - see the fired.forEach comment below for why this has to
  // survive between runs rather than being reset fresh each time.
  var layerMaxSeen = {};

  function runInference() {
    var inf = SCENE.inference;
    if (!inf) return;
    if (reinferBtn) reinferBtn.disabled = true;
    focusShape = null;
    if (predictEl) predictEl.textContent = "🧠 추론 중...";
    var img = new Image();
    img.onload = function () {
      try {
        var cur = { data: buildInputGrayscale(img, inf.inputSize), c: 1, h: inf.inputSize, w: inf.inputSize };
        var fired = [];
        for (var li = 0; li < inf.layers.length; li++) {
          var layer = inf.layers[li];
          if (layer.type === "conv") {
            // One shape per output channel (layer.shapeIndices) - the real
            // conv2d math still needs the FULL kernel tensor (all channels
            // together), so it's reconstructed by concatenating each
            // channel-shape's own weight slice back in output-channel
            // order. Those slices are exactly what the build script cut
            // the real trained kernel into in the first place (PyTorch's
            // own (outC,inC,kH,kW) row-major layout is already contiguous
            // per output channel), so concatenating them back reproduces
            // the original full array exactly - no information lost by
            // splitting it across shapes for display.
            var cw = [];
            layer.shapeIndices.forEach(function (shapeIndex) {
              cw = cw.concat(SCENE.shapes[shapeIndex].weights);
            });
            cur = conv2d(cur.data, cur.c, cur.h, cur.w, cw, layer.bias, layer.outC, layer.k);
            var convPerCh = meanAbsPerChannel(cur.data, cur.c, cur.h, cur.w);
            layer.shapeIndices.forEach(function (shapeIndex, ch) {
              fired.push({ shapeIndex: shapeIndex, value: convPerCh[ch] });
            });
          } else if (layer.type === "avgpool") {
            cur = avgPool2(cur.data, cur.c, cur.h, cur.w);
            // Pooling has no weights of its own, but its OUTPUT still
            // genuinely varies with the input digit, per channel -
            // shapeIndices is optional here specifically because not
            // every avgpool necessarily maps onto visible shapes.
            if (layer.shapeIndices) {
              var poolPerCh = meanAbsPerChannel(cur.data, cur.c, cur.h, cur.w);
              layer.shapeIndices.forEach(function (shapeIndex, ch) {
                fired.push({ shapeIndex: shapeIndex, value: poolPerCh[ch] });
              });
            }
          } else if (layer.type === "fc") {
            var fw = SCENE.shapes[layer.shapeIndex].weights;
            var outArr = fcForward(cur.data, fw, layer.bias, layer.inN, layer.outN, true);
            cur = { data: outArr, c: 1, h: 1, w: layer.outN };
            fired.push({ shapeIndex: layer.shapeIndex, value: meanAbs(outArr) });
          }
        }

        // Output layer: each digit node carries its own independent weight
        // vector/bias (see build script) rather than one shared matrix.
        var out = inf.output;
        var scores = out.nodeShapeIndices.map(function (shapeIndex, d) {
          var nw = SCENE.shapes[shapeIndex].weights;
          var sum = out.bias[d] || 0;
          for (var i = 0; i < nw.length; i++) sum += cur.data[i] * nw[i];
          return sum;
        });

        var predicted = 0;
        for (var d = 1; d < scores.length; d++) if (scores[d] > scores[predicted]) predicted = d;
        var maxScore = Math.max.apply(null, scores);
        var expSum = 0;
        var exps = scores.map(function (s) { var e = Math.exp(s - maxScore); expSum += e; return e; });
        var predictedProb = exps[predicted] / expSum;

        // Raw scores from untrained/random weights are often too flat for
        // softmax alone to read visually - min/max-normalize across the 10
        // nodes so the spread always shows, then force the actual winner to
        // full brightness (argmax is identical either way, this only helps
        // legibility).
        var minS = Math.min.apply(null, scores), maxS = Math.max.apply(null, scores);
        var range = (maxS - minS) || 1;
        out.nodeShapeIndices.forEach(function (shapeIndex, d) {
          shapes[shapeIndex].activation = (scores[d] - minS) / range;
        });
        shapes[out.nodeShapeIndices[predicted]].activation = 1;

        // Each hidden layer's brightness is relative to the STRONGEST that
        // SAME layer has ever fired across every run so far (a running
        // per-shape max, layerMaxSeen - persists across re-infer clicks),
        // not relative to its sibling layers within just this one run.
        // Normalizing against siblings meant whichever layer happens to
        // have the largest raw activation always renders at full
        // brightness on every single run regardless of digit, making the
        // hidden layers look statically identical run to run even though
        // their real values differed - reported by the user directly
        // ("입력과 출력만 그래픽이 변하는거 같은데"). Against its own
        // history instead, a layer that fires unusually hard for THIS
        // particular digit visibly lights up brighter than it did last
        // time, and one that barely fires visibly dims - a real,
        // per-layer, per-image signal.
        fired.forEach(function (f) {
          layerMaxSeen[f.shapeIndex] = Math.max(layerMaxSeen[f.shapeIndex] || 1e-6, f.value);
          shapes[f.shapeIndex].activation = f.value / layerMaxSeen[f.shapeIndex];
        });

        // Camera stays wherever the user currently has it (no auto-focus) -
        // the glow above plus each shape's own floating label are enough to
        // read the result without yanking the view out from under someone
        // who's mid-orbit or has picked their own angle via the view
        // buttons, per explicit user feedback.
        if (predictEl) {
          var weightsNote = inf.trained ? "사전학습된 실제 가중치" : "미학습 초기가중치";
          predictEl.textContent = "🧠 추론 결과: " + predicted + "  (확률 " + Math.round(predictedProb * 100) + "%, " + weightsNote + ")";
        }
      } catch (err) {
        if (predictEl) predictEl.textContent = "⚠️ 추론 실패: " + err.message;
      }
      if (reinferBtn) reinferBtn.disabled = false;
    };
    img.onerror = function () {
      if (predictEl) predictEl.textContent = "⚠️ 입력 이미지를 불러오지 못했습니다.";
      if (reinferBtn) reinferBtn.disabled = false;
    };
    img.src = inf.inputImageUrl;
  }
  // "재추론 버튼을 누를 때마다 입력 이미지 숫자가 랜덤하게 바뀌어": when the
  // scene supplies a pool of real MNIST test-digit images (sampleImages,
  // see build script's tools/export_mnist_samples.py) plus which shape
  // displays the current input (inputShapeIndex), swap both the INPUT
  // box's own texture and inf.inputImageUrl to a freshly-picked one before
  // re-running the forward pass, instead of always re-classifying the same
  // single attached image.
  function pickRandomInputImage() {
    var pool = SCENE.inference && SCENE.inference.sampleImages;
    if (!pool || !pool.length) return;
    var entry = pool[Math.floor(Math.random() * pool.length)];
    var url = typeof entry === "string" ? entry : entry.url;
    SCENE.inference.inputImageUrl = url;
    var idx = SCENE.inference.inputShapeIndex;
    if (typeof idx === "number" && shapes[idx]) {
      if (shapes[idx].tex) gl.deleteTexture(shapes[idx].tex);
      shapes[idx].tex = textureFromUrl(url);
    }
  }

  runInference();
  if (reinferBtn) {
    reinferBtn.addEventListener("click", function () {
      if (reinferBtn.disabled) return;
      // inference.trained (see build script) marks a scene as carrying a
      // real pretrained model, not a random-init demo - re-randomizing on
      // every click would silently destroy that trained model after the
      // very first click, so this only re-rolls weights for the untrained
      // demo case. A trained scene's button just re-runs the same real
      // forward pass on a freshly-picked input image instead. Reads
      // SCENE.inference directly (not the inf local var, which only
      // exists inside runInference()'s own function scope).
      if (!SCENE.inference.trained) reinitWeights();
      // Pooling layers have no weights to protect either way (see
      // refreshDecorativeTexture above) - always refresh them regardless
      // of inf.trained.
      SCENE.inference.layers.forEach(function (layer) {
        if (layer.type === "avgpool" && layer.shapeIndices) {
          layer.shapeIndices.forEach(refreshDecorativeTexture);
        }
      });
      pickRandomInputImage();
      runInference();
    });
  }

  // orbit trails - one thin ring per shape that has one, in its own local
  // space (centered on the orbit's own center) with a fixed model matrix
  var trails = SCENE.shapes
    .map(function (s, i) { return { s: s, i: i }; })
    .filter(function (o) { return o.s.orbit && o.s.orbit.trailColor; })
    .map(function (o) {
      var orbit = o.s.orbit;
      var mesh = buildOrbitLineMesh(orbit.radius);
      return {
        color: shapeColor(orbit.trailColor),
        buf: makeBuffer(mesh.verts, false),
        idxBuf: makeBuffer(mesh.idx, true),
        count: mesh.idx.length,
        model: m4Translate(orbit.center[0], orbit.center[1], orbit.center[2]),
      };
    });

  // floor
  var floorBuf = null, floorIdxBuf = null, floorIdxLen = 0, checkerTex = null;
  var FLOOR_SIZE = 10;
  if (SCENE.floor) {
    shapes.forEach(function (s) { FLOOR_SIZE = Math.max(FLOOR_SIZE, Math.abs(s.startX)*2 + 6, Math.abs(s.startZ)*2 + 6); });
    FLOOR_SIZE = Math.min(20, FLOOR_SIZE);
    var fv = [
      -FLOOR_SIZE,0,-FLOOR_SIZE, 0,1,0, 0,0,
       FLOOR_SIZE,0,-FLOOR_SIZE, 0,1,0, 1,0,
       FLOOR_SIZE,0, FLOOR_SIZE, 0,1,0, 1,1,
      -FLOOR_SIZE,0, FLOOR_SIZE, 0,1,0, 0,1,
    ];
    var fi = [0,1,2, 0,2,3];
    floorBuf = makeBuffer(fv, false); floorIdxBuf = makeBuffer(fi, true); floorIdxLen = fi.length;

    var texCanvas = document.createElement("canvas");
    texCanvas.width = texCanvas.height = 8;
    var tctx = texCanvas.getContext("2d");
    for (var ty = 0; ty < 8; ty++) for (var tx = 0; tx < 8; tx++) {
      tctx.fillStyle = (tx+ty)%2===0 ? "#1b212b" : "#e9e4d8";
      tctx.fillRect(tx,ty,1,1);
    }
    checkerTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, checkerTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(VOID_COLOR[0], VOID_COLOR[1], VOID_COLOR[2], HAS_BG ? 0 : 1);

  // ---- auto-framed orbit camera ----
  var minX=0,maxX=0,minZ=0,maxZ=0,maxY=1;
  shapes.forEach(function (s) {
    // An orbiting shape sweeps a full circle, not just its starting point -
    // frame the whole ring it travels, not just where it happens to start.
    if (s.orbit) {
      minX=Math.min(minX,s.orbit.center[0]-s.orbit.radius); maxX=Math.max(maxX,s.orbit.center[0]+s.orbit.radius);
      minZ=Math.min(minZ,s.orbit.center[2]-s.orbit.radius); maxZ=Math.max(maxZ,s.orbit.center[2]+s.orbit.radius);
    } else {
      minX=Math.min(minX,s.startX); maxX=Math.max(maxX,s.startX);
      minZ=Math.min(minZ,s.startZ); maxZ=Math.max(maxZ,s.startZ);
    }
    maxY=Math.max(maxY,s.startY);
  });
  var spread = Math.max(maxX-minX, maxZ-minZ, 4);
  // A wide row of near-flat shapes (e.g. a layer-by-layer diagram) reads its
  // own flat faces as squashed rectangles under the default 0.5rad angle,
  // worse the farther a shape sits from the row's own center - SCENE.camera
  // lets a scene ask for a flatter default angle so those faces read at
  // closer to their true proportions, still oblique enough to see depth.
  var camOverride = SCENE.camera || {};
  // The 1.4 floor below assumes demo-scale content (a ~1-unit cube resting
  // near the ground): fine when maxY*0.4 (a fraction of shapes' own Y
  // *position*) already clears it, but a scene of near-flat shapes hugging
  // y=0 (e.g. this layer diagram, tallest ~0.3) never does - the camera then
  // aims 1+ units above where the actual content sits, shrinking it toward
  // the bottom of the frame and making its true proportions unreadable.
  // centerY lets a scene say what height its own content actually occupies.
  var CENTER = [(minX+maxX)/2, typeof camOverride.centerY === "number" ? camOverride.centerY : Math.max(1.4, maxY*0.4), (minZ+maxZ)/2];
  // No upper cap - a scene scaled to real astronomical proportions (an
  // Earth-Moon distance of 200+ units) legitimately needs a camera far
  // enough back to fit both in frame; capping this at a small-demo-sized
  // value (as before) forced the camera close enough that nearby objects
  // fell inside the fog fade-out range below, making them look dim/washed
  // out for no lighting-related reason.
  // radiusScale lets a scene ask for a closer/farther default framing than
  // the auto-computed fit-everything distance below, without having to
  // reverse-engineer and hardcode an absolute radius that would silently
  // stop matching once the scene's own layout changes (shapes added/
  // resized/re-spaced) - 1 (default) keeps the existing auto-fit exactly
  // as before, < 1 moves the default view closer.
  var radiusScale = typeof camOverride.radiusScale === "number" ? camOverride.radiusScale : 1;
  var camera = {
    theta: typeof camOverride.theta === "number" ? camOverride.theta : 0.5,
    phi: typeof camOverride.phi === "number" ? camOverride.phi : 0.32,
    radius: Math.max(9, spread*1.4 + maxY*0.6 + 5) * radiusScale,
  };
  var DEFAULT_CENTER = CENTER.slice();
  var DEFAULT_RADIUS = camera.radius;
  var DEFAULT_THETA = camera.theta;
  var DEFAULT_PHI = camera.phi;
  var targetTheta = camera.theta;
  var targetPhi = camera.phi;

  // Five fixed orbit angles (see generateViewerFragment's viewLabels: 기본/
  // 정면/측면/위/대각선) - null means "use this scene's own default", the
  // rest are plain fixed radians so every scene gets the same predictable
  // front/side/top/diagonal vantage regardless of its own scale.
  var VIEW_PRESETS = [
    { theta: null, phi: null },
    { theta: 0, phi: 0.08 },
    { theta: 1.5708, phi: 0.08 },
    { theta: 0.5, phi: 1.4 },
    { theta: 1.0, phi: 0.55 },
  ];

  // Clicking any shape (not just fall-capable ones - a planet with no click-
  // to-fall physics should still be clickable to look at) smoothly glides
  // CENTER/radius toward it each frame; clicking empty space glides back out
  // to the scene's full default framing. Tracks a moving/orbiting target
  // continuously, not just a one-time aim, so focusing the Moon keeps
  // following it around its orbit.
  var focusShape = null;

  function eyePosition() {
    var p = camera.phi, t = camera.theta, r = camera.radius;
    return [CENTER[0]+r*Math.cos(p)*Math.sin(t), CENTER[1]+r*Math.sin(p), CENTER[2]+r*Math.cos(p)*Math.cos(t)];
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
    gl.viewport(0,0,canvas.width,canvas.height);
  }
  window.addEventListener("resize", resize);
  resize();

  var dragging=false, downX=0, downY=0, moved=0;
  function ndcFromEvent(e) {
    var r = canvas.getBoundingClientRect();
    return [((e.clientX-r.left)/r.width)*2-1, -(((e.clientY-r.top)/r.height)*2-1)];
  }
  function pickRay(ndc, vp, eye) {
    var inv = m4Invert(vp); if (!inv) return null;
    var far = m4TransformVec4(inv, [ndc[0], ndc[1], 1, 1]);
    var wf = [far[0]/far[3], far[1]/far[3], far[2]/far[3]];
    return { origin: eye, dir: vNorm(vSub(wf, eye)) };
  }
  function hitsShape(ray, s) {
    var pad = s.restY * 1.42;
    var min = [s.x-pad, s.y-pad, s.z-pad], max = [s.x+pad, s.y+pad, s.z+pad];
    var tmin=-Infinity, tmax=Infinity;
    for (var i=0;i<3;i++) {
      var o=ray.origin[i], d=ray.dir[i];
      if (Math.abs(d)<1e-9) { if (o<min[i]||o>max[i]) return false; }
      else {
        var t1=(min[i]-o)/d, t2=(max[i]-o)/d;
        if (t1>t2) { var tmp=t1; t1=t2; t2=tmp; }
        tmin=Math.max(tmin,t1); tmax=Math.min(tmax,t2);
        if (tmin>tmax) return false;
      }
    }
    return tmax>=0;
  }
  function pickShape(ray) {
    var best=null, bestDist=Infinity;
    shapes.forEach(function (s) {
      if (!hitsShape(ray,s)) return;
      var d = Math.hypot(s.x-ray.origin[0], s.y-ray.origin[1], s.z-ray.origin[2]);
      if (d<bestDist) { bestDist=d; best=s; }
    });
    return best;
  }
  function startFall(s) {
    if (!s.interactive || s.falling || s.y <= s.restY + 0.001) return;
    s.falling=true; s.landed=false; s.vY=0; s.vX=0; s.x=s.startX; s.z=s.startZ; s.angle=0; s.hasBounced=false;
    s.fallStartMs = performance.now();
  }

  var lastViewProj=null, lastEye=null;

  canvas.addEventListener("pointerdown", function (e) {
    dragging=true; moved=0; downX=e.clientX; downY=e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("vrml-dragging");
  });
  canvas.addEventListener("pointermove", function (e) {
    if (dragging) {
      var dx=e.clientX-downX, dy=e.clientY-downY;
      moved = Math.max(moved, Math.hypot(dx,dy));
      if (moved>4) {
        camera.theta -= (e.movementX||0)*0.006;
        camera.phi = Math.min(1.45, Math.max(0.1, camera.phi + (e.movementY||0)*0.006));
        targetTheta = camera.theta;
        targetPhi = camera.phi;
      }
    } else if (lastViewProj) {
      var ray = pickRay(ndcFromEvent(e), lastViewProj, lastEye);
      canvas.classList.toggle("vrml-hover", !!ray && !!pickShape(ray));
    }
  });
  canvas.addEventListener("pointerup", function (e) {
    dragging=false; canvas.classList.remove("vrml-dragging");
    if (moved<=4 && lastViewProj) {
      var ray = pickRay(ndcFromEvent(e), lastViewProj, lastEye);
      var hit = ray && pickShape(ray);
      focusShape = hit || null;
      if (hit) startFall(hit);
    }
  });
  if (resetBtn) resetBtn.addEventListener("click", function () {
    shapes.forEach(function (s) {
      s.x=s.startX; s.y=s.startY; s.z=s.startZ; s.vY=0; s.vX=0; s.angle=0; s.hasBounced=false; s.falling=false; s.landed=false;
    });
    focusShape = null;
  });

  // Per-object menu: same camera-focus glide as clicking the shape directly
  // in the 3D view, exposed as a named button - useful for objects with no
  // click-to-fall physics (e.g. planets), which are otherwise only
  // reachable by clicking their (possibly small, possibly moving) 3D mesh.
  // Selected by [data-shape-index] specifically (not the shared
  // .vrml-obj-btn class) and keyed off that attribute's own value - some
  // shapes are hidden from this menu (showButton:false, see
  // generateViewerFragment) so a button's position in this NodeList no
  // longer lines up with its position in the full shapes array.
  var objButtons = root.querySelectorAll("[data-shape-index]");
  var objButtonEntries = [];
  for (var mi = 0; mi < objButtons.length; mi++) {
    var obtn = objButtons[mi];
    var oidx = Number(obtn.getAttribute("data-shape-index"));
    objButtonEntries.push({ btn: obtn, idx: oidx });
    (function (idx) {
      obtn.addEventListener("click", function () { focusShape = shapes[idx]; });
    })(oidx);
  }

  // Five fixed-angle view buttons (기본/정면/측면/위/대각선 - see
  // generateViewerFragment's viewLabels) - defocuses any shape (a view
  // preset is about seeing the whole scene from a given angle) and glides
  // theta/phi toward the preset the same way center/radius already glide
  // toward a focused shape.
  var viewButtons = root.querySelectorAll("[data-view-index]");
  for (var vi = 0; vi < viewButtons.length; vi++) {
    (function (btn) {
      var preset = VIEW_PRESETS[Number(btn.getAttribute("data-view-index"))];
      if (!preset) return;
      btn.addEventListener("click", function () {
        focusShape = null;
        targetTheta = preset.theta === null ? DEFAULT_THETA : preset.theta;
        targetPhi = preset.phi === null ? DEFAULT_PHI : preset.phi;
      });
    })(viewButtons[vi]);
  }

  function draw(model, buf, idxBuf, count, tex, color, mode, highlight) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 32, 0);
    gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 32, 12);
    gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 32, 24);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.enableVertexAttribArray(loc.aNormal);
    gl.enableVertexAttribArray(loc.aUv);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.uniformMatrix4fv(loc.uModel, false, model);
    gl.uniform1f(loc.uUseTexture, tex?1:0);
    gl.uniform3fv(loc.uBaseColor, color);
    // highlight is 0..1, not just boolean - click-focus still passes a
    // plain true/false (coerces to 1/0), but runInference() below feeds
    // a continuous per-shape activation strength through the same uniform
    // so a layer/output-node can glow proportional to how hard it fired,
    // not just snap fully lit/unlit.
    gl.uniform1f(loc.uHighlight, highlight === true ? 1 : (highlight || 0));
    if (tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc.uTex, 0); }
    gl.drawElements(mode || gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  }

  // Draws every label as a quad that always faces the camera (billboard):
  // camRight/camUp are the camera's own local X/Y axes in world space,
  // derived the same way m4LookAt derives them internally, so a label reads
  // upright and undistorted from whatever angle the user is currently
  // orbiting from. Alpha-blended with depth *test* on (so a label behind an
  // opaque shape correctly hides) but depth *write* off (so overlapping
  // labels don't fight each other's depth), switching to the separate
  // unlit textProgram since labels need none of the main program's
  // lighting/highlight machinery.
  function drawLabels(eye, view, proj) {
    if (!labels.length) return;
    var back = vNorm(vSub(eye, CENTER));
    var worldUp = [0, 1, 0];
    var right = vNorm(vCross(worldUp, back));
    var up = vCross(back, right);

    gl.useProgram(textProgram);
    gl.uniformMatrix4fv(textLoc.uView, false, view);
    gl.uniformMatrix4fv(textLoc.uProj, false, proj);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, labelBuf);
    gl.enableVertexAttribArray(textLoc.aPosition);
    gl.enableVertexAttribArray(textLoc.aUv);
    gl.vertexAttribPointer(textLoc.aPosition, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(textLoc.aUv, 2, gl.FLOAT, false, 20, 12);

    labels.forEach(function (l) {
      var s = l.shape;
      var height = 0.34, width = height * l.aspect;
      // Output nodes are stacked in a tight vertical column - a label
      // centered above each one (the default, used everywhere else) would
      // sit right on top of the next node up the stack, unreadable.
      // labelSide:'right' (set per-shape by the build script, only on
      // OUTPUT nodes) offsets along the camera's own current right vector
      // instead, so the digit sits beside its node with clear space no
      // matter which way the scene's been rotated.
      var center = l.side === "right"
        ? vAdd([s.x, s.y, s.z], vScale(right, s.restY + width / 2 + 0.14))
        : [s.x, s.y + s.restY + 0.26, s.z];
      var rw = vScale(right, width / 2), ru = vScale(up, height / 2);
      var p0 = vAdd(center, vAdd(vScale(rw, -1), vScale(ru, -1))); // bottom-left
      var p1 = vAdd(center, vAdd(rw, vScale(ru, -1)));             // bottom-right
      var p2 = vAdd(center, vAdd(rw, ru));                          // top-right
      var p3 = vAdd(center, vAdd(vScale(rw, -1), ru));              // top-left
      var verts = [
        p0[0],p0[1],p0[2], 0,1,
        p1[0],p1[1],p1[2], 1,1,
        p2[0],p2[1],p2[2], 1,0,
        p3[0],p3[1],p3[2], 0,0,
      ];
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, l.tex);
      gl.uniform1i(textLoc.uTex, 0);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    });

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(program);
  }

  var lastFrameMs = 0;
  var simTime = 0;
  function frame(now) {
    var dt = lastFrameMs ? Math.min((now-lastFrameMs)/1000, 0.05) : 0;
    lastFrameMs = now;
    simTime += dt;

    shapes.forEach(function (s) {
      // Ambient motion (spin/orbit) runs unconditionally, independent of the
      // click-to-fall physics below - an orbiting body never falls.
      if (s.spin) s.spinAngle += s.spin * dt;
      if (s.orbit) {
        var ang = s.orbit.angle0 + simTime * s.orbit.speed;
        s.x = s.orbit.center[0] + s.orbit.radius * Math.cos(ang);
        s.z = s.orbit.center[2] + s.orbit.radius * Math.sin(ang);
      }

      if (!s.falling) return;
      s.vY -= GRAVITY*dt;
      s.y += s.vY*dt;
      if (s.vX > 0) {
        s.x += s.vX*dt;
        s.angle += (s.vX/Math.max(0.2,s.restY))*dt;
        s.vX = Math.max(0, s.vX - FRICTION*dt);
      }
      if (s.y <= s.restY && s.vY < 0) {
        s.y = s.restY;
        if (Math.abs(s.vY) < SETTLE_VY) { s.vY = 0; }
        else { s.vY = -s.vY*RESTITUTION; if (!s.hasBounced) { s.vX = ROLL_KICK; s.hasBounced = true; } }
      }
      if (s.vY === 0 && s.vX === 0 && s.y <= s.restY) { s.falling=false; s.landed=true; }
    });

    var aspect = canvas.width / canvas.height || 1;
    var targetCenter = focusShape ? [focusShape.x, focusShape.y, focusShape.z] : DEFAULT_CENTER;
    var targetRadius;
    if (focusShape) {
      // "화면에 가득차게" - place the camera at exactly the distance where
      // this shape's own bounding sphere spans the tighter of the two FOV
      // halves (vertical, or horizontal after aspect), so it fills the
      // frame regardless of the viewport's own aspect ratio or how big/small/
      // elongated the shape itself is, with a small margin so its silhouette
      // doesn't touch the very edge.
      var halfY = FOVY / 2;
      var halfX = Math.atan(Math.tan(halfY) * aspect);
      var fitHalfAngle = Math.min(halfY, halfX);
      targetRadius = Math.max(0.25, focusShape.boundingRadius / Math.sin(fitHalfAngle) * 1.15);
    } else {
      targetRadius = DEFAULT_RADIUS;
    }
    var glide = 1 - Math.pow(0.0015, dt); // frame-rate independent smoothing
    CENTER[0] += (targetCenter[0]-CENTER[0])*glide;
    CENTER[1] += (targetCenter[1]-CENTER[1])*glide;
    CENTER[2] += (targetCenter[2]-CENTER[2])*glide;
    camera.radius += (targetRadius-camera.radius)*glide;
    // View-preset buttons glide theta/phi the same way; manual dragging
    // (pointermove above) writes camera.theta/phi directly AND resyncs
    // target to match, so a stale preset target never fights a drag that
    // starts mid-glide.
    camera.theta += (targetTheta-camera.theta)*glide;
    camera.phi += (targetPhi-camera.phi)*glide;

    var proj = m4Perspective(FOVY, aspect, 0.1, 200);
    var eye = eyePosition();
    var view = m4LookAt(eye, CENTER, [0,1,0]);
    lastViewProj = m4Multiply(proj, view);
    lastEye = eye;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(loc.uView, false, view);
    gl.uniformMatrix4fv(loc.uProj, false, proj);
    gl.uniform3fv(loc.uEye, eye);
    gl.uniform3fv(loc.uVoidColor, VOID_COLOR);
    gl.uniform3fv(loc.uLightDir, vNorm([0.4,1.0,0.35]));
    gl.uniform2fv(loc.uFogRange, [camera.radius*1.3, camera.radius*2.4]);

    if (floorBuf) draw(m4Identity(), floorBuf, floorIdxBuf, floorIdxLen, checkerTex, [1,1,1]);
    trails.forEach(function (t) {
      draw(t.model, t.buf, t.idxBuf, t.count, null, t.color, gl.LINE_LOOP);
    });
    shapes.forEach(function (s) {
      var model = m4Multiply(m4Multiply(m4Translate(s.x, s.y, s.z), m4RotateY(s.spinAngle)), m4RotateZ(s.angle));
      var hl = s === focusShape ? 1 : (s.activation || 0);
      draw(model, s.buf, s.idxBuf, s.count, s.tex, s.color, null, hl);
    });
    drawLabels(eye, view, proj);

    for (var oi = 0; oi < objButtonEntries.length; oi++) {
      objButtonEntries[oi].btn.classList.toggle("vrml-obj-active", shapes[objButtonEntries[oi].idx] === focusShape);
    }

    if (statusEl) {
      var waiting=0, falling=0, landed=0;
      shapes.forEach(function (s) { if (s.falling) falling++; else if (s.landed) landed++; else waiting++; });
      statusEl.textContent = "⏳ 대기 " + waiting + "  ·  🔽 낙하 " + falling + "  ·  ✅ 착지 " + landed;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();`;
}

function viewerFragmentCss() {
  return `.vrml-viewer-stage{position:relative;width:100%;height:480px;background:#0a0d12;overflow:hidden;border-radius:3px}
.vrml-viewer-stage canvas{display:block;width:100%;height:100%;cursor:grab}
.vrml-viewer-stage canvas.vrml-dragging{cursor:grabbing}
.vrml-viewer-stage canvas.vrml-hover{cursor:pointer}
.vrml-hud-bar{position:absolute;left:10px;bottom:10px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.vrml-view-menu{position:absolute;top:10px;left:10px;display:flex;flex-wrap:wrap;gap:6px;max-width:70%}
.vrml-object-menu{display:flex;flex-wrap:wrap;gap:6px}
.vrml-obj-btn{font:12px/1.4 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;color:#cfd6e0;background:rgba(18,23,31,0.82);border:1px solid #2a3340;border-radius:3px;padding:5px 10px;cursor:pointer}
.vrml-obj-btn:hover,.vrml-obj-btn.vrml-obj-active{border-color:#e8a33d;color:#fff}
.vrml-hud{font:12px/1.4 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;color:#cfd6e0;background:rgba(18,23,31,0.82);border:1px solid #2a3340;border-radius:3px;padding:6px 10px;pointer-events:none}
.vrml-actions{position:absolute;top:10px;right:10px;display:flex;flex-direction:column;gap:6px;align-items:flex-end}
.vrml-reset,.vrml-reinfer{font-size:11px;letter-spacing:.05em;color:#cfd6e0;background:rgba(18,23,31,0.82);border:1px solid #2a3340;border-radius:3px;padding:5px 10px;cursor:pointer}
.vrml-reset:hover,.vrml-reinfer:hover{border-color:#e8a33d;color:#fff}
.vrml-reinfer:disabled{opacity:0.5;cursor:default}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Returns the HTML fragment (style + markup + script) to splice directly
// into the wiki page's rendered HTML - `uid` must be unique per instance so
// multiple embeds on one page (or one page viewed twice) don't collide.
function backgroundCssRgb(rgb) {
  return `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
}

function generateViewerFragment(scene, uid) {
  let stageStyle = '';
  if (scene.background) {
    const dir = scene.background.vertical ? 'to bottom' : 'to right';
    stageStyle = ` style="background:linear-gradient(${dir}, ${backgroundCssRgb(scene.background.top)}, ${backgroundCssRgb(scene.background.bottom)})"`;
  }
  // Fall/bounce status ("대기/낙하/착지") and the reset button only mean
  // anything when the scene actually has a click-to-fall shape - an
  // Earth/Moon scene with no such shape has nothing to wait/fall/land, so
  // that HUD is just noise there. A per-object menu (click a name to glide
  // the camera to it - the same focus the 3D click already does, exposed as
  // a button) is useful for every scene, so it's always shown.
  const hasInteractive = scene.shapes.some((s) => s.interactive);
  const hasInference = !!scene.inference;
  // showButton: false lets a scene with many near-identical shapes (e.g. 10
  // output-class nodes that now each carry their own 3D label already, see
  // label3d/drawLabels) skip cluttering this button row with one entry per
  // shape - the shape stays fully clickable in the 3D view itself either
  // way, this only hides its redundant flat-HUD button. data-shape-index
  // keeps each button's ORIGINAL scene.shapes index (not its position in
  // this filtered list) so the click handler still indexes the right shape.
  const menuButtons = scene.shapes
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.showButton !== false)
    .map(({ s, i }) => {
      const label = s.name || `${s.type.charAt(0).toUpperCase()}${s.type.slice(1)} ${i + 1}`;
      return `<button type="button" class="vrml-obj-btn" data-shape-index="${i}">${escapeHtml(label)}</button>`;
    })
    .join('\n    ');
  // Five fixed camera-angle presets, generically useful for any scene (not
  // LeNet5-specific) - "기본" restores whatever theta/phi the scene itself
  // asked for (scene.camera / the 0.5/0.32 default), the rest are simple,
  // predictable orbit angles a user would otherwise have to find by hand.
  const viewLabels = ['기본', '정면', '측면', '위', '대각선'];
  const viewButtons = viewLabels
    .map((label, i) => `<button type="button" class="vrml-obj-btn" data-view-index="${i}">${escapeHtml(label)}</button>`)
    .join('\n    ');
  return (
    `<style>${viewerFragmentCss()}</style>\n` +
    `<div class="vrml-viewer-stage" id="${uid}"${stageStyle}>\n` +
    `  <canvas></canvas>\n` +
    `  <div class="vrml-view-menu" data-vrml-view-menu>\n    ${viewButtons}\n    </div>\n` +
    `  <div class="vrml-hud-bar">\n` +
    `    <div class="vrml-object-menu" data-vrml-menu>\n    ${menuButtons}\n    </div>\n` +
    (hasInteractive ? `    <div class="vrml-hud" data-vrml-status>\u{1F55B} 대기 0</div>\n` : '') +
    (hasInference ? `    <div class="vrml-hud" data-vrml-predict>\u{1F9E0} 추론 준비 중...</div>\n` : '') +
    `  </div>\n` +
    (hasInteractive || hasInference
      ? `  <div class="vrml-actions">\n` +
        (hasInteractive ? `    <button type="button" class="vrml-reset" data-vrml-reset>다시 놓기</button>\n` : '') +
        (hasInference ? `    <button type="button" class="vrml-reinfer" data-vrml-reinfer>\u{1F504} 재추론</button>\n` : '') +
        `  </div>\n`
      : '') +
    `</div>\n` +
    `<script>${viewerEngineScript(uid, scene)}<\/script>\n`
  );
}

function generateViewerDocument(scene, title) {
  const uid = 'vrml-stage-standalone';
  const safeTitle = String(title || 'VRML 장면').replace(/[<>]/g, '');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  html,body{margin:0;height:100%;background:#0a0d12}
  .vrml-viewer-stage{height:100vh !important;border-radius:0 !important}
</style>
</head>
<body>
${generateViewerFragment(scene, uid)}
</body>
</html>`;
}

module.exports = {
  generateWrl,
  parseSceneFromWrl,
  generateViewerFragment,
  generateViewerDocument,
  restHeightFor,
};
