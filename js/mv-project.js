/* ============================================================
 * 多视图 App · 投射纹理（mv-project）
 *
 * 工作流的闭环口：多视图轮廓 → AI 生图 → **把生成的网格图反投回模型**，
 * 烘成一张 UV 贴图。落笔是确定性的 GPU 投影（TexPaint.bakeProject），
 * 语言模型在这一步完全不参与。
 *
 * 算法（逐 UV 岛，2026-11-11 定稿）：
 *   ① 收集 UV 岛：共享 UV 边的三角形并起来（逐网格，并查集）。
 *   ② 每个岛算「直接暴露面积」：对每个候选视图，Σ(正面三角 × 投影面积 ×
 *      质心可见性)。可见性用**全模型**深度图判定（遮挡住的岛不算暴露）。
 *      取暴露面积最大的视图为该岛的最佳视图。
 *   ③ 一个岛**只从它的最佳视图采样**：同一块表面绝不同时吃两个视图的
 *      参考——两个视图给的色彩互相矛盾时，混合出来必然是脏色。
 *   ④ 采样轮廓矢量化：岛掩膜做边界追踪 → RDP 拟合简化 → 内缩约 1 texel
 *      重光栅化。拟合去掉光栅锯齿，内缩躲开「AI 重绘轮廓略漂移」造成的
 *      边缘串色。
 *   ⑤ 未投射的区域**保持透明**：不填灰、不扩散邻色，哪里没投到一目了然。
 *
 * 关键口径（对不上就是整片错位，别凭感觉改）：
 *   · 生图参考图 = 「导出视图 PNG」，裁格用 exportLayout(views, exSize,
 *     exGap, cols, compact) 的**导出布局**（不是预览的 gap）；
 *   · 相机走 Model3D.gridCameras（与 viewGrid 同一份 frameSize / viewCamera），
 *     逐像素对齐；
 *   · 烘焙场景 = 本视图的岛（真 UV）+ 全模型遮挡件（UV 写死在裁剪区外，
 *     深度参与遮挡测试、烘焙 pass 被整体裁掉）——跨视图的遮挡关系不丢。
 *   · AI 出图尺寸不同也能用：按 imgW/L.w 等比缩放裁格，误差 > 2% 时提示。
 *
 * 对外（window.MVProject）：
 *   fromFile(file) / runImage(dataUrl)    入口（文件选择 / 粘贴截图）
 *   downloadPNG() / downloadGLB() / saveLib()
 *   close() / isOpen() / paint()
 *
 * 依赖：three.js、Model3D（load / gridCameras）、TexPaint（bakeProject /
 * composite）、ModelSplit.toGLB（仅「下载上色 GLB」用）。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('mv-project.js 必须在 mv-state.js 之后加载');
  if (!window.THREE) throw new Error('mv-project.js 必须在 three.js 之后加载');

  var state = MV.state;
  var $ = MV.$;

  /* 边界拟合的 RDP 容差（px）：小于它视为共线，光栅锯齿被这一步抹掉 */
  var FIT_EPS = 0.75;
  /* 暴露面积判定的深度图分辨率：只用来选视图，不用来落笔 */
  var EXPO_RES = 512;

  /* ---------------- 投射参数（常驻右侧「投射」页） ----------------
   * inset  拟合后往内缩的 texel 数：躲 AI 重绘的轮廓漂移
   * fill   次优视图补角的触发门槛（占最佳视图暴露面积的比例，0 = 不补角）
   * bleed  岛边缘颜色向外扩散的 texel 数：抵消实时渲染的接缝
   * flipV  UV 的 V 轴与导出图相反时整体上下翻转
   * 存档独立于 hf_mv_set：改投射参数不该触发整套渲染重跑。 */
  var SET_KEY = 'hf_mv_proj';
  var PROJ_FIELDS = [
    { k: 'inset', def: 1, min: 0, max: 4, step: 1, id: 'mvProjInset', out: 'mvProjInsetV',
      fmt: function (v) { return v + ' px'; } },
    { k: 'fill', def: 15, min: 0, max: 60, step: 5, id: 'mvProjFill', out: 'mvProjFillV',
      fmt: function (v) { return v + '%'; } },
    { k: 'bleed', def: 0, min: 0, max: 8, step: 1, id: 'mvProjBleed', out: 'mvProjBleedV',
      fmt: function (v) { return v + ' px'; } },
    { k: 'flipV', def: false, check: true, id: 'mvProjFlipV' }
  ];
  var settings = {};

  function clampField(f, v) {
    if (f.check) return !!v;
    v = Number(v);
    if (!isFinite(v)) v = f.def;
    return Math.max(f.min, Math.min(f.max, Math.round(v / f.step) * f.step));
  }

  (function loadSettings() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(SET_KEY) || 'null'); } catch (e) { raw = null; }
    for (var i = 0; i < PROJ_FIELDS.length; i++) {
      var f = PROJ_FIELDS[i];
      settings[f.k] = clampField(f, raw ? raw[f.k] : f.def);
    }
  })();

  function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function syncSettingsUI() {
    for (var i = 0; i < PROJ_FIELDS.length; i++) {
      var f = PROJ_FIELDS[i];
      var el = $(f.id);
      if (!el) continue;
      if (f.check) { el.checked = !!settings[f.k]; continue; }
      el.value = settings[f.k];
      var out = $(f.out);
      if (out) out.textContent = f.fmt(Number(settings[f.k]));
    }
  }

  function setSetting(k, v) {
    for (var i = 0; i < PROJ_FIELDS.length; i++) {
      if (PROJ_FIELDS[i].k !== k) continue;
      settings[k] = clampField(PROJ_FIELDS[i], v);
      syncSettingsUI();
      saveSettings();
      return settings[k];
    }
    return null;
  }

  function setProgress(pct, txt) {
    state.projProg = pct == null ? null : { pct: Math.max(0, Math.min(100, pct)), txt: txt || '' };
    paintProgress();
  }

  function paintProgress() {
    var g = state.projProg;
    var box = $('mvProjProg'), bar = $('mvProjProgBar'), txt = $('mvProjProgTxt');
    if (box) box.classList.toggle('hidden', !g);
    if (g) {
      if (bar) bar.style.width = g.pct + '%';
      if (txt) txt.textContent = g.txt + ' · ' + g.pct + '%';
    }
    var quick = $('mvProjQuick');
    if (quick && g) quick.textContent = g.txt + ' · ' + g.pct + '%';
  }

  /* 让出主线程一帧：长任务期间进度条和文字才有机会真正画出来 */
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ---------------- 小工具 ---------------- */

  function readFileAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error('图片读不出来')); };
      fr.readAsDataURL(file);
    });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('导入图读不出来（不是有效图像）')); };
      im.src = url;
    });
  }

  function modelHasUV(model) {
    var has = false, meshes = 0;
    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      if (o.geometry.attributes && o.geometry.attributes.uv) has = true;
    });
    return has && meshes > 0;
  }

  /* 独占的离屏渲染器：只跑「暴露面积判定」的深度图（每视图一张小图）。 */
  var projRenderer = null;
  function rendererOf() {
    if (projRenderer) return projRenderer;
    var cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    projRenderer = new THREE.WebGLRenderer({
      canvas: cv, antialias: false, alpha: true, preserveDrawingBuffer: true
    });
    projRenderer.setPixelRatio(1);
    return projRenderer;
  }

  /* ---------------- ① UV 岛收集 ----------------
   * 逐网格做「共享 UV 边」并查集（跟 modeltex.js 同一套思路）。
   * 每个岛展开成世界坐标 P[9/tri] + UV U[6/tri]，后面选视图、建几何、
   * 画掩膜全都直接吃这两份，不再回头碰原始 mesh。 */

  function collectIslands(model) {
    model.root.updateMatrixWorld(true);
    var islands = [];
    var noUvP = [];          // 没有 UV 的网格三角形（进不了贴图，但要参与遮挡）
    var v = new THREE.Vector3();

    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var g = o.geometry;
      var pos = g.attributes.position;
      var uv = g.attributes.uv;
      if (!pos) return;
      var idx = g.index;
      var triCount = Math.floor((idx ? idx.count : pos.count) / 3);
      if (triCount < 1) return;
      var mw = o.matrixWorld;

      if (!uv) {
        for (var t0 = 0; t0 < triCount; t0++) {
          for (var k0 = 0; k0 < 3; k0++) {
            var i0 = idx ? idx.getX(t0 * 3 + k0) : t0 * 3 + k0;
            v.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(mw);
            noUvP.push(v.x, v.y, v.z);
          }
        }
        return;
      }

      var parent = new Int32Array(triCount);
      for (var i1 = 0; i1 < triCount; i1++) parent[i1] = i1;
      function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
      function uni(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }
      function vi(t, k) { return idx ? idx.getX(t * 3 + k) : t * 3 + k; }
      function q(x) { return Math.round(x * 1e4) / 1e4; }

      var edgeMap = {};
      for (var t = 0; t < triCount; t++) {
        for (var k = 0; k < 3; k++) {
          var a = vi(t, k), b = vi(t, (k + 1) % 3);
          var ka = q(uv.getX(a)) + ',' + q(uv.getY(a));
          var kb = q(uv.getX(b)) + ',' + q(uv.getY(b));
          var key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
          if (edgeMap[key] === undefined) edgeMap[key] = t;
          else uni(edgeMap[key], t);
        }
      }
      var groups = {};
      for (var t2 = 0; t2 < triCount; t2++) {
        var r = find(t2);
        (groups[r] || (groups[r] = [])).push(t2);
      }
      for (var root in groups) {
        var tris = groups[root];
        var P = [], U = [];
        for (var j = 0; j < tris.length; j++) {
          for (var k2 = 0; k2 < 3; k2++) {
            var i2 = vi(tris[j], k2);
            v.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(mw);
            P.push(v.x, v.y, v.z);
            U.push(uv.getX(i2), uv.getY(i2));
          }
        }
        islands.push({ P: P, U: U, tris: tris.length });
      }
    });
    return { islands: islands, noUvP: noUvP };
  }

  /* 全模型合并网格（三角汤，世界坐标）。
   * uvReal = 真 UV → 给「UV 占据」统计用；
   * uvReal = false → UV 全写 (2,2)：烘焙 pass 里 gl_Position=(3,3) 被整体
   * 裁掉，但深度 pass 用的是真实坐标 → 一个**只遮挡不上色**的遮挡件。 */
  function mergedMesh(islands, extraP, uvReal) {
    var nTri = 0, i;
    for (i = 0; i < islands.length; i++) nTri += islands[i].P.length / 9;
    nTri += extraP.length / 9;
    var P = new Float32Array(nTri * 9);
    var U = new Float32Array(nTri * 6);
    var at = 0;
    function put(src) {
      for (var s = 0; s < src.length; s++) P[at * 9 + s] = src[s];
      at += src.length / 9;
    }
    for (i = 0; i < islands.length; i++) put(islands[i].P);
    if (extraP.length) put(extraP);
    if (uvReal) {
      var au = 0;
      for (i = 0; i < islands.length; i++) {
        var U2 = islands[i].U;
        for (var s2 = 0; s2 < U2.length; s2++) U[au++] = U2[s2];
      }
    } else {
      for (var j = 0; j < U.length; j += 2) { U[j] = 2; U[j + 1] = 2; }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  }

  function groupMesh(islands) {
    var nTri = 0, i;
    for (i = 0; i < islands.length; i++) nTri += islands[i].P.length / 9;
    var P = new Float32Array(nTri * 9);
    var U = new Float32Array(nTri * 6);
    var at = 0, au = 0;
    for (i = 0; i < islands.length; i++) {
      var IP = islands[i].P, IU = islands[i].U;
      for (var s = 0; s < IP.length; s++) P[at++] = IP[s];
      for (var s2 = 0; s2 < IU.length; s2++) U[au++] = IU[s2];
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  }

  /* ---------------- ② 暴露面积：全模型深度图 + 逐岛采样 ---------------- */

  /* 渲一张「全模型线性深度」。
   * 浮点 RT：直接存线性 vZ，清屏 0（vZ ≥ near > 0，0 只能是背景）。
   * 8 位回退：压到 0~1（near/far 归一），清屏白（= 远处 = 没东西）。
   * 这张图只用来**选视图**；真正落笔的遮挡剔除在 bakeProject 里（全精度）。 */
  function renderDepth(mesh, cam, res) {
    var r = rendererOf();
    var gl = r.getContext ? r.getContext() : null;
    var canFloat = !!(gl && (gl.getExtension('EXT_color_buffer_float') ||
      gl.getExtension('WEBGL_color_buffer_float')));
    var rt = new THREE.WebGLRenderTarget(res, res, {
      type: canFloat ? THREE.FloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: true
    });
    var near = cam.near || 0.1, far = cam.far || 1000;
    var mat = new THREE.ShaderMaterial({
      vertexShader: [
        'varying float vZ;',
        'void main(){',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vZ = -mv.z;',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: canFloat
        ? 'varying float vZ; void main(){ gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }'
        : [
          'uniform float uNear, uFar;',
          'varying float vZ;',
          'void main(){',
          '  gl_FragColor = vec4(clamp((vZ - uNear) / (uFar - uNear), 0.0, 1.0), 0.0, 0.0, 1.0);',
          '}'
        ].join('\n'),
      uniforms: canFloat ? {} : { uNear: { value: near }, uFar: { value: far } },
      side: THREE.DoubleSide
    });
    var scene = new THREE.Scene();
    scene.add(mesh);
    var prevAutoClear = r.autoClear;
    try {
      r.setRenderTarget(rt);
      r.autoClear = false;
      r.setClearColor(canFloat ? 0x000000 : 0xffffff, 1);
      r.clear(true, true, true);
      scene.overrideMaterial = mat;
      r.render(scene, cam);
      var buf = canFloat ? new Float32Array(res * res * 4) : new Uint8Array(res * res * 4);
      r.readRenderTargetPixels(rt, 0, 0, res, res, buf);
      return { data: buf, res: res, isFloat: canFloat, near: near, far: far };
    } finally {
      scene.overrideMaterial = null;
      r.autoClear = prevAutoClear;
      r.setRenderTarget(null);
      try { rt.dispose(); } catch (e) {}
      try { mat.dispose(); } catch (e2) {}
    }
  }

  /* 岛在某一视图下的直接暴露面积：正面三角 × 投影面积 × 质心可见。 */
  function exposedArea(isl, cam, depth, dir, bias, tmp) {
    var P = isl.P;
    var n = P.length / 9;
    var res = depth.res;
    var ax, ay, az, bx, by, bz, cx, cy, cz;
    var e1x, e1y, e1z, e2x, e2y, e2z, nx, ny, nz, nl;
    var area = 0;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      ax = P[o]; ay = P[o + 1]; az = P[o + 2];
      bx = P[o + 3]; by = P[o + 4]; bz = P[o + 5];
      cx = P[o + 6]; cy = P[o + 7]; cz = P[o + 8];
      e1x = bx - ax; e1y = by - ay; e1z = bz - az;
      e2x = cx - ax; e2y = cy - ay; e2z = cz - az;
      nx = e1y * e2z - e1z * e2y;
      ny = e1z * e2x - e1x * e2z;
      nz = e1x * e2y - e1y * e2x;
      nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-12) continue;
      var facing = (nx * dir.x + ny * dir.y + nz * dir.z) / nl;
      if (facing >= -1e-6) continue;              // 背对相机（或退化法线）不算暴露
      var projArea = nl * 0.5 * (-facing);
      /* 质心可见性：投影到深度图上比对（1 点采样，选视图够用） */
      tmp.v.set((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
      tmp.v2.copy(tmp.v).applyMatrix4(cam.matrixWorldInverse);
      var vz = -tmp.v2.z;
      tmp.v.project(cam);
      if (tmp.v.x < -1 || tmp.v.x > 1 || tmp.v.y < -1 || tmp.v.y > 1 || tmp.v.z < -1 || tmp.v.z > 1) continue;
      var px = Math.min(res - 1, Math.max(0, Math.floor((tmp.v.x + 1) * 0.5 * res)));
      var py = Math.min(res - 1, Math.max(0, Math.floor((1 - tmp.v.y) * 0.5 * res)));
      var di = (py * res + px) * 4;
      var bufZ = depth.data[di];
      if (!depth.isFloat) bufZ = depth.near + (bufZ / 255) * (depth.far - depth.near);
      if (bufZ > 0 && vz > bufZ + bias) continue;   // 被别的东西挡住（0 = 空背景）
      area += projArea;
    }
    return area;
  }

  /* ---------------- ④ 矢量化：边界追踪 → 拟合 → 内缩 ---------------- */

  /* marching-squares（沿像素**棱边**走，拐点在整像素格点上）。
   * 方向编号 0=E 1=S 2=W 3=N；约定「内部在行进方向左侧」。
   * 映射表按 4 邻域像素（A=左上 B=右上 C=左下 D=右下）逐 case 推导，
   * 鞍点（6 / 9）有两个入口，各走各的环。 */
  var MS_CASE = {
    1: { 2: 1 }, 2: { 3: 2 }, 3: { 2: 2 }, 4: { 1: 0 }, 5: { 1: 1 },
    6: { 3: 2, 1: 0 }, 7: { 1: 2 }, 8: { 0: 3 }, 9: { 0: 3, 2: 1 },
    10: { 3: 3 }, 11: { 2: 3 }, 12: { 0: 0 }, 13: { 0: 1 }, 14: { 3: 0 }
  };
  var MS_DX = [1, 0, -1, 0];
  var MS_DY = [0, 1, 0, -1];

  function traceRings(mask, w, h) {
    function pix(x, y) {
      return (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]) ? 1 : 0;
    }
    function caseAt(x, y) {
      return (pix(x - 1, y - 1) << 3) | (pix(x, y - 1) << 2) |
        (pix(x - 1, y) << 1) | pix(x, y);
    }
    var visited = {};
    var rings = [];
    for (var cy = 0; cy <= h; cy++) {
      for (var cx = 0; cx <= w; cx++) {
        var tab = MS_CASE[caseAt(cx, cy)];
        if (!tab) continue;
        for (var startIn in tab) {
          var sIn = +startIn;
          var key0 = cx + ',' + cy + ',' + sIn;
          if (visited[key0]) continue;
          var ring = [];
          var x = cx, y = cy, inD = sIn;
          var guard = (w + 2) * (h + 2) * 8 + 64;
          while (guard-- > 0) {
            var k = x + ',' + y + ',' + inD;
            if (visited[k]) break;
            visited[k] = 1;
            ring.push([x, y]);
            var out = MS_CASE[caseAt(x, y)][inD];
            if (out == null) break;
            x += MS_DX[out]; y += MS_DY[out];
            inD = out;
            if (x === cx && y === cy && inD === sIn) break;   // 闭环
          }
          if (ring.length >= 4) rings.push(ring);
        }
      }
    }
    return rings;
  }

  /* RDP 折线拟合（显式栈，防深递归）：共线的光栅拐点全被抹掉 */
  function fitRing(pts, eps) {
    var n = pts.length;
    if (n < 3) return pts;
    var keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var i0 = seg[0], i1 = seg[1];
      if (i1 - i0 < 2) continue;
      var ax = pts[i0][0], ay = pts[i0][1];
      var dx = pts[i1][0] - ax, dy = pts[i1][1] - ay;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var maxD = 0, idx = -1;
      for (var i = i0 + 1; i < i1; i++) {
        var d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > i0) {
        keep[idx] = 1;
        stack.push([i0, idx], [idx, i1]);
      }
    }
    var out = [];
    for (var j = 0; j < n; j++) if (keep[j]) out.push(pts[j]);
    return out;
  }

  /* RDP 按开放折线处理（首尾强制保留），闭合环会在「闭合边」上留尾巴：
   * 首或尾若跟闭合边共线就剪掉，否则内缩会在那里多推出一个假拐角。 */
  function trimClosed(r, eps) {
    var n;
    while ((n = r.length) > 4) {
      var a1 = r[n - 2], b1 = r[n - 1], c1 = r[0];
      var cr1 = (b1[0] - a1[0]) * (c1[1] - a1[1]) - (b1[1] - a1[1]) * (c1[0] - a1[0]);
      var l1 = Math.sqrt((c1[0] - a1[0]) * (c1[0] - a1[0]) + (c1[1] - a1[1]) * (c1[1] - a1[1])) || 1;
      if (Math.abs(cr1) / l1 < eps) { r.pop(); continue; }
      var a2 = r[n - 1], b2 = r[0], c2 = r[1];
      var cr2 = (b2[0] - a2[0]) * (c2[1] - a2[1]) - (b2[1] - a2[1]) * (c2[0] - a2[0]);
      var l2 = Math.sqrt((c2[0] - a2[0]) * (c2[0] - a2[0]) + (c2[1] - a2[1]) * (c2[1] - a2[1])) || 1;
      if (Math.abs(cr2) / l2 < eps) { r.shift(); continue; }
      break;
    }
    return r;
  }

  /* 多边形整体内缩 d：顶点沿相邻两条边左法线的角平分向推 **2d/|m|**。
   * 「内部在左」由追踪保证，所以左法线恒指向内部。系数 2d/|m| 是真 miter
   * （d/cos(θ/2)，|m|=2cos(θ/2)）：只推 d 会让直角处每条边只内移 0.707d。 */
  function insetRing(pts, d) {
    var n = pts.length;
    if (n < 3 || !(d > 0)) return pts;
    var out = [];
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
      var e1x = p1[0] - p0[0], e1y = p1[1] - p0[1];
      var e2x = p2[0] - p1[0], e2y = p2[1] - p1[1];
      var l1 = Math.sqrt(e1x * e1x + e1y * e1y) || 1;
      var l2 = Math.sqrt(e2x * e2x + e2y * e2y) || 1;
      var n1x = e1y / l1, n1y = -e1x / l1;
      var n2x = e2y / l2, n2y = -e2x / l2;
      var mx = n1x + n2x, my = n1y + n2y;
      var ml = Math.sqrt(mx * mx + my * my);
      if (ml < 0.3) { out.push([p1[0], p1[1]]); continue; }    // 太尖的角不推，防自交
      /* 偏移 = m̂ × (d/cos(θ/2)) = m × 2d/|m|²（|m| = 2cos(θ/2)） */
      var s = 2 * d / (ml * ml);
      out.push([p1[0] + mx * s, p1[1] + my * s]);
    }
    return out;
  }

  /* 把一个岛画成局部掩膜（2D canvas 光栅三角，AA 边）。
   * 返回 { cv, bx, by }：bx/by 是局部画布在整张贴图上的像素原点。 */
  function islandLocalMask(isl, S) {
    var U = isl.U;
    var uMin = 1, uMax = 0, vMin = 1, vMax = 0;
    for (var i = 0; i < U.length; i += 2) {
      if (U[i] < uMin) uMin = U[i];
      if (U[i] > uMax) uMax = U[i];
      if (U[i + 1] < vMin) vMin = U[i + 1];
      if (U[i + 1] > vMax) vMax = U[i + 1];
    }
    var bx = Math.floor(uMin * S) - 2;
    var by = Math.floor((1 - vMax) * S) - 2;
    var w = Math.max(1, Math.ceil(uMax * S) - bx + 2);
    var h = Math.max(1, Math.ceil((1 - vMin) * S) - by + 2);
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (var t = 0; t < U.length; t += 6) {
      ctx.moveTo(U[t] * S - bx, (1 - U[t + 1]) * S - by);
      ctx.lineTo(U[t + 2] * S - bx, (1 - U[t + 3]) * S - by);
      ctx.lineTo(U[t + 4] * S - bx, (1 - U[t + 5]) * S - by);
      ctx.closePath();
    }
    ctx.fill();
    return { cv: cv, bx: bx, by: by };
  }

  /* 一个岛的「干净边界」：矢量化后的多边形。失败 / 太小 → null（调用方
   * 退回原始光栅掩膜）。insetPx = 0 表示只拟合不内缩（补角通道用：要贴到
   * 主视图区域边上，不能留缝）。 */
  function islandRings(isl, S, insetPx) {
    var loc = islandLocalMask(isl, S);
    var w = loc.cv.width, h = loc.cv.height;
    if (w < 4 || h < 4) return { loc: loc, rings: null };
    var d = loc.cv.getContext('2d').getImageData(0, 0, w, h).data;
    var mask = new Uint8Array(w * h);
    for (var i = 0, j = 3; i < mask.length; i++, j += 4) if (d[j] > 127) mask[i] = 1;
    var raw = traceRings(mask, w, h);
    if (!raw.length) return { loc: loc, rings: null };
    var inset = insetPx == null ? settings.inset : insetPx;
    var rings = [];
    for (var k = 0; k < raw.length; k++) {
      var r = trimClosed(fitRing(raw[k], FIT_EPS), FIT_EPS);
      if (inset > 0) {
        var rin = insetRing(r, inset);
        /* 内缩把环吃没了（细条岛 / 极小岛）→ 退回不内缩的拟合环：
         * 宁可留一点串色，也不能整块岛消失。 */
        if (ringArea(rin) > ringArea(r) * 0.15 && rin.length >= 3) r = rin;
      }
      if (r.length >= 3) rings.push(r);
    }
    return { loc: loc, rings: rings.length ? rings : null };
  }

  function ringArea(r) {
    var a = 0;
    for (var i = 0; i < r.length; i++) {
      var p = r[i], q = r[(i + 1) % r.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  /* ---------------- 掩膜应用 ---------------- */

  /* 把岛的干净边界画到组的 cleanMask（白 = 允许落笔）上 */
  function drawRings(ctx, rings, bx, by) {
    ctx.fillStyle = '#fff';
    for (var k = 0; k < rings.length; k++) {
      var r = rings[k];
      ctx.beginPath();
      ctx.moveTo(bx + r[0][0], by + r[0][1]);
      for (var i = 1; i < r.length; i++) ctx.lineTo(bx + r[i][0], by + r[i][1]);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* baked 的 alpha 乘上 cleanMask：拟合内缩后的边界外的落笔全部裁掉 */
  function applyMask(baked, maskCv) {
    var W = baked.width;
    var ctx = baked.getContext('2d');
    var id = ctx.getImageData(0, 0, W, W);
    var md = maskCv.getContext('2d').getImageData(0, 0, W, W).data;
    var d = id.data;
    for (var i = 3; i < d.length; i += 4) {
      if (d[i] === 0) continue;
      var a = (d[i] * md[i] / 255) | 0;
      d[i] = a;
    }
    ctx.putImageData(id, 0, 0);
  }

  /* 把一组的结果并进 base。
   * ⚠ 不能用 TexPaint.composite：那个是「叠到不透明底图」用的，只混 RGB、
   * **不累加 alpha** —— 岛分属不同视图组、UV 上互不重叠，用它合并会让第二组
   * 之后的所有岛 alpha 恒为 0（贴图上一片黑，但 RGB 其实已经写进去了）。
   * fillOnly = 只填 base 还空着的 texel（补角通道：主视图已经落笔的地方一律不动，
   * 于是同一块表面永远是「一段一个视图」，边界是硬切换、不做混色）。 */
  function mergeInto(base, over, fillOnly) {
    var W = base.width;
    var bctx = base.getContext('2d');
    var id = bctx.getImageData(0, 0, W, W);
    var od = over.getContext('2d').getImageData(0, 0, W, W).data;
    var d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var oa = od[i + 3];
      if (!oa) continue;
      var ba = d[i + 3];
      if (!ba) {                       // base 空着：整像素搬过来
        d[i] = od[i]; d[i + 1] = od[i + 1]; d[i + 2] = od[i + 2]; d[i + 3] = oa;
        continue;
      }
      if (fillOnly) continue;          // 补角通道：主视图的地盘不碰
      /* 两段都盖到同一 texel（UV 重叠的坏模型才会发生）：按 over 覆上，alpha 取大 */
      var a = oa / 255;
      d[i] = d[i] * (1 - a) + od[i] * a;
      d[i + 1] = d[i + 1] * (1 - a) + od[i + 1] * a;
      d[i + 2] = d[i + 2] * (1 - a) + od[i + 2] * a;
      if (oa > ba) d[i + 3] = oa;
    }
    bctx.putImageData(id, 0, 0);
    return base;
  }

  /* UV 占据（覆盖率的分母）：所有岛的三角光栅到一张画布数 texel */
  function uvOccupancyCanvas(islands, S) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (var k = 0; k < islands.length; k++) {
      var U = islands[k].U;
      for (var t = 0; t < U.length; t += 6) {
        ctx.moveTo(U[t] * S, (1 - U[t + 1]) * S);
        ctx.lineTo(U[t + 2] * S, (1 - U[t + 3]) * S);
        ctx.lineTo(U[t + 4] * S, (1 - U[t + 5]) * S);
        ctx.closePath();
      }
    }
    ctx.fill();
    var d = ctx.getImageData(0, 0, S, S).data;
    var n = 0;
    for (var i = 3; i < d.length; i += 4) if (d[i] > 127) n++;
    return n;
  }

  /* 接缝扩散：把岛边缘颜色向外推 px 个 texel。
   * 只从「紧邻透明的不透明像素」出发逐层外扩，不扫描整张画布；
   * 写出的像素当轮不再作为新的采样源继续传，避免同一轮里把颜色拉花。 */
  function bleedCanvas(cv, px) {
    var W = cv.width, H = cv.height;
    var ctx = cv.getContext('2d');
    var img = ctx.getImageData(0, 0, W, H);
    var d = img.data;
    var frontier = [];
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        if (d[i + 3] < 8) continue;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { frontier.push(i); continue; }
        if (d[(y * W + x - 1) * 4 + 3] < 8 || d[(y * W + x + 1) * 4 + 3] < 8 ||
          d[((y - 1) * W + x) * 4 + 3] < 8 || d[((y + 1) * W + x) * 4 + 3] < 8) frontier.push(i);
      }
    }
    for (var it = 0; it < px && frontier.length; it++) {
      var next = [];
      for (var fi = 0; fi < frontier.length; fi++) {
        var p = frontier[fi] / 4, fx = p % W, fy = Math.floor(p / W);
        for (var k = 0; k < 4; k++) {
          var nx = fx + (k === 0 ? -1 : k === 1 ? 1 : 0);
          var ny = fy + (k === 2 ? -1 : k === 3 ? 1 : 0);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var j = (ny * W + nx) * 4;
          if (d[j + 3] >= 8) continue;
          var r = 0, g = 0, b = 0, n = 0;
          for (var m = 0; m < 4; m++) {
            var mx = nx + (m === 0 ? -1 : m === 1 ? 1 : 0);
            var my = ny + (m === 2 ? -1 : m === 3 ? 1 : 0);
            if (mx < 0 || my < 0 || mx >= W || my >= H) continue;
            var o = (my * W + mx) * 4;
            if (d[o + 3] < 8) continue;
            r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
          }
          if (!n) continue;
          d[j] = r / n; d[j + 1] = g / n; d[j + 2] = b / n; d[j + 3] = 255;
          next.push(j);
        }
      }
      frontier = next;
    }
    ctx.putImageData(img, 0, 0);
  }

  /* V 轴翻转：烘焙是按模型 UV 落笔的；当模型采样方向与导出图相反时，
   * 整张贴图上下镜像一次即可对齐（岛与掩膜一起翻，不会局部错位）。 */
  function flipCanvas(cv) {
    var out = document.createElement('canvas');
    out.width = cv.width; out.height = cv.height;
    var x = out.getContext('2d');
    x.translate(0, cv.height);
    x.scale(1, -1);
    x.drawImage(cv, 0, 0);
    return out;
  }

  /* ---------------- 主流程 ---------------- */

  async function runImage(dataUrl, name) {
    if (state.busy === 'proj') return;      // 防止连点重复烘焙
    if (!state.cur || !state.cur.src) { MV.say('先选一个模型'); return; }
    if (!window.TexPaint || typeof TexPaint.bakeProject !== 'function') {
      MV.say('投影烘焙模块未加载（js/texpaint.js）');
      return;
    }
    if (!window.Model3D || typeof Model3D.load !== 'function' || typeof Model3D.gridCameras !== 'function') {
      MV.say('3D 模块未加载或版本过旧（js/model3d.js）');
      return;
    }
    var sel = $('mvProjSize');
    var texSize = sel && [1024, 2048, 4096].indexOf(Number(sel.value)) >= 0 ? Number(sel.value) : 2048;

    MV.setBusy('proj');
    MV.paint();
    try {
      setProgress(4, '读取生图与模型');
      await tick();
      var img = await loadImage(dataUrl);
      /* 源图留在 state：改参数后「重新投射」不必再选一次文件 */
      state.projSrc = {
        dataUrl: dataUrl, name: name || '',
        w: img.naturalWidth || img.width, h: img.naturalHeight || img.height
      };
      setProgress(8, '解析导出布局');
      await tick();
      var L = MV.exportLayout(state.views.length, state.exSize, state.exGap, state.cols, state.compact);
      var model = await Model3D.load(state.cur.src);
      if (!modelHasUV(model)) {
        throw new Error('这个模型没有 UV，纹理投不上去——用带 UV 的 glb（Tripo 出的模型一般都有）');
      }

      var views = state.views.slice();
      var cams = Model3D.gridCameras(model, views, {
        cellW: L.cellW, cellH: L.cellH, margin: state.margin, cam: state.cam
      });

      /* ① 岛收集 + 全模型遮挡件（占据统计走 2D 光栅，不需要再建 WebGL 件） */
      setProgress(13, '收集 UV 岛与遮挡件');
      await tick();
      var got = collectIslands(model);
      var islands = got.islands;
      if (!islands.length) throw new Error('模型里没有可投射的 UV 岛');
      var blocker = mergedMesh(islands, got.noUvP, false);    // uv=2：只遮挡不上色

      /* ② 每视图深度图 → 每岛最佳视图 */
      var dirs = {};
      for (var vi = 0; vi < views.length; vi++) {
        var vd = Model3D.VIEWS[views[vi]].dir;
        var dl = Math.sqrt(vd[0] * vd[0] + vd[1] * vd[1] + vd[2] * vd[2]) || 1;
        dirs[views[vi]] = { x: vd[0] / dl, y: vd[1] / dl, z: vd[2] / dl };
      }
      var depths = {};
      for (var di = 0; di < views.length; di++) {
        setProgress(18 + Math.round((di + 1) / views.length * 22), '计算' + MV.viewName(views[di]) + '深度');
        await tick();
        depths[views[di]] = renderDepth(blocker, cams[di], EXPO_RES);
      }
      var expoBias = model.radius * 0.01;
      var tmp = { v: new THREE.Vector3(), v2: new THREE.Vector3() };
      var groups = {};      // 主视图 → [island...]
      var groups2 = {};     // **次优视图补角** → [island...]
      var viewCount = {};
      var fillCount = {};
      var lost = 0;         // 所有视图都照不见的岛（贴图上保持透明）
      var fillTotal = 0;
      var fillRatio = settings.fill / 100;
      for (var ii = 0; ii < islands.length; ii++) {
        var best = '', bestA = 0, second = '', secondA = 0;
        for (var wi = 0; wi < views.length; wi++) {
          var vk = views[wi];
          var a = exposedArea(islands[ii], cams[wi], depths[vk], dirs[vk], expoBias, tmp);
          if (a > bestA) { secondA = bestA; second = best; bestA = a; best = vk; }
          else if (a > secondA) { secondA = a; second = vk; }
        }
        if (!best) { lost++; continue; }        // 哪个视图都照不见 → 保持透明
        (groups[best] || (groups[best] = [])).push(islands[ii]);
        viewCount[best] = (viewCount[best] || 0) + 1;
        /* 包裹型岛（一圈绕住肢体的）只朝一个视图的话，背向那半边会被正面剔除
         * 吃掉。给一个「次优视图补角」通道：面积占比达到阈值才值得补
         * （fillRatio = 右侧「补角阈值」，0 = 关闭），且只填主视图完全没落笔的
         * texel —— 每个采样点仍然只认一个视图，两块地盘硬切换、不混色。 */
        if (fillRatio > 0 && second && secondA > bestA * fillRatio) {
          (groups2[second] || (groups2[second] = [])).push(islands[ii]);
          fillCount[second] = (fillCount[second] || 0) + 1;
          fillTotal++;
        }
      }
      setProgress(44, '归类最佳视图');
      await tick();

      /* 裁格：位置按导出布局算，大小按导入图实际尺寸等比缩 */
      var sx = (img.naturalWidth || img.width) / L.w;
      var sy = (img.naturalHeight || img.height) / L.h;
      if (!(sx > 0) || !(sy > 0)) throw new Error('导入图尺寸异常');
      /* 「尺寸不一致」只看**比例**：生图常见 1K/750，比导出的 4K 小是正常的；
       * 比例对不上才是真的错位（格子会被横向或纵向压扁）。 */
      var offScale = Math.abs(sx / sy - 1) > 0.02;
      var gridW = L.cols * L.cellW + (L.cols - 1) * L.gap;
      var gridH = L.rows * L.cellH + (L.rows - 1) * L.gap;
      var padX = Math.round((L.w - gridW) / 2);
      var padY = Math.round((L.h - gridH) / 2);

      /* 每视图的格子图只裁一次（主通道与补角通道共用） */
      var cellCache = {};
      function cellOf(gi) {
        var gk = views[gi];
        if (cellCache[gk]) return cellCache[gk];
        var col = gi % L.cols, row = Math.floor(gi / L.cols);
        var cv = document.createElement('canvas');
        cv.width = Math.max(2, Math.round(L.cellW * sx));
        cv.height = Math.max(2, Math.round(L.cellH * sy));
        cv.getContext('2d').drawImage(img,
          (padX + col * (L.cellW + L.gap)) * sx,
          (padY + row * (L.cellH + L.gap)) * sy,
          L.cellW * sx, L.cellH * sy,
          0, 0, cv.width, cv.height);
        cellCache[gk] = cv;
        return cv;
      }

      /* 一组（同一视图的岛）烘一次 + 逐岛矢量化掩膜。insetPx=0 表示不内缩。 */
      var bakeBias = Math.max(model.radius * 0.004, 1e-4);
      function bakeGroup(gi, list, insetPx) {
        var scene = new THREE.Scene();
        scene.add(groupMesh(list));
        scene.add(blocker);                     // 深度参与遮挡，烘焙被裁剪掉
        var r = TexPaint.bakeProject({
          scene: scene,
          camera: cams[gi],
          src: cellOf(gi),
          size: texSize,
          viewSize: texSize,
          screenRect: { x: 0, y: 0, w: texSize, h: texSize },
          feather: 0,                           // 边缘交给矢量化掩膜，不在这里羽化
          bias: bakeBias,
          rawColor: true,                       // 字节直通：AI 图的颜色 1:1 搬进贴图
          /* 双面：UV 空间的环绕方向跟相机朝向无关，镜像岛在 UV 里是背面。
           * 背向相机的面由 bakeProject 自己的深度测试剔掉，不会脏。 */
          side: THREE.DoubleSide
        });
        var clean = document.createElement('canvas');
        clean.width = clean.height = texSize;
        var cctx = clean.getContext('2d');
        for (var li = 0; li < list.length; li++) {
          var rr = islandRings(list[li], texSize, insetPx);
          if (rr.rings) drawRings(cctx, rr.rings, rr.loc.bx, rr.loc.by);
          else cctx.drawImage(rr.loc.cv, rr.loc.bx, rr.loc.by);
        }
        applyMask(r.canvas, clean);
        return r.canvas;
      }

      /* ③④ 主通道：组 = 该视图的全部岛；组内再按岛做矢量化掩膜
       *     （内缩 = 右侧「边缘内缩」，默认 1 texel） */
      var base = null;
      for (var gi = 0; gi < views.length; gi++) {
        var list = groups[views[gi]];
        if (!list || !list.length) continue;
        setProgress(50 + Math.round(gi / views.length * 16), '烘焙' + MV.viewName(views[gi]));
        await tick();
        var baked = bakeGroup(gi, list, settings.inset);
        base = base ? mergeInto(base, baked) : baked;
      }
      if (!base) throw new Error('没有任何岛投上颜色：换一张与当前布局对齐的生图，或多勾几个视图');

      /* ⑤ 补角通道：同一批岛从次优视图再烘一次，只填空着的 texel。
       * 不内缩（要贴到主视图区域边上）、只填不覆（fillOnly）。 */
      for (var gj = 0; gj < views.length; gj++) {
        var list2 = groups2[views[gj]];
        if (!list2 || !list2.length) continue;
        setProgress(68 + Math.round(gj / views.length * 14), '补角' + MV.viewName(views[gj]));
        await tick();
        mergeInto(base, bakeGroup(gj, list2, 0), true);
      }

      /* ⑥ 后处理：接缝扩散（可选）→ V 轴翻转（可选） */
      if (settings.bleed > 0) {
        setProgress(86, '扩散接缝');
        await tick();
        bleedCanvas(base, settings.bleed);
      }
      if (settings.flipV) {
        setProgress(90, '翻转 V 轴');
        await tick();
        base = flipCanvas(base);
      }
      setProgress(94, '统计覆盖率');
      await tick();

      var occCount = uvOccupancyCanvas(islands, texSize);
      var id0 = base.getContext('2d').getImageData(0, 0, texSize, texSize).data;
      var painted = 0;
      for (var q = 3; q < id0.length; q += 4) if (id0[q] > 8) painted++;

      var png;
      try { png = base.toDataURL('image/png'); } catch (e0) {
        throw new Error('贴图导出失败（画布过大）——换成 1K 贴图再试');
      }

      var perView = views.map(function (k) {
        return {
          key: k, name: MV.viewName(k),
          islands: viewCount[k] || 0,
          fill: fillCount[k] || 0
        };
      });
      state.proj = {
        png: png, canvas: base, size: texSize,
        painted: painted, occCount: occCount,
        pct: occCount ? Math.round(painted / occCount * 100) : 0,
        islands: islands.length,
        lost: lost,
        fillTotal: fillTotal,
        used: {
          inset: settings.inset, fill: settings.fill,
          bleed: settings.bleed, flipV: settings.flipV
        },
        offScale: offScale, perView: perView,
        root: model.root, name: name || ''
      };
      state.projProg = null;
      openPanel();
      genPreview();
    } catch (e) {
      MV.say('投射失败：' + MV.friendly(e));
    } finally {
      state.projProg = null;
      MV.setBusy('');
      MV.paint();
    }
  }

  /* 换模型时清掉整套投射状态：旧贴图和生图源都是按上一个模型的
   * 四视图布局烘/生成的，留到新模型上只会悄悄投歪，必须作废。 */
  function clearResult() {
    state.proj = null;
    state.projSrc = null;
    state.projProg = null;
    var p = $('mvProjPanel');
    if (p) p.classList.add('hidden');
    paint();
  }

  /* 重新投射：用上次导入的图 + 当前参数复烘。参数改了不必再选文件。 */
  async function reproject() {
    var s = state.projSrc;
    if (!s || !s.dataUrl) {
      MV.say('还没有可复用的生图——先「导入生图投射」一次');
      return;
    }
    if (!state.cur || !state.cur.src) { MV.say('先选一个模型'); return; }
    await runImage(s.dataUrl, s.name);
  }

  async function fromFile(file) {
    if (!file) return;
    try {
      var url = await readFileAsDataURL(file);
      await runImage(url, file.name);
    } catch (e) {
      MV.say('投射失败：' + MV.friendly(e));
    }
  }

  /* ---------------- 上色预览：同一份 viewGrid，材质模式 + texMap ---------------- */

  /* 输出的贴图 PNG 保持透明（用户要求「未投射区域 = 透明」）；
   * 但预览/GLB 不能直接用它：unlit 材质下透明 texel 的 RGB=0 会被画成纯黑。
   * 这里只给「看」和「导出模型」用一张浅灰底合成图，彩色区域 1:1 不变。 */
  function opaqueMap(pr) {
    if (pr.opaque) return pr.opaque;
    var c = document.createElement('canvas');
    c.width = c.height = pr.size;
    var x = c.getContext('2d');
    x.fillStyle = '#d9dce3';
    x.fillRect(0, 0, pr.size, pr.size);
    x.drawImage(pr.canvas, 0, 0);
    pr.opaque = c.toDataURL('image/png');
    return pr.opaque;
  }

  async function genPreview() {
    var pr = state.proj;
    if (!pr || !state.cur) return;
    if (!window.Model3D || typeof Model3D.viewGrid !== 'function') return;
    try {
      var o = await Model3D.viewGrid(state.cur.src, {
        views: state.views.slice(),
        mode: 'material',
        cam: state.cam,
        margin: state.margin,
        cell: 512,
        cols: MV.autoCols(state.views.length),
        gap: 8,
        texMap: opaqueMap(pr),
        transparent: true
      });
      pr.preview = o.png;
      var img = $('mvProjPrev');
      if (img && state.proj === pr) { img.src = o.png; img.classList.remove('hidden'); }
    } catch (e) {
      pr.previewErr = MV.friendly(e);
      paint();
    }
  }

  /* ---------------- 弹层 ---------------- */

  function paint() {
    var pr = state.proj;
    var img = $('mvProjOut');
    if (img) {
      if (pr && pr.png) { img.src = pr.png; img.classList.remove('hidden'); }
      else { img.removeAttribute('src'); img.classList.add('hidden'); }
    }
    var prev = $('mvProjPrev');
    if (prev) {
      if (pr && pr.preview) { prev.src = pr.preview; prev.classList.remove('hidden'); }
      else { prev.removeAttribute('src'); prev.classList.add('hidden'); }
    }

    /* 生图源缩略图：重新投射时确认「复用的是哪一张」 */
    var src = $('mvProjSrc'), srcBox = $('mvProjSrcBox');
    if (src && srcBox) {
      if (state.projSrc) {
        if (src.getAttribute('src') !== state.projSrc.dataUrl) src.src = state.projSrc.dataUrl;
        srcBox.classList.add('has');
      } else {
        src.removeAttribute('src');
        srcBox.classList.remove('has');
      }
    }

    var stat = $('mvProjStats');
    if (stat) {
      if (!pr) stat.innerHTML = '';
      else {
        var lostTxt = pr.islands + ' 个 · 归类 ' + (pr.islands - (pr.lost || 0)) +
          ' · 补角 ' + (pr.fillTotal || 0);
        var use = pr.used || {};
        var useTxt = '内缩 ' + (use.inset == null ? '-' : use.inset) + ' px · 补角 ' +
          (use.fill == null ? '-' : use.fill) + '% · 扩散 ' + (use.bleed == null ? '-' : use.bleed) + ' px' +
          (use.flipV ? ' · V 翻转' : '');
        stat.innerHTML =
          '<span>贴图 <b>' + pr.size + ' × ' + pr.size + '</b></span>' +
          '<span>覆盖 <b>' + pr.pct + '%</b>（' + MV.fmtN(pr.painted) + ' / ' + MV.fmtN(pr.occCount) + ' texel）</span>' +
          '<span>UV 岛 <b>' + lostTxt + '</b></span>' +
          (pr.lost ? '<span>未覆盖 <b class="is-warn">' + pr.lost + ' 个</b>（保持透明）</span>' : '') +
          '<span>参数 <b>' + useTxt + '</b></span>';
      }
    }

    var info = $('mvProjInfo');
    if (info) {
      if (!pr) info.textContent = '';
      else {
        var s = pr.size + '×' + pr.size + ' · ' + pr.islands + ' UV 岛 · 覆盖 ' + pr.pct +
          '%（' + MV.fmtN(pr.painted) + ' / ' + MV.fmtN(pr.occCount) + ' texel）';
        var who = pr.perView.filter(function (v) { return v.islands > 0; })
          .map(function (v) { return v.name + ' ' + v.islands + (v.fill ? '（补 ' + v.fill + '）' : ''); })
          .join(' / ');
        if (who) s += ' · 归类：' + who;
        if (pr.lost) s += ' · 未覆盖 ' + pr.lost + ' 个岛（保持透明）';
        if (pr.offScale) s += ' · ⚠ 导入图与当前导出布局尺寸不一致，已等比对齐（建议用导出的网格原图去生图）';
        s += ' · 空白透明（预览/GLB 以浅灰显示）';
        if (pr.previewErr) s += ' · 上色预览失败：' + pr.previewErr;
        info.textContent = s;
      }
    }

    var sub = $('mvProjSub');
    if (sub) {
      sub.textContent = (state.cur && state.cur.name) || '';
      if (pr && pr.name) sub.textContent = (sub.textContent ? sub.textContent + ' · ' : '') + pr.name;
    }

    /* 右侧「投射」页的状态：忙碌时锁按钮，参数改完可直接重新投射 */
    var busy = !!state.busy;
    var canRun = !!(state.cur && state.cur.src) && !busy;
    var pj = $('mvProj');
    if (pj) pj.disabled = !canRun;
    var canRepro = canRun && !!(state.projSrc && state.projSrc.dataUrl);
    var rp = $('mvProjReproj');
    if (rp) rp.disabled = !canRepro;
    var re2 = document.querySelectorAll('[data-mv-proj-reproj]');
    for (var ri = 0; ri < re2.length; ri++) re2[ri].disabled = !canRepro;

    var quick = $('mvProjQuick');
    if (quick && !state.projProg) {
      if (pr) quick.textContent = '已投射 · 覆盖 ' + pr.pct + '% · 改参数后可重新投射';
      else if (state.projSrc) quick.textContent = '已缓存上次生图，可直接重新投射';
      else quick.textContent = '选一张与当前导出布局对齐的生图';
    }
    paintProgress();

    /* 弹层里的导出反馈：按钮换字 + 状态行（底部 say 会被弹层挡住） */
    var es = MV.exportStatus ? MV.exportStatus() : { kind: '', txt: '', log: null };
    var PB = [
      ['mvProjDl', '下载贴图 PNG', 'proj-png'],
      ['mvProjGlb', '下载带贴图 GLB', 'proj-glb'],
      ['mvProjLib', '存入图库', 'proj-lib']
    ];
    for (var pi = 0; pi < PB.length; pi++) {
      var pb = $(PB[pi][0]);
      if (!pb) continue;
      var pon = es.kind === PB[pi][2];
      pb.textContent = pon ? '处理中…' : PB[pi][1];
      if (pon) pb.classList.add('is-busy'); else pb.classList.remove('is-busy');
    }
    var stBox = $('mvProjStatus'), stTxt = $('mvProjStatusTxt');
    if (stBox) {
      var show = !!(es.kind || es.log);
      stBox.classList.toggle('hidden', !show);
      stBox.classList.toggle('is-busy', !!es.kind);
      stBox.classList.toggle('is-ok', !!(es.log && es.log.ok));
      stBox.classList.toggle('is-err', !!(es.log && !es.log.ok));
      if (stTxt) stTxt.textContent = es.kind ? es.txt : (es.log ? es.log.txt : '');
    }

    var canDl = !!(pr && pr.png) && !busy;
    var dl = $('mvProjDl'), gl = $('mvProjGlb'), lb = $('mvProjLib');
    if (dl) dl.disabled = !canDl;
    if (gl) gl.disabled = !canDl;
    if (lb) lb.disabled = !canDl || !MV.hasDesk();
  }

  function openPanel() {
    syncSettingsUI();
    if (MV.setRightTab) MV.setRightTab('proj');
    paint();
    var p = $('mvProjPanel');
    if (p) p.classList.remove('hidden');
  }
  function close() { var p = $('mvProjPanel'); if (p) p.classList.add('hidden'); }
  function isOpen() { var p = $('mvProjPanel'); return !!(p && !p.classList.contains('hidden')); }

  /* ---------------- 交出去 ---------------- */

  async function downloadPNG() {
    var pr = state.proj;
    if (!pr || state.busy) return;
    var fn = MV.baseName() + '_贴图.png';
    MV.exportBegin('proj-png', '正在写出贴图 PNG…');
    MV.setBusy('export');
    await tick();                       // 先让按钮换字和扫光画出来
    var bytes = MV.saveBlob(MV.dataUrlToBlob(pr.png), fn);
    MV.setBusy('');
    MV.exportDone('proj-png', fn, bytes, pr.size + '×' + pr.size + ' · 未投射区域透明');
  }

  /* 上色 GLB：把烘焙贴图挂到模型上，交 GLTFExporter 内嵌导出。
   * pr.root 是 load() 给的克隆件，随便改材质不脏缓存。 */
  async function downloadGLB() {
    var pr = state.proj;
    if (!pr || !pr.root || state.busy) return;
    if (!window.ModelSplit || typeof ModelSplit.toGLB !== 'function') {
      MV.exportFail('proj-glb', 'GLB 导出组件未加载（js/model-split.js）');
      return;
    }
    var fn = MV.baseName() + '_上色.glb';
    MV.exportBegin('proj-glb', '正在打包上色 GLB（贴图内嵌）…');
    MV.setBusy('export');
    try {
      /* 字节直通 + unlit：跟预览同一个口径，颜色不会暗一档、不会多出打光明暗。
       * 用浅灰底合成图，未投射的区域在别的软件里是中性灰而不是黑洞。 */
      var texImg = new Image();
      var opaque = opaqueMap(pr);
      texImg.src = opaque;
      /* CanvasTexture 要等图解码完才有像素：直接等 onload（dataURL 一般同步，
       * 但大图在部分浏览器里是异步的，等一下更稳） */
      if (!texImg.complete || !texImg.naturalWidth) {
        await new Promise(function (res, rej) {
          texImg.onload = res;
          texImg.onerror = function () { rej(new Error('贴图读不出来')); };
        });
      }
      var tex = new THREE.CanvasTexture(texImg);
      tex.needsUpdate = true;
      var flat = new THREE.MeshBasicMaterial({
        map: tex, color: 0xffffff, side: THREE.DoubleSide
      });
      pr.root.traverse(function (o) {
        if (!o.isMesh || !o.geometry) return;
        o.material = flat;
      });
      var buf = await ModelSplit.toGLB(pr.root);
      var bytes = MV.saveBlob(MV.dataUrlToBlob(ModelSplit.bufToDataURL(buf, 'model/gltf-binary')), fn);
      MV.setBusy('');
      MV.exportDone('proj-glb', fn, bytes, '贴图已内嵌');
    } catch (e) {
      MV.setBusy('');
      MV.exportFail('proj-glb', MV.friendly(e));
    }
  }

  async function saveLib() {
    var pr = state.proj;
    if (!pr || state.busy) return;
    var d = MV.lib();
    if (!d || typeof d.assetPut !== 'function') {
      MV.exportFail('proj-lib', '浏览器里存不进图库，用「下载贴图 PNG」');
      return;
    }
    MV.exportBegin('proj-lib', '正在把贴图写入图库…');
    MV.setBusy('saving');
    var r = null, err = '';
    try {
      r = await d.assetPut({
        kind: 'image', name: MV.baseName() + '_贴图.png', ext: 'png',
        data: pr.png, source: 'multiview'
      });
    } catch (e) {
      err = MV.friendly(e);
    }
    MV.setBusy('');
    if (!err && r && r.ok) MV.exportDone('proj-lib', MV.baseName() + '_贴图.png', 0, '图库里能看到这张');
    else MV.exportFail('proj-lib', err || (r && r.message) || '未知原因');
  }

  window.MVProject = {
    fromFile: fromFile,
    runImage: runImage,
    reproject: reproject,
    clearResult: clearResult,
    downloadPNG: downloadPNG,
    downloadGLB: downloadGLB,
    saveLib: saveLib,
    close: close,
    isOpen: isOpen,
    paint: paint,
    /* 右侧「投射」页的参数控件：绑定与回填由 mv-bind / mv-project 共用一份表 */
    FIELDS: PROJ_FIELDS,
    settings: function () { return JSON.parse(JSON.stringify(settings)); },
    setSetting: setSetting,
    syncSettingsUI: syncSettingsUI
  };
})();
