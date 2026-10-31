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

  /* ---------------- 二进制 / 下载（GLB 导出与图片共用） ---------------- */
  /* ArrayBuffer → dataURL。分块转字符：一次 apply 几十万个参数会爆栈 */
  function bufToDataURL(buf, mime) {
    var u8 = new Uint8Array(buf), s = '', CH = 8192;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    return 'data:' + (mime || 'model/gltf-binary') + ';base64,' + btoa(s);
  }

  function saveDataURL(name, url) {
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

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
  /* 原始多边形 → 只画「面边界」的线几何（靠 bary 把内部对角线隐掉）。
   *
   * ⚠ 同一条棱会被相邻两个面各贡献一次（不透明时 1 over 1 看不出，半透明时会叠深：
   * 40% 变 64%），所以给夹在中间的面补一个 stencil 式的「只画一次」——见
   * wireMaterial 里的 uOpacity 注释：3D 图层的不透明度是**近似**，2D 图层才是精确的。 */
  function polyGeometry(poly, matrix) {
    /* 一个模型的 poly 是不变的，几万个面的几何别每次操作都重建一遍。
     * matrix 固定（模型自带变换），所以按 poly 对象缓存就够。 */
    if (polyGeoCache && poly) {
      var hit = polyGeoCache.get(poly);
      if (hit) return hit;
    }
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
    if (polyGeoCache && poly) polyGeoCache.set(poly, g);
    return g;
  }

  function parseGLTF(loader, data, path) {
    return new Promise(function (resolve, reject) {
      loader.parse(data, path || '', function (g) { resolve(g.scene || (g.scenes && g.scenes[0])); }, reject);
    });
  }

  // 加载并归一化（返回包围盒信息，不平移几何，只记录中心用于取景）
  /* ---------------- 解析 / 几何缓存 ----------------
   * 改一个滑条要重跑一遍 viewGrid，而它每次都会 fetch + parse 模型：
   * 3.8MB 的 OBJ 光「取字节 + 解析」就 200ms 左右，真正的绘制只有几十毫秒。
   * 缓存这三样之后，拖滑条才是几十毫秒级的手感。
   *
   * ⚠ 缓存的是**原件**，每次复用都克隆一份：clayify 会替换 mesh 的 material，
   * 直接复用原件的话，切回「材质」模式就只剩黏土材质了。
   * geometry 是共享的（它才是贵的那部分），材质按 mesh 顺序还原。 */
  var loadCache = { key: null, model: null, mats: null };
  var polyGeoCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  var baryGeoCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  /* data URL 动辄几 MB，不能整串当 key：长度 + 首尾片段足够区分（换模型才会变） */
  function srcKey(src) {
    if (typeof src !== 'string') return '';
    return src.length + '|' + src.slice(0, 96) + '|' + src.slice(-96);
  }

  function reviveModel(c) {
    var root = c.model.root.clone(true);
    var i = 0;
    root.traverse(function (o) { if (o.isMesh) o.material = c.mats[i++] || o.material; });
    root.updateMatrixWorld(true);
    return {
      root: root, box: c.model.box, ext: c.model.ext, center: c.model.center,
      radius: c.model.radius, poly: c.model.poly, polyMatrix: c.model.polyMatrix,
      format: c.model.format
    };
  }

  async function load(src) {
    if (!ready()) throw new Error('three.js 未就绪');
    var key = srcKey(src);
    if (key && loadCache.key === key && loadCache.model) return reviveModel(loadCache);
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

    var mats = [];
    obj.traverse(function (o) { if (o.isMesh) mats.push(o.material); });
    loadCache = {
      key: key,
      model: {
        root: obj, box: box, ext: extSize, center: center,
        radius: Math.max(extSize.length() / 2, 1e-6),
        poly: poly, polyMatrix: polyMatrix, format: ext
      },
      mats: mats
    };
    /* 首次也走克隆：否则调用方拿到的是原件，clayify 一改缓存就脏了 */
    return reviveModel(loadCache);
  }

  /* ---------------- 线框：重心坐标 shader ---------------- */
  function baryGeometry(geo) {
    /* 同一个 mesh 反复开/关线框时没必要再展开一次索引几何（那是全量拷贝） */
    if (baryGeoCache) {
      var done = baryGeoCache.get(geo);
      if (done) return done;
    }
    var ni = geo.index ? geo.toNonIndexed() : geo;
    var cnt = ni.attributes.position.count;
    var bary = new Float32Array(cnt * 3);
    for (var i = 0; i < cnt; i += 3) {
      bary[i * 3] = 1; bary[i * 3 + 1] = 0; bary[i * 3 + 2] = 0;
      bary[i * 3 + 3] = 0; bary[i * 3 + 4] = 1; bary[i * 3 + 5] = 0;
      bary[i * 3 + 6] = 0; bary[i * 3 + 7] = 0; bary[i * 3 + 8] = 1;
    }
    ni.setAttribute('bary', new THREE.BufferAttribute(bary, 3));
    if (baryGeoCache) baryGeoCache.set(geo, ni);
    return ni;
  }

  function wireMaterial(lineWidth, color, side, op) {
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        lineColor: { value: new THREE.Color(color || '#2b2b2b') },
        lineWidth: { value: lineWidth || 1.4 },
        /* 图层不透明度：直接乘进 alpha，而不是给材质设 opacity ——
         * ShaderMaterial 不认 material.opacity，得自己接。 */
        uOpacity: { value: 1 }
      },
      vertexShader: [
        'attribute vec3 bary;',
        'varying vec3 vB;',
        'void main(){ vB = bary; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 lineColor;',
        'uniform float lineWidth;',
        'uniform float uOpacity;',
        'varying vec3 vB;',
        'void main(){',
        '  vec3 d = fwidth(vB);',
        '  d = max(d, vec3(1e-6));',
        '  float hw = lineWidth * 0.5 + 0.25;',
        '  vec3 f = smoothstep(vec3(0.0), d * hw, vB);',
        '  float e = 1.0 - min(min(f.x, f.y), f.z);',
        '  if(e < 0.02) discard;',
        '  gl_FragColor = vec4(lineColor, e * uOpacity);',
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
    /* ⚠ 这是**近似**的图层不透明度：3D 是逐图元混合的，同一条棱会被相邻两个面
     * 各画一次（两份重合的线），40% 实际叠成 1-(1-0.4)² = 64%，棱角处会比预期实。
     * 2D 图层（描边 / 深度灰 / 标签）走离屏整层合成，是精确的 40%。
     * 要做到 3D 也精确，得每层单独渲到 RenderTarget 再合成 —— 4K 下每层一张 67MB，
     * 不值当。 */
    mat.uniforms.uOpacity.value = op == null ? 1 : clampNum(op, 0, 1);
    return mat;
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
    var wireMat = wireMaterial(opts.lineWidth, opts.lineColor, null, opts.op);
    /* renderOrder 由图层顺序决定（用户可以在图层面板里拖拽），不再是写死的 1 */
    var order = opts.order == null ? 1 : opts.order;
    pushBackDepth(scene);

    if (opts.quad !== false && model.poly && model.poly.polys.length) {
      var pg = polyGeometry(model.poly, model.polyMatrix);
      var pw = new THREE.Mesh(pg, wireMat);
      pw.frustumCulled = false;
      pw.renderOrder = order;
      scene.add(pw);
      return true;
    }

    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      var w = new THREE.Mesh(baryGeometry(o.geometry), wireMat);
      w.matrixAutoUpdate = false;
      w.matrix.copy(o.matrixWorld);
      w.renderOrder = order;
      scene.add(w);
    });
    return false;
  }

  /* ---------------- UV 岛描边 ----------------
   * 「UV 岛」= UV 上图元连成的一片。岛与岛之间，摊平的时候被撕开的那条边就是接缝。
   * 判据：同一根**空间边**上，两侧三角形用的 UV 对不一样 → 这条边在 UV 里断开了 → 画出来。
   *
   * 为什么先按空间边分组、再比 UV：
   *   只按 UV 分组的话，两个 mesh 各自都只有一条边，都会算成「只出现一次」，
   *   于是每条 mesh 分界线都被描出来——那多半根本不是 UV 接缝。
   *   按空间边分组才知道「这条边其实有两个面、UV 也一样」，不会误画。
   *
   * 为什么是「屏幕空间扩边」而不是重心坐标 shader（2026-10-31 二次改）：
   *   重心坐标那套是**在三角形内部**贴着边画，宽度靠 fwidth 推。三角形一小（密集网格）、
   *   或者侧着看，fwidth 直接饱和 → 整条边不画，接缝就断成一节一节的虚线。
   *   现在改成把每条接缝边在顶点着色器里**按像素宽度扩成一个四边形**：
   *   线宽只由 uWidth 决定，跟三角形大小、朝向彻底无关，必然是连续的等宽曲线。
   *   两端各外扩半个线宽（见 aEnd），相邻线段才会接上、拐弯处不留缺口。
   */
  function seamMaterial(widthPx, color, taper, op) {
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        lineColor: { value: new THREE.Color(color || '#ff2d78') },
        uWidth: { value: widthPx || 2.5 },          // 像素（绘制缓冲的像素，不是 CSS 像素）
        /* 图层不透明度（同一层整体一个值，不按边区分） */
        uOpacity: { value: 1 },
        /* 「随角度变粗」的强度：0 = 所有线等宽，1 = 完全按折角给粗细。
         * 只有角度线框会传非 0，UV 接缝恒为 0（接缝没有「角度」这个概念）。 */
        uTaper: { value: clampNum(taper == null ? 0 : taper, 0, 1) },
        uRes: { value: new THREE.Vector2(512, 512) } // 当前视口的绘制缓冲尺寸
      },
      vertexShader: [
        'attribute vec3 posA;',
        'attribute vec3 posB;',
        'attribute float aEnd;',
        'attribute float aSide;',
        'attribute float aCap;',
        'attribute float aWeight;',
        'uniform vec2 uRes;',
        'uniform float uWidth;',
        'uniform float uTaper;',
        'void main(){',
        /* 一条边的粗细 = 基础线宽 × mix(1, 0.25+0.75*折角比, 强度)。
         * 下限留 25%：折角刚过阈值的那些边不该细到看不见——它们是「平缓过渡」的
         * 结构线，不是噪点。 */
        '  float w = uWidth * mix(1.0, 0.25 + 0.75 * clamp(aWeight, 0.0, 1.0), uTaper);',
        '  vec4 cA = projectionMatrix * modelViewMatrix * vec4(posA, 1.0);',
        '  vec4 cB = projectionMatrix * modelViewMatrix * vec4(posB, 1.0);',
        '  vec2 sA = cA.xy / cA.w;',
        '  vec2 sB = cB.xy / cB.w;',
        '  vec2 dpx = (sB - sA) * uRes;',                 // 这段线在屏幕上的方向（像素）
        '  float len = length(dpx);',
        '  vec2 dir = len > 1e-5 ? dpx / len : vec2(1.0, 0.0);',
        '  vec2 nrm = vec2(-dir.y, dir.x);',
        /* 法向扩半个线宽；拐点再沿方向探出半个线宽（aCap），相邻线段才咬得住。
         * 折线末端 aCap=0：不然每条头都会多长出一小截，看起来像一个个小钩子。 */
        '  vec2 off = nrm * (aSide * w * 0.5) + dir * ((aEnd > 0.5 ? 1.0 : -1.0) * w * aCap);',
        '  vec4 c = aEnd > 0.5 ? cB : cA;',
        '  c.xy += off * (2.0 / uRes) * c.w;',            // NDC：整屏跨度是 2
        '  gl_Position = c;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 lineColor;',
        'uniform float uOpacity;',
        'void main(){ gl_FragColor = vec4(lineColor, uOpacity); }'
      ].join('\n'),
      transparent: true,
      depthWrite: false,
      /* 四边形绕序取决于边的朝向，双面最省事；深度测试照常做，被挡住的接缝不该透出来 */
      side: THREE.DoubleSide
    });
    mat.uniforms.uOpacity.value = clampNum(op == null ? 1 : op, 0, 1);
    return mat;
  }

  /* 扫一遍模型，产出「只画 UV 接缝」的几何：每条接缝边扩成一个四边形（4 顶点 6 索引）。
   * 位置是世界坐标（直接挂到场景根上），每个顶点带 posA/posB（这条边的两端）、
   * aEnd（自己在 A 端还是 B 端）、aSide（往法向往哪边扩）。 */
  /* 顶点 → 量化坐标串。位置先按模型尺寸归一化，大模型小模型共用一套精度
   * （1e6 格 ≈ 百万分之一模型直径，比任何真实网格的边长都细，不会把两个顶点误并成一个）。 */
  function vertPacker(center, radius) {
    var Q = 1048576, R = Math.max(radius || 1, 1e-6);
    return function (x, y, z) {
      return Math.round((x - center.x) / R * Q) + ',' +
        Math.round((y - center.y) / R * Q) + ',' +
        Math.round((z - center.z) / R * Q);
    };
  }
  /* 空间边的 key：两端固定按字典序排，保证 (a,b) 和 (b,a) 同键。
   * 只要求是个确定的顺序，所以直接比字符串（不解析回数字）就够。 */
  function edgeKeyOf(P, ia, ib, pack) {
    var a = pack(P[ia], P[ia + 1], P[ia + 2]);
    var b = pack(P[ib], P[ib + 1], P[ib + 2]);
    return a < b ? a + '|' + b : b + '|' + a;
  }

  /* 一串线段（世界坐标，每条 6 个数）→ 屏幕空间等宽的粗线几何：每条边六个数一个四边形。
   * 拐点两端各外扩半个线宽（aCap），折线头不外扩 —— 靠「同一坐标出现两次 = 拐点」判断。
   * 位置来自同一份顶点数据，浮点值完全相等，按精确值分桶就够，不用再量化。
   * 接缝和角度线框共用它，两处的线宽/连续性表现才一致。
   *
   * weights（可选）：每条线一个 0~1 的粗细权重，材质里配合 uTaper 做「折得越狠越粗」。
   * 不传 = 全 1 = 等宽（UV 接缝走这条）。 */
  function lineQuadGeometry(segs, weights) {
    if (!segs || !segs.length) return null;
    var cnt = new Map();
    function k(x, y, z) { return x + ',' + y + ',' + z; }
    var i, g;
    for (i = 0; i < segs.length; i++) {
      g = segs[i];
      var ka = k(g[0], g[1], g[2]), kb = k(g[3], g[4], g[5]);
      cnt.set(ka, (cnt.get(ka) || 0) + 1);
      cnt.set(kb, (cnt.get(kb) || 0) + 1);
    }
    var pos = [], posA = [], posB = [], endU = [], side = [], cap = [], wgt = [], idx = [];
    for (i = 0; i < segs.length; i++) {
      g = segs[i];
      var capA = (cnt.get(k(g[0], g[1], g[2])) || 0) > 1 ? 0.5 : 0;
      var capB = (cnt.get(k(g[3], g[4], g[5])) || 0) > 1 ? 0.5 : 0;
      var wv = weights && weights[i] != null ? clampNum(weights[i], 0, 1) : 1;
      for (var kk = 0; kk < 4; kk++) {
        var atB = kk >= 2 ? 1 : 0;            // 0/1 = A 端，2/3 = B 端
        pos.push(atB ? g[3] : g[0], atB ? g[4] : g[1], atB ? g[5] : g[2]);
        posA.push(g[0], g[1], g[2]); posB.push(g[3], g[4], g[5]);
        endU.push(atB); side.push(kk % 2 ? 1 : -1);
        cap.push(atB ? capB : capA);
        wgt.push(wv);
      }
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('posA', new THREE.Float32BufferAttribute(posA, 3));
    geo.setAttribute('posB', new THREE.Float32BufferAttribute(posB, 3));
    geo.setAttribute('aEnd', new THREE.Float32BufferAttribute(endU, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    geo.setAttribute('aCap', new THREE.Float32BufferAttribute(cap, 1));
    geo.setAttribute('aWeight', new THREE.Float32BufferAttribute(wgt, 1));
    geo.setIndex(idx);
    return geo;
  }

  function uvSeamGeometry(model) {
    if (!model || !model.root) return { geometry: null, edges: 0, hasUV: false };
    var C = model.center, R = Math.max(model.radius || 1, 1e-6);
    /* 量化：位置先按模型尺寸归一化，大模型小模型用同一套精度
     * （1e6 格 ≈ 百万分之一模型直径，比任何真实网格的边长都细，不会把两个顶点误并成一个）；
     * UV 用 1/16384，展 UV 软件导出的有效位远低于这个。 */
    var QU = 16384;
    function qu(v) { return Math.round(v * QU); }
    var pack = vertPacker(C, R);
    function pKey(P, ia, ib) { return edgeKeyOf(P, ia, ib, pack); }
    function uKey(U, ia, ib) {
      var u0 = qu(U[ia]), v0 = qu(U[ia + 1]), u1 = qu(U[ib]), v1 = qu(U[ib + 1]);
      var sw = (u0 > u1) || (u0 === u1 && v0 > v1);
      return sw ? u1 + ':' + v1 + '|' + u0 + ':' + v0 : u0 + ':' + v0 + '|' + u1 + ':' + v1;
    }

    /* 先把网格摊平成三角形列表：一遍算术，后面 count / 落笔两遍都复用 */
    var meshes = [];
    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var g = o.geometry;
      var a = g.attributes || {};
      if (!a.position || !a.uv) return;          // 没 UV 就没岛可描
      meshes.push({ ni: g.index ? g.toNonIndexed() : g, m: o.matrixWorld });
    });
    if (!meshes.length) return { geometry: null, edges: 0, hasUV: false };

    var vec = new THREE.Vector3();
    var P = new Array(9), U = new Array(6);
    function eachTri(fn) {
      for (var i = 0; i < meshes.length; i++) {
        var ni = meshes[i].ni, m = meshes[i].m;
        var pp = ni.attributes.position, up = ni.attributes.uv;
        for (var t = 0; t + 2 < pp.count; t += 3) {
          for (var k = 0; k < 3; k++) {
            vec.fromBufferAttribute(pp, t + k).applyMatrix4(m);
            P[k * 3] = vec.x; P[k * 3 + 1] = vec.y; P[k * 3 + 2] = vec.z;
            U[k * 2] = up.getX(t + k); U[k * 2 + 1] = up.getY(t + k);
          }
          fn(P, U);
        }
      }
    }

    /* 第一遍：数每条空间边上的每个 UV 对出现了几次。
     * 出现两次 = 两个面共用同一条 UV 边（岛内部）；只出现一次 = 撕开的那条（接缝 / 岛边界）。 */
    var groups = new Map();
    eachTri(function (P2, U2) {
      for (var e = 0; e < 3; e++) {
        var n = (e + 1) % 3;
        var pk = pKey(P2, e * 3, n * 3), uk = uKey(U2, e * 2, n * 2);
        var g = groups.get(pk);
        if (!g) groups.set(pk, g = new Map());
        g.set(uk, (g.get(uk) || 0) + 1);
      }
    });
    /* 接缝条数 = 只出现一次的 UV 边数（精确值，用于界面上的「N 条接缝」） */
    var seamEdges = 0;
    groups.forEach(function (g) { g.forEach(function (n) { if (n === 1) seamEdges++; }); });
    function isSeam(P2, U2, a, b) {
      var g = groups.get(pKey(P2, a * 3, b * 3));
      return !!g && g.get(uKey(U2, a * 2, b * 2)) === 1;
    }

    /* 第二遍：收集接缝线段。
     * 同一根物理边两侧的三角形都会报它（各自 UV 不同、都是 count==1），按空间边去重，
     * 否则同一条线会被画两遍，半透明叠加后颜色发深、宽窄也会抖。 */
    var segs = [], seen = new Set();
    eachTri(function (P2, U2) {
      for (var e = 0; e < 3; e++) {
        var n = (e + 1) % 3;
        if (!isSeam(P2, U2, e, n)) continue;
        var pk = pKey(P2, e * 3, n * 3);
        if (seen.has(pk)) continue;
        seen.add(pk);
        segs.push([P2[e * 3], P2[e * 3 + 1], P2[e * 3 + 2],
                   P2[n * 3], P2[n * 3 + 1], P2[n * 3 + 2]]);
      }
    });
    if (!segs.length) return { geometry: null, edges: 0, hasUV: true };
    return { geometry: lineQuadGeometry(segs), edges: seamEdges, hasUV: true };
  }

  /* 角度线框（普通线框的子集）：只画「两侧面真的折了」的边。
   * 判据：同一条空间边上两个面的法线夹角 ≥ deg。平面与过渡面（夹角小于阈值）一根不画，
   * 所以它永远比普通线框稀，但结构线（硬边、折痕）一条不少。
   * 只有一面挂着的边（网格边界）角记成 180°，永远保留：那是轮廓，滤掉会像模型缺了一块。
   * 阈值 0 就等于普通线框 —— 「子集」这个说法的落脚点就在这。 */
  var creaseMemo = { key: null, segs: null, ang: null };   // 只留最后一个模型

  function creaseGeometry(model, deg, key) {
    var threshold = clampNum(deg == null ? 30 : deg, 0, 90);
    if (!model || !model.root) return { geometry: null, edges: 0, hasUV: true };

    var segs = null, angs = null;
    /* 折角只跟几何有关、跟阈值无关：滑条连拖时每次重扫上万三角形太浪费，
     * 按 src 的**引用**缓存一次分析结果（同一个模型每次传进来的是同一个字符串，
     * 比拿 14MB 的 dataURL 去哈希便宜得多），改阈值只是在缓存上筛一遍。 */
    if (key && creaseMemo.key === key && creaseMemo.segs) {
      segs = creaseMemo.segs; angs = creaseMemo.ang;
    } else {
      var C = model.center, R = Math.max(model.radius || 1, 1e-6);
      var pack = vertPacker(C, R);

      var meshes = [];
      model.root.traverse(function (o) {
        if (!o.isMesh || !o.geometry) return;
        var a = o.geometry.attributes || {};
        if (!a.position) return;
        meshes.push({ ni: o.geometry.index ? o.geometry.toNonIndexed() : o.geometry, m: o.matrixWorld });
      });

      /* 每条空间边记下「第一个面的法线」和「第二个面的法线」。
       * 法线用三角形自身的叉积，不用顶点法线：平滑组会把顶点法线抹平，
       * 拿它判折角会把硬边判成平面。 */
      var groups = new Map();
      var vec = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nv = new THREE.Vector3();
      var P = new Array(9);
      for (var i = 0; i < meshes.length; i++) {
        var pp = meshes[i].ni.attributes.position, m = meshes[i].m;
        for (var t = 0; t + 2 < pp.count; t += 3) {
          for (var k = 0; k < 3; k++) {
            vec.fromBufferAttribute(pp, t + k).applyMatrix4(m);
            P[k * 3] = vec.x; P[k * 3 + 1] = vec.y; P[k * 3 + 2] = vec.z;
          }
          e1.set(P[3] - P[0], P[4] - P[1], P[5] - P[2]);
          e2.set(P[6] - P[0], P[7] - P[1], P[8] - P[2]);
          nv.crossVectors(e1, e2);
          if (nv.lengthSq() < 1e-20) continue;        // 退化三角形没有法线可谈
          nv.normalize();
          for (var sd = 0; sd < 3; sd++) {
            var n2 = (sd + 1) % 3;
            var pk = edgeKeyOf(P, sd * 3, n2 * 3, pack);
            var g = groups.get(pk);
            if (!g) {
              groups.set(pk, {
                n0: [nv.x, nv.y, nv.z], n1: null,
                a: [P[sd * 3], P[sd * 3 + 1], P[sd * 3 + 2]],
                b: [P[n2 * 3], P[n2 * 3 + 1], P[n2 * 3 + 2]]
              });
            } else if (!g.n1) {
              g.n1 = [nv.x, nv.y, nv.z];
            }
          }
        }
      }

      /* 扁平存：每 6 个数一条边的两端，角度单独一条数组。
       * 用 JS 数组的话 3 万条边就是 3 万个对象，密集模型能占几十 MB。 */
      segs = new Float32Array(groups.size * 6);
      angs = new Float32Array(groups.size);
      var ix = 0;
      groups.forEach(function (g) {
        var deg2 = 180;                             // 边界边：永远算「折得最狠」
        if (g.n1) {
          var d = g.n0[0] * g.n1[0] + g.n0[1] * g.n1[1] + g.n0[2] * g.n1[2];
          d = Math.max(-1, Math.min(1, d));
          deg2 = Math.acos(d) * 180 / Math.PI;
        }
        angs[ix] = deg2;
        var o6 = ix * 6;
        segs[o6] = g.a[0]; segs[o6 + 1] = g.a[1]; segs[o6 + 2] = g.a[2];
        segs[o6 + 3] = g.b[0]; segs[o6 + 4] = g.b[1]; segs[o6 + 5] = g.b[2];
        ix++;
      });
      creaseMemo = { key: key || null, segs: segs, ang: angs, n: ix };
    }

    var out = [], wts = [], edges = 0, n = creaseMemo.n != null ? creaseMemo.n : angs.length;
    for (var j = 0; j < n; j++) {
      if (angs[j] < threshold) continue;
      var o6 = j * 6;
      out.push([segs[o6], segs[o6 + 1], segs[o6 + 2], segs[o6 + 3], segs[o6 + 4], segs[o6 + 5]]);
      /* 粗细权重按折角归一：0° → 0（刚过阈值的平缓边最细），90° 及以上 → 1
       * （硬边最粗）。真正的缩放发生在着色器里（uTaper 决定用不用这个权重）。 */
      wts.push(clampNum(angs[j] / 90, 0, 1));
      edges++;
    }
    if (!out.length) return { geometry: null, edges: 0, hasUV: true };
    return { geometry: lineQuadGeometry(out, wts), edges: edges, hasUV: true };
  }

  /* 把线几何挂进场景。renderOrder：填充 0 < 线框 / 角度线框 1 < UV 接缝 2。
   * mvSeam 这个标只表示「这是线，不是面」，深度 / 遮罩通道见它要跳过（见 viewGrid）。 */
  function mountLineOverlay(scene, model, built, opts, order) {
    if (!built.geometry) return { mesh: null, edges: 0, hasUV: built.hasUV };
    var mesh = new THREE.Mesh(built.geometry, seamMaterial(opts.lineWidth, opts.lineColor, opts.taper, opts.op));
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.userData.mvSeam = true;
    if (opts.res) mesh.material.uniforms.uRes.value.set(opts.res[0], opts.res[1]);
    /* 视口尺寸变了（预览窗口拉伸）要跟着改，否则线宽会跟着窗口一起被拉粗拉细 */
    mesh.userData.setRes = function (w, h) {
      mesh.material.uniforms.uRes.value.set(Math.max(1, w), Math.max(1, h));
    };
    scene.add(mesh);
    return { mesh: mesh, edges: built.edges, hasUV: built.hasUV };
  }

  /* 往已有场景里叠线。pushBackDepth 必须在挂自己之前跑：
   * 它会给场景里所有 mesh 打 polygonOffset，连这层线一起推后就会被面咬掉一截一截。 */
  function addUvSeams(scene, model, opts) {
    pushBackDepth(scene);
    var o = opts || {};
    return mountLineOverlay(scene, model, uvSeamGeometry(model), o, o.order == null ? 2 : o.order);
  }
  function addCreaseWire(scene, model, opts) {
    pushBackDepth(scene);
    return mountLineOverlay(scene, model, creaseGeometry(model, opts.angle, opts.key), opts || {}, opts.order == null ? 1 : opts.order);
  }

  /* ---------------- UV 岛着色 ----------------
   * 按 UV 连通性把面切成「岛」，一只岛一个颜色。
   * 用途是检查展 UV：岛碎成一地 = 切得太狠；该断的地方没断 = 两处粘成一个岛；
   * 岛挨得太近 = mipmap 采样会串色（这条得去 UV 视图看，光看 3D 只能看出碎和粘）。
   *
   * 判据跟 uvSeamGeometry 正好互补：那边找「这条 UV 边只出现一次」＝ 被撕开；
   * 这边把「两个三角形共用同一条 UV 边」并成一个岛，最后剩下的连通分量就是岛。 */
  var ISLAND_COLORS = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
    '#46f0f0', '#f032e6', '#bcf60c', '#008080', '#e6beff', '#9a6324'
  ];

  function uvIslandGeometry(model) {
    if (!model || !model.root) return { geometry: null, islands: 0, hasUV: false };
    var C = model.center, R = Math.max(model.radius || 1, 1e-6);
    var pack = vertPacker(C, R);
    var QU = 16384;                       // UV 量化：1/16384，比任何导出精度都细
    function qu(v) { return Math.round(v * QU); }

    var meshes = [];
    model.root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var g = o.geometry, a = g.attributes || {};
      if (!a.position) return;
      if (!a.uv) return;                  // 没 UV 就没有岛
      meshes.push({ ni: g.index ? g.toNonIndexed() : g, m: o.matrixWorld });
    });
    if (!meshes.length) return { geometry: null, islands: 0, hasUV: false };

    var triTotal = 0;
    for (var mi = 0; mi < meshes.length; mi++) {
      triTotal += Math.floor(meshes[mi].ni.attributes.position.count / 3);
    }
    if (!triTotal) return { geometry: null, islands: 0, hasUV: true };

    /* 并查集：三角形是节点，「共用一条 UV 边」就连边 */
    var parent = new Int32Array(triTotal);
    for (var i0 = 0; i0 < triTotal; i0++) parent[i0] = i0;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function uni(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

    var seen = new Map();
    var P = new Array(9), U = new Array(6), vec = new THREE.Vector3();
    var base = 0;
    for (var m2 = 0; m2 < meshes.length; m2++) {
      var ni2 = meshes[m2].ni, mw = meshes[m2].m;
      var pp = ni2.attributes.position, up = ni2.attributes.uv;
      var n2 = Math.floor(pp.count / 3);
      for (var t = 0; t < n2; t++) {
        for (var k = 0; k < 3; k++) {
          vec.fromBufferAttribute(pp, t * 3 + k).applyMatrix4(mw);
          P[k * 3] = vec.x; P[k * 3 + 1] = vec.y; P[k * 3 + 2] = vec.z;
          U[k * 2] = up.getX(t * 3 + k); U[k * 2 + 1] = up.getY(t * 3 + k);
        }
        var ti = base + t;
        for (var e = 0; e < 3; e++) {
          var j = (e + 1) % 3;
          /* 键 = 空间边 + UV 边。只有两样都相同才算「同一个岛的内部边」；
           * 接缝两侧 UV 不同，键天然不同，于是自动断开。 */
          var ka = pack(P[e * 3], P[e * 3 + 1], P[e * 3 + 2]) + '/' + qu(U[e * 2]) + ',' + qu(U[e * 2 + 1]);
          var kb = pack(P[j * 3], P[j * 3 + 1], P[j * 3 + 2]) + '/' + qu(U[j * 2]) + ',' + qu(U[j * 2 + 1]);
          var key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
          var prev = seen.get(key);
          if (prev === undefined) seen.set(key, ti);
          else uni(prev, ti);
        }
      }
      base += n2;
    }

    /* 每个连通分量一个 id（按首次出现排序，颜色才稳定） */
    var idOf = [];
    var rootIdx = new Map();
    for (var q = 0; q < triTotal; q++) {
      var r = find(q);
      var id = rootIdx.get(r);
      if (id === undefined) { id = rootIdx.size; rootIdx.set(r, id); }
      idOf.push(id);
    }

    var pos = [], col = [];
    var rgb = new THREE.Color();
    base = 0;
    for (var m3 = 0; m3 < meshes.length; m3++) {
      var ni3 = meshes[m3].ni, mw3 = meshes[m3].m;
      var pp3 = ni3.attributes.position;
      var n3 = Math.floor(pp3.count / 3);
      for (var t3 = 0; t3 < n3; t3++) {
        rgb.set(ISLAND_COLORS[idOf[base + t3] % ISLAND_COLORS.length]);
        for (var k3 = 0; k3 < 3; k3++) {
          vec.fromBufferAttribute(pp3, t3 * 3 + k3).applyMatrix4(mw3);
          pos.push(vec.x, vec.y, vec.z);
          col.push(rgb.r, rgb.g, rgb.b);
        }
      }
      base += n3;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return { geometry: geo, islands: rootIdx.size, hasUV: true };
  }

  /* 岛着色是**底色**：盖在填充面之上、线之下。
   * polygonOffset 取负（往前推）才盖得住填充面——fillMaterial 是 +1.6 往后推的。
   * depthWrite:false 是关键：它只管盖颜色，不能让线（画在同一深度上）被它挡掉。 */
  function addUvIslands(scene, model, order, op) {
    var built = uvIslandGeometry(model);
    if (!built.geometry) return built;
    var a = op == null ? 1 : clampNum(op, 0, 1);
    var mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      /* 只有真的调低了才开透明：100% 时保持不透明写入，避免白白进透明队列、
       * 让底色的遮挡关系跟以前不一样。 */
      transparent: a < 0.999,
      opacity: a,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1.6,
      polygonOffsetUnits: -1.0,
      depthWrite: false
    });
    var mesh = new THREE.Mesh(built.geometry, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.userData.mvIsland = true;
    scene.add(mesh);
    return built;
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

  /* ---------- 深度描边（depth edge） ----------
   *
   * 语义：「相邻两个像素的深度差超过阈值」就是一条线。它跟外轮廓（只看 alpha）是
   * 两件事——外轮廓只认「模型 / 背景」的交界，物体**内部**的前后分界它一无所知；
   * 而深度差天然把两类都覆盖到，所以这是多视图里唯一能描出结构线的开关。
   *
   * 阈值用**相对**深度差（|Δd| / d），不是绝对 ndc 差：绝对差在近处巨大、远处细小，
   * 同一个滑条位置换个视锥就要重调。相对值跟模型尺度无关，可以存进 localStorage。 */

  /* 线性视图深度 → 24 位打包。
   * 不用 MeshDepthMaterial 的理由：它输出的是 gl_FragCoord.z（透视投影下被压成
   * 非线性），而且输出要过渲染器的色彩空间转换（sRGB 会把数值整个改写，实测
   * 线性 0.23 读回来是 0.50）。描边要的是「到相机的距离」，那就自己算、
   * 自己打包——ShaderMaterial 的输出不会被任何色彩空间动过。 */
  var DEPTH_VERT = [
    'varying float vZ;',
    'void main() {',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vZ = -mv.z;',                       // 相机空间里视线朝 -z，取正数
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var DEPTH_FRAG = [
    'uniform float uFar;',
    'varying float vZ;',
    'void main() {',
    '  float v = clamp(vZ / uFar, 0.0, 1.0);',
    /* 跟 three 的 packDepthToRGBA 同一个式子：把 [0,1] 拆成四段 8 位，
     * 24 位有效精度足够分辨一像素级的深度渐变。 */
    '  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * v;',
    '  enc = fract(enc);',
    '  enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);',
    '  gl_FragColor = enc;',
    '}'
  ].join('\n');

  function makeDepthMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uFar: { value: 1 } },
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      side: THREE.DoubleSide
    });
  }

  /* 用上面的着色器渲一遍，把打包深度读回 CPU。
   * 线（线框 / UV 接缝）不是表面，留着会在深度图里划出一道道假沟——临时隐藏再恢复。
   *
   * ⚠ 必须走离屏 RenderTarget，不能在主画布上渲完 readPixels：
   * 主画布开了 antialias，MSAA 会把多个采样**线性平均**后再 resolve。而打包深度
   * 是按字节进位的非线性编码，平均完解出来的值没有物理意义。RenderTarget 默认
   * 不开 MSAA，读回来才是逐像素原值。 */
  function renderDepthBuffer(renderer, scene, cams, count, cols, cell, gap, totalW, totalH) {
    var hid = [];
    scene.traverse(function (o) {
      if (o.isLine || o.isLineSegments || o.isLineLoop || o.isPoints || (o.userData && o.userData.mvSeam)) {
        if (o.visible) { hid.push(o); o.visible = false; }
      }
    });
    var prev = scene.overrideMaterial;
    var mat = makeDepthMaterial();
    var rt = null, buf = null;
    try {
      rt = new THREE.WebGLRenderTarget(totalW, totalH, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false
      });
      scene.overrideMaterial = mat;
      renderer.setRenderTarget(rt);
      renderer.setScissorTest(true);
      renderer.setClearColor(new THREE.Color('#000000'), 0);   // 背景 alpha=0、深度=0
      renderer.clear(true, true, true);
      for (var i = 0; i < count; i++) {
        var x = (i % cols) * (cell + gap);
        var vy = totalH - (Math.floor(i / cols) * (cell + gap) + cell);
        /* 每格用自己相机的 far 归一化：正交和透视的视锥长度差一个量级，
         * 共用一个 far 会让透视那几格的可用精度掉下去。 */
        mat.uniforms.uFar.value = Math.max(1e-3, Number(cams[i].far) || 1);
        renderer.setViewport(x, vy, cell, cell);
        renderer.setScissor(x, vy, cell, cell);
        renderer.render(scene, cams[i]);
      }
      buf = new Uint8Array(totalW * totalH * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, totalW, totalH, buf);
    } catch (e) {
      buf = null;                 // 读不出来就当没开，别让整张图失败
    } finally {
      renderer.setRenderTarget(null);
      scene.overrideMaterial = prev;
      for (var j = 0; j < hid.length; j++) hid[j].visible = true;
      try { mat.dispose(); } catch (e2) {}
      if (rt) { try { rt.dispose(); } catch (e3) {} }
    }
    return buf;
  }

  /* RGBADepthPacking 的解包式（跟上面深度图通道那处同一个算法）。 */
  function packedDepthAt(buf, i) {
    return (buf[i] + buf[i + 1] / 255 + buf[i + 2] / 65025 + buf[i + 3] / 16581375) / 255;
  }

  /**
   * 在 2D 画布上按深度差描线。
   * 逐格处理而不是整幅扫描：跨格的那两步（格间距、相邻视图）必须是「不算边」，
   * 否则会在每格边上拉出规整的方框，图就废了。
   */
  function drawDepthEdges(ctx, buf, o) {
    var cell = o.cell, gap = o.gap, cols = o.cols, totalH = o.totalH, totalW = o.totalW;
    var step = cell + gap;
    /* 阈值 = 相邻像素**线性视图深度**之差占整条视锥长度的比例（0.1% ~ 40%）。
     * 用线性距离而不是 gl_FragCoord.z：透视投影下后者在远处被压扁，同一个滑条
     * 位置在近处和远处能差出十几倍灵敏度。 */
    var th = 0.001 * Math.pow(400, o.thresh / 100);
    /* 分辨率补偿：单格越大，同一个特征逐像素的深度差越小，阈值要跟着收。
     * 不补的话「512 格一屏线、4K 导出一根没有」，换个尺寸就得重调滑条。 */
    th *= Math.max(0.25, Math.min(4, 768 / cell));
    var BG = 1e-4;                 // 解出来小于它 = 空背景（清屏是全 0）
    var ow = Math.max(1, Math.round(o.width));
    var oo = Math.floor((ow - 1) / 2);
    var stride = totalW * 4;
    var cur = new Float32Array(cell), nxt = new Float32Array(cell);
    var em = new Uint8Array(cell * cell);       // 边位图，每格整片重写，不必清
    /* 统计：命中的边里有多少只是剪影、多少真是靠深度差判出来的。
     * 全是剪影就说明阈值怎么拖都不会变——这一类「滑条失效」要能自查。 */
    var info = { th: th, hits: 0, silhouette: 0 };

    function readRow(glY, col0, dst) {
      var base = glY * stride;
      for (var x = 0; x < cell; x++) dst[x] = packedDepthAt(buf, base + (col0 + x) * 4);
    }

    function isEdge(a, b) {
      var ab = a < BG, bb = b < BG;
      if (ab && bb) return 0;                    // 背景对背景：没有面可比
      if (ab !== bb) { info.silhouette++; return 1; }   // 模型贴着背景：这就是剪影
      var d = a > b ? a - b : b - a;
      return d > th ? 1 : 0;
    }

    ctx.save();
    ctx.fillStyle = o.color;
    for (var ci = 0; ci < o.count; ci++) {
      var x0 = (ci % cols) * step;
      var vy = totalH - (Math.floor(ci / cols) * step + cell);

      /* 第一遍：逐像素判边，先落到位图里。
       * 不能边判边画——AI 生成的模型普遍有重叠面片（衣服贴着身体、双层头发），
       * 两层面在深度上交替胜出，单个像素的深度会突然跳一大截。那种孤立跳变
       * 判出来就是满屏黑点，必须在画之前滤掉。 */
      readRow(vy, x0, cur);
      for (var y = 0; y < cell; y++) {
        if (y + 1 < cell) readRow(vy + y + 1, x0, nxt);
        var base = y * cell;
        for (var x = 0; x < cell; x++) {
          var a = cur[x], b = cur[x + 1], c = nxt[x];
          var edge = 0;
          /* 右邻、上邻两个方向就覆盖了所有交界（每条交界至少被其中一个方向跨过），
           * 不必 8 邻域——那是四倍的开销换同一条线。 */
          if (x + 1 < cell) edge = isEdge(a, b);
          if (!edge && y + 1 < cell) edge = isEdge(a, c);
          em[base + x] = edge;
        }
        var t0 = cur; cur = nxt; nxt = t0;
      }

      /* 第二遍：去掉孤立点。一条真的结构线必然是连续的（至少两三个像素相接），
       * 而 z-fighting 抖出来的点是孤零零一颗。就地标成 2 当「作废」，
       * 判断只认 1，所以不会级联删掉真的短线。 */
      for (var y2 = 0; y2 < cell; y2++) {
        for (var x2 = 0; x2 < cell; x2++) {
          var idx = y2 * cell + x2;
          if (em[idx] !== 1) continue;
          var nb = 0;
          for (var dy = -1; dy <= 1 && !nb; dy++) {
            var yy = y2 + dy;
            if (yy < 0 || yy >= cell) continue;
            for (var dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              var xx = x2 + dx;
              if (xx < 0 || xx >= cell) continue;
              if (em[yy * cell + xx] === 1) { nb = 1; break; }
            }
          }
          if (!nb) em[idx] = 2;
        }
      }

      /* 第三遍：逐行合并连续段，一次 fillRect 画一段 */
      for (var y3 = 0; y3 < cell; y3++) {
        var outY = totalH - 1 - (vy + y3) - oo;
        var run = -1;
        var row = y3 * cell;
        for (var x3 = 0; x3 < cell; x3++) {
          if (em[row + x3] === 1) { info.hits++; if (run < 0) run = x3; }
          else if (run >= 0) {
            /* 行内连续段合并成一次 fillRect：4K 单格 + 稠密线条时，
             * 逐像素 fillRect 能慢十倍。 */
            ctx.fillRect(x0 + run - oo, outY, x3 - run + ow - 1, ow);
            run = -1;
          }
        }
        if (run >= 0) ctx.fillRect(x0 + run - oo, outY, cell - run + ow - 1, ow);
      }
    }
    ctx.restore();
    return info;
  }

  /* '#rrggbb' → {r,g,b}；认不出来就给兜底色（深度图的「无限远」色） */
  function hexToRgb(s, def) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(s == null ? '' : s).trim());
    if (!m) return def;
    var n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /**
   * 深度灰：把「模型表面到相机的距离」直接画成灰度，近白远黑。
   *
   * 数据源就是 renderDepthBuffer 读回来的线性视图深度（v = z / far，跟真实距离
   * 只差一个常数因子）。归一化**按本格模型自己的深度跨度**，不是按整个视锥——
   * 视锥长度通常是模型的十几倍，按视锥归一会渲出一张几乎是纯色的灰片。
   *
   * range（0.05~1）决定窗口取多宽：1 = 模型完整前后跨度；0.5 = 只留靠近相机的一半，
   * 远处直接压成黑。模型小、前后差几毫米的时候，把它调小才看得见层次。
   *
   * bg 是「无限远」的颜色——背景（没有表面）和格间距都填它。默认黑：
   * 近白远黑时黑底才接得上；想倒过来看（近黑远白）就把 bg 改成白，这时
   * 最远的表面会贴到背景色上，是刻意留的余地。
   */
  function drawDepthGray(ctx, buf, o) {
    var cell = o.cell, gap = o.gap, cols = o.cols, totalW = o.totalW, totalH = o.totalH;
    var step = cell + gap, stride = totalW * 4;
    var BG = 1e-4;
    var range = clampNum(o.range == null ? 1 : o.range, 0.05, 1);
    var img = ctx.createImageData(totalW, totalH);
    var d8 = img.data;
    /* 先整幅填成不透明的「无限远」色：模型外面 / 格间距都是它，读灰度才有参照 */
    var bgc = hexToRgb(o.bg, { r: 0, g: 0, b: 0 });
    for (var ai = 0; ai < d8.length; ai += 4) {
      d8[ai] = bgc.r; d8[ai + 1] = bgc.g; d8[ai + 2] = bgc.b; d8[ai + 3] = 255;
    }

    var dp = new Float32Array(cell * cell);     // 每格一次解码，两遍复用
    var info = { lo: 0, hi: 0, range: range };

    for (var ci = 0; ci < o.count; ci++) {
      var x0 = (ci % cols) * step;
      var vy = totalH - (Math.floor(ci / cols) * step + cell);

      var lo = 1, hi = 0;
      for (var y = 0; y < cell; y++) {
        var rb = (vy + y) * stride;
        var row = y * cell;
        for (var x = 0; x < cell; x++) {
          var vv = packedDepthAt(buf, rb + (x0 + x) * 4);
          dp[row + x] = vv;
          if (vv <= BG) continue;
          if (vv < lo) lo = vv;
          if (vv > hi) hi = vv;
        }
      }
      if (hi <= lo) continue;                   // 整格没有模型，留黑
      info.lo = lo; info.hi = hi;

      /* 窗口 = [lo, lo + (hi-lo)*range]，映射到「白 → 黑」。
       * span 卡个下限：纯平面 + range 很小的时候两者相等，会除出 NaN。 */
      var span = (hi - lo) * range;
      if (span < 1e-6) span = 1e-6;
      var top = lo + span;

      for (var y2 = 0; y2 < cell; y2++) {
        var outRow = (totalH - 1 - (vy + y2)) * totalW * 4;
        var row2 = y2 * cell;
        for (var x2 = 0; x2 < cell; x2++) {
          var v2 = dp[row2 + x2];
          if (v2 <= BG) continue;               // 背景保持黑
          var g = (top - v2) / span;            // 近 = 1（白），远 = 0（黑）
          if (g < 0) g = 0; else if (g > 1) g = 1;
          var gray = (g * 255 + 0.5) | 0;
          var oi = outRow + (x0 + x2) * 4;
          d8[oi] = gray; d8[oi + 1] = gray; d8[oi + 2] = gray; d8[oi + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return info;
  }

  /* 只渲线、不渲面：面换成 colorWrite:false 的材质，只把深度写进去。
   * 这样线（含 mvSeam 那层屏幕空间粗线）照常上色，遮挡关系仍由面决定。 */
  function renderLinesOnly(renderer, scene, cams, count, cols, cell, gap, totalW, totalH, bgColor) {
    var hasLine = false;
    scene.traverse(function (o) {
      if (!o.visible) return;
      if (o.isLine || o.isLineSegments || o.isLineLoop || o.isPoints) { hasLine = true; return; }
      /* 普通线框和 UV/角度描边都是 Mesh，靠属性/标记认，不能只看 isLine */
      /* 带 mvLayer 的层对象也要算「有东西要画」：只有 UV 岛色开着、一根线都没有时，
       * 这一遍仍然得跑——否则岛色会跟着「没有线」一起被跳过，又变成「开深度灰就没岛色」。 */
      if (o.isMesh && ((o.userData && (o.userData.mvSeam || o.userData.mvLayer)) ||
        (o.geometry && o.geometry.attributes && o.geometry.attributes.bary))) hasLine = true;
    });
    if (!hasLine) return;                          // 一条线都没有，省这一遍

    /* 面必须带和 fillMaterial 一样的 polygonOffset：线是画在**表面同一深度**上的，
     * 面不往后推一点点，深度测试会把线判成「被自己挡住」，整张图一根线都没有。 */
    var maskMat = new THREE.MeshBasicMaterial({
      colorWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1.6, polygonOffsetUnits: 1.0
    });
    var swapped = [];
    scene.traverse(function (o) {
      if (!o.isMesh) return;
      /* 带 mvLayer 的是**图层内容**（UV 岛色、线框、接缝…），它们本身就是这遍要画的
       * 东西，不能一起遮掉——以前只认 mvSeam，结果 UV 岛色被当成「面」换成
       * colorWrite:false，一开深度灰岛色就整片消失，调它自己的不透明度当然也没反应。 */
      if (o.userData && o.userData.mvLayer) return;
      /* 线也是 Mesh（屏幕空间粗线要扩成四边形），不能连它们一起遮掉：
       *   mvSeam    → UV 描边 / 角度线框那层
       *   bary 属性 → 普通线框（wireMaterial 靠重心坐标画三角形内部的线） */
      var isLine = (o.userData && o.userData.mvSeam) ||
        (o.geometry && o.geometry.attributes && o.geometry.attributes.bary);
      if (isLine) return;
      swapped.push({ o: o, m: o.material });
      o.material = maskMat;
    });
    try {
      renderer.setScissor(0, 0, totalW, totalH);
      renderer.setViewport(0, 0, totalW, totalH);
      renderer.setClearColor(new THREE.Color(bgColor || '#ffffff'), 0);
      renderer.clear(true, true, true);
      for (var i = 0; i < count; i++) {
        var x = (i % cols) * (cell + gap);
        var vy = totalH - (Math.floor(i / cols) * (cell + gap) + cell);
        renderer.setViewport(x, vy, cell, cell);
        renderer.setScissor(x, vy, cell, cell);
        renderer.render(scene, cams[i]);
      }
    } finally {
      for (var j = 0; j < swapped.length; j++) swapped[j].o.material = swapped[j].m;
      try { maskMat.dispose(); } catch (e) {}
    }
  }

  /* ---------------- 渲染图层（layer） ----------------
   * 效果一多，「谁盖谁」就只能靠读 viewGrid 里的 if 顺序猜。这里把每个效果声明成
   * 一行：阶段、顺序、依赖、开关。主干只做两件事：
   *     runLayers('mesh')  建场景时按序挂 3D 对象
   *     runLayers('post')  渲完之后按序在 2D 画布上加工
   * 加一个新效果 = 加一行 + 写一个 run 函数，不用再往主干里塞分支。
   *
   * 顺序按「面 → 底色 → 线 → 描边 → 文字」的覆盖关系排：
   *   0.5 岛着色（底色，盖住填充面）
   *   1.0 线框 / 1.1 角度线框（叠在面上，两者互斥由 flags 决定）
   *   2.0 UV 描边（比线框显眼，排在最后画）
   *   5   深度灰（整幅换成灰度，会把上面的底色作废、但保留线）
   *   10  外轮廓 / 12 深度描边（2D 后处理描出来的线）
   *   20  视图标签（永远最上面）
   * 表本身按 order 升序，runLayers 直接顺序执行，不再排序。
   */
  /* 表里的先后 = 默认的绘制顺序（面板上倒着显示）。深度灰排在线的**下面**：
   * 灰度是底色、线是结构，两者一起才看得出前后关系；把灰放上面等于把线盖掉。
   * 用户在图层面板里拖过之后，以 state.layerOrder 为准。 */
  var LAYER_TABLE = [
    { k: 'bg',       stage: 'post', flag: 'bg',       run: postBgLayer, bottom: true },
    { k: 'uvisland', stage: 'mesh', flag: 'uvisland', run: mountIslandsLayer },
    { k: 'dgray',    stage: 'post', flag: 'dgray', need: 'depth', run: postDepthGrayLayer },
    { k: 'wire',     stage: 'mesh', flag: 'wire',     run: mountWireLayer },
    { k: 'crease',   stage: 'mesh', flag: 'crease',   run: mountCreaseLayer },
    { k: 'uvseam',   stage: 'mesh', flag: 'uvseam',   run: mountSeamLayer },
    { k: 'outline',  stage: 'post', flag: 'outline',  run: postOutlineLayer },
    { k: 'dedge',    stage: 'post', flag: 'dedge', need: 'depth', run: postDepthEdgeLayer },
    { k: 'labels',   stage: 'post', flag: 'labels',   run: postLabelsLayer },
    /* 后期处理层：**永远在最上面**（top:true，排序时强制甩到末尾）。
     * 它调的是「最终输出图像」，不是某个可选效果——所以用户不能把它拖到中间，
     * 也不能拖到某个 3D 层底下（那就不是后期了）。 */
    { k: 'grade',    stage: 'post', flag: 'grade',    run: postGradeLayer, top: true }
  ];

  /* 图层执行顺序：默认就是表里的顺序；传了 layerOrder（图层面板拖出来的 k 序列）
   * 就按它排。**阶段优先**：3D 永远排在 2D 后处理之前——那个先后是物理的
   * （2D 是在渲染完的画面像素上再加工），不是用户偏好，所以跨阶段拖不动。 */
  /* 把 order（用户拖出来的 k 序列）变成完整的层序列。
   * order 里**缺**的层（老存档没有新加的 bg / grade）要按表里的默认位置插回去，
   * 不能扔到末尾 —— 末尾 = 最上层，老存档缺「背景层」时白底会盖住整个模型。
   * 插法：拿它在表里的**前一个还在的层**，插到那个层后面；没有前驱就插最前面。 */
function orderedLayers(order) {
    var list = LAYER_TABLE.slice();
    if (!Array.isArray(order) || !order.length) return list;
    var known = {};
    LAYER_TABLE.forEach(function (L) { known[L.k] = 1; });
    var seq = [];
    var used = {};
    order.forEach(function (k) {
      if (known[k] && !used[k]) { used[k] = 1; seq.push(k); }
    });
    LAYER_TABLE.forEach(function (L, i) {
      if (used[L.k]) return;
      /* 找表里在它前面、且已经在序列里的那一层，插到它后面 */
      var at = -1;
      for (var j = i - 1; j >= 0; j--) {
        var p = LAYER_TABLE[j].k;
        if (used[p]) { at = seq.indexOf(p); break; }
      }
      if (at < 0) seq.unshift(L.k); else seq.splice(at + 1, 0, L.k);
    });
    var rank = {};
    seq.forEach(function (k, i) { rank[k] = i; });
    /* 不再「阶段优先」：3D 和 2D 可以交错。渲染那边会按这个顺序切段，
     * 每段 3D 渲一次再落回 2D 画布，所以顺序是真的。 */
    list.sort(function (a, b) {
      var ra = rank[a.k], rb = rank[b.k];
      return (ra == null ? 999 : ra) - (rb == null ? 999 : rb);
    });
    /* top:true 的层（后期处理）**强制甩到末尾**：用户拖不动它，
     * 存档里旧顺序也一律作废。它调的是最终输出，必须在所有层之后。
     * bottom:true 的层（背景）**强制甩到开头**：它是底色，压在模型上面
     * 就把模型整块盖掉了（用户会以为模型坏了）。 */
    var top = list.filter(function (L) { return L.top; });
    if (top.length) {
      list = list.filter(function (L) { return !L.top; });
      list = list.concat(top);
    }
    var bot = list.filter(function (L) { return L.bottom; });
    if (bot.length) {
      list = list.filter(function (L) { return !L.bottom; });
      list = bot.concat(list);
    }
    return list;
  }

  /* 把「已排序的层列表」切成执行序列：
   *   [{keys:[3D 层...]}, {layer:2D 层}, {keys:[...]}, ...]
   * 连续的一段 3D 合成一次渲染，中间夹着的 2D 层插在两次渲染之间。 */
  function splitLayerOps(list, flags) {
    var ops = [], buf = [];
    for (var i = 0; i < list.length; i++) {
      var L = list[i];
      if (!flags[L.flag]) continue;
      if (L.stage === 'mesh') { buf.push(L.k); continue; }
      if (buf.length) { ops.push({ keys: buf }); buf = []; }
      ops.push({ layer: L });
    }
    if (buf.length) ops.push({ keys: buf });
    return ops;
  }

  /* 单独跑一层 2D 后处理（带这一层自己的不透明度） */
  function runPostLayer(env, L) {
    var a = layerAlpha(env, L.k);
    if (a < 0.002) return;                     // 拖到 0 就别白跑一遍逐像素
    try {
      /* selfAlpha 的层自己处理不透明度（后期处理层要改的是**画布本身**，
       * 走「离屏 + 合成」那条路会对着空离屏调色，什么都不会发生）。 */
      if (L.selfAlpha) { L.run(env); return; }
      if (a < 0.999) runPostAlpha(env, L, a);
      else L.run(env);
    } catch (e) {
      if (!env.layerErr) env.layerErr = {};
      env.layerErr[L.k] = String(e && e.message || e);
    }
  }

  /* 渲染「指定的一批 3D 层」到 WebGL 画布。
   *
   * first=true  ：填充面照常写颜色（它就是最底下的那张）
   * first=false ：填充面只写深度不写颜色——颜色早在上一次 drawImage 里落到 2D 画布了，
   *               再写一遍会把前一段（以及夹在中间的 2D 层）整个盖掉。深度仍然要写，
   *               否则第二段的线会穿透到模型正面。
   */
  function renderSceneSegment(renderer, scene, cams, names, cols, cell, gap, totalW, totalH, keys, first, bgColor) {
    scene.traverse(function (o) {
      var k = o.userData && o.userData.mvLayer;
      if (k) o.visible = keys.indexOf(k) >= 0;
    });

    var muted = [];
    if (!first) {
      scene.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        if (o.userData && o.userData.mvLayer) return;      // 层对象不动
        if (muted.indexOf(o.material) < 0) { muted.push(o.material); o.material.colorWrite = false; }
      });
    }

    renderer.setScissorTest(true);
    renderer.autoClear = false;
    renderer.setScissor(0, 0, totalW, totalH);
    renderer.setViewport(0, 0, totalW, totalH);
    /* 清屏色用 bgColor 而不是黑：抗锯齿边缘是跟清屏色混的，混黑会在浅底上留一圈黑边。
     * alpha=0 保证它不会盖住上一段。 */
    renderer.setClearColor(new THREE.Color(bgColor || '#ffffff'), 0);
    renderer.clear(true, true, true);

    for (var i = 0; i < names.length; i++) {
      var x = (i % cols) * (cell + gap);
      var yTop = Math.floor(i / cols) * (cell + gap);
      var vy = totalH - (yTop + cell);                 // GL 视口原点在左下
      renderer.setViewport(x, vy, cell, cell);
      renderer.setScissor(x, vy, cell, cell);
      renderer.render(scene, cams[i]);
    }

    for (var m = 0; m < muted.length; m++) muted[m].colorWrite = true;
    scene.traverse(function (o) {
      if (o.userData && o.userData.mvLayer) o.visible = true;
    });
  }

  /* 2D 图层的整体不透明度：**先画到一张临时画布，再整体压 alpha 合成**。
   *
   * 为什么不能直接给主画布设 ctx.globalAlpha：描边是逐行 fillRect 叠出来的，
   * 相邻行的矩形在纵向有 (线宽-1) 的重叠，逐笔压 alpha 会在重叠处叠深——
   * 表现为「同样的线，粗的地方更黑、细的地方更淡」，那不是图层不透明度该有的样子。
   * 画到离屏再一次性合成，重叠在离屏里就已经是实心的，压的是整层的 alpha。
   *
   * 只有一张临时画布、按需 resize（改尺寸等于清空）：4K 下每层各留一张会吃掉几百 MB。 */
  var scratchCv = null;
  function scratchCanvas(w, h) {
    if (!scratchCv) scratchCv = document.createElement('canvas');
    if (scratchCv.width !== w || scratchCv.height !== h) {
      scratchCv.width = w; scratchCv.height = h;
    } else {
      scratchCv.getContext('2d').clearRect(0, 0, w, h);
    }
    return scratchCv;
  }

  /* 某层的不透明度：0~1，没配就是 1（老调用方不传 layerOpacity 时行为完全不变） */
  function layerAlpha(env, k) {
    var m = env.opacity;
    if (!m) return 1;
    var v = m[k];
    return v == null ? 1 : clampNum(v, 0, 1);
  }

  /* 在离屏画布上跑一层 post，再整体合成回去 */
  function runPostAlpha(env, L, a) {
    var ctx = env.ctx;
    var sc = scratchCanvas(env.totalW, env.totalH);
    var sctx = sc.getContext('2d');
    sctx.save();
    env.ctx = sctx;
    try { L.run(env); } finally { env.ctx = ctx; sctx.restore(); }
    ctx.save();
    ctx.globalAlpha = a;
    ctx.drawImage(sc, 0, 0);
    ctx.restore();
  }

  function runLayers(list, stage, flags, env) {
    var seq = 0;
    for (var i = 0; i < list.length; i++) {
      var L = list[i];
      if (L.stage !== stage || !flags[L.flag]) continue;
      /* 3D 图层的绘制先后 = 列表里的先后。从 1 起（0 留给填充面），
       * 所以把「UV 岛色」拖到线框上面，它就真的盖住线——跟 PS 一样。 */
      if (stage === 'mesh') env.meshOrder = ++seq;
      var a = layerAlpha(env, L.k);
      if (stage === 'mesh') env.meshAlpha = a;
      try {
        /* 满不透明直接画主画布（默认路径，零额外开销）；调低了才绕离屏 */
        if (stage === 'post' && !L.selfAlpha && a < 0.999) runPostAlpha(env, L, a);
        else L.run(env);
      } catch (e) {
        /* 单个图层失败不拖垮整张图：记下线、继续下一层 */
        if (!env.layerErr) env.layerErr = {};
        env.layerErr[L.k] = String(e && e.message || e);
      }
    }
  }

  /* 哪些图层要深度缓冲——主干预先渲一遍，多个图层共用同一张 */
  function needsDepthBuffer(flags) {
    for (var i = 0; i < LAYER_TABLE.length; i++) {
      var L = LAYER_TABLE[i];
      if (L.need === 'depth' && flags[L.flag]) return true;
    }
    return false;
  }

  /* ---------- mesh 层 ---------- */

  /* 给「刚挂进 scene 的对象」盖一个层标记。
   * 分段渲染靠它决定这一遍该显示谁：同一个 scene 里会有八个层的东西，
   * 换 visible 比重新建场景便宜几个数量级。 */
  function tagLayer(env, k, fn) {
    var scene = env.scene;
    var before = scene.children.length;
    var r = fn();
    for (var i = before; i < scene.children.length; i++) {
      if (scene.children[i] && scene.children[i].userData) scene.children[i].userData.mvLayer = k;
    }
    return r;
  }

  function mountIslandsLayer(env) {
    var r = tagLayer(env, 'uvisland', function () {
      return addUvIslands(env.scene, env.model, env.meshOrder, env.meshAlpha);
    });
    env.info.uvisland = { islands: r.islands, hasUV: r.hasUV, drawn: !!r.geometry };
  }

  function mountWireLayer(env) {
    /* 纯色模式（line）的线是 buildWireScene 一起建的，这里不再叠一层 */
    if (env.mode === 'line') return;
    env.quad = tagLayer(env, 'wire', function () {
      return addWireOverlay(env.scene, env.model, {
        lineWidth: env.lineW * env.lwScale,
        lineColor: env.lineColor,
        quad: env.opts.quad,
        order: env.meshOrder,
        op: env.meshAlpha
      });
    });
  }

  function mountCreaseLayer(env) {
    env.creaseOpts.order = env.meshOrder;
    env.creaseOpts.op = env.meshAlpha;
    var r = tagLayer(env, 'crease', function () {
      return addCreaseWire(env.scene, env.model, env.creaseOpts);
    });
    env.quad = false;
    env.info.crease = { deg: env.creaseOpts.angle, edges: r.edges, drawn: !!r.mesh };
  }

  function mountSeamLayer(env) {
    env.seamOpts.order = env.meshOrder;
    env.seamOpts.op = env.meshAlpha;
    var seam = tagLayer(env, 'uvseam', function () {
      return addUvSeams(env.scene, env.model, env.seamOpts);
    });
    env.info.uv = { edges: seam.edges, hasUV: seam.hasUV, drawn: !!seam.mesh };
  }

  /* ---------- post 层（都在 2D 画布上） ---------- */

  /* 背景层：整幅铺一层纯色（含格间距）。它默认关着——这套图的用途是叠到别处，
   * 带底反而要再抠一遍；需要白底/黑底时勾上，还能调不透明度。 */
  function postBgLayer(env) {
    var ctx = env.ctx;
    ctx.save();
    ctx.fillStyle = env.opts.bgColor || '#ffffff';
    ctx.fillRect(0, 0, env.totalW, env.totalH);
    ctx.restore();
  }

  /* 后期处理层：调**最终输出图像**的饱和度 / 对比度 / 亮度。
   *
   * 做法是逐像素改画布自己（getImageData → 算 → putImageData），不是再画一遍。
   * 这跟别的 2D 图层不一样，所以：
   *   ① 它必须跑在**最后**（LAYER_TABLE 里 top:true，排序时强制甩到末尾）；
   *   ② 它不能走「离屏 + globalAlpha 合成」那条通用路径——离屏画布是空的，
   *      画上去什么也没有。所以它自己处理不透明度：把「调色后的像素」和
   *      「原像素」按 alpha 混合，alpha=100% 就是完全替换。
   *
   * 只处理 RGB，alpha 原样保留：这套图常常是透明底，调色不该把透明区弄脏。 */
  function postGradeLayer(env) {
    var ctx = env.ctx;
    var o = env.opts;
    var sat = clampNum(o.gradeSat == null ? 1 : o.gradeSat, 0, 2);
    var con = clampNum(o.gradeContrast == null ? 1 : o.gradeContrast, 0, 2);
    var bri = clampNum(o.gradeBright == null ? 0 : o.gradeBright, -1, 1);
    /* 全中性就一个像素都不碰（省掉一次几百 MB 的 getImageData） */
    if (Math.abs(sat - 1) < 1e-6 && Math.abs(con - 1) < 1e-6 && Math.abs(bri) < 1e-6) return;
    var a = layerAlpha(env, 'grade');
    if (a < 0.002) return;
    var w = env.totalW, h = env.totalH;
    var img;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch (e) { return; }
    var d = img.data;
    var k = a >= 0.999 ? 1 : a;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;              // 透明像素不参与，也别去动它
      var r = d[i], g = d[i + 1], b = d[i + 2];
      /* 亮度 → 对比度 → 饱和度（跟 PS 的基本调整顺序一致） */
      var br = bri * 255;
      r = r + br; g = g + br; b = b + br;
      if (con !== 1) {
        r = (r - 128) * con + 128;
        g = (g - 128) * con + 128;
        b = (b - 128) * con + 128;
      }
      if (sat !== 1) {
        var l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = l + (r - l) * sat;
        g = l + (g - l) * sat;
        b = l + (b - l) * sat;
      }
      if (k !== 1) {
        r = d[i] + (r - d[i]) * k;
        g = d[i + 1] + (g - d[i + 1]) * k;
        b = d[i + 2] + (b - d[i + 2]) * k;
      }
      d[i] = r < 0 ? 0 : (r > 255 ? 255 : r);
      d[i + 1] = g < 0 ? 0 : (g > 255 ? 255 : g);
      d[i + 2] = b < 0 ? 0 : (b > 255 ? 255 : b);
    }
    try { ctx.putImageData(img, 0, 0); } catch (e2) { /* 画布太大就放弃这一层 */ }
  }

  function postDepthGrayLayer(env) {
    if (!env.depthBuf) return;
    env.info.dgray = drawDepthGray(env.ctx, env.depthBuf, {
      totalW: env.totalW, totalH: env.totalH,
      cell: env.cell, gap: env.gap, cols: env.cols, count: env.names.length,
      bg: env.opts.depthGrayBg || '#000000',
      range: env.pass === 'depth' ? 1 : (env.opts.depthGrayRange == null ? 1 : clampNum(env.opts.depthGrayRange, 0.05, 1))
    });
    /* 不再「把线再叠一次」：线之所以看得见，靠的是它在 layerOrder 里排在深度灰
     * 后面（默认顺序就是这样），由分段渲染自然叠上去。以前那个特技强行把线画在灰上，
     * 代价是顺序彻底失效——半透明时既看不到底下，也调不动谁盖住谁。
     */
  }

  function postOutlineLayer(env) {
    var ctx = env.ctx, totalW = env.totalW, totalH = env.totalH;
    /* 外轮廓描边：在 alpha 通道里找「有模型 / 空背景」的交界——那就是画面上真正的剪影。
     * 不从几何算（法线外扩 / 反面壳）的三个理由：
     *   ① 依赖法线，OBJ 常缺法线或全是硬边，外扩壳会在硬边处裂开一道道缝；
     *   ② 不同相机看到的外轮廓不一样，而 viewGrid 是一张场景多个视角，
     *      几何法得每个相机各算一遍；alpha 交界天然按视角算好；
     *   ③ 采集的是最终像素，跟材质、透明、线框怎么画都无关。
     * 读 WebGL 的 drawingBuffer（preserveDrawingBuffer 已开），行序是从下往上，要翻。 */
    var gl = env.renderer.getContext();
    var buf = new Uint8Array(totalW * totalH * 4);
    gl.readPixels(0, 0, totalW, totalH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    var ow = Math.max(1, Math.round(Number(env.opts.outlineWidth) || Math.max(1, env.cell / 512 * 1.6)));
    var oo = Math.floor((ow - 1) / 2);
    var stride = totalW * 4;
    ctx.save();
    ctx.fillStyle = env.opts.outlineColor || '#171a20';
    for (var oy = 0; oy < totalH; oy++) {
      var row = (totalH - 1 - oy) * stride;
      var rs = -1;
      for (var ox = 0; ox < totalW; ox++) {
        var oi = row + ox * 4;
        var edge = false;
        if (buf[oi + 3] > 16) {
          /* 画布边界一律不算线：模型被裁到画布外时不该沿图边拉一条 */
          if (ox > 0 && buf[oi - 1] <= 16) edge = true;
          else if (ox < totalW - 1 && buf[oi + 7] <= 16) edge = true;
          else if (oy > 0 && buf[oi + stride + 3] <= 16) edge = true;
          else if (oy < totalH - 1 && buf[oi - stride + 3] <= 16) edge = true;
        }
        if (edge) { if (rs < 0) rs = ox; }
        else if (rs >= 0) {
          ctx.fillRect(rs - oo, oy - oo, ox - rs + ow - 1, ow);
          rs = -1;
        }
      }
      if (rs >= 0) ctx.fillRect(rs - oo, oy - oo, totalW - rs + ow - 1, ow);
    }
    ctx.restore();
  }

  function postDepthEdgeLayer(env) {
    if (!env.depthBuf) return;
    env.info.dedge = drawDepthEdges(env.ctx, env.depthBuf, {
      totalW: env.totalW, totalH: env.totalH,
      cell: env.cell, gap: env.gap, cols: env.cols, count: env.names.length,
      thresh: env.opts.depthEdgeThresh == null ? 40 : clampNum(env.opts.depthEdgeThresh, 0, 100),
      width: Math.max(1, Math.round(Number(env.opts.depthEdgeWidth) || env.lineW * env.lwScale)),
      color: env.opts.depthEdgeColor || env.lineColor
    });
  }

  function postLabelsLayer(env) {
    var ctx = env.ctx, cell = env.cell, gap = env.gap, cols = env.cols, names = env.names;
    var fs = Math.max(11, Math.round(cell * 0.042));
    var dark = env.opts.bgColor && !/^#(fff|ffffff)$/i.test(env.opts.bgColor) && !env.opts.transparent;
    ctx.font = '600 ' + fs + 'px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'bottom';
    for (var j = 0; j < names.length; j++) {
      var lx = (j % cols) * (cell + gap) + Math.round(cell * 0.045);
      var ly = Math.floor(j / cols) * (cell + gap) + cell - Math.round(cell * 0.045);
      ctx.fillStyle = dark ? 'rgba(255,255,255,.62)' : 'rgba(42,48,60,.52)';
      ctx.fillText(VIEWS[names[j]].name, lx, ly);
    }
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
    /* 角度线框是线框的**过滤条件**，不是第四种模式：勾上它本身就要出线，
     * 只是把「两侧面几乎平」的那些边滤掉。所以它一开，wireOn 必然为真。 */
    var angleOn = !!opts.wireAngle;
    if (angleOn) wireOn = true;
    var angleDeg = clampNum(opts.wireAngleDeg == null ? 30 : Number(opts.wireAngleDeg), 0, 90);
    /* 角度线框的三条独立参数：整体倍率、随角度的粗细梯度、颜色。
     * 它跟普通线框是**两套观感**——普通线框是「一条都不许少」的骨架，
     * 角度线框是「结构线」，所以粗细和颜色都允许分开调。 */
    var creaseScale = clampNum(opts.creaseScale == null ? 1 : Number(opts.creaseScale), 0.2, 3);
    var creaseTaper = clampNum(opts.creaseTaper == null ? 0 : Number(opts.creaseTaper), 0, 1);
    var creaseColor = opts.creaseColor || opts.lineColor || '#2b2b2b';
    var creaseOpts = {
      lineWidth: lineW * lwScale * creaseScale,
      lineColor: creaseColor,
      taper: creaseTaper,
      angle: angleDeg,
      res: [cell, cell],
      key: src        // 折角分析的缓存键（同一个模型反复改阈值只分析一次）
    };
    var creaseInfo = null;

    /* 输出通道先定下来：「深度灰」和「描边类」图层都要看它决定开不开 */
    var pass = ['depth', 'mask'].indexOf(opts.pass) >= 0 ? opts.pass : 'color';
    var depthEdgeOn = !!opts.depthEdge && pass === 'color';
    var depthGrayOn = !!opts.depthGray && pass === 'color';

    /* ---- 场景本体：只负责「面」 ---- */
    if (mode === 'material') {
      scene = litScene(model);
      quadUsed = true;
    } else if (mode === 'shaded') {
      clayify(model, opts.clayColor);
      scene = litScene(model);
      quadUsed = true;
    } else {
      var built = buildWireScene(model, {
        lineWidth: lineW * lwScale,
        lineColor: opts.lineColor || '#2b2b2b',
        fillColor: opts.fillColor || '#ffffff',
        fillOpacity: opts.fillOpacity == null ? 1 : clampNum(opts.fillOpacity, 0, 1),
        /* 纯色模式的线交给「线框」图层去画：场景里那份是**不透明度写死 1** 的，
         * 两处都画会让 40% 的线叠在 100% 的线上，结果看起来一点都没变淡。
         * 只有老的 mode=line 例外——那条路径里没有独立的线框图层。 */
        showWire: opts.mode === 'line' && wireOn && !angleOn,
        quad: opts.quad
      });
      scene = built.scene;
      quadUsed = !!built.quad;
    }

    /* ---- 图层开关：3D 与 2D 共用同一份，顺序与依赖见 LAYER_TABLE ---- */
    var flags = {
      /* 背景层只在彩色通道出现：深度/遮罩是喂 AI 的数据，不许垫底色 */
      bg: !!opts.bg && pass === 'color',
      uvisland: !!opts.uvIsland && pass === 'color',
      /* 两个线框互斥：角度线框本身就是线框的子集，同时开等于只画角度线框 */
      wire: wireOn && !angleOn,
      crease: angleOn,
      uvseam: !!opts.uvEdge,
      /* 导出深度通道（pass='depth'）走的就是这一层，只是参数不同 */
      dgray: depthGrayOn || pass === 'depth',
      outline: !!opts.outline && pass === 'color' && !depthGrayOn,
      dedge: depthEdgeOn,
      labels: !!opts.labels && pass === 'color' && !depthGrayOn,
      /* 后期处理：只作用在彩色输出上。深度 / 遮罩是喂 AI 的数据，
       * 调色会把像素值改坏（那两张图要的是数值，不是好看的画面）。 */
      grade: !!opts.grade && pass === 'color'
    };
    var env = {
      opts: opts, mode: mode, model: model, scene: scene, src: src, pass: pass,
      cell: cell, gap: gap, cols: cols, totalW: totalW, totalH: totalH, names: names,
      lineW: lineW, lwScale: lwScale, lineColor: opts.lineColor || '#2b2b2b',
      creaseOpts: creaseOpts,
      seamOpts: {
        /* 比线框粗一点：接缝是这张图要看的重点，被线框淹没就失去意义了 */
        lineWidth: Math.max(1.6, lineW * 1.6) * lwScale,
        lineColor: opts.uvEdgeColor || '#ff2d78',
        res: [cell, cell]
      },
      quad: quadUsed,
      /* 每层不透明度（0~1），没有就全 1。图层调度按 L.k 取值 */
      opacity: opts.layerOpacity || null,
      meshAlpha: 1,
      info: { crease: null, uv: null, uvisland: null, dgray: null, dedge: null }
    };
    var actLayers = orderedLayers(opts.layerOrder);
    runLayers(actLayers, 'mesh', flags, env);
    quadUsed = env.quad;
    creaseInfo = env.info.crease;
    var uvInfo = env.info.uv;
    var islandInfo = env.info.uvisland;

    var camMargin = opts.margin == null ? 1.08 : clampNum(opts.margin, 1, 2.4);
    // 所有视图共用一个视锥边长 → 各格尺度严格一致
    var frameL = frameSize(model, names, camMargin);
    var cams = names.map(function (k) {
      return viewCamera(model, k, {
        cam: opts.cam === 'persp' ? 'persp' : 'ortho',
        margin: camMargin
      }, frameL);
    });

    /* 遮罩只看轮廓，跟材质模式无关——用 overrideMaterial 盖成纯白。
     * 深度通道不能这么干（见上面的注释），它走 dgray 图层那一套。 */
    if (pass === 'mask') {
      scene.traverse(function (o) {
        /* mvSeam / mvIsland 都是 Mesh（为了线宽 / 顶点色），overrideMaterial 会把整片
         * 三角形涂成白色，等于往遮罩里塞脏数据——必须和线一样隐藏掉。 */
        if (o.isLine || o.isLineSegments || o.isLineLoop || o.isPoints ||
          (o.userData && (o.userData.mvSeam || o.userData.mvIsland))) o.visible = false;
      });
      scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
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
      /* 颜色通道一律**透明清屏**，底色留到 2D 落脚时铺（见下面 ctx.fillRect）。
       * 理由：alpha 通道就是「模型覆盖了多少」，外轮廓描边直接从它取边界，
       * 不用为描边再渲一遍遮罩。清屏色仍填 bgColor 而不是黑色——抗锯齿边缘是跟
       * 清屏色混的，混成黑色会在浅底上留一圈黑边（premultiply 那一课）。 */
      renderer.setClearColor(new THREE.Color(opts.bgColor || '#ffffff'), 0);
    }
    /* 需要深度的图层（深度灰 / 深度描边）共用这一张底图：单独渲一遍把打包深度读回
     * CPU，读完立刻清屏再正常渲颜色。多一遍渲染换来的东西是**遮挡边**（前后两个物体
     * 之间的分界线），那是只看 alpha 的外轮廓永远拿不到的。 */
    var depthBuf = null;
    if (needsDepthBuffer(flags) || pass === 'depth') {
      depthBuf = renderDepthBuffer(renderer, scene, cams, names.length, cols, cell, gap, totalW, totalH);
    }

    /* 换一张 2D 画布落脚：同一个 canvas 拿不到第二种上下文（WebGL 之后再 getContext('2d')
     * 返回 null），而标签必须用 2D 画。顺便让 toDataURL 只跑一次。 */
    var out = document.createElement('canvas');
    out.width = totalW;
    out.height = totalH;
    var ctx = out.getContext('2d');
    if (pass === 'color' && !opts.transparent) {
      /* 底色从 WebGL 清屏挪到这里（清屏现在恒透明）。铺的方式跟原来一样：
       * bgColor + bgOpacity，铺完再把模型叠上去，观感与改之前完全等价。 */
      var bop = opts.bgOpacity == null ? 1 : clampNum(opts.bgOpacity, 0, 1);
      if (bop > 0) {
        ctx.globalAlpha = bop;
        ctx.fillStyle = opts.bgColor || '#ffffff';
        ctx.fillRect(0, 0, totalW, totalH);
        ctx.globalAlpha = 1;
      }
    }

    env.ctx = ctx;
    env.renderer = renderer;
    env.canvas = canvas;
    env.depthBuf = depthBuf;
    env.out = out;

    /* ---- 渲染与合成 ----
     * 两种走法：
     *   ① 「深度灰 / 导出深度 / 遮罩」是整幅覆盖或只看轮廓的，排序没有意义，
     *      仍旧一口气渲完再落画布（最快，也保住了 renderLinesOnly 那套）。
     *   ② 其余按 layerOrder 切成「一段 3D + 若干 2D 层」：每段渲一次、drawImage 落到
     *      2D 画布，碰到 2D 层就当场画 —— 于是 3D 和 2D 能真正交错。
     *      默认顺序（3D 全在前）只有一段，跟改之前完全一样，不多花一毫秒。 */
    if (pass !== 'color') {
      renderer.setScissorTest(true);
      renderer.autoClear = false;
      renderer.setScissor(0, 0, totalW, totalH);
      renderer.setViewport(0, 0, totalW, totalH);
      renderer.setClearColor(new THREE.Color(opts.bgColor || '#ffffff'), 0);
      renderer.clear(true, true, true);

      /* 颜色通道已经全部走分段（深度灰也是普通图层，顺序交给 layerOrder）。
       * 这里只剩「导出深度 / 遮罩通道」——它们只要轮廓或深度本身。 */
      if (pass !== 'depth') {
        for (var i = 0; i < names.length; i++) {
          var x = (i % cols) * (cell + gap);
          var yTop = Math.floor(i / cols) * (cell + gap);
          var vy = totalH - (yTop + cell);                 // 关键：GL 视口原点在左下
          renderer.setViewport(x, vy, cell, cell);
          renderer.setScissor(x, vy, cell, cell);
          renderer.render(scene, cams[i]);
        }
      }

      ctx.drawImage(canvas, 0, 0);
      runLayers(actLayers, 'post', flags, env);
    } else {
      var ops = splitLayerOps(actLayers, flags);
      /* 填充面（模型本体）不属于任何图层，它必须**永远有段来画**：
       * 一个 3D 层都没开时 ops 里没有渲染动作，结果就是一张空图。
       * ⚠ 补的位置要跳过「背景层」——背景是最底下那层，模型本体得压在它上面；
       * 直接 unshift 到最前会被后面的背景整片盖掉（黑底一勾模型就没了）。 */
      var hasSeg = false;
      for (var si = 0; si < ops.length; si++) if (ops[si].keys) { hasSeg = true; break; }
      if (!hasSeg) {
        var at = ops.length;
        for (var bi = 0; bi < ops.length; bi++) {
          if (ops[bi].layer && ops[bi].layer.k !== 'bg') { at = bi; break; }
        }
        ops.splice(at, 0, { keys: [] });
      }
      var firstSeg = true;
      for (var oi = 0; oi < ops.length; oi++) {
        if (ops[oi].keys) {
          renderSceneSegment(renderer, scene, cams, names, cols, cell, gap, totalW, totalH,
            ops[oi].keys, firstSeg, opts.bgColor);
          ctx.drawImage(canvas, 0, 0);
          firstSeg = false;
        } else {
          runPostLayer(env, ops[oi].layer);
        }
      }
    }
    var depthGrayInfo = env.info.dgray;    var depthGrayInfo = env.info.dgray;
    var deInfo = env.info.dedge;

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
      /* UV 描边结果：edges=接缝条数，hasUV=false 说明模型没有 UV（画不出来），
       * drawn=false 说明有 UV 但整片连着（没有一条接缝）——界面要分开提示 */
      uv: uvInfo,
      /* 角度线框：{deg, edges, drawn}；没开就是 null。界面上要显示「≥N° 时几条线」 */
      crease: creaseInfo,
      /* UV 岛着色：{islands, hasUV, drawn}；没开就是 null */
      uvisland: islandInfo,
      /* 外轮廓描边是否画了（深度/遮罩通道不画：线是脏数据） */
      outline: !!(opts.outline && pass === 'color'),
      /* 深度描边是否画了（同上：只在彩色通道；深度缓冲读不出来时是 false） */
      depthEdge: (depthEdgeOn && depthBuf) ? deInfo : false,
      /* 深度灰是否画了：带上本格模型的深度跨度（归一化后的 0~1），界面要显示 */
      depthGray: (depthGrayOn && depthGrayInfo) ? depthGrayInfo : false,
      /* 图层自检：哪一层抛了错（单个图层失败不拖垮整张图，但要能看见） */
      layerErr: env.layerErr || null,
      /* 这次真正生效的绘制顺序（用户在面板里拖过的结果），测试靠它比对 */
      layers: actLayers.filter(function (L) { return flags[L.flag]; }).map(function (L) { return L.k; }),
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
  var refOpener = null;   // 当前预览的「打开参考图」动作（没有预览时为 null）

  function closePreview() {
    refOpener = null;      // 视口没了，入口也就没了
    if (!pv) return;
    cancelAnimationFrame(pv.raf);
    try { pv.controls && pv.controls.dispose && pv.controls.dispose(); } catch (e) {}
    /* 深度描边的 RT 和 shader 要一起收：它的 RT 是一个额外的帧缓冲 + 深度纹理，
     * 每次开关预览都漏一份的话，多开几次模型就顶到显存上限 */
    try { pv.dout && pv.dout.dispose && pv.dout.dispose(); } catch (e) {}
    try { pv.renderer.dispose(); } catch (e) {}
    if (pv.overlay && pv.overlay.parentNode) pv.overlay.parentNode.removeChild(pv.overlay);
    /* 宿主模式（app 内 .os-win 窗口）：藏窗口 + 清空宿主，renderer 不 dispose 会一直占 WebGL 上下文 */
    if (pv.win) {
      try { pv.win.classList.add('hidden'); } catch (e) {}
    }
    if (pv.host) pv.host.innerHTML = '';
    pv = null;
  }

  async function openPreview(src, opts) {
    opts = opts || {};
    if (!ready()) throw new Error('three.js 未就绪');
    closePreview();

    /* 宿主优先（2026-10-30）：工作台里有 #modelViewHost（3D 查看器 .os-win 窗口）就
     * 装进窗口——和图片编辑器同一套窗口隐喻，不再全屏接管整个屏幕。
     * 独立页（multiview.html 等）没有这个宿主，退回全屏遮罩；opts.host 可显式指定容器。 */
    var hostEl = opts.host || document.getElementById('modelViewHost') || null;
    var winEl = hostEl && hostEl.closest ? hostEl.closest('.os-win') : null;
    var overlay = null, panel = null;

    var stage = document.createElement('div');
    stage.style.cssText = 'flex:1;position:relative;background:#0a0b0e;min-height:0;';
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';
    stage.appendChild(canvas);

    var bar = document.createElement('div');
    bar.className = 'mv3-bar';
    bar.style.cssText = 'flex:0 0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 14px;border-top:1px solid #23262e;background:#111318;';

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

    if (hostEl) {
      /* chrome:false —— 宿主自己带标题栏/关闭按钮（例如嵌在模型库 App 里），
       * 这里就只管渲染本体，不去改外层窗口的标题和关闭行为。 */
      hostEl.innerHTML = '';
      hostEl.appendChild(stage);
      hostEl.appendChild(bar);
      if (opts.chrome !== false) {
        var tEl = winEl && winEl.querySelector('.os-win-title');
        if (tEl) tEl.textContent = opts.title || '3D 预览';
        if (winEl) winEl.classList.remove('hidden');
        /* onclick 覆盖赋值而不是 addEventListener：重复打开不会叠出一排旧监听 */
        var xBtn = winEl && winEl.querySelector('.os-win-close');
        if (xBtn) xBtn.onclick = closePreview;
      }
    } else {
      overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(6,7,10,.86);' +
        'display:flex;align-items:center;justify-content:center;padding:24px;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#e8eaf0;';

      panel = document.createElement('div');
      panel.style.cssText = 'width:min(1100px,96vw);height:min(760px,92vh);background:#111318;border:1px solid #23262e;' +
        'border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.5);';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #23262e;flex:0 0 auto;';
      var title = document.createElement('div');
      title.style.cssText = 'font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      title.textContent = opts.title || '3D 预览';
      head.appendChild(title);

      var closeBtn = mkBtn('关闭', closePreview);
      head.appendChild(closeBtn);
      overlay.appendChild(panel);
      panel.appendChild(head);
      panel.appendChild(stage);
      panel.appendChild(bar);
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closePreview(); });
      document.body.appendChild(overlay);
    }

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
    /* 贴图是 sRGB 的，渲染器不声明 outputEncoding 就会把线性值直接当显示值输出 ——
     * 表现就是「模型发灰发暗，跟原画不是一个颜色」。这一行是颜色正确的前提。 */
    if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    /* 三盏灯而不是一盏：主光给形，补光把暗面提起来（否则白模/哑光一片死黑，看不出形体），
     * 背光勾一圈轮廓，模型边缘不会糊进深色背景里。 */
    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    var dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(1, 1.2, 1);
    scene.add(dir);
    var fill = new THREE.DirectionalLight(0xdce6ff, 0.45);
    fill.position.set(-1.1, 0.5, 0.7);
    scene.add(fill);
    var rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(0.2, 0.6, -1.2);
    scene.add(rim);

    /* near / far 跟着模型尺度走，别抄 0.01 / 1000 这种默认值。
     * 原因不只是近裁面：**深度精度由 near 决定**——透视深度的有效位几乎全压在 near 附近那一小段，
     * near=0.01 而模型上千单位时，1000 米处的深度已经写着 0.99999，
     * 24 位深度纹理的 1 个台阶反算回线性深度就是 6 个世界单位。
     * 深度描边（1 像素 ≈ 0.8 单位）会把同一块平面上的相邻像素全判成「深度断裂」，
     * 整只模型被描黑。near = radius/100 之后量化误差降到 0.05 单位，问题消失。
     * far 收到 radius*50：相机最远也就在 radius*3 附近，留 50 倍余量足够。 */
    var camNear = Math.max(model.radius / 100, 0.001);
    var camFar = Math.max(model.radius * 50, 100);
    var camera = new THREE.PerspectiveCamera(45, 1, camNear, camFar);
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

    /* ---------------- 预览材质（只影响「怎么看」） ----------------
     * 换的是 mesh.material 这张皮，几何 / 贴图 / 文件都不动；原件挂在 mesh.userData.__origMat 上，
     * 切回「原始」原样放回（含贴图插槽面板改过的那份，所以来回切不会丢编辑）。
     * 为什么需要几个预设：
     *   贴图会把结构问题盖住（腿歪一点、肩不对称，上色后完全看不出来）→ 白模 / 哑光用来量形体；
     *   平涂去掉光照，只剩贴图本色 → 判断颜色是否过曝 / 偏色最直接；
     *   法线一眼看出 UV 接缝和翻面。 */
    var MAT_PRESETS = [
      { key: 'original', label: '原始贴图' },
      { key: 'clay', label: '白模' },
      { key: 'matte', label: '哑光灰' },
      { key: 'metal', label: '金属' },
      { key: 'flat', label: '平涂' },
      { key: 'normal', label: '法线' }
    ];
    var curPreset = 'original';
    var presetCache = {};      // key -> Map(mesh.uuid -> material)，flat 要按 mesh 的贴图各做一份
    var envTex = null;

    /* 金属没有环境贴图就是一坨黑：现场烘一张 64×32 的等距柱状渐变当环境光，
     * 只在选「金属」时挂到 scene.environment，切走就摘掉（不影响别的预设的观感）。 */
    function ensureEnv() {
      if (envTex) return envTex;
      var c = document.createElement('canvas');
      c.width = 64; c.height = 32;
      var x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, 0, 32);
      g.addColorStop(0, '#e9eef7'); g.addColorStop(0.45, '#8f97a6'); g.addColorStop(1, '#2a2f38');
      x.fillStyle = g; x.fillRect(0, 0, 64, 32);
      var hot = x.createRadialGradient(46, 8, 0, 46, 8, 14);
      hot.addColorStop(0, 'rgba(255,252,240,.95)'); hot.addColorStop(1, 'rgba(255,252,240,0)');
      x.fillStyle = hot; x.fillRect(0, 0, 64, 32);
      envTex = new THREE.CanvasTexture(c);
      envTex.mapping = THREE.EquirectangularReflectionMapping;
      if ('encoding' in envTex) envTex.encoding = THREE.sRGBEncoding;
      return envTex;
    }

    function makePresetMat(key, origMat) {
      var m;
      if (key === 'clay') {
        m = new THREE.MeshStandardMaterial({ color: 0xe7e3dc, metalness: 0, roughness: 0.62, side: THREE.FrontSide });
      } else if (key === 'matte') {
        m = new THREE.MeshStandardMaterial({ color: 0x9aa3af, metalness: 0, roughness: 0.85 });
      } else if (key === 'metal') {
        m = new THREE.MeshStandardMaterial({ color: 0xd6dae2, metalness: 1, roughness: 0.26 });
      } else if (key === 'flat') {
        /* 平涂必须带各自的 map，否则全白什么都看不出来 */
        m = new THREE.MeshBasicMaterial({ map: (origMat && origMat.map) || null });
      } else if (key === 'normal') {
        m = new THREE.MeshNormalMaterial();
      }
      if (m && origMat) {
        m.transparent = !!origMat.transparent;
        m.side = origMat.side != null ? origMat.side : THREE.FrontSide;
      }
      return m;
    }

    function applyPreset(key) {
      if (!matGroup) return;
      curPreset = key;
      if (key === 'original') {
        matGroup.traverse(function (o) {
          if (o.isMesh && o.userData && o.userData.__origMat) {
            o.material = o.userData.__origMat;
            delete o.userData.__origMat;
          }
        });
        scene.environment = null;
      } else {
        if (!presetCache[key]) presetCache[key] = {};
        var cache = presetCache[key];
        matGroup.traverse(function (o) {
          if (!o.isMesh || !o.material) return;
          if (!o.userData.__origMat) o.userData.__origMat = o.material;
          var pick = cache[o.uuid];
          if (!pick) {
            pick = cache[o.uuid] = makePresetMat(key, o.userData.__origMat);
          }
          o.material = pick;
        });
        scene.environment = (key === 'metal') ? ensureEnv() : null;
      }
      /* 线框模式和材质预设是两个维度：开着线框时切预设，把用户拉回实体，
       * 否则点半天没反应（线框组本来就不吃材质）。 */
      if (curMode === 'wire') setMode('material');
      syncPresetChips();
      /* 换预设 = 换了一批新材质（没打 polygonOffset），描边会被面咬掉，重推一次 */
      if (seamMesh) pushBackDepth(scene);
    }

    function syncPresetChips() {
      for (var i = 0; i < presetBtns.length; i++) {
        var b = presetBtns[i];
        b.classList.toggle('on', b.getAttribute('data-mv-preset') === curPreset);
      }
    }

    var presetRow = document.createElement('div');
    presetRow.className = 'mv3-presets';
    var presetBtns = [];
    MAT_PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mv3-preset';
      b.setAttribute('data-mv-preset', p.key);
      b.textContent = p.label;
      b.addEventListener('click', function () { applyPreset(p.key); });
      presetRow.appendChild(b);
      presetBtns.push(b);
    });
    bar.appendChild(presetRow);
    syncPresetChips();

    /* ---------------- UV 描边（3D 视口里的开关） ----------------
     * 只加一层线，不动材质、不进预设——它是「怎么看」的东西（检查展 UV / 找翻面接缝）。
     * 描边几何按需算（扫一遍模型的所有三角形），关掉就 dispose，不常驻。 */
    var seamMesh = null, seamBtn = null;
    function toggleSeam() {
      if (seamMesh) {
        scene.remove(seamMesh);
        try { seamMesh.geometry.dispose(); seamMesh.material.dispose(); } catch (e) {}
        seamMesh = null;
        if (seamBtn) { seamBtn.style.borderColor = '#2c303a'; seamBtn.style.color = '#e8eaf0'; }
        hint.textContent = 'UV 描边已关闭';
        return;
      }
      var dbs = renderer.getDrawingBufferSize(new THREE.Vector2());
      var dpr = renderer.getPixelRatio() || 1;
      var r = addUvSeams(scene, model, {
        lineWidth: 2.4 * dpr, lineColor: '#ff2d78', res: [dbs.x, dbs.y]
      });
      seamMesh = r.mesh;
      if (!seamMesh) {
        hint.textContent = r.hasUV ? '这个模型没有 UV 接缝（整片 UV 连着）' : '模型没有 UV，画不出 UV 岛';
        return;
      }
      if (seamBtn) { seamBtn.style.borderColor = '#a3345e'; seamBtn.style.color = '#ffb3cd'; }
      hint.textContent = 'UV 描边：' + r.edges + ' 条接缝';
    }
    seamBtn = mkBtn('UV 描边', toggleSeam);
    bar.appendChild(seamBtn);


    /* 材质插槽面板：模型库「设置贴图」的入口（插槽列表 / 选图 / 导出 GLB） */
    var slotUI = setupSlotPanel({
      model: model, stage: stage, bar: bar, mkBtn: mkBtn, hint: hint, title: opts.title, assetId: opts.assetId,
      /* 打开插槽面板时先退出 UV：面板是 3D 视口右侧的抽屉，两层叠着看不清 */
      onPanelOpen: function () {
        if (uv && uv.on) uvClose();
        /* 换贴图要在「原始贴图」下看，否则白模/平涂顶着，改完毫无反馈 */
        if (curPreset !== 'original') applyPreset('original');
      }
    });

    /* 参考图：结构参考 + 着色参考，存在资产库里（见 js/model-refs.js）。
     * 这里只挂一个入口；面板自己管上传 / 清除 / 发到 AI 对话。 */
    if (global.ModelRefs && opts.assetId) {
      /* 打开动作抽成具名函数：按钮点击和「模型库磁贴上的参考入口」走同一条路。
       * 不要再经由 refBtn.click() 转发——宿主重绘时旧按钮会脱链（isConnected 为 false），
       * 点了个空。 */
      var openRefPanel = function () {
        if (uv && uv.on) uvClose();
        return global.ModelRefs.panel(stage, {
          modelId: opts.assetId,
          modelName: opts.title || '',
          onChange: function (ids) {
            var n = (ids.struct ? 1 : 0) + (ids.color ? 1 : 0);
            refBtn.textContent = n ? ('参考图 ' + n) : '参考图';
            refBtn.classList.toggle('mv3-has-ref', n > 0);
          }
        });
      };
      var refBtn = mkBtn('参考图', openRefPanel);
      refOpener = openRefPanel;
      bar.appendChild(refBtn);
      /* 已经配过参考图的模型，按钮上直接标数量：不用点进去才知道有没有 */
      try {
        var initIds = global.ModelRefs.get(opts.assetId);
        var n0 = (initIds.struct ? 1 : 0) + (initIds.color ? 1 : 0);
        if (n0) { refBtn.textContent = '参考图 ' + n0; refBtn.classList.add('mv3-has-ref'); }
      } catch (e) {}
    }


    /* ---------------- UV 视图（并入查看器内部） ----------------
     * 以前 UV 是库窗口里另一层浅色浮层，和 3D 查看器是两套界面。这里把它并进来：
     * 同一个视口里按「UV 查看」切过去，岛图 / 3D 岛图 / 编号 / 插槽隔离 / 分辨率 /
     * 导出都在这一层，配色沿用 3D 视口的深色语言，不再跳窗口也不再换主题。
     * 分析走 ModelTex（它会自己再 load 一次模型），首次进入 UV 才算，3D 不受影响。 */
    var uvName = String(opts.title || '模型').replace(/\.(glb|gltf|obj|fbx|stl|ply|3mf|usdz)$/i, '');
    var uv = {
      on: false, layer: null, a: null, busy: false, err: '',
      mode: 'atlas', part: 'all', labels: true, size: 1024,
      atlas: null, preview: '', previewBusy: false, partIslands: [],
      /* 排布状态：scale=滑杆（相对原始 UV 的倍率），snap=第一次动手前留的基线，
       * applied=排过没（决定「还原 / 存为 GLB」可不可点） */
      pk: { scale: 100, density: false, fill: 0, note: '', snap: null, busy: false, applied: false, saving: false }
    };
    var uvBtn = mkBtn('UV 查看', function () { uvToggle(); });
    bar.appendChild(uvBtn);
    /* 外层窗口（模型库）靠它知道现在是 UV 还是 3D，好把副标题换成对应的操作提示 */
    var notifyUv = opts.onUvState;

    function uvEsc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }
    function uvColor(id) {
      return 'hsl(' + ((id * 137.508) % 360).toFixed(1) + ',72%,58%)';
    }
    function ensureUvStyle() {
      if (document.getElementById('mv3UvStyle')) return;
      var st = document.createElement('style');
      st.id = 'mv3UvStyle';
      st.textContent = [
        '.mv3-uv{position:absolute;inset:0;display:none;flex-direction:column;background:#0a0b0e;z-index:4;}',
        '.mv3-uv.on{display:flex;}',
        '.mv3-uv-head{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid #23262e;background:#111318;}',
        '.mv3-uv-brand{display:flex;flex-direction:column;gap:1px;margin-right:auto;min-width:0;}',
        '.mv3-uv-kicker{font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#e88a00;}',
        '.mv3-uv-name{font-size:13px;font-weight:600;color:#e8eaf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw;}',
        '.mv3-uv-sub{font-size:10.5px;color:#8b90a0;font-variant-numeric:tabular-nums;}',
        '.mv3-uv-chip{padding:4px 10px;border-radius:7px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;font-size:12px;cursor:pointer;line-height:1.4;font-family:inherit;}',
        '.mv3-uv-chip.on{border-color:#e88a00;background:#241c10;color:#ffb453;}',
        '.mv3-uv-chip:disabled{opacity:.45;cursor:default;}',
        '.mv3-uv-main{flex:1;min-height:0;display:flex;}',
        '.mv3-uv-stage{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:10px;position:relative;',
          'background-color:#0a0b0e;',
          'background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);',
          'background-size:24px 24px;}',
        '.mv3-uv-img{max-width:100%;max-height:100%;display:block;object-fit:contain;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.45);}',
        '.mv3-uv-state{display:flex;align-items:center;gap:8px;font-size:12px;color:#c6ccd6;}',
        '.mv3-uv-state.err{color:#ff9a90;max-width:90%;line-height:1.6;}',
        '.mv3-uv-spin{width:14px;height:14px;border-radius:50%;flex:0 0 auto;border:2px solid rgba(255,255,255,.18);border-top-color:#e88a00;animation:mv3UvSpin .8s linear infinite;}',
        '@keyframes mv3UvSpin{to{transform:rotate(360deg);}}',
        '.mv3-uv-side{flex:0 0 208px;width:208px;display:flex;flex-direction:column;gap:12px;padding:12px;border-left:1px solid #23262e;background:#0d0f14;overflow-y:auto;color:#c6ccd6;}',
        '.mv3-uv-sec{display:flex;flex-direction:column;gap:4px;}',
        '.mv3-uv-h{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8b90a0;}',
        '.mv3-uv-kv{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:11.5px;color:#a8aeba;}',
        '.mv3-uv-kv b{font-weight:600;color:#e8eaf0;font-variant-numeric:tabular-nums;}',
        '.mv3-uv-island{display:flex;align-items:center;gap:7px;padding:4px 7px;border-radius:6px;background:#171a21;font-size:10.5px;color:#a8aeba;}',
        '.mv3-uv-island b{color:#e8eaf0;font-variant-numeric:tabular-nums;}',
        '.mv3-uv-island span{margin-left:auto;font-variant-numeric:tabular-nums;color:#8b90a0;}',
        '.mv3-uv-dot{flex:0 0 auto;width:9px;height:9px;border-radius:3px;}',
        /* UV 排布：滑杆 + 整行按钮 + 两列小按钮 */
        '.mv3-uv-slider{display:flex;align-items:center;gap:8px;}',
        '.mv3-uv-slider input{flex:1;min-width:0;height:16px;accent-color:#e88a00;cursor:pointer;}',
        '.mv3-uv-slider b{flex:0 0 auto;min-width:36px;text-align:right;font-size:11.5px;font-weight:600;color:#e8eaf0;font-variant-numeric:tabular-nums;}',
        '.mv3-uv-wide{width:100%;padding:6px 8px;border-radius:7px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;font-size:12px;font-family:inherit;cursor:pointer;line-height:1.4;}',
        '.mv3-uv-wide:hover{border-color:#3a3f4b;}',
        '.mv3-uv-wide.on{border-color:#e88a00;background:#241c10;color:#ffb453;}',
        '.mv3-uv-wide.primary{border-color:#e88a00;background:#e88a00;color:#1a1206;font-weight:700;}',
        '.mv3-uv-wide.primary:hover{background:#ffa52b;}',
        '.mv3-uv-wide:disabled{opacity:.45;cursor:default;}',
        '.mv3-uv-row{display:flex;gap:6px;}',
        '.mv3-uv-row .mv3-uv-chip{flex:1;text-align:center;}',
        '.mv3-uv-hint{font-size:10.5px;line-height:1.6;color:#8b90a0;}',
        '.mv3-uv-tip{margin-top:auto;font-size:10.5px;line-height:1.65;color:#8b90a0;}'
      ].join('\n');
      document.head.appendChild(st);
    }
    function ensureUvLayer() {
      ensureUvStyle();
      if (uv.layer) return uv.layer;
      uv.layer = document.createElement('div');
      uv.layer.className = 'mv3-uv';
      stage.appendChild(uv.layer);
      /* 一层铺在 stage 上，事件统一委托：重绘只改 innerHTML，不重复绑监听 */
      uv.layer.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('[data-uv]') : null;
        if (!el) return;
        uvAct(el.getAttribute('data-uv'), el.getAttribute('data-v'));
      });
      /* 滑杆走 input 而不是 click：拖动过程中只改数字和一个文本节点，
       * 绝不能让 uvRender 重建 innerHTML——那样滑杆会在拖动中途被销毁，手感直接废掉。 */
      uv.layer.addEventListener('input', function (e) {
        var el = e.target;
        if (!el || !el.getAttribute || el.getAttribute('data-uvrange') !== 'scale') return;
        uv.pk.scale = Math.round(Number(el.value) || 100);
        var lab = uv.layer.querySelector('[data-uvscale]');
        if (lab) lab.textContent = uv.pk.scale + '%';
      });
      return uv.layer;
    }
    function uvAct(act, val) {
      if (act === 'back') { uvClose(); return; }
      if (act === 'mode') {
        if (uv.mode === val) return;
        uv.mode = val;
        uvRender();
        if (val === '3d' && !uv.preview) uvPreview();
      } else if (act === 'part') {
        if (uv.part === val) return;
        uv.part = val;
        uvBuildAtlas(); uv.preview = ''; uvRender();
        if (uv.mode === '3d') uvPreview();
      } else if (act === 'labels') {
        uv.labels = !uv.labels; uvBuildAtlas(); uv.preview = ''; uvRender();
      } else if (act === 'size') {
        uv.size = uv.size === 1024 ? 2048 : 1024; uvBuildAtlas(); uv.preview = ''; uvRender();
      } else if (act === 'density') {
        uv.pk.density = !uv.pk.density; uvRender();
      } else if (act === 'pack') {
        uvPackRun();
      } else if (act === 'pkreset') {
        uvPackReset();
      } else if (act === 'pksave') {
        uvSaveGlb();
      } else if (act === 'export') {
        uvExport();
      }
    }
    function uvAtlasCanvas(forPreview) {
      var o = { labels: uv.labels };
      if (uv.part !== 'all') o.parts = [Number(uv.part)];
      if (forPreview) o.bg = '#ffffff';
      return global.ModelTex.islandAtlas(uv.a, uv.size, o);
    }
    function uvBuildAtlas() {
      uv.atlas = null;
      if (!uv.a || !global.ModelTex) return;
      try { uv.atlas = uvAtlasCanvas(false); }
      catch (e) { uv.err = '生成 UV 岛图失败：' + ((e && e.message) || e); }
    }
    async function uvPreview() {
      if (!uv.a || uv.previewBusy || !global.ModelTex) return;
      uv.previewBusy = true;
      uvRender();
      try {
        await new Promise(function (r) { setTimeout(r, 0); });   // 先让「渲染中」上屏
        uv.preview = global.ModelTex.previewGrid(uv.a, uvAtlasCanvas(true), {
          cell: 320, angles: [0, 35, 180], compare: false,
          paintedLabel: uv.part === 'all' ? '岛图' : ('插槽 ' + (Number(uv.part) + 1)),
          texLabel: 'UV 岛图'
        });
      } catch (e) {
        uv.err = '渲染 3D 岛图失败：' + ((e && e.message) || e);
      } finally {
        uv.previewBusy = false;
        uvRender();
      }
    }
    function uvExport() {
      if (!global.ModelTex || !global.ModelTex.download) return;
      var base = uvName.replace(/[\\/:*?"<>|]/g, '_');
      if (uv.mode === '3d' && uv.preview) global.ModelTex.download(base + '_3d_islands.png', uv.preview);
      else if (uv.atlas) global.ModelTex.download(base + '_uv_' + uv.size + '.png', uv.atlas.toDataURL('image/png'));
    }

    /* ---------------- UV 排布：调节岛大小 + 自动装箱 ----------------
     * 滑杆是参数、按钮是动作，不合成一个：
     *   拖动中就改几何的话，一来看不到「改动前后差在哪」，二来每拖一格都要重算装箱，
     *   手感直接废。所以滑杆只记数，「自动排布」才动几何。
     * 每次都从 snap 基线重来（restore → pack → apply）：这样 100% 恒等于模型原始尺寸，
     * 连点两次不会越缩越小，滑杆也才有确定含义。 */
    async function uvPackRun() {
      if (!uv.a || uv.pk.busy) return;
      var P = global.UvPack;
      if (!P) { uv.err = 'UV 排布模块未就绪（uvpack.js 未加载）'; uvRender(); return; }
      uv.pk.busy = true; uv.err = ''; uv.pk.note = '';
      uvRender();
      await new Promise(function (r) { setTimeout(r, 0); });   // 先让「排布中」上屏
      try {
        if (!uv.pk.snap) uv.pk.snap = P.snapshot(uv.a);
        P.restore(uv.a, uv.pk.snap);
        var r = P.pack(uv.a, { scale: uv.pk.scale / 100, equalDensity: uv.pk.density });
        if (!r.ok) throw new Error('没有可排布的 UV 岛');
        P.apply(uv.a, r.ops);
        P.refresh(uv.a);
        /* 几何写完就算排布成功（还原 / 存 GLB 必须可用），贴图是附加一步：
         * 贴图重采样挂了不该让整个操作变成「失败但几何已经改了」的中间态。 */
        uv.pk.applied = true;
        uv.pk.fill = r.fill;
        var notes = (r.notes || []).slice();
        var rm = null;
        try {
          rm = P.remapTextures(uv.a, uv.pk.snap);
        } catch (e2) {
          notes.push('贴图重采样失败：' + ((e2 && e2.message) || e2) + '（建议存 GLB 后重新上色）');
        }
        if (rm && rm.count) notes.push(rm.count + ' 张贴图已按新 UV 重采样');
        uv.pk.note = notes.join('；') || ('已按 ' + uv.pk.scale + '% 排满 0–1 UV');
        uvBuildAtlas();
        uv.preview = '';
      } catch (e) {
        uv.err = '排布失败：' + ((e && e.message) || e);
      } finally {
        uv.pk.busy = false;
        uvRender();
        if (uv.mode === '3d' && !uv.err) uvPreview();
      }
    }

    async function uvPackReset() {
      if (!uv.a || !uv.pk.snap || uv.pk.busy) return;
      var P = global.UvPack;
      if (!P) return;
      uv.pk.busy = true; uv.err = ''; uv.pk.note = '';
      uvRender();
      await new Promise(function (r) { setTimeout(r, 0); });
      try {
        P.restore(uv.a, uv.pk.snap);
        uv.pk.snap = null;        // 基线已经还回去了，下次排布重新拍一份
        uv.pk.applied = false; uv.pk.fill = 0;
        uvBuildAtlas(); uv.preview = '';
      } catch (e) {
        uv.err = '还原失败：' + ((e && e.message) || e);
      } finally {
        uv.pk.busy = false; uvRender();
        if (uv.mode === '3d' && !uv.err) uvPreview();
      }
    }

    /* 排布结果只活在 UV 视图里（3D 视口那份模型是另一次 load 的实例）。
     * 出口是「存为 GLB」：新 UV + 重采样后的贴图一起内嵌，入库后从模型库打开即是新排布。 */
    async function uvSaveGlb() {
      var P = global.UvPack;
      if (!uv.a || !P || uv.pk.saving) return;
      uv.pk.saving = true; uv.pk.note = '正在导出 GLB…'; uv.err = '';
      uvRender();
      try {
        var buf = await P.exportGLB(uv.a);
        var url = bufToDataURL(buf, 'model/gltf-binary');
        var nm = (uvName.replace(/[\\/:*?"<>|]/g, '_') || 'model') + '_UV排布.glb';
        var d = window.openagiDesktop;
        if (!(d && typeof d.assetPut === 'function')) {
          saveDataURL(nm, url);
          uv.pk.note = '浏览器里存不进模型库，已改为下载 GLB';
          return;
        }
        var r = await d.assetPut({ kind: 'model', ext: 'glb', name: nm, data: url, source: 'uvpack' });
        if (!(r && r.ok && r.asset && r.asset.id)) throw new Error((r && r.message) || '入库失败');
        /* 缩略图顺手补一张，模型库磁贴直接是新排布的样子（失败不影响入库） */
        try {
          var th = await renderThumb(url, { size: 256 });
          await d.assetThumbSave(r.asset.id, th.dataURL);
        } catch (e2) { }
        uv.pk.note = '已存入模型库：「' + nm + '」';
      } catch (e) {
        uv.err = '导出失败：' + ((e && e.message) || e);
      } finally {
        uv.pk.saving = false;
        uvRender();
      }
    }
    function uvPackHtml() {
      var P = uv.pk;
      var s = '<div class="mv3-uv-sec">' +
        '<div class="mv3-uv-h">UV 排布</div>' +
        '<div class="mv3-uv-slider">' +
          '<input type="range" min="20" max="200" step="5" value="' + P.scale + '" data-uvrange="scale" title="相对原始 UV 的尺寸倍率（100% = 模型本身的尺寸）">' +
          '<b data-uvscale>' + P.scale + '%</b>' +
        '</div>' +
        '<button type="button" class="mv3-uv-wide' + (P.density ? ' on' : '') + '" data-uv="density" data-v="1"' +
          ' title="按 3D 面积给每个岛分配 UV 面积：贴图精度均匀，不会大岛吃满、小岛只剩几个像素">' +
          '统一贴图密度' + (P.density ? ' · 开' : '') + '</button>' +
        '<button type="button" class="mv3-uv-wide primary" data-uv="pack" data-v="1"' + (P.busy ? ' disabled' : '') + '>' +
          (P.busy ? '排布中…' : '自动排布') + '</button>' +
        '<div class="mv3-uv-row">' +
          '<button type="button" class="mv3-uv-chip" data-uv="pkreset" data-v="1"' + (P.applied && !P.busy ? '' : ' disabled') + '>还原</button>' +
          '<button type="button" class="mv3-uv-chip" data-uv="pksave" data-v="1"' + (P.applied && !P.busy ? '' : ' disabled') + '>存为 GLB</button>' +
        '</div>' +
        (P.fill > 0 ? '<div class="mv3-uv-kv"><span>UV 占用</span><b>' + Math.round(P.fill * 100) + '%</b></div>' : '') +
        (P.note ? '<div class="mv3-uv-hint">' + uvEsc(P.note) + '</div>' : '') +
        '<div class="mv3-uv-hint">' + (P.applied
          ? '排布只在本视图和导出的 GLB 里生效；3D 视口要重新打开新文件才看得到。'
          : '滑杆定尺寸，排布按它重新装箱；贴图会跟着重采样，不会错位。') + '</div>' +
        '</div>';
      return s;
    }
    function uvStatHtml() {
      var a = uv.a;
      if (!a) return '';
      var tris = a.parts.reduce(function (n, p) { return n + p.tri; }, 0);
      var num = uv.part === 'all' ? -1 : Number(uv.part);
      var shown = uv.part === 'all' ? a.islands : a.islands.filter(function (o) {
        return o.tris.some(function (r) { return r.part === num; });
      });
      var slotTris = uv.part === 'all' ? tris : a.parts[num].tri;
      /* UV 空间组：共用一张贴图的网格必须装在同一份 0–1 里。
       * 多网格模型的「插槽数」和「UV 空间数」经常不是一回事（一个 OBJ 里几个 object 摊在同一张 UV 上），
       * 这里把两者都摆出来，免得看到「3 网格 / 1 组」以为坏了。 */
      var grp = (global.UvPack && global.UvPack.groups) ? global.UvPack.groups(a) : [];
      var kv = function (k, v) { return '<div class="mv3-uv-kv"><span>' + k + '</span><b>' + v + '</b></div>'; };
      var rng = function (o) { return o.bbox[1].toFixed(1) + '–' + o.bbox[4].toFixed(1); };
      return '<div class="mv3-uv-sec"><div class="mv3-uv-h">概览</div>' +
          kv('UV 岛', uv.part === 'all' ? shown.length : (shown.length + ' / ' + a.islands.length)) +
          kv('三角面', slotTris) +
          kv('网格', a.parts.length) +
          (a.parts.length > 1 ? kv('UV 空间', grp.length + ' 组') : '') +
          (a.parts.length > 1 ? kv('当前插槽', uv.part === 'all' ? '全部' : ('#' + (num + 1))) : '') +
          kv('UV 图', uv.size + ' × ' + uv.size) +
        '</div>' +
        uvPackHtml() +
        '<div class="mv3-uv-sec"><div class="mv3-uv-h">最大的岛</div>' +
          shown.slice(0, 6).map(function (o) {
            return '<div class="mv3-uv-island">' +
              '<i class="mv3-uv-dot" style="background:' + uvColor(o.id) + '"></i>' +
              '<b>#' + o.id + '</b>' +
              '<span>' + o.tris.length + ' 面 · y ' + rng(o) + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
        '<div class="mv3-uv-tip">' + (a.parts.length > 1
          ? (grp.length === 1
            ? '这 ' + a.parts.length + ' 个网格共用同一张 UV（同一套布局），排布时会一起装进 0–1。'
            : '这个模型有 ' + a.parts.length + ' 个网格、' + grp.length + ' 份独立 UV 空间（各自一张贴图），每份分别装进 0–1。')
          : '岛编号可以直接写进「模型区域上色」的区域规则与细节规则，用来定位部位。') + '</div>';
    }
    function uvRender() {
      if (!uv.layer) return;
      var a = uv.a;
      var sub = a
        ? (a.islands.length + ' 个 UV 岛 · ' + a.parts.reduce(function (n, p) { return n + p.tri; }, 0) + ' 三角面' +
           (uv.pk.applied ? ' · 已排布' : ''))
        : (uv.busy ? '读取模型中…' : '等待分析');
      var chip = function (act, val, label, on, title) {
        return '<button type="button" class="mv3-uv-chip' + (on ? ' on' : '') + '" data-uv="' + act + '" data-v="' + val + '"' +
          (title ? ' title="' + uvEsc(title) + '"' : '') + '>' + label + '</button>';
      };
      var slots = (a && a.parts.length > 1)
        ? chip('part', 'all', '全部', uv.part === 'all') +
          a.parts.map(function (p, i) {
            return chip('part', String(i), '插槽 ' + (i + 1), uv.part === String(i),
              p.tri + ' 面 · ' + (uv.partIslands[i] || 0) + ' 个岛');
          }).join('')
        : '';
      var stageHtml;
      if (uv.err) stageHtml = '<div class="mv3-uv-state err">' + uvEsc(uv.err) + '</div>';
      else if (uv.busy) stageHtml = '<div class="mv3-uv-state"><span class="mv3-uv-spin"></span>正在分析 UV 岛…</div>';
      else if (!a) stageHtml = '<div class="mv3-uv-state">准备中…</div>';
      else if (uv.mode === '3d') {
        stageHtml = uv.preview
          ? '<img class="mv3-uv-img" src="' + uv.preview + '" alt="3D 岛图">'
          : '<div class="mv3-uv-state"><span class="mv3-uv-spin"></span>正在渲染 3D 岛图…</div>';
      } else {
        stageHtml = uv.atlas
          ? '<img class="mv3-uv-img" src="' + uv.atlas.toDataURL('image/png') + '" alt="UV 岛图">'
          : '<div class="mv3-uv-state">准备中…</div>';
      }
      uv.layer.innerHTML =
        '<div class="mv3-uv-head">' +
          '<div class="mv3-uv-brand">' +
            '<span class="mv3-uv-kicker">UV 查看</span>' +
            '<b class="mv3-uv-name" title="' + uvEsc(uvName) + '">' + uvEsc(uvName) + '</b>' +
            '<span class="mv3-uv-sub">' + uvEsc(sub) + '</span>' +
          '</div>' +
          chip('mode', 'atlas', 'UV 岛图', uv.mode === 'atlas') +
          chip('mode', '3d', '3D 岛图', uv.mode === '3d') +
          slots +
          chip('labels', '1', '编号', uv.labels, '在面积足够大的岛上标出编号') +
          chip('size', '1', uv.size, false, '切换 UV 图分辨率') +
          chip('export', '1', '导出 PNG', false) +
          chip('back', '1', '返回 3D', false) +
        '</div>' +
        '<div class="mv3-uv-main">' +
          '<div class="mv3-uv-stage">' + stageHtml + '</div>' +
          '<aside class="mv3-uv-side">' + uvStatHtml() + '</aside>' +
        '</div>';
    }
    function uvToggle() {
      if (uv.on) uvClose();
      else uvOpen();
    }
    async function uvOpen() {
      ensureUvLayer();
      uv.on = true;
      uv.layer.classList.add('on');
      /* UV 是完整的另一屏：底栏那几个 3D 专用按钮（线框 / 朝向 / 四视图）在这层没意义，
       * 直接收起，回到 3D 时再出现；插槽抽屉也一样收起，免得两面叠在一起。 */
      canvas.style.display = 'none';
      bar.style.display = 'none';
      if (slotUI && slotUI.hide) slotUI.hide();
      uvBtn.textContent = '返回 3D';
      if (typeof notifyUv === 'function') notifyUv(true);
      if (!global.ModelTex) {
        uv.err = 'UV 分析模块未就绪（modeltex.js 未加载）';
        uvRender();
        return;
      }
      if (!uv.a && !uv.busy) {
        uv.busy = true; uv.err = '';
        uvRender();
        try {
          uv.a = await global.ModelTex.analyze(src);
          uv.partIslands = uv.a.parts.map(function (p, i) {
            return uv.a.islands.filter(function (o) {
              return o.tris.some(function (r) { return r.part === i; });
            }).length;
          });
          uvBuildAtlas();
        } catch (e) {
          uv.err = 'UV 分析失败：' + ((e && e.message) || e);
        } finally {
          uv.busy = false;
          uvRender();
        }
      } else {
        uvRender();
      }
    }
    function uvClose() {
      uv.on = false;
      if (uv.layer) uv.layer.classList.remove('on');
      canvas.style.display = '';
      bar.style.display = '';
      uvBtn.textContent = 'UV 查看';
      if (typeof notifyUv === 'function') notifyUv(false);
      resize();
    }

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

    /* ---------------- 深度像素描边：工具条开关 + 弹层两个滑条 ----------------
     * 滑条为什么不放工具条里：工具条已经到「前/后/左/右/顶/轴测 + 导出」了，
     * 再塞两个 range 会把按钮挤成两行、每次开关还抖一下。弹层固定在视口右上角，
     * 开的时候才出现，参数改完立刻生效（每帧都在重画）。 */
    var dout = createDepthOutline({ renderer: renderer, scene: scene, camera: camera });
    var doutPop = null;

    function ensureDoutPop() {
      if (doutPop) return doutPop;
      doutPop = document.createElement('div');
      doutPop.className = 'mv3-dout';
      doutPop.innerHTML =
        '<div class="mv3-dout-h">深度描边</div>' +
        '<label class="mv3-dout-row"><span>阈值</span>' +
          '<input type="range" min="0.5" max="12" step="0.5" value="' + dout.params.threshold + '" data-dout="threshold">' +
          '<b>' + Number(dout.params.threshold).toFixed(1) + '</b></label>' +
        '<label class="mv3-dout-row"><span>线宽</span>' +
          '<input type="range" min="0.5" max="4" step="0.5" value="' + dout.params.width + '" data-dout="width">' +
          '<b>' + Number(dout.params.width).toFixed(1) + '</b></label>' +
        '<div class="mv3-dout-tip">阈值 = 深度跳变相当于几个像素的倾斜。数字越小线越多；调到 8 以上只剩大轮廓。</div>';
      stage.appendChild(doutPop);
      /* 只改 uniform，不重建面板：拖动过程中 DOM 被重建的话滑杆会掉手 */
      doutPop.addEventListener('input', function (e) {
        var el = e.target;
        var k = el && el.getAttribute ? el.getAttribute('data-dout') : null;
        if (!k) return;
        dout.setParam(k, el.value);
        var b = el.parentNode.querySelector('b');
        if (b) b.textContent = Number(dout.params[k]).toFixed(1);
      });
      return doutPop;
    }
    function showDoutPop(v) {
      ensureDoutPop().classList.toggle('on', !!v);
    }

    var doutBtn = mkBtn('深度描边', function () {
      var on = !dout.enabled;
      dout.setEnabled(on);
      doutBtn.style.borderColor = on ? '#e88a00' : '#2c303a';
      doutBtn.style.color = on ? '#ffb453' : '#e8eaf0';
      showDoutPop(on);
      if (on && dout.failed) hint.textContent = '这台设备给不了深度纹理，描边开不了（画面已退回普通渲染）';
      else hint.textContent = on ? '深度描边：勾出所有深度断裂（轮廓 / 遮挡 / 台阶），参数在右上角' : '深度描边已关闭';
    });
    bar.appendChild(doutBtn);

    hint.textContent = '拖拽旋转 · 滚轮缩放 · 右键平移';

    function resize() {
      var w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      /* 深度描边的 RT 跟着视口走：不通知的话窗口拉大会按旧尺寸采样，线会糊成一团 */
      dout.resize(w, h);
      /* UV 描边是屏幕空间扩边，视口一变就得把新的像素尺寸告诉它，
       * 否则窗口拉大后线会跟着变粗（线宽是「像素」不是「世界单位」）。 */
      if (seamMesh && seamMesh.userData && seamMesh.userData.setRes) {
        var pr = renderer.getPixelRatio() || 1;
        seamMesh.userData.setRes(w * pr, h * pr);
        seamMesh.material.uniforms.uWidth.value = 2.4 * pr;
      }
    }
    resize();
    var ro = new ResizeObserver(resize);
    ro.observe(stage);

    function tick() {
      pv.raf = requestAnimationFrame(tick);
      controls.update();
      /* 关闭时这里就是一次普通 render，没有额外开销 */
      dout.draw();
    }
    pv = { overlay: overlay, win: (hostEl && opts.chrome !== false) ? winEl : null, host: hostEl, renderer: renderer, controls: controls, raf: 0, ro: ro, dout: dout };
    tick();

    /* 库里的「UV 查看」入口：直接以 UV 模式打开，不用先看 3D 再切 */
    /* 初始状态放到最后再描：上面那行「拖拽旋转…」会把 hint 覆盖掉，
     * 先描的话用户永远看不到「N 条接缝」这句 */
    if (opts.uvEdge) toggleSeam();
    if (opts.uv) uvOpen();

    return true;
  }

  /* ---------------- 材质插槽：查看 + 纹理混合 + 导出 GLB ----------------
   * 模型库「设置贴图」的入口（2026-10-30）：预览弹窗里列出模型全部材质插槽
   * （按材质去重，一个材质可能被多个 mesh 共用），每个槽可以：
   *   ① 纹理混合（2026-10-31 起）：图层栈，每层可各自调「混合模式 + 比例 + 遮罩」；
   *   ② 清除混合 → 回到模型自带贴图；
   *   ③ 整体导出 GLB（合成贴图内嵌）→ 存回模型库 / 下载。
   *
   * 为什么是「烘一张图」而不是着色器里混：
   *   GLB 导出只认 mat.map 一张图，用 onBeforeCompile 混出来的只有视口好看，导出后是空的。
   *   这里把每层按 比例 × 遮罩 × 混合模式 烘进 canvas 再当贴图用，
   *   视口 / 缩略图 / GLB 内嵌图三处永远是同一张，不会「预览对了导出不对」。
   *
   * 为什么存 GLB 而不是 OBJ+MTL+PNG 三件套：
   *   资产库一个资产就是一个文件，三件套拆成三个资产后文件名互不相干，
   *   模型库双击预览走 OBJLoader（不带 MTL），看到的仍是灰模。
   *   GLB 把贴图嵌进文件本身，导出即所见，任何查看器打开都带贴图。
   *
   * flipY 的坑：glTF 的 UV 按「纹理不翻转」设计（GLTFLoader 里 flipY=false），
   * OBJ 走传统约定（flipY=true）。合成贴图必须跟槽里原有贴图保持一致——
   * 槽里没有贴图时按模型格式兜底，否则 GLB 模型贴图会上下颠倒。
   */
  function setupSlotPanel(deps) {
    var model = deps.model, stage = deps.stage, bar = deps.bar;
    var mkBtn = deps.mkBtn, hint = deps.hint;
    var baseName = String(deps.title || 'model')
      .replace(/\.(glb|gltf|obj|fbx|stl|ply|3mf|usdz)$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_') || 'model';

    var panel = null, listEl = null;
    var picker = null, pickerAlive = false;
    var mixer = null, mixerAlive = false, mixerSlot = null, mixBody = null;
    var fileInput = null;

    /* 单槽最多叠几层：再多滑杆也调不动，配置也会失控 */
    var MIX_LIMIT = 8;
    /* 合成画布长边上限：结果要内嵌进 GLB，4096 会让文件翻几倍，2048 已经够看 */
    var MIX_MAX_SIDE = 2048;

    /* 混合模式 → canvas 合成算子。名字沿用设计软件的说法；
     * 「相加」用 lighter——它既是唯一会让结果整体变亮的模式，也是发光层要的效果。 */
    var BLEND_MODES = [
      { key: 'normal', label: '正常', op: 'source-over' },
      { key: 'multiply', label: '正片叠底', op: 'multiply' },
      { key: 'screen', label: '滤色', op: 'screen' },
      { key: 'overlay', label: '叠加', op: 'overlay' },
      { key: 'softlight', label: '柔光', op: 'soft-light' },
      { key: 'add', label: '相加', op: 'lighter' },
      { key: 'darken', label: '变暗', op: 'darken' },
      { key: 'lighten', label: '变亮', op: 'lighten' }
    ];
    function blendOp(key) {
      for (var i = 0; i < BLEND_MODES.length; i++) if (BLEND_MODES[i].key === key) return BLEND_MODES[i].op;
      return 'source-over';
    }

    /* ---------------- 贴图配置持久化 ----------------
     * 资产库里的模型只存几何，贴图/遮罩是「查看器里的设置」，关掉窗口就没了。
     * 这里把「模型资产 id → 材质槽 → 混合层」记进 localStorage：
     * 图层与遮罩图片本身落进资产库（assetPut kind:'image'），配置只存 id 不存 base64，
     * 免得几张 2048 贴图把 5MB 的 localStorage 配额撑爆。
     * 没有桌面桥（纯网页版）时无法落盘，退化为「本次会话内有效」。
     *
     * 格式演进（别改 key，旧配置要能读）：
     *   v2 = { v:2, layers:[{id,name,flipY,opacity,blend,mask:{id,name,flipY,invert}}] }
     *   v1 = { id,name,flipY }   ← 旧版单贴图，读的时候当成一层，用户配好的贴图不会丢
     */
    var assetId = String(deps.assetId || '');
    var TEX_KEY = 'openagi_model_tex_v1';

    function readTexCfg() {
      try {
        var j = JSON.parse(localStorage.getItem(TEX_KEY) || '{}');
        return (j && typeof j === 'object') ? j : {};
      } catch (e) { return {}; }
    }
    function writeTexCfg(all) {
      try { localStorage.setItem(TEX_KEY, JSON.stringify(all)); } catch (e) { }
    }
    /* 槽的稳定标识：优先材质名（OBJ 的 usemtl 名、glTF 材质名都稳定），
     * 匿名材质退回遍历序号（模型文件不变，遍历顺序也不变）。 */
    function slotKey(slot) {
      if (slot.mat && slot.mat.name) return String(slot.mat.name);
      var ss = collectSlots();
      for (var i = 0; i < ss.length; i++) {
        if (ss[i].mat === slot.mat) return 'slot' + i;
      }
      return 'slot0';
    }
    function slotCfg() {
      if (!assetId) return null;
      var all = readTexCfg();
      var m = all[assetId];
      return (m && typeof m === 'object') ? { all: all, map: m } : null;
    }
    /* 只存「读得回来」的层：没有资产 id 的层（网页版上传、磁盘没落住）下次必丢，
     * 那就别写进配置——写了只会让人以为配过、下次又没了。 */
    function layerRec(l) {
      var o = {
        id: String(l.id), name: String(l.name || ''), flipY: !!l.flipY,
        opacity: clampNum(l.opacity, 0, 1), blend: l.blend || 'normal'
      };
      if (l.mask && l.mask.id) {
        o.mask = {
          id: String(l.mask.id), name: String(l.mask.name || ''),
          flipY: !!l.mask.flipY, invert: !!l.mask.invert
        };
      }
      return o;
    }
    function persistSlot(slot) {
      if (!assetId) return;
      var all = readTexCfg();
      var m = (all[assetId] && typeof all[assetId] === 'object') ? all[assetId] : {};
      var ls = [], arr = slot.layers || [];
      for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id) ls.push(layerRec(arr[i]));
      var k = slotKey(slot);
      if (ls.length) m[k] = { v: 2, layers: ls };
      else delete m[k];
      if (Object.keys(m).length) all[assetId] = m;
      else delete all[assetId];
      writeTexCfg(all);
    }
    /* 图片（贴图 / 遮罩）先进资产库换 id：配置里只记 id，
     * 图本身跟模型一样由资产库管着，删掉图库里那张就等于删这一层。 */
    async function putImageAsset(dataURL, name) {
      var d = window.openagiDesktop;
      if (!(d && typeof d.assetPut === 'function')) return '';
      try {
        var res = await d.assetPut({
          kind: 'image', name: name || (baseName + '-贴图'), data: dataURL, source: '模型贴图'
        });
        var a = res && res.ok && res.asset;
        return (a && a.id) ? String(a.id) : '';
      } catch (e) { return ''; }
    }
    async function readAssetImage(id) {
      var d = window.openagiDesktop;
      if (!(d && typeof d.assetRead === 'function')) throw new Error('网页版没有资产库');
      var r = await d.assetRead(id);
      if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
      return await loadImg(r.dataURL);
    }

    /* ---------------- 基础层 ----------------
     * 每个槽的「基础层」= 模型文件自带的贴图（GLB 内嵌的 baseColor）。混合结果永远盖在它上面，
     * 「清除」= 回到它。必须在任何一次写入之前抓一份，否则 mat.map 换成合成图后原图再也找不回来。 */
    function ensureBase(slot) {
      if (slot.__baseReady) return;
      slot.__baseReady = true;
      if (!slot.layers) slot.layers = [];
      if (!('baseTex' in slot)) slot.baseTex = slot.mat.map || null;
    }
    function conventionFlipY(slot) {
      if (slot.baseTex && typeof slot.baseTex.flipY === 'boolean') return slot.baseTex.flipY;
      return model.format === 'obj';
    }

    /* ---------------- 合成 ----------------
     * 为什么不在着色器里混：GLB 导出只认 mat.map 这一张图。用 onBeforeCompile 混出来的
     * 只有视口里好看，导出后是空的——「所见即所得」就断了。
     * 所以这里把每层按「比例 + 遮罩 + 混合模式」烘进一张 canvas，再当贴图用：
     * 视口、缩略图、GLB 内嵌图三处永远是同一张，不存在「预览对了导出不对」。 */
    function mixSize(slot) {
      var base = slot.baseTex && slot.baseTex.image;
      var W = (base && base.width) ? base.width : 0;
      var H = (base && base.height) ? base.height : 0;
      if (!W || !H) {
        var ls = slot.layers || [];
        for (var i = 0; i < ls.length; i++) {
          var im = ls[i] && ls[i].img;
          if (im && im.width) { W = im.width; H = im.height; break; }
        }
      }
      if (!W || !H) { W = H = 1024; }
      /* 保持长宽比等比压到上限：贴图必须和基础层同一个 UV 比例，改比例会整片拉伸 */
      var sc = Math.min(1, MIX_MAX_SIDE / Math.max(W, H));
      return { w: Math.max(4, Math.round(W * sc)), h: Math.max(4, Math.round(H * sc)) };
    }

    /* 遮罩 → alpha 图。约定「白=显示、黑=隐藏」，跟常见灰度遮罩一致；
     * 透明区域一律算隐藏（白色形状 + 透明底 的 PNG 不会整片糊上去）。
     * 反相只翻灰度、不动透明度——否则透明底会变成整块不透明，层直接消失。
     * 按「尺寸 + 反相 + 是否上下翻」缓存：拖滑杆时每帧都重算像素会卡。 */
    function maskAlpha(rec, w, h, flip) {
      if (!rec.__mc) rec.__mc = {};
      var key = w + 'x' + h + (rec.invert ? 'i' : '') + (flip ? 'f' : '');
      if (rec.__mc[key]) return rec.__mc[key];
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      if (flip) { ctx.translate(0, h); ctx.scale(1, -1); }
      ctx.drawImage(rec.img, 0, 0, w, h);
      var data = ctx.getImageData(0, 0, w, h);
      var px = data.data;
      for (var i = 0; i < px.length; i += 4) {
        var l = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
        if (rec.invert) l = 255 - l;
        px[i + 3] = Math.round(l * px[i + 3] / 255);
      }
      ctx.putImageData(data, 0, 0);
      var keys = Object.keys(rec.__mc);
      if (keys.length > 5) delete rec.__mc[keys[0]];
      rec.__mc[key] = cv;
      return cv;
    }

    function composeSlot(slot) {
      var sz = mixSize(slot);
      var W = sz.w, H = sz.h;
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      /* 没有自带贴图时从白底开始：OBJ 的默认材质就是白色，
       * 用黑底会让「叠一层带透明洞的图」变成黑影，跟直觉相反。 */
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      var base = slot.baseTex && slot.baseTex.image;
      if (base && base.width) ctx.drawImage(base, 0, 0, W, H);

      /* 每层先画到自己那张纸上（顺便让遮罩裁一次），再整体混上去：
       * 直接在主画布上做 destination-in 会把底下的东西一起裁掉。 */
      var tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      var tctx = tmp.getContext('2d');
      var ls = slot.layers || [];
      for (var i = 0; i < ls.length; i++) {
        var l = ls[i];
        if (!l || !l.img) continue;
        var a = clampNum(l.opacity, 0, 1);
        if (a <= 0) continue;
        tctx.globalCompositeOperation = 'source-over';
        tctx.clearRect(0, 0, W, H);
        tctx.drawImage(l.img, 0, 0, W, H);
        if (l.mask && l.mask.img) {
          tctx.globalCompositeOperation = 'destination-in';
          tctx.drawImage(maskAlpha(l.mask, W, H, false), 0, 0);
          tctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = a;
        ctx.globalCompositeOperation = blendOp(l.blend);
        ctx.drawImage(tmp, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      return cv;
    }

    function applyMix(slot) {
      ensureBase(slot);
      var n = 0, ls = slot.layers || [];
      for (var i = 0; i < ls.length; i++) if (ls[i] && ls[i].img && clampNum(ls[i].opacity, 0, 1) > 0) n++;
      if (!n) {
        if (slot.__mixTex) { slot.__mixTex.dispose(); slot.__mixTex = null; }
        if (slot.mat.map !== slot.baseTex) {
          slot.mat.map = slot.baseTex || null;
          slot.mat.needsUpdate = true;
        }
        return;
      }
      var tex = new THREE.CanvasTexture(composeSlot(slot));
      tex.flipY = conventionFlipY(slot);
      if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      tex.name = (slot.mat.name || 'slot') + '-mix';
      tex.needsUpdate = true;
      var old = slot.__mixTex;
      slot.__mixTex = tex;
      slot.mat.map = tex;
      slot.mat.needsUpdate = true;
      if (old && old !== slot.baseTex) old.dispose();
    }
    /* 拖比例滑杆时每帧都合成会掉帧：合并到一帧一次，留最后一次的值就够 */
    function scheduleMix(slot) {
      if (slot.__mixRaf) return;
      slot.__mixRaf = requestAnimationFrame(function () {
        slot.__mixRaf = 0;
        applyMix(slot);
      });
    }

    function resetMix(slot) {
      ensureBase(slot);
      slot.layers = [];
      if (slot.__mixRaf) { cancelAnimationFrame(slot.__mixRaf); slot.__mixRaf = 0; }
      applyMix(slot);
      persistSlot(slot);
      refreshList();
      if (mixerAlive) renderMix();
    }

    /* 打开模型时把上次的混合层贴回去。资产被删掉的那层直接丢，并改写配置，
     * 否则每次打开都白读一次、还看不出少了一层。 */
    async function restoreTextures() {
      var cfg = slotCfg();
      var slots = collectSlots();
      for (var b = 0; b < slots.length; b++) ensureBase(slots[b]);
      if (!cfg) { refreshList(); return; }
      var d = window.openagiDesktop;
      if (!(d && typeof d.assetRead === 'function')) { refreshList(); return; }
      var dirty = false, restored = 0;
      for (var i = 0; i < slots.length; i++) {
        var slot = slots[i];
        var rec = cfg.map[slotKey(slot)];
        if (!rec) continue;
        var recs = rec.layers ? rec.layers : (rec.id ? [rec] : []);
        var kept = [];
        for (var j = 0; j < recs.length; j++) {
          var L = recs[j];
          if (!L || !L.id) continue;
          try {
            var img = await readAssetImage(L.id);
            var layer = {
              id: String(L.id), name: L.name || '', flipY: L.flipY !== false, img: img,
              opacity: (L.opacity == null ? 1 : clampNum(L.opacity, 0, 1)),
              blend: L.blend || 'normal', mask: null
            };
            if (L.mask && L.mask.id) {
              try {
                layer.mask = {
                  id: String(L.mask.id), name: L.mask.name || '',
                  flipY: L.mask.flipY !== false, invert: !!L.mask.invert,
                  img: await readAssetImage(L.mask.id)
                };
              } catch (e2) { dirty = true; }
            }
            kept.push(layer);
          } catch (e) { dirty = true; }
        }
        if (kept.length !== recs.length) dirty = true;
        slot.layers = kept;
        if (kept.length) { applyMix(slot); restored++; }
      }
      if (dirty) for (var k = 0; k < slots.length; k++) persistSlot(slots[k]);
      if (restored) refreshList();
      refreshList();
    }

    /* 材质槽收集：按材质 uuid 去重，记录共用它的 mesh（取名 / 展示用）。
     *
     * ⚠ 包装对象必须**按 uuid 复用**（slotCache）：混合层、基础贴图这些状态挂在包装对象上，
     *   每次新建一个的话，下一次 refreshList 就全丢——症状是「配置里明明有 2 层，面板显示无贴图」。
     *   meshes 每次重算（材质被换到别的网格上时不能留旧引用）。 */
    var slotCache = {};
    function collectSlots() {
      var slots = [], seen = {};
      model.root.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        var mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        mats.forEach(function (m) {
          if (!m) return;
          var s = seen[m.uuid];
          if (!s) {
            s = seen[m.uuid] = slotCache[m.uuid] || (slotCache[m.uuid] = { mat: m, meshes: [] });
            s.mat = m;
            s.meshes = [];
            slots.push(s);
          }
          s.meshes.push(o);
        });
      });
      return slots;
    }

    function slotName(slot, i) {
      var mesh = slot.meshes[0] && slot.meshes[0].name;
      /* glTF 导入器会把节点名写成 TEMPORARY_IMPORT_NAMESPACE_xxx_obj1:inputSurface，
       * 摆到面板上就是一串看不懂的乱码（中文还会变方块）。这种情况退回材质名。 */
      var n = (mesh && !/^TEMPORARY_IMPORT_NAMESPACE_/i.test(mesh)) ? mesh : slot.mat.name;
      return n || mesh || ('插槽 ' + (i + 1));
    }
    /* 混合面板标题旁边显示「在改哪个材质」：和列表同一套取名规则 */
    function slotLabel(slot) {
      return slotName(slot, 0) || '当前材质';
    }

    /* 槽的贴图缩略图：没有贴图返回 null。glTF 贴图 flipY=false，缩略图要翻回来才不颠倒 */
    function thumbOfTex(tex, size) {
      var img = tex && tex.image;
      if (!img || !img.width) return null;
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var ctx = c.getContext('2d');
      if (tex.flipY === false) {
        ctx.translate(0, size); ctx.scale(1, -1);
      }
      ctx.drawImage(img, 0, 0, size, size);
      return c;
    }
    function thumbOf(slot, size) { return thumbOfTex(slot.mat.map, size); }

    /* 单层的缩略图：连遮罩一起画（已经抠掉的部分直接不显示），一眼看出这层到底盖在哪里 */
    function layerThumb(l, size) {
      if (!l || !l.img) return null;
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var ctx = c.getContext('2d');
      var flip = l.flipY === false;
      if (flip) { ctx.translate(0, size); ctx.scale(1, -1); }
      ctx.drawImage(l.img, 0, 0, size, size);
      if (l.mask && l.mask.img) {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskAlpha(l.mask, size, size, flip), 0, 0);
      }
      return c;
    }

    function metaText(slot) {
      var matType = (slot.mat.type || 'Material')
        .replace('MeshStandardMaterial', 'PBR').replace('MeshPhongMaterial', 'Phong').replace('MeshBasicMaterial', 'Basic');
      var ls = slot.layers || [], masks = 0;
      for (var i = 0; i < ls.length; i++) if (ls[i].mask && ls[i].mask.id) masks++;
      var state = ls.length
        ? (ls.length + ' 层混合' + (masks ? ' · ' + masks + ' 个遮罩' : ''))
        : (slot.baseTex ? '自带贴图' : '无贴图');
      return matType + ' · ' + slot.meshes.length + ' 个网格 · ' + state;
    }

    function refreshList() {
      if (!listEl) return;
      listEl.innerHTML = '';
      var slots = collectSlots();
      if (!slots.length) {
        var empty = document.createElement('div');
        empty.style.cssText = 'color:#8b90a0;font-size:12px;line-height:1.6;';
        empty.textContent = '模型里没有材质（纯几何）——OBJ 模型常见。仍可导出 GLB，但没地方贴图。';
        listEl.appendChild(empty);
        return;
      }
      slots.forEach(function (slot, i) {
        ensureBase(slot);
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;background:#171a21;border:1px solid #23262e;border-radius:10px;padding:10px;';

        var th = thumbOf(slot, 52);
        var box = document.createElement('div');
        box.style.cssText = 'flex:0 0 52px;height:52px;border-radius:8px;background:#0a0b0e;border:1px solid #23262e;overflow:hidden;display:flex;align-items:center;justify-content:center;';
        if (th) box.appendChild(th);
        else {
          var no = document.createElement('span');
          no.textContent = '无';
          no.style.cssText = 'color:#5a5f70;font-size:11px;';
          box.appendChild(no);
        }
        row.appendChild(box);

        var info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;';
        var nm = document.createElement('div');
        nm.textContent = slotName(slot, i);
        nm.title = nm.textContent;
        nm.style.cssText = 'color:#e8eaf0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        var meta = document.createElement('div');
        meta.textContent = metaText(slot);
        meta.style.cssText = 'color:#8b90a0;font-size:11px;';
        info.appendChild(nm); info.appendChild(meta);

        var btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
        btns.appendChild(mkBtn('纹理混合', function () { openMixer(slot); }));
        if ((slot.layers || []).length) {
          btns.appendChild(mkBtn('清除', function () { resetMix(slot); }));
        }
        info.appendChild(btns);
        row.appendChild(info);
        listEl.appendChild(row);
      });
    }

    function ensurePanel() {
      if (panel) { panel.style.display = 'flex'; refreshList(); return panel; }
      panel = document.createElement('div');
      panel.setAttribute('data-slot-panel', '1');
      /* 380：混合层一行要放「缩略图 + 名字 + 三个小按钮」，340 会挤成两行放不下 */
      panel.style.cssText = 'position:absolute;top:0;right:0;bottom:0;width:380px;max-width:86%;background:rgba(13,15,20,.97);border-left:1px solid #23262e;display:flex;flex-direction:column;z-index:5;';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #23262e;flex:0 0 auto;';
      var t = document.createElement('div');
      t.textContent = '材质插槽';
      t.style.cssText = 'font-weight:600;flex:1;color:#e8eaf0;font-size:13px;';
      var x = document.createElement('button');
      x.textContent = '×';
      x.style.cssText = 'border:0;background:transparent;color:#8b90a0;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;';
      x.onclick = function () {
        if (mixerSlot) persistSlot(mixerSlot);
        closeMixer(); panel.style.display = 'none';
      };
      head.appendChild(t); head.appendChild(x);

      listEl = document.createElement('div');
      listEl.style.cssText = 'flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;min-height:0;';

      var foot = document.createElement('div');
      foot.style.cssText = 'flex:0 0 auto;padding:10px 12px;border-top:1px solid #23262e;display:flex;gap:8px;flex-wrap:wrap;';
      var saveBtn = mkBtn('导出 GLB 存入模型库', function () { saveGLB(saveBtn); });
      var dlBtn = mkBtn('下载 GLB', function () { downloadGLB(dlBtn); });
      foot.appendChild(saveBtn); foot.appendChild(dlBtn);
      var tip = document.createElement('div');
      tip.textContent = 'GLB 内嵌合成后的贴图，导出后双击打开就是混合好的状态';
      tip.style.cssText = 'color:#8b90a0;font-size:11px;flex-basis:100%;';
      foot.appendChild(tip);

      panel.appendChild(head); panel.appendChild(listEl); panel.appendChild(foot);
      stage.appendChild(panel);
      refreshList();
      return panel;
    }

    /* 本机文件选择（input 复用，选同一个文件也能再触发 onchange） */
    function ensureFileInput() {
      if (fileInput) return fileInput;
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/webp';
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      return fileInput;
    }

    function loadImg(src) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () { res(img); };
        img.onerror = function () { rej(new Error('贴图图片解码失败')); };
        img.src = src;
      });
    }

    /* ---------------- 贴图选择器（面板内二级层） ----------------
     * 贴图和遮罩走同一个选择器：只有标题和数据落点不同。
     * onPick 收到 { dataURL, name, texId? }；texId 只有「从图库选」才有（图已经在资产库里了）。
     * opts.multi —— 允许一次选多张（加图层时用，遮罩只认一张）。 */
    function closePicker() {
      pickerAlive = false;
      if (picker && picker.parentNode) picker.parentNode.removeChild(picker);
      picker = null;
    }

    function openPicker(title, onPick, opts) {
      opts = opts || {};
      closePicker();
      pickerAlive = true;
      picker = document.createElement('div');
      picker.style.cssText = 'position:absolute;inset:0;background:rgba(13,15,20,.98);z-index:7;display:flex;flex-direction:column;';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #23262e;flex:0 0 auto;';
      var t = document.createElement('div');
      t.textContent = title || '选择图片';
      t.style.cssText = 'font-weight:600;flex:1;color:#e8eaf0;font-size:13px;';
      var cancelB = document.createElement('button');
      cancelB.textContent = '取消';
      cancelB.style.cssText = 'padding:5px 10px;border-radius:8px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;cursor:pointer;font-size:12px;';
      cancelB.onclick = closePicker;
      head.appendChild(t); head.appendChild(cancelB);

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'padding:10px 12px;display:flex;gap:8px;flex:0 0 auto;';
      var upBtn = mkBtn('本机文件…', function () {
        var fi = ensureFileInput();
        fi.multiple = !!opts.multi;
        fi.onchange = function () {
          var files = Array.prototype.slice.call(fi.files || []);
          if (!files.length) return;
          if (!opts.multi) files = files.slice(0, 1);
          var reads = files.map(function (f) {
            return new Promise(function (res) {
              var rd = new FileReader();
              rd.onload = function () { res(rd.result); };
              rd.onerror = function () { res(''); };
              rd.readAsDataURL(f);
            });
          });
          Promise.all(reads).then(async function (urls) {
            closePicker();
            /* 多张按选择顺序逐层往上叠：后选的盖在前选的上面，跟列表顺序一致 */
            for (var i = 0; i < files.length; i++) {
              if (!urls[i]) continue;
              try { await onPick({ dataURL: urls[i], name: files[i].name }); }
              catch (e) { hint.textContent = '贴图失败：' + ((e && e.message) || e); }
            }
          });
          fi.value = '';
        };
        fi.click();
      });
      var libBtn = mkBtn('从图库选择', function () { showGallery(); });
      btnRow.appendChild(upBtn); btnRow.appendChild(libBtn);

      var body = document.createElement('div');
      body.style.cssText = 'flex:1;overflow-y:auto;padding:0 12px 12px;min-height:0;';

      picker.appendChild(head); picker.appendChild(btnRow); picker.appendChild(body);
      panel.appendChild(picker);

      function showGallery() {
        upBtn.disabled = libBtn.disabled = true;
        body.innerHTML = '';
        var d = window.openagiDesktop;
        if (!(d && typeof d.assetList === 'function')) {
          body.textContent = '网页版没有资产库，用「本机文件」上传贴图';
          body.style.cssText += 'color:#8b90a0;font-size:12px;padding:12px;';
          return;
        }
        body.textContent = '读取图库…';
        d.assetList().then(function (l) {
          if (!pickerAlive) return;
          var imgs = (l.assets || []).filter(function (a) { return a.kind === 'image' && !a.missing; });
          if (!imgs.length) {
            body.textContent = '图库里还没有图片';
            body.style.cssText += 'color:#8b90a0;font-size:12px;padding:12px;';
            return;
          }
          body.innerHTML = '';
          body.style.cssText += 'display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;align-content:start;';
          /* 缩略图逐张补：assetRead 拉的是整图，一次全拉会把内存打爆。
           * 先摆名字卡片占位，再按顺序读、谁先到谁先显示；关掉面板就停。 */
          imgs.slice(0, 120).forEach(function (a) {
            var card = document.createElement('div');
            card.title = a.name;
            card.style.cssText = 'aspect-ratio:1;border-radius:8px;background:#171a21;border:1px solid #23262e;overflow:hidden;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;';
            var label = document.createElement('span');
            label.textContent = String(a.ext || '').toUpperCase() || '?';
            label.style.cssText = 'color:#5a5f70;font-size:10px;';
            card.appendChild(label);
            card.onclick = function () {
              d.assetRead(a.id).then(function (r) {
                if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
                closePicker();
                return onPick({ dataURL: r.dataURL, name: a.name, texId: a.id });
              }).catch(function () {
                label.textContent = '失败';
                label.style.color = '#e05252';
              });
            };
            body.appendChild(card);
            d.assetRead(a.id).then(function (r) {
              if (!pickerAlive || !r || !r.ok) return;
              var img = document.createElement('img');
              img.src = r.dataURL;
              img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
              card.innerHTML = '';
              card.appendChild(img);
            }).catch(function () { });
          });
          var more = imgs.length - 120;
          if (more > 0) {
            var note = document.createElement('div');
            note.textContent = '还有 ' + more + ' 张未显示（搜索/整理请去图库 App）';
            note.style.cssText = 'grid-column:1/-1;color:#8b90a0;font-size:11px;padding:4px;';
            body.appendChild(note);
          }
        }).catch(function (e) {
          if (pickerAlive) body.textContent = '读取图库失败：' + ((e && e.message) || e);
        });
      }
    }

    /* ---------------- 添加图层 / 设置遮罩 ---------------- */
    async function addLayer(slot, pick) {
      ensureBase(slot);
      if ((slot.layers || []).length >= MIX_LIMIT) {
        hint.textContent = '一个插槽最多 ' + MIX_LIMIT + ' 层';
        return;
      }
      var img;
      try { img = await loadImg(pick.dataURL); }
      catch (e) { hint.textContent = '贴图失败：' + ((e && e.message) || e); return; }
      var id = pick.texId ? String(pick.texId) : await putImageAsset(pick.dataURL, pick.name);
      var layer = {
        id: id, name: pick.name || '贴图', flipY: conventionFlipY(slot), img: img,
        opacity: 1, blend: 'normal', mask: null
      };
      slot.layers.push(layer);
      applyMix(slot);
      persistSlot(slot);
      refreshList();
      if (mixerAlive) renderMix();
      hint.textContent = '已叠加「' + layer.name + '」' + (id ? '' : '（网页版：本次会话内有效）');
    }

    async function setMask(layer, pick) {
      var img;
      try { img = await loadImg(pick.dataURL); }
      catch (e) { hint.textContent = '遮罩失败：' + ((e && e.message) || e); return; }
      var id = pick.texId ? String(pick.texId) : await putImageAsset(pick.dataURL, pick.name || '遮罩');
      layer.mask = { id: id, name: pick.name || '遮罩', flipY: layer.flipY, invert: false, img: img };
      if (mixerSlot) applyMix(mixerSlot);
      if (mixerSlot) persistSlot(mixerSlot);
      refreshList();
      if (mixerAlive) renderMix();
      hint.textContent = '遮罩已设置：白色显示、黑色隐藏';
    }

    /* ---------------- 纹理混合面板 ----------------
     * 一个材质槽 = 一叠图层。列表从上到下就是合成顺序（最上面最后叠加），
     * 最下面是「模型自带贴图」，不可删、不可调比例（它就是底）。
     * 每层三个旋钮：混合模式 / 比例（不透明度）/ 遮罩。
     */
    function closeMixer() {
      mixerAlive = false;
      mixerSlot = null;
      mixBody = null;
      if (mixer && mixer.parentNode) mixer.parentNode.removeChild(mixer);
      mixer = null;
    }

    /* 拖滑杆只重合成、不重绘列表（重绘会把手指下面的 range 换掉）；
     * 松手才写盘 + 刷新外层卡片上的「N 层混合」。 */
    function renderMix() {
      var slot = mixerSlot; if (!slot) return;
      mixBody.innerHTML = '';
      var ls = slot.layers || [];

      if (!ls.length) {
        var zero = document.createElement('div');
        zero.style.cssText = 'color:#8b90a0;font-size:12px;line-height:1.7;background:#12151b;border:1px dashed #2c303a;border-radius:10px;padding:10px;';
        zero.textContent = '还没有混合层。点下面「＋ 本机贴图」加一张，它会盖在模型自带贴图上；再加第二张就能用「比例 + 遮罩」做过渡、脏迹、旧化这类效果。';
        mixBody.appendChild(zero);
      }

      /* 从上往下画：数组最后一项是最上面那层 */
      for (var i = ls.length - 1; i >= 0; i--) mixBody.appendChild(layerRow(ls, i));
      mixBody.appendChild(baseRow());
    }

    function layerRow(ls, idx) {
      var slot = mixerSlot; if (!slot) return null;
      var l = ls[idx];
      var row = document.createElement('div');
      row.style.cssText = 'background:#171a21;border:1px solid #23262e;border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:7px;';

      /* 第一行：缩略图 + 名字 + 上移/下移/删除 */
      var line1 = document.createElement('div');
      line1.style.cssText = 'display:flex;align-items:center;gap:8px;';
      var thBox = document.createElement('div');
      thBox.style.cssText = 'flex:0 0 40px;height:40px;border-radius:6px;background:#0a0b0e;border:1px solid #23262e;overflow:hidden;';
      var lth = layerThumb(l, 40);
      if (lth) thBox.appendChild(lth);
      line1.appendChild(thBox);

      var nm = document.createElement('div');
      nm.textContent = l.name || ('图层 ' + (idx + 1));
      nm.title = nm.textContent;
      nm.style.cssText = 'flex:1;min-width:0;color:#e8eaf0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      line1.appendChild(nm);

      function miniBtn(text, title, fn, on) {
        var b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText = 'flex:0 0 auto;min-width:26px;height:24px;padding:0 6px;border-radius:6px;border:1px solid ' +
          (on ? '#3f6ea8' : '#2c303a') + ';background:' + (on ? '#1d3550' : '#191c22') +
          ';color:' + (on ? '#cfe4ff' : '#c9cede') + ';cursor:pointer;font-size:12px;line-height:1;';
        b.onclick = fn;
        line1.appendChild(b);
        return b;
      }
      /* 列表是倒序显示的：视觉上「上移」= 数组往后挪一位 */
      if (idx < ls.length - 1) miniBtn('↑', '上移一层', function () { moveLayer(ls, idx, idx + 1); });
      if (idx > 0) miniBtn('↓', '下移一层', function () { moveLayer(ls, idx, idx - 1); });
      miniBtn('×', '删除这一层', function () {
        ls.splice(idx, 1);
        applyMix(slot); persistSlot(slot); refreshList(); renderMix();
      });
      row.appendChild(line1);

      /* 第二行：混合模式 + 比例 */
      var line2 = document.createElement('div');
      line2.style.cssText = 'display:flex;align-items:center;gap:8px;';
      var sel = document.createElement('select');
      sel.style.cssText = 'flex:0 0 92px;padding:4px 6px;border-radius:6px;border:1px solid #2c303a;background:#0f1116;color:#e8eaf0;font-size:12px;';
      BLEND_MODES.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.key; o.textContent = m.label;
        sel.appendChild(o);
      });
      sel.value = l.blend || 'normal';
      sel.onchange = function () { l.blend = sel.value; scheduleMix(slot); persistSlot(slot); };
      line2.appendChild(sel);

      var rng = document.createElement('input');
      rng.type = 'range'; rng.min = '0'; rng.max = '100'; rng.step = '1';
      rng.value = String(Math.round(clampNum(l.opacity, 0, 1) * 100));
      rng.style.cssText = 'flex:1;min-width:0;accent-color:#4d8cf5;height:18px;';
      var val = document.createElement('span');
      val.textContent = rng.value + '%';
      val.style.cssText = 'flex:0 0 38px;text-align:right;color:#9aa0b0;font-size:11px;font-variant-numeric:tabular-nums;';
      rng.oninput = function () {
        l.opacity = Number(rng.value) / 100;
        val.textContent = rng.value + '%';
        scheduleMix(slot);
      };
      rng.onchange = function () { persistSlot(slot); refreshList(); };
      line2.appendChild(rng); line2.appendChild(val);
      row.appendChild(line2);

      /* 第三行：遮罩（白色显示 / 黑色隐藏，可反相） */
      var line3 = document.createElement('div');
      line3.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
      if (l.mask && l.mask.id) {
        var mtag = document.createElement('span');
        mtag.textContent = '遮罩 ' + (l.mask.name || '');
        mtag.title = mtag.textContent;
        mtag.style.cssText = 'flex:1;min-width:0;color:#7fbf8f;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        line3.appendChild(mtag);
        var invB = document.createElement('button');
        invB.textContent = '反相';
        invB.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid ' +
          (l.mask.invert ? '#3f6ea8' : '#2c303a') + ';background:' + (l.mask.invert ? '#1d3550' : '#191c22') +
          ';color:' + (l.mask.invert ? '#cfe4ff' : '#c9cede') + ';cursor:pointer;font-size:11px;';
        invB.onclick = function () {
          l.mask.invert = !l.mask.invert;
          applyMix(slot); persistSlot(slot); refreshList(); renderMix();
        };
        line3.appendChild(invB);
        var reB = document.createElement('button');
        reB.textContent = '换';
        reB.title = '换一张遮罩';
        reB.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid #2c303a;background:#191c22;color:#c9cede;cursor:pointer;font-size:11px;';
        reB.onclick = function () {
          openPicker('选择遮罩', function (pick) { return setMask(l, pick); });
        };
        line3.appendChild(reB);
        var clrB = document.createElement('button');
        clrB.textContent = '去遮罩';
        clrB.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid #2c303a;background:#191c22;color:#c9cede;cursor:pointer;font-size:11px;';
        clrB.onclick = function () {
          l.mask = null;
          applyMix(slot); persistSlot(slot); refreshList(); renderMix();
        };
        line3.appendChild(clrB);
      } else {
        var mAdd = document.createElement('button');
        mAdd.textContent = '＋ 遮罩';
        mAdd.title = '用一张黑白图决定这一层显示在哪里';
        mAdd.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid #2c303a;background:#191c22;color:#c9cede;cursor:pointer;font-size:11px;';
        mAdd.onclick = function () {
          openPicker('选择遮罩（白=显示 黑=隐藏）', function (pick) { return setMask(l, pick); });
        };
        line3.appendChild(mAdd);
      }
      row.appendChild(line3);
      return row;
    }

    function moveLayer(ls, from, to) {
      var slot = mixerSlot; if (!slot) return;
      var tmp = ls[to];
      ls[to] = ls[from];
      ls[from] = tmp;
      applyMix(slot); persistSlot(slot); refreshList(); renderMix();
    }

    function baseRow() {
      var slot = mixerSlot; if (!slot) return null;
      var has = !!(slot.baseTex && slot.baseTex.image);
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;background:#12151b;border:1px dashed #2c303a;border-radius:10px;padding:8px;';
      var box = document.createElement('div');
      box.style.cssText = 'flex:0 0 40px;height:40px;border-radius:6px;background:#0a0b0e;border:1px solid #23262e;overflow:hidden;display:flex;align-items:center;justify-content:center;';
      var th = thumbOfTex(slot.baseTex, 40);
      if (th) box.appendChild(th);
      else {
        var sp = document.createElement('span');
        sp.textContent = '无';
        sp.style.cssText = 'color:#5a5f70;font-size:10px;';
        box.appendChild(sp);
      }
      row.appendChild(box);
      var col = document.createElement('div');
      col.style.cssText = 'flex:1;min-width:0;';
      var a = document.createElement('div');
      a.textContent = '模型自带贴图（底层）';
      a.style.cssText = 'color:#c9cede;font-size:12px;';
      var b = document.createElement('div');
      b.textContent = has ? '不可删除、不参与混合比例' : '模型没有自带贴图，合成从白底开始';
      b.style.cssText = 'color:#7d8291;font-size:11px;';
      col.appendChild(a); col.appendChild(b);
      row.appendChild(col);
      return row;
    }


    function openMixer(slot) {
      if (!panel) return;
      closePicker();
      closeMixer();
      ensureBase(slot);
      mixerSlot = slot;
      mixerAlive = true;

      mixer = document.createElement('div');
      mixer.setAttribute('data-mix-root', '1');
      mixer.style.cssText = 'position:absolute;inset:0;background:rgba(13,15,20,.99);z-index:6;display:flex;flex-direction:column;';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #23262e;flex:0 0 auto;';
      var t = document.createElement('div');
      t.style.cssText = 'flex:1;min-width:0;';
      var t1 = document.createElement('div');
      t1.textContent = '纹理混合';
      t1.style.cssText = 'font-weight:600;color:#e8eaf0;font-size:13px;';
      var t2 = document.createElement('div');
      t2.textContent = slotLabel(slot);
      t2.style.cssText = 'color:#8b90a0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      t.appendChild(t1); t.appendChild(t2);
      var backB = document.createElement('button');
      backB.textContent = '返回';
      backB.style.cssText = 'padding:5px 10px;border-radius:8px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;cursor:pointer;font-size:12px;';
      backB.onclick = function () {
        if (mixerSlot) persistSlot(mixerSlot);
        closeMixer(); refreshList();
      };
      head.appendChild(t); head.appendChild(backB);

      var body = document.createElement('div');
      body.style.cssText = 'flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0;';
      mixBody = body;

      var foot = document.createElement('div');
      foot.style.cssText = 'flex:0 0 auto;padding:10px 12px;border-top:1px solid #23262e;display:flex;flex-direction:column;gap:8px;';
      var addRow = document.createElement('div');
      addRow.style.cssText = 'display:flex;gap:8px;';
      addRow.appendChild(mkBtn('＋ 本机贴图', function () {
        openPicker('添加贴图', function (pick) { return addLayer(slot, pick); }, { multi: true });
      }));
      addRow.appendChild(mkBtn('＋ 从图库', function () {
        openPicker('添加贴图', function (pick) { return addLayer(slot, pick); }, { multi: true });
      }));
      var resetB = mkBtn('清空混合', function () { resetMix(slot); });
      addRow.appendChild(resetB);
      var tip = document.createElement('div');
      var sz = mixSize(slot);
      tip.textContent = '合成 ' + sz.w + '×' + sz.h + ' · 最多 ' + MIX_LIMIT + ' 层 · 遮罩白=显示 黑=隐藏';
      tip.style.cssText = 'color:#8b90a0;font-size:11px;';
      foot.appendChild(addRow); foot.appendChild(tip);

      mixer.appendChild(head); mixer.appendChild(body); mixer.appendChild(foot);
      panel.appendChild(mixer);

      renderMix();
    }

    /* ---------------- GLB 导出 ---------------- */
    function exportGLBBuffer() {
      if (!THREE.GLTFExporter) throw new Error('GLTFExporter 未加载（vendor/GLTFExporter.js）');
      var exp = new THREE.GLTFExporter();
      return new Promise(function (res, rej) {
        exp.parse(model.root, res, rej, { binary: true });
      }).then(function (r) {
        if (!(r instanceof ArrayBuffer)) throw new Error('GLB 导出结果异常');
        return r;
      });
    }

    /* 这两个是模块级 bufToDataURL / saveDataURL 的薄别名（原来各写一份，导出 GLB 与
     * UV 排布都要用，留两份迟早「一处改了另一处没改」） */
    function abToDataURL(buf) { return bufToDataURL(buf, 'model/gltf-binary'); }
    function downloadDataURL(name, url) { saveDataURL(name, url); }

    async function saveGLB(btn) {
      var old = btn.textContent;
      btn.disabled = true; btn.textContent = '导出中…';
      hint.textContent = '正在导出 GLB…';
      try {
        var buf = await exportGLBBuffer();
        var url = abToDataURL(buf);
        var d = window.openagiDesktop;
        if (!(d && typeof d.assetPut === 'function')) {
          downloadDataURL(baseName + '_贴图.glb', url);
          hint.textContent = '浏览器里存不进模型库，已改为下载 GLB';
          return;
        }
        var r = await d.assetPut({
          kind: 'model', ext: 'glb',
          name: baseName + '_贴图.glb',
          data: url, source: 'texture'
        });
        if (!(r && r.ok && r.asset && r.asset.id)) throw new Error((r && r.message) || '入库失败');
        /* 缩略图顺手存一张：模型库磁贴直接显示带贴图的样子（失败不影响入库） */
        try {
          var th = await renderThumb(url, { size: 256 });
          await d.assetThumbSave(r.asset.id, th.dataURL);
        } catch (e) { }
        hint.textContent = '已存入模型库：「' + baseName + '_贴图.glb」';
      } catch (e) {
        hint.textContent = '导出失败：' + ((e && e.message) || e);
        hint.style.color = '#e05252';
      } finally {
        btn.disabled = false; btn.textContent = old;
      }
    }

    async function downloadGLB(btn) {
      var old = btn.textContent;
      btn.disabled = true; btn.textContent = '导出中…';
      try {
        var buf = await exportGLBBuffer();
        downloadDataURL(baseName + '_贴图.glb', abToDataURL(buf));
        hint.textContent = 'GLB 已开始下载';
      } catch (e) {
        hint.textContent = '导出失败：' + ((e && e.message) || e);
        hint.style.color = '#e05252';
      } finally {
        btn.disabled = false; btn.textContent = old;
      }
    }

    bar.appendChild(mkBtn('材质插槽', function () {
      if (typeof deps.onPanelOpen === 'function') deps.onPanelOpen();
      ensurePanel();
    }));

    /* 模型加载完就把上次的贴图贴回去（异步，加载不阻塞视口） */
    restoreTextures();

    /* 给 UV 视图用：切过去之前把抽屉和它的二级层一起收掉 */
    return {
      hide: function () {
        /* 滑杆只松手才写盘；收抽屉前补一次，免得「拖到一半点 UV」把最后一格丢了 */
        if (mixerSlot) persistSlot(mixerSlot);
        closePicker(); closeMixer();
        if (panel) panel.style.display = 'none';
      }
    };
  }

  /* ---------------- 深度像素描边（屏幕空间） ----------------
   * 判据是「相邻像素的世界深度差」，不是几何数据：外轮廓、遮挡关系、台阶、两块网格没对齐，
   * 全都自动出线，不需要任何显式边信息。和 UV 描边（几何法，只描显式接缝）互补，两个开关互不影响。
   *
   * 为什么阈值要归一化成「像素当量」：
   *   直接拿 |Δz| 当阈值，模型一放大 / 一拉近 / 换分辨率，线就忽有忽无——透视下同一个深度断裂
   *   在近处的 Δz 远大于远处。这里把 Δz 除以「该深度下 1 个像素对应的世界尺寸」
   *   （2·z·tan(fov/2)/H），得到「这个跳变相当于多少个像素的平面倾斜」：
   *   斜面一般 1–3，真正的断裂几十上百。于是阈值 2 在任何视角、任何分辨率下含义都一样。
   *
   * 两次渲染：场景 → 带 DepthTexture 的 RT，再全屏 quad 采样深度做 8 方向 × 2 环比较。
   * 关掉时退回一次直接渲染，零额外开销；RT 按需建、关掉即 dispose。
   */
  function createDepthOutline(opt) {
    var renderer = opt.renderer, scene = opt.scene, camera = opt.camera;
    var enabled = false, rt = null, w = 1, h = 1, failed = false;
    var bgTmp = new THREE.Color();
    var params = { threshold: 2, width: 1.5 };

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uTan: { value: 0.4 },
        uThreshold: { value: 2 },
        uWidth: { value: 1.5 },
        uColor: { value: new THREE.Color('#000000') },
        uStrength: { value: 1 }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = vec4(position.xy, 0.0, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        '#include <packing>',
        'uniform sampler2D tColor;',
        'uniform sampler2D tDepth;',
        'uniform vec2 uRes;',
        'uniform float uNear;',
        'uniform float uFar;',
        'uniform float uTan;',
        'uniform float uThreshold;',
        'uniform float uWidth;',
        'uniform vec3 uColor;',
        'uniform float uStrength;',
        'varying vec2 vUv;',
        '',
        '/* 线性 → sRGB。为什么要自己写：three r149 只有渲染到屏幕时才套 outputEncoding，',
        ' * 渲到普通 RT 恒为线性（WebGLProgram 里 `currentRenderTarget === null ? outputEncoding : Linear`）。',
        ' * 不补这一步，后处理把线性值直接上屏，整屏发暗（实测平均亮度 20.7 -> 14.0）。',
        ' * 手写而不 include <encodings_pars_fragment>：那个依赖 WebGLProgram 注入的宏，',
        ' * 对自定义 ShaderMaterial 不保证注入，编不出来就是黑屏。 */',
        'vec3 lin2srgb(vec3 c) {',
        '  vec3 lo = c * 12.92;',
        '  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;',
        '  return mix(lo, hi, step(vec3(0.0031308), c));',
        '}',
        '',
        '/* 线性深度（相机到片元的距离，正数，越大越远）。',
        ' * 必须自己做钳位，不能直接丢给 perspectiveDepthToViewZ：',
        ' * 那边是 (near*far)/((far-near)*d - far)，d 一旦 >= 1（背景、或精度上溢到 1.0000001）',
        ' * 分母变号，返回 -inf / 巨大值 —— 后面除以 px 就变成 inf，max() 把它传染给整片，',
        ' * 结果整只模型被判成断裂（实测：模型全黑，只剩轮廓外的背景正常）。',
        ' * 这里把「背景 / 越界 / NaN」统一按 far 处理，公式只在 [0,1) 内跑。 */',
        'float lz(vec2 p) {',
        '  float d = texture2D(tDepth, p).x;',
        '  if (!(d >= 0.0) || d >= 0.9999990) return uFar;',
        '  float z = -perspectiveDepthToViewZ(d, uNear, uFar);',
        '  return (z > 0.0 && z < uFar * 1.5) ? z : uFar;',
        '}',
        'float isBg(float z) { return step(uFar * 0.999, z); }',
        '',
        'void main() {',
        '  vec3 col = texture2D(tColor, vUv).rgb;',
        '  float z0 = lz(vUv);',
        '  /* 该深度下 1 像素的世界尺寸：透视投影 = 2*z*tan(fov/2)/H */',
        '  float px = max(z0 * 2.0 * uTan / uRes.y, 1e-5);',
        '  vec2 o = vec2(uWidth) / uRes;',
        '  float e = 0.0;',
        '',
        '  /* 判据用**二阶差分**（z(+) + z(-) - 2*z0），不是一阶 |z(+) - z0|。',
        '   * 一开始写的是「相邻像素深度差超过阈值就描」，结果整只模型被描黑：',
        '   * 掠射面上（侧着对视线、头发边缘、裙褶）相邻像素的 Δz 本来就很大 ——',
        '   * 表面与视线夹角超过 ~63° 时 Δz 就超过「2 个像素的世界尺寸」，',
        '   * 而模型上一大半的面都是这种角度。二阶差分对「线性变化」是 0，',
        '   * 斜面（含透视下的近似线性）几乎不留残差，只有真正断开的地方（遮挡、台阶、剪影）才爆。',
        '   * 归一化仍用 px，阈值含义保持「相当于多少个像素的断裂」。 */',
        '  #define LAP(dx, dy, r) { float za = lz(vUv + vec2(dx, dy) * o * r); float zb = lz(vUv - vec2(dx, dy) * o * r); e = max(e, abs(za + zb - 2.0 * z0) / px); }',
        '  LAP(1.0, 0.0, 1.0) LAP(0.0, 1.0, 1.0)',
        '  LAP(0.707, 0.707, 1.0) LAP(0.707, -0.707, 1.0)',
        '  /* 内环：比线宽还小的凸起只跑外环会被整段跳过 */',
        '  LAP(1.0, 0.0, 0.5) LAP(0.0, 1.0, 0.5)',
        '  #undef LAP',
        '',
        '  float k = smoothstep(uThreshold * 0.6, uThreshold, e) * uStrength;',
        '',
        '  /* 空背景那一侧也要描：中心是 far、四邻有实体 → 描。',
        '   * 不补的话外轮廓只有内侧 1px，模型贴边或局部出画时线会断一截。 */',
        '  float nb = min(min(lz(vUv + vec2(o.x, 0.0)), lz(vUv - vec2(o.x, 0.0))),',
        '                 min(lz(vUv + vec2(0.0, o.y)), lz(vUv - vec2(0.0, o.y))));',
        '  if (isBg(z0) > 0.5 && isBg(nb) < 0.5) k = max(k, uStrength);',
        '',
        '  gl_FragColor = vec4(lin2srgb(mix(col, uColor, clamp(k, 0.0, 1.0))), 1.0);',
        '}'
      ].join('\n'),
      depthTest: false,
      depthWrite: false
    });

    var quadScene = new THREE.Scene();
    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    function disposeRT() {
      if (!rt) return;
      try { rt.depthTexture && rt.depthTexture.dispose(); } catch (e) {}
      try { rt.dispose(); } catch (e) {}
      rt = null;
    }

    function ensureRT() {
      var pr = renderer.getPixelRatio() || 1;
      var W = Math.max(2, Math.floor(w * pr)), H = Math.max(2, Math.floor(h * pr));
      if (rt && rt.width === W && rt.height === H) return true;
      disposeRT();
      try {
        var dt = new THREE.DepthTexture(W, H);
        /* UnsignedIntType 是这里唯一能拿到的：r149 的 WebGLTextures.setupRenderTarget 会把
         * depthTexture.format/type 强制改写成 DEPTH_COMPONENT24 + UnsignedIntType，
         * 设 FloatType 会被无声覆盖（试过）。
         * 所以深度精度只能靠相机 near/far 控制 —— 见 openPreview 里 camNear 那段注释。 */
        dt.type = THREE.UnsignedIntType;
        dt.minFilter = THREE.NearestFilter;
        dt.magFilter = THREE.NearestFilter;
        rt = new THREE.WebGLRenderTarget(W, H, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          depthTexture: dt,
          depthBuffer: true,
          stencilBuffer: false
        });
        /* RT 保持默认的线性色彩空间：显式设 texture.encoding = sRGBEncoding 在 r149 里
         * 对普通 RT 没有任何作用（见 shader 里 lin2srgb 那段注释），设了只会让人误以为已经处理过。
         * 编码统一在后处理片元里做一次。 */
        mat.uniforms.tColor.value = rt.texture;
        mat.uniforms.tDepth.value = dt;
        mat.uniforms.uRes.value.set(W, H);
        return true;
      } catch (e) {
        rt = null;
        failed = true;
        return false;
      }
    }

    function draw() {
      if (!enabled || failed) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      if (!ensureRT()) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      var u = mat.uniforms;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uTan.value = Math.tan(camera.fov * Math.PI / 360);
      u.uThreshold.value = params.threshold;
      u.uWidth.value = params.width;
      /* 背景色要临时转成线性：
       * scene.background 是「清屏色」，不论渲染到屏幕还是 RT 都是把 Color 数字直接丢给
       * gl.clearColor，**不过 outputEncoding**。而模型是走编码的（屏幕 sRGB / RT 线性）。
       * 所以进 RT 时背景不转，出来再统一编码，背景就会被抬亮（#0a0b0e 变成 #383838）。
       * 只在画这一帧期间换掉，画完立刻换回，外面看到的一直是原值。 */
      var bg = scene.background, swap = null;
      if (bg && bg.isColor) {
        swap = bg;
        bgTmp.copy(bg).convertSRGBToLinear();
        scene.background = bgTmp;
      }
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      if (swap) scene.background = swap;
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
    }

    return {
      get enabled() { return enabled; },
      get failed() { return failed; },
      params: params,
      setEnabled: function (v) { enabled = !!v; if (!enabled) disposeRT(); },
      setParam: function (k, v) {
        if (!(k in params)) return;
        var n = Number(v);
        if (!isFinite(n)) return;
        params[k] = k === 'threshold' ? Math.max(0.1, Math.min(40, n)) : Math.max(0.5, Math.min(8, n));
      },
      resize: function (nw, nh) { w = Math.max(1, nw || 1); h = Math.max(1, nh || 1); },
      draw: draw,
      dispose: function () {
        disposeRT();
        try { mat.dispose(); quadScene.children[0].geometry.dispose(); } catch (e) {}
      }
    };
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
    /* 打开当前预览的参考图抽屉（模型库磁贴上的「参考」用它，省掉轮询 DOM） */
    openRefs: function () { if (refOpener) refOpener(); return !!refOpener; },
    closePreview: closePreview,
    VIEWS: VIEWS,
    VIEW_KEYS: VIEW_KEYS,
    QUAD_NAMES: QUAD_NAMES
  };
})(window);
