(function () {
  // Buttonfly-style 3D wiki navigator.
  //
  // This replaces the old orbit-camera "cone tree" graph view with the
  // interaction language of the classic SGI "buttonfly" demo: a FIXED
  // camera looking at a flat grid of boxy buttons. Click a button and it
  // flies toward you, and its own linked pages become the next grid of
  // buttons - drilling deeper into the wiki's link tree one screen at a
  // time. Click empty space and the button you came in on flies back out
  // to its resting spot, returning you to the previous screen.
  //
  // Two things buttonfly didn't have to deal with that a real wiki does:
  //   - a page can have far more links than fit on one screen. Rather than
  //     a separate prev/next UI, this is handled exactly the way the
  //     original buttonfly's own menu files handled an oversized menu (see
  //     "More Demos" in menus/m_demos): the last slot on a crowded screen
  //     becomes an ordinary-looking button - "다음 버튼들" - that flies you
  //     into the next batch of the same list, same as any other button;
  //   - link titles are free text (often long, often Korean), so labels
  //     are trimmed to their first few words and drawn with one font stack
  //     that covers Hangul and Latin alike (canvas text, not a bitmap font).
  //
  // There's deliberately no info panel or preview pane sitting over the
  // scene - buttonfly is just buttons. A branch button flies you in and
  // shows its own links as the next screen; a leaf button (nothing further
  // to drill into) opens that real page in a new tab, the same way
  // buttonfly's own leaf buttons ran their action in place without ever
  // covering the button grid.
  var statusEl = document.getElementById('graph-status');
  var canvas = document.getElementById('graph-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  function setStatus(text) {
    statusEl.textContent = text;
    statusEl.style.display = text ? '' : 'none';
  }

  // Buttons on screen at once, max. Above this, the last slot becomes a
  // "다음 버튼들" (more buttons) button instead of a 9th real link.
  var MAX_PER_SCREEN = 9;
  var PAGE_STEP = MAX_PER_SCREEN - 1;

  // Long titles just show their first few words on the button face.
  var TITLE_MAX_WORDS = 6;

  // The wiki's own body-text font stack (public/style.css: body {
  // font-family: Georgia, "Nanum Myeongjo", serif }) - so button labels
  // read as the same typeface as the pages themselves, not a lookalike.
  var LABEL_FONT = 'Georgia, "Nanum Myeongjo", serif';

  function shortLabel(text) {
    var words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (words.length <= TITLE_MAX_WORDS) return words.join(' ');
    return words.slice(0, TITLE_MAX_WORDS).join(' ') + '…';
  }

  fetch('/api/graph')
    .then(function (r) {
      if (!r.ok) throw new Error('failed to load graph');
      return r.json();
    })
    .then(function (data) {
      var nodes = data.nodes || [];
      var edges = data.edges || [];
      if (!nodes.length || !data.root) {
        setStatus('그래프를 그릴 페이지가 없습니다.');
        return;
      }
      setStatus('');
      buildScene(data.root, nodes, edges);
    })
    .catch(function () {
      setStatus('그래프를 불러오지 못했습니다.');
    });

  function buildScene(root, nodes, edges) {
    var labelOf = {};
    nodes.forEach(function (n) {
      labelOf[n.id] = n.label || n.id;
    });

    // Children in the order their links were first discovered (i.e. roughly
    // the order they're mentioned in the parent page) - a more meaningful
    // reading order than an alphabetical resort.
    var childrenOf = {};
    edges.forEach(function (e) {
      if (e.parent === e.child) return;
      if (!childrenOf[e.parent]) childrenOf[e.parent] = [];
      childrenOf[e.parent].push(e.child);
    });

    // --- Three.js boilerplate: fixed camera, no orbit controls -----------
    // Buttonfly's camera never moves; only the buttons do. Keeping that
    // here is what makes this feel like buttonfly instead of "yet another
    // free-orbit 3D graph."
    var scene = new THREE.Scene();

    // buttonfly's own clear color is a near-black (0.1, 0.1, 0.1) - a flat
    // dark charcoal, not the navy this used to be, so a faint vertical
    // gradient is all that's kept for depth cues.
    var skyCanvas = document.createElement('canvas');
    skyCanvas.width = 2;
    skyCanvas.height = 256;
    var skyCtx = skyCanvas.getContext('2d');
    var skyGradient = skyCtx.createLinearGradient(0, 0, 0, 256);
    skyGradient.addColorStop(0, '#0d0d0d');
    skyGradient.addColorStop(0.55, '#1a1a1a');
    skyGradient.addColorStop(1, '#050505');
    skyCtx.fillStyle = skyGradient;
    skyCtx.fillRect(0, 0, 2, 256);
    scene.background = new THREE.CanvasTexture(skyCanvas);

    var camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);

    scene.add(new THREE.HemisphereLight(0x9fb6cc, 0x0a0d12, 0.95));
    var key = new THREE.DirectionalLight(0xfff2d8, 0.9);
    key.position.set(-3, 4, 2);
    scene.add(key);

    // --- Button shape: buttonfly's own beveled "pillow" box, not a plain
    // cube. Ported verbatim from sgi-demos/demos/buttonfly/data.h's
    // edge_polys/front_polys (WIDE/HIGH/THICK/BEVEL are that file's own
    // constants) - a flat recessed front face where the label sits, joined
    // to the outer rim by 4 beveled trapezoids, exactly like the original.
    // buttonfly's own draw_button() rotates every button 180 degrees about
    // X before drawing it (part of how the original made backface culling
    // work); rotateX(PI) below does the same thing once, at geometry-build
    // time, which is what turns this data's front face to actually face
    // the fixed camera here.
    var BF_WIDE = 0.625, BF_HIGH = 0.5, BF_THICK = 0.125, BF_BEVEL = 0.125;
    var BTN_SCALE = 1.24; // buttonfly's own units -> a comfortable on-screen size
    var BUTTON_W = BF_WIDE * 2 * BTN_SCALE;
    var BUTTON_H = BF_HIGH * 2 * BTN_SCALE;
    var BUTTON_D = BF_THICK * 2 * BTN_SCALE;
    var FRONT_W = (BF_WIDE - BF_BEVEL) * 2 * BTN_SCALE;
    var FRONT_H = (BF_HIGH - BF_BEVEL) * 2 * BTN_SCALE;
    var FRONT_Z = BF_THICK * BTN_SCALE + 0.005; // label plane sits just proud of the recessed face

    function buildButtonGeometry() {
      var w = BF_WIDE, h = BF_HIGH, t = BF_THICK, b = BF_BEVEL;
      // Quads + their flat face normal, straight from data.h's edge_polys/
      // edge_normals and front_polys/front_normals.
      var faces = [
        [[[-w, h, 0], [-w, h, t], [w, h, t], [w, h, 0]], [0, 1, 0]],
        [[[w, h, t], [w, -h, t], [w, -h, 0], [w, h, 0]], [1, 0, 0]],
        [[[-w, h, 0], [-w, -h, 0], [-w, -h, t], [-w, h, t]], [-1, 0, 0]],
        [[[w, -h, 0], [w, -h, t], [-w, -h, t], [-w, -h, 0]], [0, -1, 0]],
        [[[-w + b, h - b, -t], [-w, h, 0], [w, h, 0], [w - b, h - b, -t]], [0, Math.SQRT1_2, -Math.SQRT1_2]],
        [[[w, -h, 0], [w - b, -h + b, -t], [w - b, h - b, -t], [w, h, 0]], [Math.SQRT1_2, 0, -Math.SQRT1_2]],
        [[[-w, h, 0], [-w + b, h - b, -t], [-w + b, -h + b, -t], [-w, -h, 0]], [-Math.SQRT1_2, 0, -Math.SQRT1_2]],
        [[[w, -h, 0], [-w, -h, 0], [-w + b, -h + b, -t], [w - b, -h + b, -t]], [0, -Math.SQRT1_2, -Math.SQRT1_2]],
        [[[-w + b, h - b, -t], [w - b, h - b, -t], [w - b, -h + b, -t], [-w + b, -h + b, -t]], [0, 0, -1]],
        // Back face (data.h's back_polys/back_normals) - buttonfly only ever
        // needs this while a button is mid-flip (its own draw_selected_button
        // draws a literal back polygon there); without it, the button would
        // be a hollow shell for the half of its 180-degree spin where the
        // camera is looking at what used to be the inside.
        [[[-w, -h, t], [w, -h, t], [w, h, t], [-w, h, t]], [0, 0, 1]],
      ];
      var positions = [];
      var normals = [];
      faces.forEach(function (face) {
        var quad = face[0], n = face[1];
        [[0, 1, 2], [0, 2, 3]].forEach(function (tri) {
          tri.forEach(function (i) {
            positions.push(quad[i][0], quad[i][1], quad[i][2]);
            normals.push(n[0], n[1], n[2]);
          });
        });
      });
      var geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geom.rotateX(Math.PI);
      geom.scale(BTN_SCALE, BTN_SCALE, BTN_SCALE);
      return geom;
    }

    var buttonGeom = buildButtonGeometry();
    // buttonfly's own menus/m_demos color: '.color. .9 .5 .9' / '.highcolor.
    // 1.0 .7 1.0' (0-1 floats) - the pink every real demo button in the
    // original used.
    var nodeMaterial = new THREE.MeshStandardMaterial({ color: 0xe680e6, roughness: 0.85, metalness: 0 });
    var nodeHoverMaterial = new THREE.MeshStandardMaterial({ color: 0xffb3ff, roughness: 0.75, metalness: 0 });

    // The label is a flat CanvasTexture mapped onto a PlaneGeometry(FRONT_W,
    // FRONT_H) - if the canvas's own pixel dimensions don't share that same
    // width:height ratio, the GPU has to stretch the texture non-uniformly
    // to cover the plane, which is exactly what was squashing the font
    // horizontally and stretching it vertically. Deriving the canvas height
    // from FRONT_H/FRONT_W keeps the two ratios identical, so text renders
    // at its true, undistorted proportions.
    var LABEL_CANVAS_W = 560;
    var LABEL_CANVAS_H = Math.round(LABEL_CANVAS_W * (FRONT_H / FRONT_W));

    function makeLabelTexture(text) {
      var c = document.createElement('canvas');
      var ctx = c.getContext('2d');
      var fontPx = Math.round(LABEL_CANVAS_H * 0.24);
      ctx.font = fontPx + 'px ' + LABEL_FONT;
      var maxWidth = LABEL_CANVAS_W;
      c.width = maxWidth;
      c.height = LABEL_CANVAS_H;
      ctx.font = fontPx + 'px ' + LABEL_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fdfdf6'; // the wiki's own page background cream (style.css body), for contrast on the pink
      // Simple word-wrap onto up to 3 lines so long-ish labels still fit
      // the button face instead of overflowing it.
      var words = text.split(/\s+/);
      var lines = [];
      var line = '';
      words.forEach(function (w) {
        var trial = line ? line + ' ' + w : w;
        if (ctx.measureText(trial).width > maxWidth - 24 && line) {
          lines.push(line);
          line = w;
        } else {
          line = trial;
        }
      });
      if (line) lines.push(line);
      lines = lines.slice(0, 3);
      var lineHeight = fontPx * 1.15;
      var startY = c.height / 2 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach(function (l, i) {
        ctx.fillText(l, c.width / 2, startY + i * lineHeight);
      });
      var texture = new THREE.CanvasTexture(c);
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      return texture;
    }

    // A button is a small group: the beveled box plus a label plane glued
    // to its recessed front face (the face pointed at the fixed camera).
    function makeButton(spec) {
      // Shared (not cloned) material: every button looks alike, so there's
      // nothing per-instance for a clone to protect, and swapping
      // box.material back to this same shared instance on hover-out is
      // exactly what's wanted.
      var box = new THREE.Mesh(buttonGeom, nodeMaterial);
      var label = new THREE.Mesh(
        new THREE.PlaneGeometry(FRONT_W, FRONT_H),
        new THREE.MeshBasicMaterial({
          map: makeLabelTexture(spec.label),
          transparent: true,
          depthWrite: false,
        })
      );
      label.position.z = FRONT_Z;

      var group = new THREE.Group();
      group.add(box);
      group.add(label);
      group.userData = {
        id: spec.id,
        more: !!spec.more,
        box: box,
        normalMaterial: nodeMaterial,
        hoverMaterial: nodeHoverMaterial,
      };
      // The label plane sits *in front of* the box (closer to the camera),
      // so a straight-on ray hits it before the box - it needs the same
      // back-reference or a center click (the most natural place to click)
      // resolves to an id-less group.
      box.userData.buttonGroup = group;
      label.userData.buttonGroup = group;
      return group;
    }

    // --- Grid layout: a generic, wide-biased grid for any button count ---
    // up to MAX_PER_SCREEN, standing in for buttonfly's hand-tuned per-count
    // "spot" tables (which only ever covered up to 32 buttons of fixed menu
    // files, not an arbitrary wiki's fan-out).
    var SPACING_X = 1.75, SPACING_Y = 1.45;
    // How much of the viewport the grid should fill: the depth (z) it's
    // placed at is solved for directly from this, rather than picked by
    // feel, so the same 9-or-fewer button screen always reads as "close and
    // legible" regardless of window size/aspect - not a handful of small
    // boxes floating in the middle of a big empty screen.
    var FILL_FRACTION = 0.76;
    var MIN_Z = 2.6;

    function layoutSlots(n) {
      if (n <= 0) return [];
      var cols = Math.max(1, Math.round(Math.sqrt(n * 1.8)));
      var rows = Math.ceil(n / cols);

      var rowSpanX = (cols - 1) * SPACING_X + BUTTON_W;
      var rowSpanY = (rows - 1) * SPACING_Y + BUTTON_H;
      var halfVFov = (camera.fov * Math.PI) / 360;
      var tanHalfV = Math.tan(halfVFov);
      var zForWidth = rowSpanX / FILL_FRACTION / (2 * tanHalfV * camera.aspect);
      var zForHeight = rowSpanY / FILL_FRACTION / (2 * tanHalfV);
      var baseZ = -Math.max(zForWidth, zForHeight, MIN_Z);

      var slots = [];
      var idx = 0;
      for (var r = 0; r < rows && idx < n; r++) {
        var remaining = n - idx;
        var rowsLeft = rows - r;
        var thisRowCols = Math.min(cols, Math.ceil(remaining / rowsLeft));
        for (var c = 0; c < thisRowCols; c++) {
          slots.push({
            x: (c - (thisRowCols - 1) / 2) * SPACING_X,
            y: ((rows - 1) / 2 - r) * SPACING_Y,
            z: baseZ,
          });
          idx++;
        }
      }
      return slots;
    }

    // --- Screen state ------------------------------------------------------
    var currentId = root;
    var pageOffset = 0; // index into currentId's children that this screen starts showing from
    // Stack of {id, offset} for the screens we drilled in from - popping
    // this is the only "back" there is, since a button screen only ever
    // shows one slice of one node's direct children (no free-roam history
    // to track).
    var stack = [];
    var buttonGroups = [];
    var flying = null; // active fly animation, if any

    // Slices `id`'s children starting at `offset`: up to PAGE_STEP (8) of
    // them, plus however many are left over beyond that - which, if
    // nonzero, is what the screen renders as the 9th "다음 버튼들" button
    // (buildScreen below) instead of a 9th real link.
    function childPage(id, offset) {
      var kids = childrenOf[id] || [];
      var remaining = kids.length - offset;
      if (remaining <= MAX_PER_SCREEN) {
        return { slice: kids.slice(offset), more: 0 };
      }
      return { slice: kids.slice(offset, offset + PAGE_STEP), more: kids.length - (offset + PAGE_STEP) };
    }

    function clearButtons() {
      buttonGroups.forEach(function (g) {
        scene.remove(g);
      });
      buttonGroups = [];
    }

    // Builds (or rebuilds) the on-screen grid for `id`'s children starting
    // at `offset`, at rest (no flight). Returns the button group for
    // `focusId` if it's among the buttons just built, so a caller can
    // animate that one specially (used when flying back out to a parent
    // screen, or into a "다음 버튼들" screen from a specific earlier button).
    function buildScreen(id, offset, focusId) {
      clearButtons();
      var info = childPage(id, offset);
      var specs = info.slice.map(function (kid) {
        return { id: kid, label: shortLabel(labelOf[kid] || kid) };
      });
      if (info.more > 0) {
        specs.push({ more: true, label: '다음 버튼들 (' + info.more + '개 더)' });
      }

      var slots = layoutSlots(specs.length);
      var focusGroup = null;
      specs.forEach(function (spec, i) {
        var group = makeButton(spec);
        var slot = slots[i];
        group.position.set(slot.x, slot.y, slot.z);
        group.userData.restPosition = new THREE.Vector3(slot.x, slot.y, slot.z);
        group.userData.restRotationX = 0;
        scene.add(group);
        buttonGroups.push(group);
        if (spec.id ? spec.id === focusId : spec.more && focusId === MORE_FOCUS_ID) focusGroup = group;
      });

      currentId = id;
      pageOffset = offset;
      return focusGroup;
    }

    // --- Flight animation ---------------------------------------------------
    // Ported directly from buttonfly's flyindraw()/flyoutdraw()/
    // draw_selected_button(): those step a single t by exactly 0.02 every
    // redrawn frame (t: 1.0 -> 0.0 flying in, 0.0 -> 1.0 flying out) with NO
    // easing, and position is a plain linear lerp of t against the origin -
    // translate(t*tx, t*ty, t*tz) - so the button doesn't stop at some
    // arbitrary "close-up" spot the way a UI transition would; it flies all
    // the way to the camera itself, and perspective alone is what makes it
    // balloon up to fill the screen right at the end, exactly as it did in
    // the original. At 0.02/frame and buttonfly's native ~60Hz redraw rate,
    // a full transition is 1/0.02 = 50 frames - about 833ms.
    var FLY_MS = 1000 / 60 * 50;
    var FOCUS_POS = new THREE.Vector3(0, 0, 0);

    function animateButton(group, direction, onDone) {
      // direction: 'in' animates rest -> focus (t: 0 -> 1); 'out' animates
      // focus -> rest (t: 1 -> 0), i.e. buttonfly's flyindraw vs flyoutdraw.
      //
      // draw_selected_button() also always uses button->highcolor while
      // flying in and button->color while flying out (regardless of mouse
      // hover) - not just a detail of the fly, but a real part of "what it
      // looks like while it moves", so it's forced here rather than left to
      // whatever the hover system last set box.material to.
      group.userData.box.material = direction === 'in' ? group.userData.hoverMaterial : group.userData.normalMaterial;
      var rest = group.userData.restPosition;
      flying = {
        group: group,
        direction: direction,
        start: performance.now(),
        onDone: onDone,
      };
      function step(t) {
        var mix = direction === 'in' ? t : 1 - t; // linear - buttonfly never eased this
        group.position.lerpVectors(rest, FOCUS_POS, mix);
        // buttonfly's own ax = button->ax * t: at rest (start of flying in)
        // the button already sits at its full resting rotation, and that
        // rotation UNWINDS toward 0 as it approaches the camera - i.e. the
        // rotation angle here counts DOWN through the same turn a resting
        // button is already holding, not a fresh spin in the other
        // direction (hence the minus sign: winding further, the +Math.PI
        // way, is a mirror-image swing of what the original actually does).
        group.rotation.x = -Math.PI * mix;
      }
      flying.step = step;
      step(0); // t is elapsed-time, not mix - step() itself maps t=0 to each direction's own start pose
    }

    // Sentinel focusId that means "focus the '다음 버튼들' button" instead of
    // a real page id, for flying back out of a "more" screen into the
    // button that led there (which has no id of its own).
    var MORE_FOCUS_ID = ' more';

    function flyInto(group) {
      if (flying) return;
      if (group.userData.more) {
        animateButton(group, 'in', function () {
          stack.push({ id: currentId, offset: pageOffset, more: true });
          buildScreen(currentId, pageOffset + PAGE_STEP);
        });
        return;
      }
      var id = group.userData.id;
      var kids = childrenOf[id] || [];
      if (!kids.length) {
        // Leaf page: buttonfly runs the action instantly with no flight
        // when a button has no forward submenu - here that "action" is
        // opening the real page, in a new tab so the button grid (and
        // wherever you were in it) is still sitting right here after.
        window.open('/page/' + encodeURIComponent(id), '_blank');
        return;
      }
      animateButton(group, 'in', function () {
        stack.push({ id: currentId, offset: pageOffset, more: false });
        buildScreen(id, 0);
      });
    }

    function flyBack() {
      if (flying || !stack.length) return;
      var leavingId = currentId;
      var back = stack.pop();
      var focusGroup = buildScreen(back.id, back.offset, back.more ? MORE_FOCUS_ID : leavingId);
      if (focusGroup) {
        animateButton(focusGroup, 'out', function () {
          /* settled at rest already via the final step() call */
        });
      }
    }

    // --- Input: click a button to fly in; click empty space to fly back
    // out (buttonfly's "click nothing = go up a menu").
    var raycaster = new THREE.Raycaster();
    var mouse = new THREE.Vector2();
    var hovered = null;

    function groupFromHit(hit) {
      var obj = hit.object;
      return obj.userData.buttonGroup || obj;
    }

    function onPointerDown(ev) {
      if (ev.button !== 0) return;
      mouse.x = (ev.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(ev.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      var hits = raycaster.intersectObjects(buttonGroups, true);
      if (!hits.length) {
        flyBack();
        return;
      }
      flyInto(groupFromHit(hits[0]));
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    function onPointerMove(ev) {
      mouse.x = (ev.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(ev.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      var hits = raycaster.intersectObjects(buttonGroups, true);
      var group = hits.length ? groupFromHit(hits[0]) : null;
      if (group !== hovered) {
        if (hovered) hovered.userData.box.material = hovered.userData.normalMaterial;
        if (group) group.userData.box.material = group.userData.hoverMaterial;
        hovered = group;
      }
      renderer.domElement.style.cursor = group ? 'pointer' : 'default';
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove);

    window.addEventListener('resize', function () {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    buildScreen(root, 0);

    (function animate(now) {
      requestAnimationFrame(animate);
      if (flying) {
        var t = Math.min((now - flying.start) / FLY_MS, 1);
        flying.step(t);
        if (t >= 1) {
          var done = flying.onDone;
          flying = null;
          if (done) done();
        }
      }
      renderer.render(scene, camera);
    })(performance.now());
  }
})();
