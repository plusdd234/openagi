/* 图像工坊 · 3D 绘制工作区（window.PS3D）
 *
 * 和位图 / 矢量编辑器并列的第三种工作区：这里不编辑 2D 像素，而是在模型表面
 * 按「UV 岛」和「遮挡关系」生成动态遮罩，再把结果交给 2D 文档当图层 / 图层蒙版。
 *
 * 关键概念：
 *   · UV 岛——同一网格里 UV 连续的一组三角面。岛是遮罩的基本单位，点选岛 = 圈定范围。
 *   · 遮挡——从当前相机看过去只保留最前面的面。做法是先用全模型填一遍深度，
 *     再把「已选岛」的面画一遍 UV，深度测试自动剔除被挡住的部分。
 *   · 动态遮罩——遮罩贴图在 UV 空间；相机一转、岛一改、笔刷一落就重算，
 *     开着「动态更新」时会同步回写到 2D 文档里的目标图层 / 图层蒙版。
 *
 * 依赖：vendor/three.min.js、GLTFLoader、OBJLoader、OrbitControls（index.html 已加载）。
 * 不依赖任何网络资源：模型来自本地文件或内置示例。
 */
(function (global) {
  'use strict';

  var HAS_THREE = typeof global.THREE !== 'undefined';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
  }

  function paletteColor(i) {
    var C = global.THREE.Color;
    var c = new C();
    /* 黄金角散开色相：相邻岛的颜色差得开，又不至于刺眼 */
    c.setHSL((i * 0.618033988749895) % 1, 0.52, 0.56);
    return c;
  }

  function colorHex(c) { return '#' + c.getHexString(); }

  /* ---------------- 网格分析：UV 岛 ---------------- */
  /* 判定标准：两个三角面共享一条边，且这条边两个端点的 UV 完全一致，
   * 才属于同一个 UV 岛。UV 断开的接缝（哪怕是同一个顶点）会切成两个岛。 */
  function analyzeGeometry(geo) {
    var T = global.THREE;
    var pos = geo.attributes.position;
    var uv = geo.attributes.uv || geo.attributes.uv2;
    if (!pos || !uv) return null;
    var index = geo.index;
    var count = index ? index.count : pos.count;
    var triCount = Math.floor(count / 3);
    if (!triCount) return null;

    var vid = new Int32Array(count);
    var i, t, e;
    for (i = 0; i < count; i++) vid[i] = index ? index.getX(i) : i;

    var parent = new Int32Array(triCount);
    for (i = 0; i < triCount; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

    var uvX = new Float32Array(count), uvY = new Float32Array(count);
    for (i = 0; i < count; i++) { uvX[i] = uv.getX(vid[i]); uvY[i] = uv.getY(vid[i]); }

    /* 顶点按「位置」焊接一次：OBJ / 部分 GLB 会把接缝顶点复制成多份，
     * 只看顶点下标会把本该连续的岛切碎；位置相同才当作同一个点。 */
    var pMap = new Map();
    var pNext = 0;
    var vgid = new Int32Array(pos.count);
    var qv = function (v) { return Math.round(v * 1e4); };
    for (i = 0; i < pos.count; i++) {
      var pk = qv(pos.getX(i)) + ',' + qv(pos.getY(i)) + ',' + qv(pos.getZ(i));
      var pid = pMap.get(pk);
      if (pid === undefined) { pid = pNext++; pMap.set(pk, pid); }
      vgid[i] = pid;
    }

    var EPS = 1e-5;
    var edges = new Map();
    for (t = 0; t < triCount; t++) {
      for (e = 0; e < 3; e++) {
        var k0 = t * 3 + e, k1 = t * 3 + (e + 1) % 3;
        var a = vgid[vid[k0]], b = vgid[vid[k1]];
        var ax = uvX[k0], ay = uvY[k0], bx = uvX[k1], by = uvY[k1];
        if (a > b) {
          var tv = a; a = b; b = tv;
          var tx = ax; ax = bx; bx = tx;
          var ty = ay; ay = by; by = ty;
        }
        var key = a + ':' + b;
        var rec = edges.get(key);
        if (!rec) {
          edges.set(key, { t: t, ax: ax, ay: ay, bx: bx, by: by });
        } else if (Math.abs(rec.ax - ax) < EPS && Math.abs(rec.ay - ay) < EPS &&
                   Math.abs(rec.bx - bx) < EPS && Math.abs(rec.by - by) < EPS) {
          union(rec.t, t);
        }
      }
    }

    var idOf = new Int32Array(triCount);
    var roots = new Map();
    var localTris = [];
    for (t = 0; t < triCount; t++) {
      var r = find(t);
      var id = roots.get(r);
      if (id === undefined) { id = localTris.length; roots.set(r, id); localTris.push([]); }
      idOf[t] = id;
      localTris[id].push(t);
    }

    /* 非索引副本：逐面写颜色 / 岛号需要顶点级属性，索引几何做不到「同一个顶点两种颜色」 */
    var g2 = index ? geo.toNonIndexed() : geo.clone();
    if (!g2.attributes.normal) g2.computeVertexNormals();

    var uvArr = g2.attributes.uv ? g2.attributes.uv.array : null;
    var posArr = g2.attributes.position.array;

    /* 每岛的 UV 包围盒（面板里显示用） */
    var bounds = [];
    for (i = 0; i < localTris.length; i++) {
      var u0 = 1, v0 = 1, u1 = 0, v1 = 0;
      var list = localTris[i];
      for (var k = 0; k < list.length; k++) {
        for (var j = 0; j < 3; j++) {
          var o = (list[k] * 3 + j) * 2;
          var uu = uvArr[o], vv = uvArr[o + 1];
          if (uu < u0) u0 = uu;
          if (uu > u1) u1 = uu;
          if (vv < v0) v0 = vv;
          if (vv > v1) v1 = vv;
        }
      }
      bounds.push({ u0: u0, v0: v0, u1: u1, v1: v1 });
    }

    return {
      geo: g2, triCount: triCount, idOf: idOf, localTris: localTris, bounds: bounds,
      uv: uvArr, pos: posArr
    };
  }

  /* 岛的接缝线：两个面共用位置边但岛号不同（或只有单个面）的边 */
  function boundarySegments(info) {
    var pos = info.pos;
    var seen = new Map();
    var out = [];
    for (var t = 0; t < info.triCount; t++) {
      var isl = info.idOf[t];
      for (var e = 0; e < 3; e++) {
        var a = t * 3 + e, b = t * 3 + (e + 1) % 3;
        var ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        var bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
        var q = function (v) { return Math.round(v * 1e4); };
        var k1 = q(ax) + ',' + q(ay) + ',' + q(az);
        var k2 = q(bx) + ',' + q(by) + ',' + q(bz);
        var key = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        var rec = seen.get(key);
        if (!rec) {
          seen.set(key, { isl: isl, ax: ax, ay: ay, az: az, bx: bx, by: by, bz: bz });
        } else if (rec.isl !== isl) {
          out.push(rec.ax, rec.ay, rec.az, rec.bx, rec.by, rec.bz);
          seen.set(key, { isl: -1, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0 });
        }
      }
    }
    /* 只出现一次的边（开放边界）也画出来：遍历完再补 */
    seen.forEach(function (rec) {
      if (rec.isl >= 0) out.push(rec.ax, rec.ay, rec.az, rec.bx, rec.by, rec.bz);
    });
    return out.length ? new Float32Array(out) : null;
  }

  /* ---------------- 内置示例模型 ----------------
   * 五块面板：地面 + 背板 + 左右侧板 + 前方悬浮遮挡板。
   * 每块面板在 UV 图集里各占一格（互不重叠），所以能真的演示「岛」；
   * 前挡板会挡住后板的一部分，用来演示「遮挡」。 */
  function demoGeometry() {
    var T = global.THREE;
    var tiles = [
      [0.02, 0.02], [0.36, 0.02], [0.70, 0.02],
      [0.02, 0.54], [0.36, 0.54]
    ];
    var TW = 0.28, TH = 0.42;   /* 每格可用尺寸（留 0.02 间隙） */
    var quads = [
      { p: [[-1, -0.9, -1], [1, -0.9, -1], [1, -0.9, 1], [-1, -0.9, 1]], n: [0, 1, 0], tile: 0 },
      { p: [[-1, -0.9, -1], [1, -0.9, -1], [1, 1.1, -1], [-1, 1.1, -1]], n: [0, 0, 1], tile: 1 },
      { p: [[-1, -0.9, -1], [-1, -0.9, 1], [-1, 1.1, 1], [-1, 1.1, -1]], n: [1, 0, 0], tile: 2 },
      { p: [[1, -0.9, 1], [1, -0.9, -1], [1, 1.1, -1], [1, 1.1, 1]], n: [-1, 0, 0], tile: 3 },
      { p: [[-0.45, -0.2, 0.35], [0.45, -0.2, 0.15], [0.45, 0.95, 0.3], [-0.45, 0.95, 0.5]], n: [0, 0, 1], tile: 4 }
    ];
    var pos = [], uv = [], nor = [], idx = [];
    var cornerUV = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (var q = 0; q < quads.length; q++) {
      var quad = quads[q];
      var base = pos.length / 3;
      for (var c = 0; c < 4; c++) {
        pos.push(quad.p[c][0], quad.p[c][1], quad.p[c][2]);
        nor.push(quad.n[0], quad.n[1], quad.n[2]);
        var tile = tiles[quad.tile];
        uv.push(tile[0] + cornerUV[c][0] * TW, tile[1] + cornerUV[c][1] * TH);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return geo;
  }

  /* ---------------- 工作区 ---------------- */
  function create(host, api) {
    api = api || {};

    var S = {
      host: host,
      active: false,
      renderer: null,
      scene: null,
      camera: null,
      controls: null,
      viewEl: null,
      canvas: null,
      grid: null,
      root: null,
      meshes: [],
      islands: [],
      selected: new Set(),
      tool: 'island',
      occlude: true,
      live: true,
      commitKind: 'layer',
      maskSize: 1024,
      viewSize: 768,
      maskCv: null, mctx: null,
      addCv: null, eraseCv: null,
      islandCv: null,
      previewEl: null,
      coverage: 0,
      hasModel: false,
      dirty: false,
      raf: 0,
      busy: false,
      pendingMask: 0,
      lastMaskAt: 0,
      stroke: null,
      selTex: null,
      selData: null,
      visMat: null,
      depthMat: null,
      visRT: null,
      visBuf: null,
      projRT: null,
      projMat: null,
      projBuf: null,
      target: null,
      groupError: '',
      brush: { radius: 44, flow: 0.85 },
      stats: { meshes: 0, tris: 0, skipped: 0, name: '' }
    };

    /* ---------------- DOM ---------------- */
    host.innerHTML =
      '<div class="ps3d">' +
        '<div class="ps3d-bar">' +
          '<div class="ps3d-group">' +
            '<button type="button" class="ps3d-btn is-primary" data-act="load">载入模型</button>' +
            '<button type="button" class="ps3d-btn" data-act="demo">示例模型</button>' +
            '<span class="ps3d-name" data-el="name">未载入模型</span>' +
          '</div>' +
          '<div class="ps3d-seg" data-el="tools">' +
            '<button type="button" data-tool="orbit">环绕</button>' +
            '<button type="button" data-tool="island" class="is-on">UV岛</button>' +
            '<button type="button" data-tool="brush">遮罩笔刷</button>' +
            '<button type="button" data-tool="erase">擦除</button>' +
          '</div>' +
          '<label class="ps3d-check"><input type="checkbox" data-el="occ" checked> 遮挡剔除</label>' +
          '<label class="ps3d-check"><input type="checkbox" data-el="live" checked> 动态更新</label>' +
          '<label class="ps3d-check"><input type="checkbox" data-el="showIslands" checked> 岛列表</label>' +
          '<label class="ps3d-check"><input type="checkbox" data-el="showMask" checked> 遮罩预览</label>' +
          '<label class="ps3d-field">遮罩 <select data-el="size">' +
            '<option value="512">512</option>' +
            '<option value="1024" selected>1024</option>' +
            '<option value="2048">2048</option>' +
          '</select></label>' +
          '<div class="ps3d-seg" data-el="commitKind">' +
            '<button type="button" data-kind="layer" class="is-on">遮罩图层</button>' +
            '<button type="button" data-kind="mask">图层蒙版</button>' +
          '</div>' +
          '<button type="button" class="ps3d-btn is-primary" data-act="commit">生成遮罩</button>' +
          '<button type="button" class="ps3d-btn is-primary" data-act="group" title="按当前视角正交投影，每个可见 UV 岛一个带蒙版的图层">添加遮罩</button>' +
        '</div>' +
        '<div class="ps3d-main">' +
          '<aside class="ps3d-left" data-el="islandPanel">' +
            '<div class="ps3d-h"><span>UV 岛</span><b data-el="islandCount">0</b>' +
              '<span class="ps3d-acts">' +
                '<button type="button" data-act="all">全选</button>' +
                '<button type="button" data-act="none">清空</button>' +
              '</span>' +
            '</div>' +
            '<div class="ps3d-list" data-el="islandList"></div>' +
            '<div class="ps3d-h">模型信息</div>' +
            '<div class="ps3d-info" data-el="info">未载入模型</div>' +
          '</aside>' +
          '<div class="ps3d-view" data-el="view">' +
            '<canvas data-el="canvas"></canvas>' +
            '<div class="ps3d-brush" data-el="brush" hidden></div>' +
            '<div class="ps3d-hint" data-el="hint">拖入 GLB / GLTF / OBJ，或点「示例模型」</div>' +
            '<div class="ps3d-badge" data-el="badge"></div>' +
          '</div>' +
          '<aside class="ps3d-right" data-el="maskPanel">' +
            '<div class="ps3d-h"><span>动态遮罩</span><b data-el="maskStat">0%</b></div>' +
            '<div class="ps3d-preview"><canvas data-el="preview" width="256" height="256"></canvas></div>' +
            '<div class="ps3d-h">笔刷</div>' +
            '<label class="ps3d-range">半径<input type="range" data-el="brushSize" min="6" max="160" value="44"><i data-el="brushVal">44</i></label>' +
            '<label class="ps3d-range">流量<input type="range" data-el="brushFlow" min="10" max="100" value="85"><i data-el="brushFlowVal">85</i></label>' +
            '<div class="ps3d-h">目标</div>' +
            '<div class="ps3d-info" data-el="target">尚未生成</div>' +
            '<button type="button" class="ps3d-btn" data-act="clearMask">清空笔刷</button>' +
          '</aside>' +
        '</div>' +
      '</div>' +
      '<input type="file" accept=".glb,.gltf,.obj" data-el="file" hidden>';

    var el = {};
    host.querySelectorAll('[data-el]').forEach(function (n) { el[n.dataset.el] = n; });
    S.viewEl = el.view;
    S.canvas = el.canvas;

    if (!HAS_THREE) {
      el.hint.textContent = 'three.js 未加载：3D 工作区不可用';
      el.hint.classList.add('is-err');
      return apiStub();
    }

    /* ---------------- three 基础 ---------------- */
    var T = global.THREE;
    try {
      S.renderer = new T.WebGLRenderer({ canvas: S.canvas, antialias: true, alpha: false });
      S.renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
      if ('outputEncoding' in S.renderer) S.renderer.outputEncoding = T.sRGBEncoding;
    } catch (e) {
      S.renderer = null;
      el.hint.textContent = '当前环境没有可用的 WebGL：3D 工作区无法渲染';
      el.hint.classList.add('is-err');
      return apiStub();
    }

    S.scene = new T.Scene();
    S.scene.background = new T.Color('#1a1f27');

    S.camera = new T.PerspectiveCamera(45, 1, 0.05, 200);
    S.camera.position.set(0, 1.2, 5.2);

    S.controls = new T.OrbitControls(S.camera, S.canvas);
    S.controls.enableDamping = false;
    S.controls.minDistance = 0.6;
    S.controls.maxDistance = 40;
    S.controls.addEventListener('change', function () {
      S.dirty = true;
      onCameraMove();
    });

    S.scene.add(new T.HemisphereLight(0xffffff, 0x2a3442, 0.85));
    S.scene.add(new T.AmbientLight(0xffffff, 0.25));
    var key = new T.DirectionalLight(0xffffff, 0.95);
    key.position.set(3, 5, 4);
    S.scene.add(key);
    var fill = new T.DirectionalLight(0xcfdfff, 0.45);
    fill.position.set(-4, 2, -3);
    S.scene.add(fill);

    S.grid = new T.GridHelper(10, 20, 0x3a4a5e, 0x27313d);
    S.grid.position.y = -1.35;
    S.scene.add(S.grid);

    S.depthMat = new T.MeshBasicMaterial({ colorWrite: false, side: T.DoubleSide });
    S.visMat = new T.ShaderMaterial({
      uniforms: { uSel: { value: null }, uCount: { value: 1 } },
      vertexShader: [
        'attribute float aIsland;',
        'varying vec2 vUv;',
        'varying float vId;',
        'void main(){',
        '  vUv = uv;',
        '  vId = aIsland;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uSel;',
        'uniform float uCount;',
        'varying vec2 vUv;',
        'varying float vId;',
        'void main(){',
        '  float sel = texture2D(uSel, vec2((vId + 0.5) / uCount, 0.5)).r;',
        '  if (sel < 0.5) discard;',
        '  gl_FragColor = vec4(vUv, 0.0, 1.0);',
        '}'
      ].join('\n'),
      side: T.DoubleSide,
      depthTest: true,
      depthWrite: false
    });

    /* 遮罩画布 + 笔刷画布 */
    ensureMaskCanvas();
    S.addCv = makeCanvas(S.maskSize, S.maskSize);
    S.eraseCv = makeCanvas(S.maskSize, S.maskSize);
    S.islandCv = makeCanvas(S.maskSize, S.maskSize);
    S.previewEl = el.preview;

    if (typeof ResizeObserver !== 'undefined') {
      S.resizeObs = new ResizeObserver(function () { resize(); });
      S.resizeObs.observe(S.viewEl);
    }

    bindUI();
    resize();
    renderPreview();
    updateBadge();

    /* ---------------- UV 岛 / 选择纹理 ---------------- */
    function ensureMaskCanvas() {
      if (!S.maskCv || S.maskCv.width !== S.maskSize) {
        S.maskCv = document.createElement('canvas');
        S.maskCv.width = S.maskSize;
        S.maskCv.height = S.maskSize;
        S.mctx = S.maskCv.getContext('2d');
        S.islandCv = makeCanvas(S.maskSize, S.maskSize);
        S.addCv = null;
        S.eraseCv = null;
        S.strokeDirty = false;
      }
      if (!S.addCv) resetBrushCanvases();
    }

    function resetBrushCanvases() {
      S.addCv = makeCanvas(S.maskSize, S.maskSize);
      S.eraseCv = makeCanvas(S.maskSize, S.maskSize);
    }

    function ensureSelTexture() {
      var n = Math.max(1, S.islands.length);
      if (!S.selTex || S.selData.length !== n * 4) {
        S.selData = new Uint8Array(n * 4);
        S.selTex = new T.DataTexture(S.selData, n, 1, T.RGBAFormat);
        S.selTex.minFilter = T.NearestFilter;
        S.selTex.magFilter = T.NearestFilter;
        S.selTex.wrapS = T.ClampToEdgeWrapping;
        S.selTex.wrapT = T.ClampToEdgeWrapping;
      }
      S.visMat.uniforms.uSel.value = S.selTex;
      S.visMat.uniforms.uCount.value = n;
      syncSelTexture();
    }

    function syncSelTexture() {
      if (!S.selData) return;
      var d = S.selData;
      for (var i = 0; i < S.islands.length; i++) {
        var on = S.selected.has(S.islands[i].id) ? 255 : 0;
        d[i * 4] = on; d[i * 4 + 1] = on; d[i * 4 + 2] = on; d[i * 4 + 3] = 255;
      }
      S.selTex.needsUpdate = true;
    }

    /* ---------------- 模型 ---------------- */
    function clearModel() {
      if (!S.root) return;
      S.scene.remove(S.root);
      S.root.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material !== S.depthMat && o.material !== S.visMat) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
      S.root = null;
      S.meshes = [];
      S.islands = [];
      S.selected.clear();
      S.covCache = null;
      S.hasModel = false;
      S.stats = { meshes: 0, tris: 0, skipped: 0, name: '' };
      S.target = null;
      renderIslandList();
      updateInfo();
      updateTargetInfo();
      updateBadge();
      S.dirty = true;
    }

    function setModel(rootObj, name) {
      clearModel();
      if (!rootObj) return false;

      rootObj.updateMatrixWorld(true);
      var box = new T.Box3().setFromObject(rootObj);
      var size = new T.Vector3();
      var center = new T.Vector3();
      box.getSize(size);
      box.getCenter(center);
      var maxDim = Math.max(size.x, size.y, size.z) || 1;
      var scale = 2.7 / maxDim;

      S.root = new T.Group();
      S.root.add(rootObj);
      S.root.scale.setScalar(scale);
      S.root.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
      S.scene.add(S.root);

      var skipped = 0;
      var meshList = [];
      rootObj.traverse(function (o) {
        if (o.isMesh && o.geometry) meshList.push(o);
      });

      var totalTris = 0;
      meshList.forEach(function (mesh) {
        var info = analyzeGeometry(mesh.geometry);
        if (!info) { skipped++; return; }
        var meshIndex = S.meshes.length;
        var oldGeo = mesh.geometry;
        mesh.geometry = info.geo;
        oldGeo.dispose();

        var base = S.islands.length;
        var localCount = info.localTris.length;
        for (var li = 0; li < localCount; li++) {
          var col = paletteColor(base + li);
          S.islands.push({
            id: base + li,
            mi: meshIndex,
            local: li,
            tris: info.localTris[li],
            color: col,
            hex: colorHex(col),
            bounds: info.bounds[li]
          });
        }

        var faceCount = info.triCount;
        var colors = new Float32Array(faceCount * 9);
        var ids = new Float32Array(faceCount * 3);
        for (var f = 0; f < faceCount; f++) {
          var isl = S.islands[base + info.idOf[f]];
          for (var k = 0; k < 3; k++) {
            var o = f * 9 + k * 3;
            colors[o] = isl.color.r;
            colors[o + 1] = isl.color.g;
            colors[o + 2] = isl.color.b;
            ids[f * 3 + k] = isl.id;
          }
        }
        info.geo.setAttribute('color', new T.BufferAttribute(colors, 3));
        info.geo.setAttribute('aIsland', new T.BufferAttribute(ids, 1));

        mesh.material = new T.MeshStandardMaterial({
          vertexColors: true,
          side: T.DoubleSide,
          roughness: 0.88,
          metalness: 0.05
        });

        var record = {
          index: meshIndex,
          mesh: mesh, info: info, base: base, localCount: localCount,
          selMesh: null, line: null
        };

        /* 岛接缝线（很密的模型就跳过，免得几十万段线拖垮帧率） */
        var segs = boundarySegments(info);
        if (segs && segs.length <= 240000) {
          var lg = new T.BufferGeometry();
          lg.setAttribute('position', new T.BufferAttribute(segs, 3));
          var line = new T.LineSegments(lg, new T.LineBasicMaterial({
            color: 0x6fd8ff, transparent: true, opacity: 0.55
          }));
          line.raycast = function () {};
          mesh.add(line);
          record.line = line;
        }

        /* 已选岛的高亮罩 */
        var sel = new T.Mesh(new T.BufferGeometry(), new T.MeshBasicMaterial({
          color: 0xffb257, transparent: true, opacity: 0.5, side: T.DoubleSide,
          depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        }));
        sel.raycast = function () {};
        sel.visible = false;
        mesh.add(sel);
        record.selMesh = sel;

        mesh.userData.ps3d = record;
        S.meshes.push(record);
        totalTris += faceCount;
      });

      S.hasModel = S.meshes.length > 0;
      S.stats = {
        meshes: S.meshes.length,
        tris: totalTris,
        skipped: skipped,
        name: name || '未命名模型'
      };

      if (S.hasModel) {
        S.viewSize = Math.min(1024, Math.max(512, S.maskSize));
        ensureSelTexture();
        /* 默认全选：先能看到完整 UV 岛分布，用户再按需取消 */
        S.selected.clear();
        S.islands.forEach(function (isl) { S.selected.add(isl.id); });
        syncSelTexture();
        rebuildSelectionOverlay();
        renderIslandList();
        updateInfo();
        frameCamera();
        el.hint.hidden = true;
        el.name.textContent = S.stats.name;
        scheduleMask(0);
      } else {
        el.hint.hidden = false;
        el.hint.textContent = '模型里没有可用的 UV：需要带 uv 属性的网格';
        el.hint.classList.add('is-err');
        el.name.textContent = '未载入模型';
      }
      S.dirty = true;
      return S.hasModel;
    }

    function frameCamera() {
      var r = 1.6;
      S.camera.position.set(0, r * 0.45, r * 2.45);
      S.controls.target.set(0, 0, 0);
      S.controls.update();
      S.dirty = true;
    }

    function rebuildSelectionOverlay() {
      S.meshes.forEach(function (rec) {
        var geom = rec.selMesh.geometry;
        var out = [];
        S.islands.forEach(function (isl) {
          if (isl.mi !== rec.index || !S.selected.has(isl.id)) return;
          for (var i = 0; i < isl.tris.length; i++) {
            var t = isl.tris[i];
            for (var k = 0; k < 3; k++) {
              var o = (t * 3 + k) * 3;
              out.push(rec.info.pos[o], rec.info.pos[o + 1], rec.info.pos[o + 2]);
            }
          }
        });
        if (out.length) {
          geom.setAttribute('position', new T.Float32BufferAttribute(out, 3));
          geom.computeVertexNormals();
          rec.selMesh.visible = true;
        } else {
          geom.setAttribute('position', new T.Float32BufferAttribute([], 3));
          rec.selMesh.visible = false;
        }
      });
    }

    /* ---------------- 相机 / 主循环 ---------------- */
    function resize() {
      if (!S.renderer) return;
      var r = S.viewEl.getBoundingClientRect();
      var w = Math.max(2, Math.round(r.width));
      var h = Math.max(2, Math.round(r.height));
      S.renderer.setSize(w, h, false);
      S.camera.aspect = w / h;
      S.camera.updateProjectionMatrix();
      S.dirty = true;
    }

    function loop() {
      S.raf = requestAnimationFrame(loop);
      if (!S.active || !S.renderer) return;
      if (S.dirty) {
        S.dirty = false;
        S.renderer.render(S.scene, S.camera);
      }
    }

    function enter() {
      S.active = true;
      resize();
      if (!S.raf) loop();
    }

    function leave() {
      S.active = false;
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    }

    function onCameraMove() {
      if (!S.hasModel) return;
      if (!S.occlude) return;
      if (!S.selected.size && !hasStrokes()) return;
      scheduleMask(180);
    }

    /* ---------------- 遮罩计算 ---------------- */
    function scheduleMask(delay) {
      if (!S.hasModel) return;
      if (S.pendingMask) return;
      S.pendingMask = setTimeout(function () {
        S.pendingMask = 0;
        rebuildMask();
      }, Math.max(0, delay == null ? 120 : delay));
    }

    function hasStrokes() {
      return !!S.strokeDirty;
    }

    function islandCoverage(W, H) {
      var sig = S.maskSize + '|' + Array.from(S.selected).sort(function (a, b) { return a - b; }).join(',');
      if (S.covCache && S.covCache.sig === sig && S.covCache.arr.length === W * H) {
        return S.covCache.arr;
      }
      var arr = new Uint8Array(W * H);
      if (!S.selected.size) return arr;
      var cv = S.islandCv;
      if (cv.canvas.width !== W) cv = S.islandCv = makeCanvas(W, H);
      var ctx = cv.ctx;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      S.islands.forEach(function (isl) {
        if (!S.selected.has(isl.id)) return;
        var rec = S.meshes[isl.mi];
        if (!rec) return;
        var uv = rec.info.uv;
        for (var t = 0; t < isl.tris.length; t++) {
          var base = isl.tris[t] * 3;
          for (var k = 0; k < 3; k++) {
            var o = (base + k) * 2;
            var x = uv[o] * (W - 1);
            var y = (1 - uv[o + 1]) * (H - 1);
            if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
      });
      ctx.fill('nonzero');
      var img = ctx.getImageData(0, 0, W, H).data;
      for (var p = 0; p < W * H; p++) arr[p] = img[p * 4 + 3];
      S.covCache = { sig: sig, arr: arr };
      return arr;
    }

    function dilate(arr, W, H, r) {
      if (r <= 0) return arr;
      var tmp = new Uint8Array(W * H);
      var x, y, i;
      for (y = 0; y < H; y++) {
        var row = y * W;
        for (x = 0; x < W; x++) {
          var best = 0;
          var x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
          for (i = x0; i <= x1; i++) { if (arr[row + i] > best) best = arr[row + i]; }
          tmp[row + x] = best;
        }
      }
      for (x = 0; x < W; x++) {
        for (y = 0; y < H; y++) {
          var b2 = 0;
          var y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
          for (i = y0; i <= y1; i++) { if (tmp[i * W + x] > b2) b2 = tmp[i * W + x]; }
          arr[y * W + x] = b2;
        }
      }
      return arr;
    }

    function visibilityCoverage(W, H) {
      var arr = new Uint8Array(W * H);
      if (!S.renderer || !S.hasModel) return arr;
      var size = S.viewSize;
      if (!S.visRT || S.visRT.width !== size) {
        if (S.visRT) S.visRT.dispose();
        S.visRT = new T.WebGLRenderTarget(size, size, {
          minFilter: T.NearestFilter,
          magFilter: T.NearestFilter,
          format: T.RGBAFormat,
          type: T.UnsignedByteType,
          depthBuffer: true,
          stencilBuffer: false
        });
        S.visBuf = new Uint8Array(size * size * 4);
      }

      var renderer = S.renderer;
      var prevTarget = renderer.getRenderTarget();
      var prevAuto = renderer.autoClear;
      var prevBg = S.scene.background;
      var prevClear = new T.Color();
      renderer.getClearColor(prevClear);
      var prevAlpha = renderer.getClearAlpha();

      var hide = [];
      S.meshes.forEach(function (rec) {
        if (rec.line) { hide.push([rec.line, rec.line.visible]); rec.line.visible = false; }
        if (rec.selMesh) { hide.push([rec.selMesh, rec.selMesh.visible]); rec.selMesh.visible = false; }
      });
      if (S.grid) { hide.push([S.grid, S.grid.visible]); S.grid.visible = false; }
      var mats = S.meshes.map(function (rec) { return rec.mesh.material; });

      try {
        S.scene.background = null;
        renderer.setRenderTarget(S.visRT);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = false;
        renderer.clear(true, true, false);

        /* 第一遍：全模型只写深度（不含 UV，被挡住的面也参与遮挡） */
        S.meshes.forEach(function (rec) { rec.mesh.material = S.depthMat; });
        renderer.render(S.scene, S.camera);

        /* 第二遍：只画已选岛，深度测试决定前后；写进颜色的是 UV */
        S.meshes.forEach(function (rec, i) { rec.mesh.material = S.visMat; });
        renderer.render(S.scene, S.camera);

        renderer.readRenderTargetPixels(S.visRT, 0, 0, size, size, S.visBuf);
      } catch (e) {
        api.note && api.note('遮挡计算失败：' + (e && e.message), true);
      } finally {
        S.meshes.forEach(function (rec, i) { rec.mesh.material = mats[i]; });
        hide.forEach(function (pair) { pair[0].visible = pair[1]; });
        S.scene.background = prevBg;
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevClear, prevAlpha);
        renderer.autoClear = prevAuto;
        S.dirty = true;
      }

      var buf = S.visBuf;
      var r = Math.max(2, Math.round(W / 255) + 1);
      for (var y = 0; y < size; y++) {
        var rowOff = y * size * 4;
        for (var x = 0; x < size; x++) {
          var i = rowOff + x * 4;
          if (!buf[i + 3]) continue;
          var u = buf[i] / 255;
          var v = buf[i + 1] / 255;
          var px = Math.round(u * (W - 1));
          var py = Math.round((1 - v) * (H - 1));
          var x0 = Math.max(0, px - 1), x1 = Math.min(W - 1, px + 1);
          var y0 = Math.max(0, py - 1), y1 = Math.min(H - 1, py + 1);
          for (var yy = y0; yy <= y1; yy++) {
            for (var xx = x0; xx <= x1; xx++) arr[yy * W + xx] = 255;
          }
        }
      }
      return dilate(arr, W, H, r);
    }

    function readAlpha(cv) {
      var W = cv.canvas.width, H = cv.canvas.height;
      var d = cv.ctx.getImageData(0, 0, W, H).data;
      var out = new Uint8Array(W * H);
      for (var i = 0; i < W * H; i++) out[i] = d[i * 4 + 3];
      return out;
    }

    function rebuildMask() {
      if (!S.hasModel || S.busy) return;
      ensureMaskCanvas();
      S.busy = true;
      var W = S.maskSize, H = S.maskSize;
      try {
        var A = islandCoverage(W, H);
        var V = (S.occlude && S.islands.length) ? visibilityCoverage(W, H) : null;
        var add = S.strokeDirty ? readAlpha(S.addCv) : null;
        var era = S.strokeDirty ? readAlpha(S.eraseCv) : null;
        var img = S.mctx.createImageData(W, H);
        var d = img.data;
        var covered = 0;
        for (var i = 0; i < W * H; i++) {
          var a = A[i];
          if (V) { var vv = V[i]; if (vv < a) a = vv; }
          if (add && add[i] > a) a = add[i];
          if (era && era[i]) { a -= era[i]; if (a < 0) a = 0; }
          if (a > 0) {
            covered++;
            d[i * 4] = 255;
            d[i * 4 + 1] = 255;
            d[i * 4 + 2] = 255;
            d[i * 4 + 3] = a;
          }
        }
        S.mctx.putImageData(img, 0, 0);
        S.coverage = covered / (W * H);
      } finally {
        S.busy = false;
      }
      renderPreview();
      updateBadge();
      if (S.live && S.target) commitTarget();
    }

    function renderPreview() {
      if (!S.previewEl) return;
      var ctx = S.previewEl.getContext('2d');
      var W = S.previewEl.width, H = S.previewEl.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#10151c';
      ctx.fillRect(0, 0, W, H);
      /* 棋盘底：透明区域和「被遮挡」区分开 */
      var step = 16;
      ctx.fillStyle = 'rgba(255,255,255,.045)';
      for (var y = 0; y < H; y += step) {
        for (var x = 0; x < W; x += step) {
          if (((x / step) + (y / step)) % 2 < 1) ctx.fillRect(x, y, step, step);
        }
      }
      if (S.maskCv) ctx.drawImage(S.maskCv, 0, 0, W, H);
      ctx.strokeStyle = 'rgba(111,216,255,.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    }

    /* ---------------- 笔刷 ---------------- */
    function paintAt(clientX, clientY, erase) {
      var hit = pick(clientX, clientY);
      if (!hit || !hit.uv) return false;
      var W = S.maskSize, H = S.maskSize;
      var cv = erase ? S.eraseCv : S.addCv;
      var x = hit.uv.x * W;
      var y = (1 - hit.uv.y) * H;
      var r = Math.max(1, S.brush.radius * (W / 1024));
      var flow = S.brush.flow;
      var ctx = cv.ctx;
      var g = ctx.createRadialGradient(x, y, r * 0.25, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,' + flow + ')');
      g.addColorStop(0.65, 'rgba(255,255,255,' + (flow * 0.6) + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      S.strokeDirty = true;
      scheduleMask(90);
      return true;
    }

    function pick(clientX, clientY) {
      if (!S.hasModel) return null;
      var rect = S.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      var ndc = new T.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      S.ray = S.ray || new T.Raycaster();
      S.ray.setFromCamera(ndc, S.camera);
      var meshes = S.meshes.map(function (r) { return r.mesh; });
      var hits = S.ray.intersectObjects(meshes, false);
      return hits.length ? hits[0] : null;
    }

    function updateBrushRing(ev) {
      var ring = el.brush;
      if (!ring) return;
      if (S.tool !== 'brush' && S.tool !== 'erase') { ring.hidden = true; return; }
      var rect = S.viewEl.getBoundingClientRect();
      var r = Math.max(6, S.brush.radius * (Math.min(rect.width, rect.height) / 1024) * 1.35);
      ring.hidden = false;
      ring.style.width = ring.style.height = (r * 2) + 'px';
      ring.style.left = (ev.clientX - rect.left) + 'px';
      ring.style.top = (ev.clientY - rect.top) + 'px';
    }

    /* ---------------- 交互 ---------------- */
    function setTool(t) {
      S.tool = t;
      el.tools.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('is-on', b.dataset.tool === t);
      });
      var orbit = t === 'orbit';
      S.controls.mouseButtons.LEFT = orbit ? T.MOUSE.ROTATE : null;
      S.controls.mouseButtons.RIGHT = orbit ? T.MOUSE.PAN : T.MOUSE.ROTATE;
      S.canvas.style.cursor = orbit ? 'grab' : (t === 'brush' || t === 'erase') ? 'crosshair' : 'pointer';
      if (!orbit) el.brush.hidden = true;
      updateBadge();
    }

    function toggleIslandAt(ev) {
      var hit = pick(ev.clientX, ev.clientY);
      if (!hit || !hit.object || !hit.object.userData.ps3d) {
        api.note && api.note('没点到模型表面', false);
        return false;
      }
      var rec = hit.object.userData.ps3d;
      var face = hit.faceIndex | 0;
      var local = rec.info.idOf[face];
      if (local == null || local < 0) return false;
      var id = rec.base + local;
      if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
      syncSelTexture();
      rebuildSelectionOverlay();
      renderIslandList();
      scheduleMask(0);
      return true;
    }

    function selectIsland(id, on) {
      id = Number(id);
      if (on === undefined) on = !S.selected.has(id);
      if (on) S.selected.add(id); else S.selected.delete(id);
      syncSelTexture();
      rebuildSelectionOverlay();
      renderIslandList();
      scheduleMask(0);
      return S.selected.has(id);
    }

    function selectAll(on) {
      S.selected.clear();
      if (on) S.islands.forEach(function (isl) { S.selected.add(isl.id); });
      syncSelTexture();
      rebuildSelectionOverlay();
      renderIslandList();
      scheduleMask(0);
    }

    function bindUI() {
      host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var act = btn.dataset.act;
          if (act === 'load') el.file.click();
          else if (act === 'demo') loadDemo();
          else if (act === 'commit') commit();
          else if (act === 'group') addMaskGroup();
          else if (act === 'all') selectAll(true);
          else if (act === 'none') selectAll(false);
          else if (act === 'clearMask') {
            resetBrushCanvases();
            S.strokeDirty = false;
            scheduleMask(0);
          }
        });
      });

      el.file.addEventListener('change', function () {
        var f = el.file.files && el.file.files[0];
        el.file.value = '';
        if (f) loadFile(f);
      });

      el.tools.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () { setTool(b.dataset.tool); });
      });

      el.occ.addEventListener('change', function () { setOcclude(el.occ.checked); });
      el.live.addEventListener('change', function () { S.live = !!el.live.checked; });

      /* 两个浮层只是遮挡视口，收起后模型看得更全；状态不改遮罩 */
      el.showIslands.addEventListener('change', function () {
        el.islandPanel.classList.toggle('hidden', !el.showIslands.checked);
      });
      el.showMask.addEventListener('change', function () {
        el.maskPanel.classList.toggle('hidden', !el.showMask.checked);
      });

      el.size.addEventListener('change', function () {
        setMaskSize(Number(el.size.value) || 1024);
      });

      el.commitKind.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          S.commitKind = b.dataset.kind;
          el.commitKind.querySelectorAll('button').forEach(function (x) {
            x.classList.toggle('is-on', x === b);
          });
        });
      });

      el.islandList.addEventListener('click', function (ev) {
        var row = ev.target.closest ? ev.target.closest('[data-island]') : null;
        if (!row) return;
        selectIsland(Number(row.dataset.island));
      });

      el.brushSize.addEventListener('input', function () {
        S.brush.radius = Number(el.brushSize.value) || 44;
        el.brushVal.textContent = S.brush.radius;
      });
      el.brushFlow.addEventListener('input', function () {
        S.brush.flow = clamp((Number(el.brushFlow.value) || 85) / 100, 0.1, 1);
        el.brushFlowVal.textContent = el.brushFlow.value;
      });

      /* 画布：点岛 / 笔刷 */
      S.canvas.addEventListener('pointerdown', function (ev) {
        if (!S.hasModel) return;
        if (ev.button === 2) return;
        if (S.tool === 'island') { toggleIslandAt(ev); return; }
        if (S.tool !== 'brush' && S.tool !== 'erase') return;
        ev.preventDefault();
        S.canvas.setPointerCapture && S.canvas.setPointerCapture(ev.pointerId);
        S.stroke = { erase: S.tool === 'erase' };
        paintAt(ev.clientX, ev.clientY, S.stroke.erase);
      });
      S.canvas.addEventListener('pointermove', function (ev) {
        updateBrushRing(ev);
        if (!S.stroke) return;
        paintAt(ev.clientX, ev.clientY, S.stroke.erase);
      });
      S.canvas.addEventListener('pointerup', function () {
        S.stroke = null;
        scheduleMask(0);
      });
      S.canvas.addEventListener('pointerleave', function () { el.brush.hidden = true; });

      /* 拖入模型 */
      ['dragenter', 'dragover'].forEach(function (type) {
        S.viewEl.addEventListener(type, function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          S.viewEl.classList.add('is-drop');
        });
      });
      S.viewEl.addEventListener('dragleave', function (ev) {
        ev.stopPropagation();
        S.viewEl.classList.remove('is-drop');
      });
      S.viewEl.addEventListener('drop', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        S.viewEl.classList.remove('is-drop');
        var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f) loadFile(f);
      });
    }

    /* ---------------- 文件加载 ---------------- */
    function loadFile(file) {
      var name = file.name || '模型';
      var lower = name.toLowerCase();
      var url = URL.createObjectURL(file);
      api.note && api.note('正在载入 ' + name + ' …', false);
      var done = function (obj, label) {
        URL.revokeObjectURL(url);
        el.hint.hidden = true;
        el.hint.classList.remove('is-err');
        var ok = setModel(obj, label || name);
        api.note && api.note(ok ? ('已载入 ' + (label || name) + ' · ' + S.stats.tris + ' 面 · ' + S.islands.length + ' 个 UV 岛')
          : '模型没有可用 UV，无法生成遮罩', !ok);
        return ok;
      };
      if (/\.(glb|gltf)$/.test(lower) && global.THREE.GLTFLoader) {
        return new Promise(function (resolve) {
          new T.GLTFLoader().load(url, function (gltf) {
            resolve(done(gltf.scene, name));
          }, undefined, function (err) {
            URL.revokeObjectURL(url);
            api.note && api.note('载入失败：' + ((err && err.message) || name), true);
            resolve(false);
          });
        });
      }
      if (/\.obj$/.test(lower) && T.OBJLoader) {
        return new Promise(function (resolve) {
          new T.OBJLoader().load(url, function (obj) {
            resolve(done(obj, name));
          }, undefined, function (err) {
            URL.revokeObjectURL(url);
            api.note && api.note('载入失败：' + ((err && err.message) || name), true);
            resolve(false);
          });
        });
      }
      URL.revokeObjectURL(url);
      api.note && api.note('只支持 .glb / .gltf / .obj', true);
      return Promise.resolve(false);
    }

    function loadDemo() {
      var T2 = global.THREE;
      var mesh = new T2.Mesh(demoGeometry(), new T2.MeshStandardMaterial({ color: 0xffffff }));
      var group = new T2.Group();
      group.add(mesh);
      var ok = setModel(group, '示例模型 · 折叠面板');
      api.note && api.note(ok ? ('示例模型已载入：' + S.islands.length + ' 个 UV 岛，旋转视角看遮挡变化')
        : '示例模型载入失败', !ok);
      return ok;
    }

    /* ---------------- 按当前视角正交投影：每个可见 UV 岛一个图层 ----------------
     * 和「生成遮罩」的区别：
     *   · 生成遮罩——结果落在 UV 空间，一张图，适合继续在 3D 里改；
     *   · 添加遮罩——沿当前相机方向做正交投影，每个可见岛投到文档平面，
     *     一个岛一个图层 + 一张岛形蒙版，之后到位图模式逐层绘制。
     *
     * 遮挡仍然靠深度：先画全模型写深度，再画岛号颜色，读回最前面的岛 id。
     * 岛号编码成三通道（每通道 64 级、留半级余量），避免量化误差把 1 读成 0。 */
    function addMaskGroup() {
      S.groupError = '';
      if (!S.hasModel || !S.meshes.length) {
        S.groupError = 'no-model';
        api.note && api.note('先载入一个带 UV 的模型', true);
        return false;
      }
      var doc = api.getDoc && api.getDoc();
      if (!doc || !doc.width || !doc.height) {
        S.groupError = 'no-doc';
        api.note && api.note('先打开一个文档，再添加 UV 岛遮罩组', true);
        return false;
      }
      if (S.pendingMask) { clearTimeout(S.pendingMask); S.pendingMask = 0; rebuildMask(); }

      var T = global.THREE;
      var maxSide = 1600;
      var fp = Math.min(1, maxSide / Math.max(doc.width, doc.height));
      var PW = Math.max(64, Math.round(doc.width * fp));
      var PH = Math.max(64, Math.round(doc.height * fp));

      /* 正交相机：方向沿用当前视角，按模型包围球取景，长宽比跟文档一致 */
      var target = S.controls.target.clone();
      var dir = S.camera.position.clone().sub(target);
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
      dir.normalize();
      var box = new T.Box3().setFromObject(S.root);
      if (box.isEmpty()) { S.groupError = 'empty-box'; api.note && api.note('模型包围盒为空，无法投影', true); return false; }
      var sphere = box.getBoundingSphere(new T.Sphere());
      var r = Math.max(0.01, sphere.radius * 1.03);
      var aspect = PW / PH;
      var halfH = r, halfW = r * aspect;
      if (halfW < r) { halfW = r; halfH = r / aspect; }
      var cam = new T.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 1000);
      cam.position.copy(sphere.center).addScaledVector(dir, 5);
      cam.up.copy(S.camera.up);
      cam.lookAt(sphere.center);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);

      if (!S.projMat) {
        S.projMat = new T.ShaderMaterial({
          vertexShader: [
            'attribute float aIsland;',
            'varying float vId;',
            'void main(){',
            '  vId = aIsland;',
            '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
            '}'
          ].join('\n'),
          fragmentShader: [
            'varying float vId;',
            'void main(){',
            '  float id = vId + 1.0;',
            '  float r = mod(id, 64.0);',
            '  float g = mod(floor(id / 64.0), 64.0);',
            '  float b = mod(floor(id / 4096.0), 64.0);',
            '  gl_FragColor = vec4((r + 0.5) / 64.0, (g + 0.5) / 64.0, (b + 0.5) / 64.0, 1.0);',
            '}'
          ].join('\n'),
          side: T.DoubleSide
        });
      }
      if (!S.projRT || S.projRT.width !== PW || S.projRT.height !== PH) {
        if (S.projRT) S.projRT.dispose();
        S.projRT = new T.WebGLRenderTarget(PW, PH, {
          minFilter: T.NearestFilter, magFilter: T.NearestFilter,
          format: T.RGBAFormat, type: T.UnsignedByteType
        });
      }
      if (!S.projBuf || S.projBuf.length !== PW * PH * 4) S.projBuf = new Uint8Array(PW * PH * 4);

      var renderer = S.renderer;
      var prevRT = renderer.getRenderTarget();
      var prevClear = renderer.getClearColor(new T.Color());
      var prevAlpha = renderer.getClearAlpha();
      var prevAuto = renderer.autoClear;
      var prevBg = S.scene.background;

      /* 隐藏网格 / 岛接缝 / 已选高亮：投影里只要模型本体 */
      var hidden = [];
      if (S.grid && S.grid.visible) { hidden.push(S.grid); S.grid.visible = false; }
      var skip = new Set();
      var entries = [];
      S.meshes.forEach(function (rec) {
        if (rec.line) { skip.add(rec.line); if (rec.line.visible) { hidden.push(rec.line); rec.line.visible = false; } }
        /* 已选高亮是覆盖在模型上的第二层网格，不隐藏会挡住岛号颜色 */
        if (rec.selMesh) {
          skip.add(rec.selMesh);
          if (rec.selMesh.visible) { hidden.push(rec.selMesh); rec.selMesh.visible = false; }
        }
      });
      S.root.traverse(function (o) {
        if (!o.isMesh || skip.has(o)) return;
        entries.push({ mesh: o, painted: !!(o.geometry && o.geometry.attributes && o.geometry.attributes.aIsland), mat: o.material });
      });

      try {
        renderer.autoClear = false;
        /* 背景色会铺满整张 RT，把岛号颜色盖掉，投影期间必须关掉 */
        S.scene.background = null;
        renderer.setRenderTarget(S.projRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        /* 1) 全模型深度 */
        entries.forEach(function (e) { e.mesh.material = S.depthMat; });
        renderer.render(S.scene, cam);
        /* 2) 只清颜色，保留深度；带 UV 的网格画岛号 */
        renderer.clear(true, false, false);
        entries.forEach(function (e) { e.mesh.material = e.painted ? S.projMat : S.depthMat; });
        renderer.render(S.scene, cam);
        renderer.readRenderTargetPixels(S.projRT, 0, 0, PW, PH, S.projBuf);
      } catch (err) {
        S.groupError = 'render: ' + (err && err.message);
        api.note && api.note('正交投影失败：' + (err && err.message), true);
        return false;
      } finally {
        entries.forEach(function (e) { e.mesh.material = e.mat; });
        hidden.forEach(function (o) { o.visible = true; });
        S.scene.background = prevBg;
        renderer.setRenderTarget(prevRT);
        renderer.setClearColor(prevClear, prevAlpha);
        renderer.autoClear = prevAuto;
      }

      /* 解码岛号 + 统计每岛的屏幕包围盒 */
      var n = S.islands.length;
      var buf = S.projBuf;
      var bb = new Int32Array(n * 4);
      var cnt = new Int32Array(n);
      for (var i = 0; i < n; i++) { bb[i * 4] = PW; bb[i * 4 + 1] = PH; bb[i * 4 + 2] = -1; bb[i * 4 + 3] = -1; }
      var ids = new Int32Array(PW * PH);
      var lvl = function (c) { return Math.round(c / 255 * 64 - 0.5); };
      for (var py = 0; py < PH; py++) {
        var sy = PH - 1 - py;
        for (var px = 0; px < PW; px++) {
          var o = (py * PW + px) * 4;
          if (!buf[o + 3]) continue;
          var id = lvl(buf[o]) + lvl(buf[o + 1]) * 64 + lvl(buf[o + 2]) * 4096 - 1;
          if (id < 0 || id >= n) continue;
          ids[sy * PW + px] = id + 1;
          cnt[id]++;
          var q = id * 4;
          if (px < bb[q]) bb[q] = px;
          if (sy < bb[q + 1]) bb[q + 1] = sy;
          if (px > bb[q + 2]) bb[q + 2] = px;
          if (sy > bb[q + 3]) bb[q + 3] = sy;
        }
      }

      var sx = doc.width / PW, syy = doc.height / PH;
      var items = [];
      for (var isl = 0; isl < n; isl++) {
        if (cnt[isl] < 4) continue;
        var x0 = Math.max(0, bb[isl * 4] - 1), y0 = Math.max(0, bb[isl * 4 + 1] - 1);
        var x1 = Math.min(PW - 1, bb[isl * 4 + 2] + 1), y1 = Math.min(PH - 1, bb[isl * 4 + 3] + 1);
        var mw = x1 - x0 + 1, mh = y1 - y0 + 1;
        if (mw < 2 || mh < 2) continue;
        /* 1px 膨胀：补掉光栅化在轮廓上留下的细缝，免得画笔漏出去 */
        var a0 = new Uint8Array(mw * mh);
        for (var yy = 0; yy < mh; yy++) {
          for (var xx = 0; xx < mw; xx++) {
            if (ids[(y0 + yy) * PW + (x0 + xx)] === isl + 1) a0[yy * mw + xx] = 1;
          }
        }
        var a1 = a0.slice();
        for (var vy = 0; vy < mh; vy++) {
          for (var vx = 0; vx < mw; vx++) {
            if (a0[vy * mw + vx]) continue;
            if ((vx > 0 && a0[vy * mw + vx - 1]) || (vx + 1 < mw && a0[vy * mw + vx + 1]) ||
                (vy > 0 && a0[(vy - 1) * mw + vx]) || (vy + 1 < mh && a0[(vy + 1) * mw + vx])) {
              a1[vy * mw + vx] = 1;
            }
          }
        }
        var cv = document.createElement('canvas');
        cv.width = mw; cv.height = mh;
        var cx = cv.getContext('2d');
        var img = cx.createImageData(mw, mh);
        var d = img.data;
        for (var k = 0; k < a1.length; k++) {
          if (!a1[k]) continue;
          var od = k * 4;
          d[od] = 255; d[od + 1] = 255; d[od + 2] = 255; d[od + 3] = 255;
        }
        cx.putImageData(img, 0, 0);

        var dx = Math.max(0, Math.min(doc.width - 1, Math.round(x0 * sx)));
        var dy = Math.max(0, Math.min(doc.height - 1, Math.round(y0 * syy)));
        var dw = Math.max(1, Math.min(doc.width - dx, Math.round(mw * sx)));
        var dh = Math.max(1, Math.min(doc.height - dy, Math.round(mh * syy)));
        items.push({
          name: 'UV 岛 ' + (isl + 1),
          x: dx, y: dy, w: dw, h: dh,
          mask: cv
        });
      }

      if (!items.length) {
        var nz = 0, idMin = 1e9, idMax = -1;
        for (var bi = 0; bi < buf.length; bi += 4) {
          if (!buf[bi + 3]) continue;
          nz++;
          var bid = lvl(buf[bi]) + lvl(buf[bi + 1]) * 64 + lvl(buf[bi + 2]) * 4096 - 1;
          if (bid < idMin) idMin = bid;
          if (bid > idMax) idMax = bid;
        }
        var painted = 0;
        entries.forEach(function (e) { if (e.painted) painted++; });
        S.groupError = 'no-visible-island; entries=' + entries.length + ' painted=' + painted +
          ' nz=' + nz + ' ids=' + idMin + '..' + idMax + ' n=' + n +
          ' cam=' + cam.position.toArray().map(function (v) { return v.toFixed(2); }).join(',') +
          ' r=' + r.toFixed(2);
        api.note && api.note('当前视角没有可见的 UV 岛，转一下模型再试', true);
        return false;
      }
      var name = '3D 遮罩 · ' + (S.stats.name || '模型') + ' · ' + items.length + ' 岛';
      var gid = api.commitGroup && api.commitGroup(items, { name: name });
      if (!gid) {
        S.groupError = 'commit-failed: items=' + items.length + ' hasApi=' + !!api.commitGroup;
        api.note && api.note('未能写入文档：请确认已打开图像文档', true);
        return false;
      }
      api.note && api.note('已添加遮罩组「' + name + '」：每个岛一个图层 + 蒙版，按 F2 到位图即可逐层绘制');
      return true;
    }

    /* ---------------- 参数 ---------------- */
    function setOcclude(on) {
      S.occlude = !!on;
      if (el.occ) el.occ.checked = S.occlude;
      scheduleMask(0);
      updateBadge();
      return S.occlude;
    }

    function setMaskSize(n) {
      n = Math.round(n) || 1024;
      if (n < 256) n = 256;
      if (n > 2048) n = 2048;
      S.maskSize = n;
      S.viewSize = Math.min(1024, Math.max(512, n));
      S.maskCv = document.createElement('canvas');
      S.maskCv.width = n;
      S.maskCv.height = n;
      S.mctx = S.maskCv.getContext('2d');
      S.islandCv = makeCanvas(n, n);
      resetBrushCanvases();
      S.strokeDirty = false;
      if (el.size) el.size.value = String(n);
      scheduleMask(0);
      return n;
    }

    /* ---------------- 提交到 2D 文档 ---------------- */
    function commit() {
      if (!S.hasModel) {
        api.note && api.note('先载入一个模型，再生成遮罩', true);
        return false;
      }
      if (!S.coverage) {
        api.note && api.note('当前遮罩是空的：先选 UV 岛或画几笔', true);
        return false;
      }
      if (S.pendingMask) {
        clearTimeout(S.pendingMask);
        S.pendingMask = 0;
        rebuildMask();
      }
      S.target = {
        kind: S.commitKind,
        name: '3D 遮罩 · ' + (S.stats.name || '模型'),
        layerId: S.target && S.target.kind === S.commitKind ? S.target.layerId : null
      };
      commitTarget();
      return true;
    }

    function commitTarget() {
      if (!S.target || !api) return;
      if (S.target.kind === 'layer') {
        var id = api.commitLayer && api.commitLayer(S.maskCv, {
          name: S.target.name, layerId: S.target.layerId
        });
        if (id) S.target.layerId = id;
      } else {
        var lid = api.applyMask && api.applyMask(S.maskCv, {
          layerId: S.target.layerId
        });
        if (lid) S.target.layerId = lid;
      }
      updateTargetInfo();
    }

    /* ---------------- 面板渲染 ---------------- */
    function renderIslandList() {
      if (!el.islandList) return;
      if (!S.islands.length) {
        el.islandList.innerHTML = '<div class="ps3d-empty">载入模型后，这里按 UV 岛分组</div>';
        if (el.islandCount) el.islandCount.textContent = '0';
        return;
      }
      var rows = '';
      var max = Math.min(S.islands.length, 400);
      for (var i = 0; i < max; i++) {
        var isl = S.islands[i];
        var b = isl.bounds;
        var on = S.selected.has(isl.id);
        rows += '<button type="button" class="ps3d-island' + (on ? ' is-on' : '') + '" data-island="' + isl.id + '">' +
          '<i class="ps3d-dot" style="background:' + isl.hex + '"></i>' +
          '<span class="ps3d-isl-name">岛 ' + (isl.id + 1) + '</span>' +
          '<span class="ps3d-isl-meta">' + isl.tris.length + ' 面</span>' +
          '<span class="ps3d-isl-uv">' + b.u0.toFixed(2) + ',' + b.v0.toFixed(2) + '</span>' +
        '</button>';
      }
      if (S.islands.length > max) {
        rows += '<div class="ps3d-empty">还有 ' + (S.islands.length - max) + ' 个岛未列出</div>';
      }
      el.islandList.innerHTML = rows;
      if (el.islandCount) el.islandCount.textContent = S.selected.size + ' / ' + S.islands.length;
    }

    function updateInfo() {
      if (!el.info) return;
      if (!S.hasModel) { el.info.textContent = '未载入模型'; return; }
      el.info.innerHTML =
        '<div>模型：' + S.stats.name + '</div>' +
        '<div>网格：' + S.stats.meshes + ' 个 · ' + S.stats.tris + ' 面</div>' +
        '<div>UV 岛：' + S.islands.length + ' 个' + (S.stats.skipped ? ' · 跳过 ' + S.stats.skipped + ' 个无 UV 网格' : '') + '</div>' +
        '<div>已选：' + S.selected.size + ' 个岛</div>';
    }

    function updateTargetInfo() {
      if (!el.target) return;
      if (!S.target) { el.target.textContent = '尚未生成'; return; }
      var kind = S.target.kind === 'layer' ? '遮罩图层' : '图层蒙版';
      el.target.innerHTML = '<div>类型：' + kind + '</div>' +
        '<div>状态：' + (S.live ? '动态更新中' : '仅生成时更新') + '</div>' +
        '<div>图层：' + (S.target.layerId || '—') + '</div>';
    }

    function updateBadge() {
      var badge = el.badge;
      if (!badge) return;
      if (!S.hasModel) { badge.textContent = ''; return; }
      var pct = (S.coverage * 100).toFixed(1) + '%';
      badge.textContent = '遮罩 ' + pct + ' · 已选 ' + S.selected.size + '/' + S.islands.length +
        ' 岛 · ' + (S.occlude ? '遮挡剔除开' : '遮挡剔除关') + ' · ' + toolName(S.tool);
      if (el.maskStat) el.maskStat.textContent = pct;
    }

    function toolName(t) {
      return t === 'orbit' ? '环绕' : t === 'brush' ? '遮罩笔刷' : t === 'erase' ? '擦除' : 'UV岛';
    }

    /* ---------------- 对外接口 ---------------- */
    function debug() {
      return {
        ready: S.hasModel,
        meshes: S.stats.meshes,
        tris: S.stats.tris,
        skipped: S.stats.skipped,
        name: S.stats.name,
        islands: S.islands.length,
        selected: Array.from(S.selected),
        occlude: S.occlude,
        live: S.live,
        tool: S.tool,
        maskSize: S.maskSize,
        coverage: S.coverage,
        stroke: !!S.strokeDirty,
        target: S.target ? { kind: S.target.kind, layerId: S.target.layerId } : null,
        groupError: S.groupError
      };
    }

    function apiStub() {
      var noop = function () { return null; };
      return {
        enter: noop, leave: noop, dispose: noop,
        loadDemo: function () { return false; },
        loadFile: function () { return Promise.resolve(false); },
        debug: debug, islands: function () { return []; },
        selectIsland: noop, selectAll: noop,
        setTool: noop, setOcclude: noop, setMaskSize: noop,
        setCommitKind: function () { return 'layer'; },
        rebuild: noop, commit: function () { return false; },
        addMaskGroup: function () { return false; },
        maskCanvas: function () { return null; },
        orbit: noop
      };
    }

    setTool('island');
    S.controls.mouseButtons.LEFT = null;
    S.controls.mouseButtons.RIGHT = T.MOUSE.ROTATE;

    return {
      enter: enter,
      leave: leave,
      dispose: function () { leave(); if (S.renderer) S.renderer.dispose(); },
      loadDemo: loadDemo,
      loadFile: loadFile,
      debug: debug,
      islands: function () {
        return S.islands.map(function (isl) {
          return { id: isl.id, tris: isl.tris.length, hex: isl.hex, selected: S.selected.has(isl.id) };
        });
      },
      selectIsland: selectIsland,
      selectAll: selectAll,
      setTool: setTool,
      setOcclude: setOcclude,
      setMaskSize: setMaskSize,
      setCommitKind: function (kind) {
        S.commitKind = kind === 'mask' ? 'mask' : 'layer';
        if (el.commitKind) {
          el.commitKind.querySelectorAll('button').forEach(function (b) {
            b.classList.toggle('is-on', b.dataset.kind === S.commitKind);
          });
        }
        return S.commitKind;
      },
      rebuild: function () { rebuildMask(); return S.coverage; },
      commit: commit,
      addMaskGroup: addMaskGroup,
      maskCanvas: function () { return S.maskCv; },
      orbit: function (dx, dy) {
        if (!S.hasModel) return false;
        var off = S.camera.position.clone().sub(S.controls.target);
        var sph = new T.Spherical().setFromVector3(off);
        sph.theta += Number(dx) || 0;
        sph.phi = clamp(sph.phi + (Number(dy) || 0), 0.05, Math.PI - 0.05);
        S.camera.position.copy(S.controls.target).add(new T.Vector3().setFromSpherical(sph));
        S.controls.update();
        return true;
      }
    };
  }

  global.PS3D = { create: create };
})(window);
