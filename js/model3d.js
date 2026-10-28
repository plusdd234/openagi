/* ============================================================
 * 3D 模块：模型加载 / 交互预览 / 四视图导出
 *
 * 依赖（均为本地 vendor，UMD 全局 THREE，file:// 可用）：
 *   vendor/three.min.js      three.js r149 (MIT)
 *   vendor/GLTFLoader.js     GLB / glTF
 *   vendor/OBJLoader.js      OBJ
 *   vendor/OrbitControls.js  轨道操控
 *
 * 四视图算法参考「自研贴图系统 · AIGC工具包」web/main.js（MIT）：
 *   - 正交相机 ×4（前/后/左/右），共用同一世界尺度 L，视锥正方形 → 绝不拉伸
 *   - scissor + viewport 单次 clear、四次 render（GL 原点在左下，需翻 Y）
 *   - 重心坐标(barycentric)线框 shader：线宽单位为像素，与分辨率解耦
 *   - 实体面 polygonOffset 后退 + 线框写真实深度 = 天然隐藏线消除
 *
 * 对外接口（全局 Model3D）：
 *   Model3D.ready()                      是否具备 three.js
 *   Model3D.load(src)                    加载模型 → {root,ext,center,radius}
 *   Model3D.quadViews(src, opts)         渲染四视图 → PNG dataURL
 *   Model3D.openPreview(src, opts)       打开交互预览弹窗
 *   Model3D.closePreview()
 * ============================================================ */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var QUAD_DIRS = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0]]; // 视线方向：相机 -> 目标
  var QUAD_NAMES = ['front', 'back', 'left', 'right'];

  function clampNum(v, lo, hi) { v = Number(v); if (!isFinite(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }
  function evenInt(v) { v = Math.round(Number(v) || 0); return v % 2 ? v - 1 : v; }
  function ready() { return !!(THREE && THREE.GLTFLoader && THREE.OBJLoader); }

  /* ---------------- 模型字节获取 ---------------- */
  // 远端地址优先直连；失败则走本地中转（relay.js 通用代理，带 X-Relay-Target 头）绕过 CORS
  async function fetchBytes(src) {
    if (!src) throw new Error('缺少模型地址');
    if (/^data:/i.test(src)) {
      var r0 = await fetch(src);
      return new Uint8Array(await r0.arrayBuffer());
    }
    try {
      var r1 = await fetch(src, { mode: 'cors' });
      if (r1.ok) return new Uint8Array(await r1.arrayBuffer());
    } catch (e) { /* 落到中转 */ }

    var base = 'http://127.0.0.1:8787';
    try {
      if (typeof global.relayEnabled === 'function' && global.relayEnabled() &&
          typeof global.relayBase === 'function') base = global.relayBase();
    } catch (e) { /* 用默认端口 */ }

    var r2 = await fetch(base, { headers: { 'X-Relay-Target': src } });
    if (!r2.ok) throw new Error('模型下载失败（HTTP ' + r2.status + '）。跨域地址请启动项目（桌面端双击 start.bat）');
    return new Uint8Array(await r2.arrayBuffer());
  }

  function sniffGLB(buf) {
    return buf.length >= 4 && buf[0] === 0x67 && buf[1] === 0x6c && buf[2] === 0x54 && buf[3] === 0x46; // 'glTF'
  }

  function parseGLTF(loader, data, path) {
    return new Promise(function (resolve, reject) {
      loader.parse(data, path || '', function (g) { resolve(g.scene || (g.scenes && g.scenes[0])); }, reject);
    });
  }

  // 加载并归一化（返回包围盒信息，不平移几何，只记录中心用于取景）
  async function load(src) {
    if (!ready()) throw new Error('three.js 未就绪');
    var buf = await fetchBytes(src);
    var obj = null;

    if (sniffGLB(buf)) {
      obj = await parseGLTF(new THREE.GLTFLoader(), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } else {
      var text = new TextDecoder('utf-8').decode(buf);
      var t = text.replace(/^\s+/, '');
      if (t.charAt(0) === '{') obj = await parseGLTF(new THREE.GLTFLoader(), text);
      else obj = new THREE.OBJLoader().parse(text);
    }
    if (!obj) throw new Error('模型解析结果为空');

    obj.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) throw new Error('模型包围盒为空，可能没有有效网格');
    var ext = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());
    return { root: obj, box: box, ext: ext, center: center, radius: Math.max(ext.length() / 2, 1e-6) };
  }

  /* ---------------- 线框：重心坐标 shader ---------------- */
  function baryGeometry(geo) {
    var ni = geo.index ? geo.toNonIndexed() : geo;
    var cnt = ni.attributes.position.count;
    var bary = new Float32Array(cnt * 3);
    for (var i = 0; i < cnt; i += 3) {
      bary[i * 3] = 1; bary[i * 3 + 1] = 0; bary[i * 3 + 2] = 0;
      bary[i * 3 + 3] = 0; bary[i * 3 + 4] = 1; bary[i * 3 + 5] = 0;
      bary[i * 3 + 6] = 0; bary[i * 3 + 7] = 0; bary[i * 3 + 8] = 1;
    }
    ni.setAttribute('bary', new THREE.BufferAttribute(bary, 3));
    return ni;
  }

  function wireMaterial(lineWidth, color) {
    return new THREE.ShaderMaterial({
      uniforms: {
        lineColor: { value: new THREE.Color(color || '#2b2b2b') },
        lineWidth: { value: lineWidth || 1.4 }
      },
      vertexShader: [
        'attribute vec3 bary;',
        'varying vec3 vB;',
        'void main(){ vB = bary; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 lineColor;',
        'uniform float lineWidth;',
        'varying vec3 vB;',
        'void main(){',
        '  vec3 d = fwidth(vB);',
        '  d = max(d, vec3(1e-6));',
        '  float hw = lineWidth * 0.5 + 0.25;',
        '  vec3 f = smoothstep(vec3(0.0), d * hw, vB);',
        '  float e = 1.0 - min(min(f.x, f.y), f.z);',
        '  if(e < 0.02) discard;',
        '  gl_FragColor = vec4(lineColor, e);',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      extensions: { derivatives: true }
    });
  }

  function fillMaterial(color, opacity) {
    var op = opacity == null ? 1 : clampNum(opacity, 0, 1);
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(color || '#ffffff'),
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1.6,
      polygonOffsetUnits: 1.0,
      transparent: op < 1,
      opacity: op,
      depthWrite: true
    });
  }

  // 构建「实体面 + 线框」双 Pass 场景（隐藏线消除）
  function buildWireScene(model, opts) {
    var scene = new THREE.Scene();
    var fillMat = fillMaterial(opts.fillColor, opts.fillOpacity);
    var wireMat = wireMaterial(opts.lineWidth, opts.lineColor);
    var count = 0;

    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      var geo = o.geometry;
      var m = new THREE.Matrix4().copy(o.matrixWorld);

      var fill = new THREE.Mesh(geo, fillMat);
      fill.matrixAutoUpdate = false;
      fill.matrix.copy(m);
      scene.add(fill);

      if (opts.showWire !== false) {
        var wire = new THREE.Mesh(baryGeometry(geo), wireMat);
        wire.matrixAutoUpdate = false;
        wire.matrix.copy(m);
        scene.add(wire);
      }
      count++;
    });

    if (!count) throw new Error('模型中没有可渲染的网格');
    return { scene: scene, fillMat: fillMat, wireMat: wireMat };
  }

  /* ---------------- 四视图渲染 ---------------- */
  function quadCameras(model) {
    // 四格共用同一视锥边长 L（世界尺度一致 → 像素对齐、绝不拉伸）
    var L = Math.max(model.ext.x, model.ext.y, model.ext.z) * 1.0; // margin 固定 1
    var d = Math.max(model.radius * 4, 1e-3);
    return QUAD_DIRS.map(function (dir) {
      var c = new THREE.OrthographicCamera(-L / 2, L / 2, L / 2, -L / 2, 0.01, d * 4);
      c.position.set(model.center.x - dir[0] * d, model.center.y - dir[1] * d, model.center.z - dir[2] * d);
      c.up.set(0, 1, 0);
      c.lookAt(model.center);
      c.updateProjectionMatrix();
      return c;
    });
  }

  /**
   * 渲染 2×2 四视图拼图
   * @param {string} src  模型地址（data: / http(s) / 经中转）
   * @param {object} opts size(2048|4096) gap lineWidth lineColor fillColor fillOpacity bgColor bgOpacity mode('line'|'solid')
   * @returns {Promise<string>} PNG dataURL
   */
  async function quadViews(src, opts) {
    opts = opts || {};
    var model = await load(src);

    var size = Number(opts.size) === 4096 ? 4096 : 2048;
    var gap = evenInt(clampNum(opts.gap, 0, 256));
    var cell = (size - gap) / 2;                       // 网格正好铺满画布：2*cell+gap === size
    var mode = opts.mode === 'solid' ? 'solid' : 'line';
    var bgOpacity = opts.bgOpacity == null ? 1 : clampNum(opts.bgOpacity, 0, 1);

    // 线宽单位为像素，按单格尺寸等比放大，保证不同分辨率下观感一致
    var lw = clampNum(opts.lineWidth, 0.4, 6) || 1.4;
    var scale = Math.max(1, cell / 512);

    var ro = {
      lineWidth: lw * scale,
      lineColor: opts.lineColor || '#2b2b2b',
      fillColor: opts.fillColor || '#ffffff',
      fillOpacity: opts.fillOpacity == null ? 1 : clampNum(opts.fillOpacity, 0, 1),
      showWire: mode === 'line'
    };

    var canvas = document.createElement('canvas');
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.debug.checkShaderErrors = false;
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);

    var built = buildWireScene(model, ro);
    var cams = quadCameras(model);

    renderer.setClearColor(new THREE.Color(opts.bgColor || '#ffffff'), bgOpacity);
    renderer.setScissorTest(false);
    renderer.clear(true, true, true);
    renderer.autoClear = false;                        // 关键：否则第二格会擦掉第一格

    for (var i = 0; i < 4; i++) {
      var x = (i & 1) * (cell + gap);
      var yTop = (i >> 1) * (cell + gap);
      var vy = size - (yTop + cell);                   // 关键：GL 视口原点在左下
      renderer.setViewport(x, vy, cell, cell);
      renderer.setScissor(x, vy, cell, cell);
      renderer.setScissorTest(true);
      renderer.render(built.scene, cams[i]);
    }

    var url;
    try {
      url = canvas.toDataURL('image/png');
    } catch (e) {
      renderer.dispose();
      throw new Error('导出失败：画布过大（' + size + '×' + size + '），请改用 2K');
    }
    renderer.dispose();
    return url;
  }

  /* ---------------- 交互预览 ---------------- */
  var pv = null; // 当前预览实例

  function closePreview() {
    if (!pv) return;
    cancelAnimationFrame(pv.raf);
    try { pv.controls && pv.controls.dispose && pv.controls.dispose(); } catch (e) {}
    try { pv.renderer.dispose(); } catch (e) {}
    if (pv.overlay && pv.overlay.parentNode) pv.overlay.parentNode.removeChild(pv.overlay);
    pv = null;
  }

  async function openPreview(src, opts) {
    opts = opts || {};
    if (!ready()) throw new Error('three.js 未就绪');
    closePreview();

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(6,7,10,.86);' +
      'display:flex;align-items:center;justify-content:center;padding:24px;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#e8eaf0;';

    var panel = document.createElement('div');
    panel.style.cssText = 'width:min(1100px,96vw);height:min(760px,92vh);background:#111318;border:1px solid #23262e;' +
      'border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.5);';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #23262e;flex:0 0 auto;';
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    title.textContent = opts.title || '3D 预览';
    head.appendChild(title);

    var stage = document.createElement('div');
    stage.style.cssText = 'flex:1;position:relative;background:#0a0b0e;min-height:0;';
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';
    stage.appendChild(canvas);

    var bar = document.createElement('div');
    bar.style.cssText = 'flex:0 0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 14px;border-top:1px solid #23262e;';

    var hint = document.createElement('span');
    hint.style.cssText = 'color:#8b90a0;font-size:12px;margin-right:auto;';
    hint.textContent = '拖拽旋转 · 滚轮缩放 · 右键平移';
    bar.appendChild(hint);

    function mkBtn(text, fn) {
      var b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'padding:6px 12px;border-radius:8px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;cursor:pointer;font-size:13px;';
      b.addEventListener('click', fn);
      return b;
    }

    var closeBtn = mkBtn('关闭', closePreview);
    head.appendChild(closeBtn);
    overlay.appendChild(panel);
    panel.appendChild(head);
    panel.appendChild(stage);
    panel.appendChild(bar);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closePreview(); });
    document.body.appendChild(overlay);

    hint.textContent = '正在加载模型…';

    var model;
    try {
      model = await load(src);
    } catch (e) {
      hint.textContent = '加载失败：' + (e && e.message);
      hint.style.color = '#e05252';
      throw e;
    }

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.debug.checkShaderErrors = false;
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));

    var scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0b0e');
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    var dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(1, 1.2, 1);
    scene.add(dir);

    var camera = new THREE.PerspectiveCamera(45, 1, 0.01, Math.max(model.radius * 200, 100));
    var d0 = model.radius * 3;
    camera.position.set(model.center.x + d0 * 0.6, model.center.y + d0 * 0.45, model.center.z + d0 * 0.9);

    var controls = new THREE.OrbitControls(camera, canvas);
    controls.target.copy(model.center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    var wireGroup = null, matGroup = null;
    matGroup = model.root;
    scene.add(matGroup);

    // 线框组（懒构建，切到线框模式时才生成）
    function ensureWire() {
      if (wireGroup) return wireGroup;
      wireGroup = new THREE.Group();
      var fillMat = fillMaterial('#ffffff', 1);
      var wireMat = wireMaterial(2.0, '#2b2b2b');
      model.root.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        var m = new THREE.Matrix4().copy(o.matrixWorld);
        var f = new THREE.Mesh(o.geometry, fillMat); f.matrixAutoUpdate = false; f.matrix.copy(m);
        var w = new THREE.Mesh(baryGeometry(o.geometry), wireMat); w.matrixAutoUpdate = false; w.matrix.copy(m);
        wireGroup.add(f); wireGroup.add(w);
      });
      return wireGroup;
    }

    var curMode = 'material';
    function setMode(m) {
      curMode = m;
      if (m === 'wire') {
        scene.remove(matGroup);
        scene.add(ensureWire());
        scene.background = new THREE.Color('#ffffff');
      } else {
        if (wireGroup) scene.remove(wireGroup);
        scene.add(matGroup);
        scene.background = new THREE.Color('#0a0b0e');
      }
    }

    bar.appendChild(mkBtn('实体 / 线框', function () { setMode(curMode === 'wire' ? 'material' : 'wire'); }));

    ['前', '后', '左', '右', '顶', '轴测'].forEach(function (label, i) {
      bar.appendChild(mkBtn(label, function () {
        var d = model.radius * 3;
        var p = [
          [0, 0, d], [0, 0, -d], [-d, 0, 0], [d, 0, 0], [0, d, 0], [d * 0.7, d * 0.5, d * 0.7]
        ][i];
        camera.position.set(model.center.x + p[0], model.center.y + p[1], model.center.z + p[2]);
        controls.target.copy(model.center);
        controls.update();
      }));
    });

    var exportBtn = mkBtn('导出四视图 2K', async function () {
      exportBtn.disabled = true;
      var old = exportBtn.textContent;
      exportBtn.textContent = '渲染中…';
      try {
        var url = await quadViews(src, { size: 2048, mode: 'line' });
        var a = document.createElement('a');
        a.href = url;
        a.download = 'model_quad_views_2k.png';
        a.click();
        hint.textContent = '四视图已导出';
      } catch (e) {
        hint.textContent = '导出失败：' + (e && e.message);
        hint.style.color = '#e05252';
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = old;
      }
    });
    bar.appendChild(exportBtn);

    hint.textContent = '拖拽旋转 · 滚轮缩放 · 右键平移';

    function resize() {
      var w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    var ro = new ResizeObserver(resize);
    ro.observe(stage);

    function tick() {
      pv.raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    }
    pv = { overlay: overlay, renderer: renderer, controls: controls, raf: 0, ro: ro };
    tick();

    return true;
  }

  /* ---------------- 缩略图 ----------------
   * 资产库的 3D 磁贴需要一张「一眼能认出这是什么模型」的图。
   * 没缩略图时卡片上只有 "GLB" 三个字母，跟 UE 那种网格缩略图完全不是一回事。
   *
   * 两个必须处理的细节：
   *   ① OBJ 没有材质信息，OBJLoader 出来是纯白，打光也看不出体积——统一补中性灰；
   *   ② 渲染完必须 dispose + forceContextLoss。不做的话导入十几个模型会攒十几个
   *      WebGL 上下文（浏览器上限通常 16 个），超过之后整个页面直接白屏。 */
  async function renderThumb(src, opts) {
    opts = opts || {};
    if (!ready()) throw new Error('three.js 未就绪');
    var size = Math.max(64, Math.min(512, Number(opts.size) || 256));
    var model = await load(src);

    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    // 环境光 + 主光 + 补光：只有环境光的话模型看起来像一张贴纸，没有立体感
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    var key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 1.5, 1.1);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-1.1, -0.5, -0.9);
    scene.add(fill);

    model.root.traverse(function (o) {
      if (!o.isMesh) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        if (!m) return;
        // 纯白 + 没有贴图 = 大概率是 OBJ 的默认材质，换成中性灰才看得出结构
        if (m.color && m.color.getHex && m.color.getHex() === 0xffffff && !m.map) {
          m.color.setHex(0xc3c9d4);
          if ('roughness' in m) m.roughness = Math.max(0.45, m.roughness);
        }
      });
    });
    scene.add(model.root);

    var r = Math.max(model.radius, 1e-4);
    var cam = new THREE.PerspectiveCamera(35, 1, r / 500, r * 40);
    var d = r * 3.1;
    // 轴测角度：比正视更容易看出体积，也是 UE 默认缩略图的角度
    cam.position.set(model.center.x + d * 0.66, model.center.y + d * 0.58, model.center.z + d * 0.8);
    cam.lookAt(model.center);

    renderer.render(scene, cam);
    var out = canvas.toDataURL('image/png');

    try { renderer.dispose(); } catch (e) {}
    try { renderer.forceContextLoss && renderer.forceContextLoss(); } catch (e) {}
    return { dataURL: out, width: size, height: size };
  }

  global.Model3D = {
    ready: ready,
    load: load,
    quadViews: quadViews,
    renderThumb: renderThumb,
    openPreview: openPreview,
    closePreview: closePreview,
    QUAD_NAMES: QUAD_NAMES
  };
})(window);
