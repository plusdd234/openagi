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
 *   Model3D.quadViews(src, opts)         渲染四视图 → PNG dataURL（viewGrid 的固定四格特例）
 *   Model3D.viewGrid(src, opts)          渲染任意视图网格 → 整图 + 逐格单图
 *   Model3D.VIEWS                        可用视图表（key → {dir,up,name}）
 *   Model3D.openPreview(src, opts)       打开交互预览弹窗
 *   Model3D.closePreview()
 * ============================================================ */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  // 四视图的名字只在导出里用到；方向表已经收进 VIEWS，不再单独维护一份
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

  /* ---------------- OBJ 原始多边形 ----------------
   * 为什么不用 OBJLoader 的结果画线框：
   *   它把每个面**三角化**，quad `f 1 2 3 4` 变成 (1,2,3)+(1,3,4)，那条 1-3 的对角线
   *   在几何上确实存在，但**它不是模型的边**——建模师看线框图时第一眼就会指出来。
   *   所以这里单独留一份原始面表，线框按它画；填充仍然用它三角化的结果（同一份顶点，
   *   面不会和线错位）。
   *
   * 只认 v / f 两种行。OBJ 的 v 是绝对坐标（格式不支持节点变换），
   * 所以解析出来的点可以直接用；外面的 matrixWorld 再补一次以防万一。
   */
  function parseObjPolys(text) {
    var verts = [];
    var polys = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln) continue;
      var c0 = ln.charCodeAt(0);
      if (c0 === 35) continue;                               // '#'
      var c1 = ln.charCodeAt(1);
      if (c1 !== 32 && c1 !== 9) continue;                    // 只处理 "v " / "f "（排除 vt/vn）

      if (c0 === 118) {                                       // 'v'
        var p = ln.trim().split(/\s+/);
        verts.push(Number(p[1]) || 0, Number(p[2]) || 0, Number(p[3]) || 0);
      } else if (c0 === 102) {                                // 'f'
        var q = ln.trim().split(/\s+/);
        var poly = [];
        for (var k = 1; k < q.length; k++) {
          var raw = q[k];
          if (!raw) continue;
          var idx = parseInt(String(raw).split('/')[0], 10);
          if (!isFinite(idx) || idx === 0) continue;
          // OBJ 索引 1-based；负数表示「从末尾数」
          var vi = idx > 0 ? idx - 1 : (verts.length / 3) + idx;
          poly.push(vi);
        }
        if (poly.length >= 3) polys.push(poly);
      }
    }
    return { verts: verts, polys: polys };
  }

  /* 把原始多边形三角化，同时在重心坐标里**屏蔽掉内部对角线**。
   *
   * 原理：bary 三分量各自负责一条边（某分量在边上恒为 0 → 该边显形）。
   * 把某个分量在三个顶点上都置 1，这条边就再也检测不到——等于隐去。
   *
   * 扇形三角化 (p0, pt, p(t+1))，t = 1..n-2：
   *   边 p0-pt   ：t >= 2 时是对角线
   *   边 pt-p(t+1)：永远是真实边
   *   边 p(t+1)-p0：t <= n-3 时是对角线（最后一条才是闭环边）
   *
   * quad 验证：t=1 屏蔽 p2-p0 → 只剩 p0-p1、p1-p2；
   *            t=2 屏蔽 p0-p2 → 只剩 p2-p3、p3-p0。
   *            合起来正好四条边，没有对角线。 ✓
   */
  function polyGeometry(poly, matrix) {
    var V = poly.verts, P = poly.polys;
    var pos = [];
    var bar = [];
    var v = new THREE.Vector3();

    function push(i) {
      v.set(V[i * 3] || 0, V[i * 3 + 1] || 0, V[i * 3 + 2] || 0);
      if (matrix) v.applyMatrix4(matrix);
      pos.push(v.x, v.y, v.z);
    }

    for (var f = 0; f < P.length; f++) {
      var p = P[f], n = p.length;
      if (n < 3) continue;
      for (var t = 1; t <= n - 2; t++) {
        push(p[0]); push(p[t]); push(p[t + 1]);
        var a = [1, 0, 0], b = [0, 1, 0], c = [0, 0, 1];
        if (t >= 2) { a[2] = 1; b[2] = 1; c[2] = 1; }        // 隐去 p0-pt
        if (t <= n - 3) { a[1] = 1; b[1] = 1; c[1] = 1; }    // 隐去 p(t+1)-p0
        bar.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      }
    }

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('bary', new THREE.Float32BufferAttribute(bar, 3));
    return g;
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
    var poly = null;
    var ext = '';

    if (sniffGLB(buf)) {
      ext = 'glb';
      obj = await parseGLTF(new THREE.GLTFLoader(), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } else {
      var text = new TextDecoder('utf-8').decode(buf);
      var t = text.replace(/^\s+/, '');
      if (t.charAt(0) === '{') {
        ext = 'gltf';
        obj = await parseGLTF(new THREE.GLTFLoader(), text);
      } else {
        ext = 'obj';
        obj = new THREE.OBJLoader().parse(text);
        /* 只有 OBJ 有「原始多边形」这回事——glTF 格式本身就只存三角形，
         * 解析出来能拿到什么就是什么，没有可恢复的四边面。 */
        try { poly = parseObjPolys(text); } catch (e) { poly = null; }
        if (poly && (!poly.polys.length || !poly.verts.length)) poly = null;
      }
    }
    if (!obj) throw new Error('模型解析结果为空');

    obj.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) throw new Error('模型包围盒为空，可能没有有效网格');
    var extSize = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());

    /* poly 是原始坐标，要跟 OBJLoader 出来的东西放进同一处世界空间。
     * OBJ 一般没有变换（matrixWorld = I），但真不是 I 时必须补上，否则线框会跟实体面错位。 */
    var polyMatrix = poly ? new THREE.Matrix4().copy(obj.matrixWorld) : null;

    return {
      root: obj, box: box, ext: extSize, center: center,
      radius: Math.max(extSize.length() / 2, 1e-6),
      poly: poly, polyMatrix: polyMatrix, format: ext
    };
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

  function wireMaterial(lineWidth, color, side) {
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
      /* 双面：手写 / 老旧软件导出的 OBJ 绕序经常不一致，FrontSide 会让整整一个视图
       * 变成空白（线被当背面剔除），用户以为是渲染坏了。
       * 隐藏线不会因此失效——填充先画且写深度，背面的线被 depthTest 挡掉。 */
      side: side == null ? THREE.DoubleSide : side,
      extensions: { derivatives: true }
    });
  }

  function fillMaterial(color, opacity) {
    var op = opacity == null ? 1 : clampNum(opacity, 0, 1);
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(color || '#ffffff'),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1.6,
      polygonOffsetUnits: 1.0,
      transparent: op < 1,
      opacity: op,
      depthWrite: true
    });
  }

  /* 把实体面往后推一点，给叠在上面的线框让出深度
   *
   * 为什么必须要这个：线框网格与实体面**顶点完全相同**，深度值也就完全相同，
   * 默认 depthFunc(LESS) 判不过 → 所有线都被自己的面挡掉，整张图一根线都不出来
   * （而且不报错，看起来像「线框开关坏了」）。polygonOffset 把面推后半步即可。 */
  function pushBackDepth(scene) {
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach(function (m) {
        if (!m) return;
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1.6;
        m.polygonOffsetUnits = 1.0;
        m.needsUpdate = true;
      });
    });
  }

  /* 往一个**已有实体**的场景里加一层线框（素模 / 材质模式下勾「线框」时用）。
   * 与 buildWireScene 的区别：这里不动填充材质，只在上面补线，
   * 所以「材质 + 线框」「素模 + 线框」才能成立（旧版只能二选一）。
   * 返回值同 buildWireScene.quad：是否用上了原始多边形（四边面）。 */
  function addWireOverlay(scene, model, opts) {
    var wireMat = wireMaterial(opts.lineWidth, opts.lineColor);
    pushBackDepth(scene);

    if (opts.quad !== false && model.poly && model.poly.polys.length) {
      var pg = polyGeometry(model.poly, model.polyMatrix);
      var pw = new THREE.Mesh(pg, wireMat);
      pw.frustumCulled = false;
      pw.renderOrder = 1;
      scene.add(pw);
      return true;
    }

    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      var w = new THREE.Mesh(baryGeometry(o.geometry), wireMat);
      w.matrixAutoUpdate = false;
      w.matrix.copy(o.matrixWorld);
      w.renderOrder = 1;
      scene.add(w);
    });
    return false;
  }

  /* 构建「实体面 + 线框」双 Pass 场景（隐藏线消除）
   *
   * opts.quad 三态：
   *   undefined / true → 有 OBJ 原始面就用它（四边面线框），否则退回三角线框
   *   false            → 强制三角线框（想看真实三角网格时用）
   *
   * 两种走法的**填充完全相同**，只是线的来源不同：一份来自原始多边形，
   * 一份来自 mesh 的三角几何。所以切「四边面 / 三角」时实体的明暗不会跳。
   */
  function buildWireScene(model, opts) {
    var scene = new THREE.Scene();
    var fillMat = fillMaterial(opts.fillColor, opts.fillOpacity);
    var wireMat = wireMaterial(opts.lineWidth, opts.lineColor);
    var count = 0;

    if (opts.quad !== false && model.poly && model.poly.polys.length) {
      var pg = polyGeometry(model.poly, model.polyMatrix);
      var pf = new THREE.Mesh(pg, fillMat);
      pf.frustumCulled = false;
      pf.renderOrder = 0;
      scene.add(pf);
      if (opts.showWire !== false) {
        var pw = new THREE.Mesh(pg, wireMat);
        pw.frustumCulled = false;
        /* 线必须在填充之后画：否则双面线里「背面那些线」会因为填充还没写深度而透出来，
         * 隐藏线消除就废了。 */
        pw.renderOrder = 1;
        scene.add(pw);
      }
      return { scene: scene, fillMat: fillMat, wireMat: wireMat, quad: true };
    }

    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      var geo = o.geometry;
      var m = new THREE.Matrix4().copy(o.matrixWorld);

      var fill = new THREE.Mesh(geo, fillMat);
      fill.matrixAutoUpdate = false;
      fill.matrix.copy(m);
      fill.renderOrder = 0;
      scene.add(fill);

      if (opts.showWire !== false) {
        var wire = new THREE.Mesh(baryGeometry(geo), wireMat);
        wire.matrixAutoUpdate = false;
        wire.matrix.copy(m);
        wire.renderOrder = 1;
        scene.add(wire);
      }
      count++;
    });

    if (!count) throw new Error('模型中没有可渲染的网格');
    return { scene: scene, fillMat: fillMat, wireMat: wireMat, quad: false };
  }

  /* ---------------- 多视图网格 ----------------
   * 这是「多视图」App 的渲染核。跟原来写死的 quadViews 比，多了四件事：
   *   ① 视图任意（前后左右 + 顶/底/轴测），不是只能四格
   *   ② 布局按数量自动算列（4 张 → 2×2，6 张 → 3×2，8 张 → 4×2）
   *   ③ 多一档 shaded（素模）：模型自带材质常常全黑或没贴图，直接拿去当参考图
   *      根本看不清结构；素模打光才是建模参考该有的样子
   *   ④ 逐格切出单图，用户能只下其中一张
   *
   * 三条硬约束（改这个函数前先读）：
   *   · 所有格共用**同一视锥尺度**（正交用同一个 L）。不一致的话每格大小不一，
   *     这种图当三视图参考就废了——比例本身就是它的全部意义。
   *   · 顶/底视图的 up 不能是 (0,1,0)：跟视线平行，lookAt 退化成 NaN，整格黑屏。
   *   · 渲染器必须 dispose + forceContextLoss。浏览器 WebGL 上下文上限约 16 个，
   *     连点十几次「渲染」就白屏，而且报错信息完全指不到这里。
   */
  var VIEWS = {
    front:  { dir: [0, 0, -1],          up: [0, 1, 0],  name: '前' },
    back:   { dir: [0, 0, 1],           up: [0, 1, 0],  name: '后' },
    left:   { dir: [1, 0, 0],           up: [0, 1, 0],  name: '左' },
    right:  { dir: [-1, 0, 0],          up: [0, 1, 0],  name: '右' },
    top:    { dir: [0, -1, 0],          up: [0, 0, -1], name: '顶' },
    bottom: { dir: [0, 1, 0],           up: [0, 0, 1],  name: '底' },
    iso:    { dir: [0.72, 0.5, 0.78],   up: [0, 1, 0],  name: '轴测' },
    isoAlt: { dir: [-0.72, 0.5, -0.78], up: [0, 1, 0],  name: '背轴测' }
  };
  var VIEW_KEYS = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'isoAlt'];

  /* 统一视锥边长：取**所有选中视图里最大的那个屏幕投影宽度**。
   *
   * 为什么不能只写 max(ext)：
   *   轴测方向的投影宽度是 (ex·|rx| + ey·|ry| + ez·|rz|)，等于把三个轴都摊进来，
   *   比任何一个单轴尺寸都大。只按 max(ext) 给视锥，斜视格一定会被裁掉一角
   *   （八视图里最容易发现：轴测的角飞出了格子）。
   *
   * 为什么不是「斜视格单独放大」：
   *   那样每格尺度不同，多视图作为参考图就废了。宁可所有格一起退一点，
   *   也不能让某几格的比例和别人对不上。
   */
  function frameSize(model, names, margin) {
    var e = model.ext;
    var best = 0;
    for (var i = 0; i < names.length; i++) {
      var v = VIEWS[names[i]];
      var dl = Math.sqrt(v.dir[0] * v.dir[0] + v.dir[1] * v.dir[1] + v.dir[2] * v.dir[2]) || 1;
      var d = [v.dir[0] / dl, v.dir[1] / dl, v.dir[2] / dl];
      var ul = Math.sqrt(v.up[0] * v.up[0] + v.up[1] * v.up[1] + v.up[2] * v.up[2]) || 1;
      var up = [v.up[0] / ul, v.up[1] / ul, v.up[2] / ul];

      // 屏幕右向量 = up × d
      var r = [
        up[1] * d[2] - up[2] * d[1],
        up[2] * d[0] - up[0] * d[2],
        up[0] * d[1] - up[1] * d[0]
      ];
      var rl = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) || 1;
      r = [r[0] / rl, r[1] / rl, r[2] / rl];

      // 屏幕上向量 = d × r
      var u = [
        d[1] * r[2] - d[2] * r[1],
        d[2] * r[0] - d[0] * r[2],
        d[0] * r[1] - d[1] * r[0]
      ];

      var w = Math.abs(r[0]) * e.x + Math.abs(r[1]) * e.y + Math.abs(r[2]) * e.z;
      var h = Math.abs(u[0]) * e.x + Math.abs(u[1]) * e.y + Math.abs(u[2]) * e.z;
      if (w > best) best = w;
      if (h > best) best = h;
    }
    return Math.max(best, 1e-6) * margin;
  }

  function viewCamera(model, key, o, L) {
    var v = VIEWS[key], c = model.center;
    var d = Math.max(model.radius * 4, 1e-3);
    var cam;
    if (o.cam === 'persp') {
      // 让包围球正好贴边，再乘 margin 留白
      var fov = 34;
      var dist = Math.max(model.radius, 1e-4) / Math.sin(fov * Math.PI / 180 / 2) * o.margin;
      cam = new THREE.PerspectiveCamera(fov, 1, dist / 400, dist * 30);
      cam.position.set(c.x - v.dir[0] * dist, c.y - v.dir[1] * dist, c.z - v.dir[2] * dist);
    } else {
      // near 跟着模型尺度走：写死 0.01 时大模型会出现 z-fighting（面上起黑斑）
      var near = Math.max(d * 0.004, 1e-4);
      cam = new THREE.OrthographicCamera(-L / 2, L / 2, L / 2, -L / 2, near, d * 4);
      cam.position.set(c.x - v.dir[0] * d, c.y - v.dir[1] * d, c.z - v.dir[2] * d);
    }
    cam.up.set(v.up[0], v.up[1], v.up[2]);
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    return cam;
  }

  // 素模：把所有网格换成同一个中性材质，靠打光看结构
  function clayify(model, color) {
    var mat = new THREE.MeshStandardMaterial({
      /* 别用接近白的浅灰（#cfd5de）：正面受光后直接 clamp 成纯白，
       * 白底上一片空白，看着像「渲染坏了」。中灰留出明暗余量才看得清转折。 */
      color: new THREE.Color(color || '#c2c9d6'),
      roughness: 0.66,
      metalness: 0.02,
      // 双面：薄壁 / 单面板片模型从背面看才不会是空洞
      side: THREE.DoubleSide
    });
    model.root.traverse(function (o) { if (o.isMesh) o.material = mat; });
  }

  function litScene(model) {
    var scene = new THREE.Scene();
    /* 光强总和刻意压在 1.0 附近：three.js 默认不做色调映射，超过 1 直接截断成纯白，
     * 于是「受光面」和「背景」混成一片，等于没有明暗。 */
    scene.add(new THREE.AmbientLight(0xffffff, 0.34));
    var key = new THREE.DirectionalLight(0xffffff, 0.62);
    key.position.set(0.9, 1.4, 1.1);
    var fill = new THREE.DirectionalLight(0xffffff, 0.22);
    fill.position.set(-1.1, -0.35, -0.9);
    var rim = new THREE.DirectionalLight(0xffffff, 0.14);
    rim.position.set(0, -1.2, 0.6);
    scene.add(key); scene.add(fill); scene.add(rim);
    scene.add(model.root);
    return scene;
  }

  /**
   * 渲染任意视图网格
   * @param {string} src 模型地址（data: / http(s) / 经中转）
   * @param {object} opts
   *   views      ['front',...]          缺省四视图
   *   cell       单格边长 px（128–2048，默认 768）
   *   cols       列数（默认 ceil(√n)）
   *   gap        格间距 px
   *   cam        'ortho' | 'persp'（默认 ortho——多视图参考必须正交）
   *   mode       'line' | 'solid' | 'shaded' | 'material'
   *   wire       是否叠一层线框（缺省时只有 mode='line' 画线）。
   *              素模 / 材质上也能叠——旧版靠切 mode 二选一，那样「材质+线框」做不到。
   *   transparent / bgColor / bgOpacity
   *   lineWidth / lineColor / fillColor / fillOpacity / margin
   *   labels     是否在每格左下角烧上视图名
   * @returns {Promise<{png, cols, rows, cell, gap, width, height, cells}>}
   */
  /**
   * 模型统计：顶点 / 三角面 / 是否带 UV。遍历一遍网格数出来，
   * OBJ 的四边面在这里已经是三角化后的 mesh，所以三角面按几何数，不按原始 poly 数。
   */
  function modelStats(model) {
    var verts = 0, tris = 0, uv = false, meshes = 0;
    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var g = o.geometry;
      var pos = g.attributes && g.attributes.position;
      if (!pos) return;
      meshes++;
      verts += pos.count;
      tris += g.index ? g.index.count / 3 : pos.count / 3;
      if (g.attributes.uv) uv = true;
    });
    return {
      verts: verts,
      tris: Math.round(tris),
      uv: uv ? '有' : (meshes ? '无' : '—'),
      meshes: meshes
    };
  }

  async function viewGrid(src, opts) {
    opts = opts || {};
    if (!ready()) throw new Error('three.js 未就绪');

    var names = (Array.isArray(opts.views) && opts.views.length ? opts.views : ['front', 'back', 'left', 'right'])
      .filter(function (k) { return !!VIEWS[k]; });
    if (!names.length) throw new Error('至少要选一个视图');

    var mode = opts.mode || 'line';
    if (['line', 'solid', 'shaded', 'material'].indexOf(mode) < 0) mode = 'line';

    var model = await load(src);

    /* 单格上限放到 4096：4K 整图导出 2 列布局单格 ≈ 2040，1 视图 4K 会顶到 4096。
     * 下面 totalW/H 的钳制已经守住 WebGL 纹理上限，这里不用再卡 2048。 */
    var cell = Math.round(clampNum(Number(opts.cell) || 768, 128, 4096));
    var gap = Math.max(0, Math.round(Number(opts.gap) || 0));
    var cols = Math.round(Number(opts.cols) || 0);
    if (cols < 1) cols = Math.ceil(Math.sqrt(names.length));
    cols = Math.min(cols, names.length);
    var rows = Math.ceil(names.length / cols);

    /* 总边长受 WebGL 纹理上限约束（常见 8192）。超了自动缩格，
     * 而不是让 toDataURL 抛一个用户看不懂的异常。 */
    var MAX = 8192;
    var totalW = cols * cell + (cols - 1) * gap;
    var totalH = rows * cell + (rows - 1) * gap;
    var over = Math.max(totalW, totalH) / MAX;
    if (over > 1) {
      cell = Math.max(64, Math.floor(cell / over));
      if (cell % 2) cell -= 1;
      totalW = cols * cell + (cols - 1) * gap;
      totalH = rows * cell + (rows - 1) * gap;
    }

    // 线宽按格尺寸等比放大：512 格上 1.4px 正好，1024 格还写 1.4 就细得看不见
    var lwScale = Math.max(1, cell / 512);
    var lineW = clampNum(opts.lineWidth, 0.4, 6);
    if (!isFinite(Number(opts.lineWidth)) || Number(opts.lineWidth) <= 0) lineW = 1.4;

    var scene;
    var quadUsed = false;
    /* wire 是独立的开关，不再是一个「模式」：
     *   undefined → 跟老行为一致（只有 line 模式画线）
     *   true/false → 素模 / 材质 / 纯色上都可以叠线，也可以都不画
     * 这样「材质 + 线框」「素模 + 线框」都成立，旧版只能四选一。 */
    var wireOn = opts.wire == null ? (mode === 'line') : !!opts.wire;
    var wireOpts = {
      lineWidth: lineW * lwScale,
      lineColor: opts.lineColor || '#2b2b2b',
      quad: opts.quad
    };

    if (mode === 'material') {
      scene = litScene(model);
      quadUsed = wireOn ? addWireOverlay(scene, model, wireOpts) : true;
    } else if (mode === 'shaded') {
      clayify(model, opts.clayColor);
      scene = litScene(model);
      quadUsed = wireOn ? addWireOverlay(scene, model, wireOpts) : true;
    } else {
      var built = buildWireScene(model, {
        lineWidth: lineW * lwScale,
        lineColor: opts.lineColor || '#2b2b2b',
        fillColor: opts.fillColor || '#ffffff',
        fillOpacity: opts.fillOpacity == null ? 1 : clampNum(opts.fillOpacity, 0, 1),
        showWire: wireOn,
        quad: opts.quad
      });
      scene = built.scene;
      quadUsed = !!built.quad;
    }

    var camMargin = opts.margin == null ? 1.08 : clampNum(opts.margin, 1, 2.4);
    // 所有视图共用一个视锥边长 → 各格尺度严格一致
    var frameL = frameSize(model, names, camMargin);
    var cams = names.map(function (k) {
      return viewCamera(model, k, {
        cam: opts.cam === 'persp' ? 'persp' : 'ortho',
        margin: camMargin
      }, frameL);
    });

    /* 输出通道：
     *   color(默认) 正常上色；mask 白模剪影（黑底，喂 AI 的遮罩）；
     *   depth 深度灰度（近白远黑，黑底，喂 ControlNet depth）。
     * 深度/遮罩只看轮廓与前后关系，跟材质模式无关——统一用 overrideMaterial 盖掉，
     * 线框对象直接隐藏（线不是表面，留在深度图里是脏数据）。 */
    var pass = ['depth', 'mask'].indexOf(opts.pass) >= 0 ? opts.pass : 'color';
    if (pass !== 'color') {
      scene.traverse(function (o) {
        if (o.isLine || o.isLineSegments || o.isLineLoop || o.isPoints) o.visible = false;
      });
      scene.overrideMaterial = pass === 'mask'
        ? new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
        : new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    }

    var canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.debug.checkShaderErrors = false;
    renderer.setPixelRatio(1);
    renderer.setSize(totalW, totalH, false);
    if (pass === 'mask') {
      renderer.setClearColor(new THREE.Color('#000000'), 1);   // 遮罩：黑底白模，不透明
    } else if (pass === 'depth') {
      /* 深度：透明清屏。MeshDepthMaterial 打包后的深度写在 RGBA 里，
       * 背景保持 alpha=0，2D 落脚时按 alpha 区分「模型」和「空背景」。 */
      renderer.setClearColor(new THREE.Color('#000000'), 0);
    } else {
      renderer.setClearColor(
        new THREE.Color(opts.bgColor || '#ffffff'),
        opts.transparent ? 0 : (opts.bgOpacity == null ? 1 : clampNum(opts.bgOpacity, 0, 1))
      );
    }
    renderer.setScissorTest(true);
    renderer.autoClear = false;                        // 关键：否则第二格会擦掉第一格
    renderer.clear(true, true, true);

    for (var i = 0; i < names.length; i++) {
      var x = (i % cols) * (cell + gap);
      var yTop = Math.floor(i / cols) * (cell + gap);
      var vy = totalH - (yTop + cell);                 // 关键：GL 视口原点在左下
      renderer.setViewport(x, vy, cell, cell);
      renderer.setScissor(x, vy, cell, cell);
      renderer.render(scene, cams[i]);
    }

    /* 换一张 2D 画布落脚：同一个 canvas 拿不到第二种上下文（WebGL 之后再 getContext('2d')
     * 返回 null），而标签必须用 2D 画。顺便让 toDataURL 只跑一次。 */
    var out = document.createElement('canvas');
    out.width = totalW;
    out.height = totalH;
    var ctx = out.getContext('2d');
    if (pass === 'depth') {
      /* 深度图：先铺黑底，再把打包深度解包成灰度（近白远黑）。
       * 解包系数是 RGBADepthPacking 的标准式：d = dot(rgba/255, (1, 1/255, 1/65025, 1/16581375))。 */
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, totalW, totalH);
    }
    ctx.drawImage(canvas, 0, 0);

    if (pass === 'depth') {
      try {
        var im = ctx.getImageData(0, 0, totalW, totalH);
        var d8 = im.data;
        for (var p = 0; p < d8.length; p += 4) {
          if (d8[p + 3] < 128) {          // 空背景 → 纯黑
            d8[p] = 0; d8[p + 1] = 0; d8[p + 2] = 0; d8[p + 3] = 255;
            continue;
          }
          var dv = (d8[p] + d8[p + 1] / 255 + d8[p + 2] / 65025 + d8[p + 3] / 16581375) / 255;
          var gray = Math.round((1 - Math.min(1, Math.max(0, dv))) * 255);
          d8[p] = gray; d8[p + 1] = gray; d8[p + 2] = gray; d8[p + 3] = 255;
        }
        ctx.putImageData(im, 0, 0);
      } catch (e4) { /* getImageData 被污染时兜底：宁可给原样打包图也不抛错 */ }
    }

    if (opts.labels && pass === 'color') {
      var fs = Math.max(11, Math.round(cell * 0.042));
      var dark = opts.bgColor && !/^#(fff|ffffff)$/i.test(opts.bgColor) && !opts.transparent;
      ctx.font = '600 ' + fs + 'px system-ui,"Microsoft YaHei",sans-serif';
      ctx.textBaseline = 'bottom';
      for (var j = 0; j < names.length; j++) {
        var lx = (j % cols) * (cell + gap) + Math.round(cell * 0.045);
        var ly = Math.floor(j / cols) * (cell + gap) + cell - Math.round(cell * 0.045);
        ctx.fillStyle = dark ? 'rgba(255,255,255,.62)' : 'rgba(42,48,60,.52)';
        ctx.fillText(VIEWS[names[j]].name, lx, ly);
      }
    }

    var png;
    try {
      png = out.toDataURL('image/png');
    } catch (e) {
      throw new Error('导出失败：画布过大（' + totalW + '×' + totalH + '），请调小单格尺寸');
    } finally {
      try { renderer.dispose(); } catch (e2) {}
      try { renderer.forceContextLoss && renderer.forceContextLoss(); } catch (e3) {}
    }

    var cells = names.map(function (k, idx) {
      return {
        key: k,
        name: VIEWS[k].name,
        col: idx % cols,
        row: Math.floor(idx / cols),
        x: (idx % cols) * (cell + gap),
        y: Math.floor(idx / cols) * (cell + gap),
        w: cell,
        h: cell
      };
    });

    return {
      png: png, cols: cols, rows: rows, cell: cell, gap: gap,
      width: totalW, height: totalH, cells: cells,
      quad: quadUsed,          // false = 这次画的是三角线框（glTF 或用户强制）
      format: model.format || '',
      pass: pass,
      stats: modelStats(model) // 顶点 / 三角面 / UV（导出面板的模型信息用）
    };
  }

  /**
   * 渲染 2×2 四视图拼图（老接口，保持兼容）
   * @param {string} src  模型地址（data: / http(s) / 经中转）
   * @param {object} opts size(2048|4096) gap lineWidth lineColor fillColor fillOpacity bgColor bgOpacity mode('line'|'solid')
   * @returns {Promise<string>} PNG dataURL
   */
  async function quadViews(src, opts) {
    opts = opts || {};
    var size = Number(opts.size) === 4096 ? 4096 : 2048;
    var gap = evenInt(clampNum(opts.gap, 0, 256));
    var r = await viewGrid(src, {
      views: ['front', 'back', 'left', 'right'],
      cell: Math.round((size - gap) / 2),   // 网格正好铺满画布：2*cell+gap === size
      cols: 2,
      gap: gap,
      mode: opts.mode === 'solid' ? 'solid' : 'line',
      bgColor: opts.bgColor,
      bgOpacity: opts.bgOpacity,
      lineWidth: opts.lineWidth,
      lineColor: opts.lineColor,
      fillColor: opts.fillColor,
      fillOpacity: opts.fillOpacity,
      margin: 1.0
    });
    return r.png;
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
    viewGrid: viewGrid,
    renderThumb: renderThumb,
    openPreview: openPreview,
    closePreview: closePreview,
    VIEWS: VIEWS,
    VIEW_KEYS: VIEW_KEYS,
    QUAD_NAMES: QUAD_NAMES
  };
})(window);
