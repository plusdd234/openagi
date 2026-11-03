/* ============================================================
 * 3D 模块：模型加载 / 交互预览 / 四视图导出
 *
 * 依赖（均为本地 vendor，UMD 全局 THREE，file:// 可用）：
 *   vendor/three.min.js      three.js r149 (MIT)
 *   vendor/GLTFLoader.js     GLB / glTF
 *   vendor/OBJLoader.js      OBJ
 *   vendor/FBXLoader.js      FBX（含 NURBSCurve / NURBSUtils，二进制解压用 fflate）
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
  function ready() { return !!(THREE && THREE.GLTFLoader && THREE.OBJLoader && THREE.FBXLoader); }

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

  /* 二进制 FBX 的魔数「Kaydara FBX Binary  \0」（20 字节），比扩展名可靠：
   * 模型库里有的资产是 .glb 改名来的，只能按内容判。 */
  function sniffFBXBinary(buf) {
    var magic = [0x4B, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20, 0x46, 0x42, 0x58,
      0x20, 0x42, 0x69, 0x6E, 0x61, 0x72, 0x79, 0x20, 0x20, 0x00];
    if (buf.length < magic.length) return false;
    for (var i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
    return true;
  }

  /* ASCII FBX 没有魔数，只能看头部的注释与块名 */
  function sniffFBXText(text) {
    var t = text.slice(0, 4096);
    return /^\s*;\s*FBX\s+\d/.test(t) ||
      (t.indexOf('FBXHeaderExtension') >= 0 && t.indexOf('Objects:') >= 0);
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
    } else if (sniffFBXBinary(buf)) {
      ext = 'fbx';
      obj = new THREE.FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    } else {
      var text = new TextDecoder('utf-8').decode(buf);
      var t = text.replace(/^\s+/, '');
      if (sniffFBXText(text)) {
        ext = 'fbx';
        /* FBXLoader.parse 统一收 ArrayBuffer（ASCII 也由它自己转文本） */
        obj = new THREE.FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
      } else if (t.charAt(0) === '{') {
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
  /* aspect = 单格宽/高。紧凑模式下格子是矩形的（2 视图 1:2），视锥也要按这个比例给：
   * 宽度装下 w、高度装下 h*aspect，才能保证所有格**同一个缩放**且不裁切。 */
  function frameSize(model, names, margin, aspect) {
    var e = model.ext;
    aspect = aspect > 0 ? aspect : 1;
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
      /* 以「宽度」为基准需求：高度要求 = h * aspect（因为画布高度 = 宽度 / aspect） */
      var need = Math.max(w, h * aspect);
      if (need > best) best = need;
    }
    return Math.max(best, 1e-6) * margin;
  }

  function viewCamera(model, key, o, L, aspect) {
    var v = VIEWS[key], c = model.center;
    var d = Math.max(model.radius * 4, 1e-3);
    aspect = aspect > 0 ? aspect : 1;
    var cam;
    if (o.cam === 'persp') {
      // 让包围球正好贴边，再乘 margin 留白；横向 fov 由像素宽高比推出
      var fov = 34;
      var vHalf = fov * Math.PI / 180 / 2;
      var hHalf = Math.atan(Math.tan(vHalf) * aspect);
      var dist = Math.max(model.radius, 1e-4) / Math.sin(Math.min(vHalf, hHalf)) * o.margin;
      cam = new THREE.PerspectiveCamera(fov, aspect, dist / 400, dist * 30);
      cam.position.set(c.x - v.dir[0] * dist, c.y - v.dir[1] * dist, c.z - v.dir[2] * dist);
    } else {
      // near 跟着模型尺度走：写死 0.01 时大模型会出现 z-fighting（面上起黑斑）
      var near = Math.max(d * 0.004, 1e-4);
      /* 横向装下 L，纵向是 L/aspect：矩形格子时上下自然变长/变短，比例不拉伸 */
      var halfW = L / 2, halfH = L / aspect / 2;
      cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, near, d * 4);
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
   *   cell       单格边长 px（128–4096，默认 768）；cellW / cellH 可单独给，用于矩形格
   *   cols       列数（默认 ceil(√n)）
   *   gap        格间距 px
   *   canvasSize 画布边长 px：传了就输出 size×size 的正方形（网格居中；紧凑模式的
   *              网格本身已铺满，居中等于不留白）；不传就是贴合网格的矩形，老调用方不变
   *   cam        'ortho' | 'persp'（默认 ortho——多视图参考必须正交）
   *   mode       'line' | 'solid' | 'shaded' | 'material'
   *   wire       是否叠一层线框（缺省时只有 mode='line' 画线）。
   *              素模 / 材质上也能叠——旧版靠切 mode 二选一，那样「材质+线框」做不到。
   *   transparent / bgColor / bgOpacity
   *   lineWidth / lineColor / fillColor / fillOpacity / margin
   *   labels     是否在每格左下角烧上视图名
   * @returns {Promise<{png, cols, rows, cell, cellW, cellH, gap, width, height, cells}>}
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
  function renderDepthBuffer(renderer, scene, cams, count, cols, cellW, cellH, gap, totalW, totalH) {
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
        var x = (i % cols) * (cellW + gap);
        var vy = totalH - (Math.floor(i / cols) * (cellH + gap) + cellH);
        /* 每格用自己相机的 far 归一化：正交和透视的视锥长度差一个量级，
         * 共用一个 far 会让透视那几格的可用精度掉下去。 */
        mat.uniforms.uFar.value = Math.max(1e-3, Number(cams[i].far) || 1);
        renderer.setViewport(x, vy, cellW, cellH);
        renderer.setScissor(x, vy, cellW, cellH);
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
    var cellW = o.cellW || o.cell, cellH = o.cellH || o.cell, gap = o.gap, cols = o.cols;
    var totalH = o.totalH, totalW = o.totalW;
    var stepX = cellW + gap, stepY = cellH + gap;
    /* 阈值 = 相邻像素**线性视图深度**之差占整条视锥长度的比例（0.1% ~ 40%）。
     * 用线性距离而不是 gl_FragCoord.z：透视投影下后者在远处被压扁，同一个滑条
     * 位置在近处和远处能差出十几倍灵敏度。 */
    var th = 0.001 * Math.pow(400, o.thresh / 100);
    /* 分辨率补偿：单格越大，同一个特征逐像素的深度差越小，阈值要跟着收。
     * 不补的话「512 格一屏线、4K 导出一根没有」，换个尺寸就得重调滑条。 */
    th *= Math.max(0.25, Math.min(4, 768 / Math.max(cellW, cellH)));
    var BG = 1e-4;                 // 解出来小于它 = 空背景（清屏是全 0）
    var ow = Math.max(1, Math.round(o.width));
    var oo = Math.floor((ow - 1) / 2);
    var stride = totalW * 4;
    var cur = new Float32Array(cellW), nxt = new Float32Array(cellW);
    var em = new Uint8Array(cellW * cellH);       // 边位图，每格整片重写，不必清
    /* 统计：命中的边里有多少只是剪影、多少真是靠深度差判出来的。
     * 全是剪影就说明阈值怎么拖都不会变——这一类「滑条失效」要能自查。 */
    var info = { th: th, hits: 0, silhouette: 0 };

    function readRow(glY, col0, dst) {
      var base = glY * stride;
      for (var x = 0; x < cellW; x++) dst[x] = packedDepthAt(buf, base + (col0 + x) * 4);
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
      var x0 = (ci % cols) * stepX;
      var vy = totalH - (Math.floor(ci / cols) * stepY + cellH);

      /* 第一遍：逐像素判边，先落到位图里。
       * 不能边判边画——AI 生成的模型普遍有重叠面片（衣服贴着身体、双层头发），
       * 两层面在深度上交替胜出，单个像素的深度会突然跳一大截。那种孤立跳变
       * 判出来就是满屏黑点，必须在画之前滤掉。 */
      readRow(vy, x0, cur);
      for (var y = 0; y < cellH; y++) {
        if (y + 1 < cellH) readRow(vy + y + 1, x0, nxt);
        var base = y * cellW;
        for (var x = 0; x < cellW; x++) {
          var a = cur[x], b = cur[x + 1], c = nxt[x];
          var edge = 0;
          /* 右邻、上邻两个方向就覆盖了所有交界（每条交界至少被其中一个方向跨过），
           * 不必 8 邻域——那是四倍的开销换同一条线。 */
          if (x + 1 < cellW) edge = isEdge(a, b);
          if (!edge && y + 1 < cellH) edge = isEdge(a, c);
          em[base + x] = edge;
        }
        var t0 = cur; cur = nxt; nxt = t0;
      }

      /* 第二遍：去掉孤立点。一条真的结构线必然是连续的（至少两三个像素相接），
       * 而 z-fighting 抖出来的点是孤零零一颗。就地标成 2 当「作废」，
       * 判断只认 1，所以不会级联删掉真的短线。 */
      for (var y2 = 0; y2 < cellH; y2++) {
        for (var x2 = 0; x2 < cellW; x2++) {
          var idx = y2 * cellW + x2;
          if (em[idx] !== 1) continue;
          var nb = 0;
          for (var dy = -1; dy <= 1 && !nb; dy++) {
            var yy = y2 + dy;
            if (yy < 0 || yy >= cellH) continue;
            for (var dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              var xx = x2 + dx;
              if (xx < 0 || xx >= cellW) continue;
              if (em[yy * cellW + xx] === 1) { nb = 1; break; }
            }
          }
          if (!nb) em[idx] = 2;
        }
      }

      /* 第三遍：逐行合并连续段，一次 fillRect 画一段 */
      for (var y3 = 0; y3 < cellH; y3++) {
        var outY = totalH - 1 - (vy + y3) - oo;
        var run = -1;
        var row = y3 * cellW;
        for (var x3 = 0; x3 < cellW; x3++) {
          if (em[row + x3] === 1) { info.hits++; if (run < 0) run = x3; }
          else if (run >= 0) {
            /* 行内连续段合并成一次 fillRect：4K 单格 + 稠密线条时，
             * 逐像素 fillRect 能慢十倍。 */
            ctx.fillRect(x0 + run - oo, outY, x3 - run + ow - 1, ow);
            run = -1;
          }
        }
        if (run >= 0) ctx.fillRect(x0 + run - oo, outY, cellW - run + ow - 1, ow);
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
    var cellW = o.cellW || o.cell, cellH = o.cellH || o.cell, gap = o.gap, cols = o.cols;
    var totalW = o.totalW, totalH = o.totalH;
    var stepX = cellW + gap, stepY = cellH + gap, stride = totalW * 4;
    var BG = 1e-4;
    var range = clampNum(o.range == null ? 1 : o.range, 0.05, 1);
    var img = ctx.createImageData(totalW, totalH);
    var d8 = img.data;
    /* 先整幅填成不透明的「无限远」色：模型外面 / 格间距都是它，读灰度才有参照 */
    var bgc = hexToRgb(o.bg, { r: 0, g: 0, b: 0 });
    for (var ai = 0; ai < d8.length; ai += 4) {
      d8[ai] = bgc.r; d8[ai + 1] = bgc.g; d8[ai + 2] = bgc.b; d8[ai + 3] = 255;
    }

    var dp = new Float32Array(cellW * cellH);     // 每格一次解码，两遍复用
    var info = { lo: 0, hi: 0, range: range };

    for (var ci = 0; ci < o.count; ci++) {
      var x0 = (ci % cols) * stepX;
      var vy = totalH - (Math.floor(ci / cols) * stepY + cellH);

      var lo = 1, hi = 0;
      for (var y = 0; y < cellH; y++) {
        var rb = (vy + y) * stride;
        var row = y * cellW;
        for (var x = 0; x < cellW; x++) {
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

      for (var y2 = 0; y2 < cellH; y2++) {
        var outRow = (totalH - 1 - (vy + y2)) * totalW * 4;
        var row2 = y2 * cellW;
        for (var x2 = 0; x2 < cellW; x2++) {
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
  function renderLinesOnly(renderer, scene, cams, count, cols, cellW, cellH, gap, totalW, totalH, bgColor) {
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
        var x = (i % cols) * (cellW + gap);
        var vy = totalH - (Math.floor(i / cols) * (cellH + gap) + cellH);
        renderer.setViewport(x, vy, cellW, cellH);
        renderer.setScissor(x, vy, cellW, cellH);
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
  function renderSceneSegment(renderer, scene, cams, names, cols, cellW, cellH, gap, totalW, totalH, keys, first, bgColor) {
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
      var x = (i % cols) * (cellW + gap);
      var yTop = Math.floor(i / cols) * (cellH + gap);
      var vy = totalH - (yTop + cellH);                 // GL 视口原点在左下
      renderer.setViewport(x, vy, cellW, cellH);
      renderer.setScissor(x, vy, cellW, cellH);
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
      cellW: env.cellW, cellH: env.cellH, gap: env.gap, cols: env.cols, count: env.names.length,
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
    var ow = Math.max(1, Math.round(Number(env.opts.outlineWidth) ||
      Math.max(1, Math.max(env.cellW || env.cell, env.cellH || env.cell) / 512 * 1.6)));
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
      cellW: env.cellW, cellH: env.cellH, gap: env.gap, cols: env.cols, count: env.names.length,
      thresh: env.opts.depthEdgeThresh == null ? 40 : clampNum(env.opts.depthEdgeThresh, 0, 100),
      width: Math.max(1, Math.round(Number(env.opts.depthEdgeWidth) || env.lineW * env.lwScale)),
      color: env.opts.depthEdgeColor || env.lineColor
    });
  }

  function postLabelsLayer(env) {
    var ctx = env.ctx, cellW = env.cellW || env.cell, cellH = env.cellH || env.cell;
    var gap = env.gap, cols = env.cols, names = env.names;
    var fs = Math.max(11, Math.round(Math.min(cellW, cellH) * 0.042));
    var dark = env.opts.bgColor && !/^#(fff|ffffff)$/i.test(env.opts.bgColor) && !env.opts.transparent;
    ctx.font = '600 ' + fs + 'px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'bottom';
    for (var j = 0; j < names.length; j++) {
      var lx = (j % cols) * (cellW + gap) + Math.round(cellW * 0.045);
      var ly = Math.floor(j / cols) * (cellH + gap) + cellH - Math.round(cellH * 0.045);
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
     * 下面 totalW/H 的钳制已经守住 WebGL 纹理上限，这里不用再卡 2048。
     * cellW / cellH 允许不同（「一键紧凑」的矩形格）；只传 cell 时两者相等。 */
    var cellW = Math.round(clampNum(Number(opts.cellW) || Number(opts.cell) || 768, 128, 4096));
    var cellH = Math.round(clampNum(Number(opts.cellH) || Number(opts.cell) || 768, 128, 4096));
    var gap = Math.max(0, Math.round(Number(opts.gap) || 0));
    var cols = Math.round(Number(opts.cols) || 0);
    if (cols < 1) cols = Math.ceil(Math.sqrt(names.length));
    cols = Math.min(cols, names.length);
    var rows = Math.ceil(names.length / cols);

    /* 总边长受 WebGL 纹理上限约束（常见 8192）。超了自动缩格，
     * 而不是让 toDataURL 抛一个用户看不懂的异常。 */
    var MAX = 8192;
    var totalW = cols * cellW + (cols - 1) * gap;
    var totalH = rows * cellH + (rows - 1) * gap;
    var over = Math.max(totalW, totalH) / MAX;
    if (over > 1) {
      cellW = Math.max(64, Math.floor(cellW / over));
      cellH = Math.max(64, Math.floor(cellH / over));
      if (cellW % 2) cellW -= 1;
      if (cellH % 2) cellH -= 1;
      totalW = cols * cellW + (cols - 1) * gap;
      totalH = rows * cellH + (rows - 1) * gap;
    }
    var aspect = cellW / cellH;

    // 线宽按格尺寸等比放大：512 格上 1.4px 正好，1024 格还写 1.4 就细得看不见
    var lwScale = Math.max(1, Math.min(cellW, cellH) / 512);
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
      res: [cellW, cellH],
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
      /* cell 保留旧字段名（= 宽）；矩形格要用 cellW / cellH */
      cell: cellW, cellW: cellW, cellH: cellH,
      gap: gap, cols: cols, totalW: totalW, totalH: totalH, names: names,
      lineW: lineW, lwScale: lwScale, lineColor: opts.lineColor || '#2b2b2b',
      creaseOpts: creaseOpts,
      seamOpts: {
        /* 比线框粗一点：接缝是这张图要看的重点，被线框淹没就失去意义了 */
        lineWidth: Math.max(1.6, lineW * 1.6) * lwScale,
        lineColor: opts.uvEdgeColor || '#ff2d78',
        res: [cellW, cellH]
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
    // 所有视图共用一个视锥 → 各格尺度严格一致；视锥按单格宽高比铺开
    var frameL = frameSize(model, names, camMargin, aspect);
    var cams = names.map(function (k) {
      return viewCamera(model, k, {
        cam: opts.cam === 'persp' ? 'persp' : 'ortho',
        margin: camMargin
      }, frameL, aspect);
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
      depthBuf = renderDepthBuffer(renderer, scene, cams, names.length, cols, cellW, cellH, gap, totalW, totalH);
    }

    /* 外圈画布：传了 opts.canvasSize 时（多视图 App 的固定 2K/4K 正方形口径），
     * 把贴合网格的渲染结果居中放进 size×size 的正方块；不传就是贴合网格的矩形，
     * 老调用方（工作流节点 / quadViews）完全不变。 */
    var outW = totalW, outH = totalH, padX = 0, padY = 0;
    var box = Math.round(Number(opts.canvasSize) || 0);
    if (box >= 2048 && box >= totalW && box >= totalH) {
      outW = outH = box;
      padX = Math.round((outW - totalW) / 2);
      padY = Math.round((outH - totalH) / 2);
    }

    /* 先画在贴合网格的 work 上：各图层函数都按网格坐标算，
     * 最后再整幅搬到正方画布——图层代码不用知道留白的存在。 */
    var work = document.createElement('canvas');
    work.width = totalW;
    work.height = totalH;
    var ctx = work.getContext('2d');
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
    env.out = work;

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
          var x = (i % cols) * (cellW + gap);
          var yTop = Math.floor(i / cols) * (cellH + gap);
          var vy = totalH - (yTop + cellH);                 // 关键：GL 视口原点在左下
          renderer.setViewport(x, vy, cellW, cellH);
          renderer.setScissor(x, vy, cellW, cellH);
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
          renderSceneSegment(renderer, scene, cams, names, cols, cellW, cellH, gap, totalW, totalH,
            ops[oi].keys, firstSeg, opts.bgColor);
          ctx.drawImage(canvas, 0, 0);
          firstSeg = false;
        } else {
          runPostLayer(env, ops[oi].layer);
        }
      }
    }
    /* 整幅搬进正方形画布。遮罩通道先铺黑底——它的语义是「黑底白模」，
     * 留白区也必须是黑的；颜色 / 深度通道保持透明，AI 才分得清模型和空白。 */
    var out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    var octx = out.getContext('2d');
    if (pass === 'mask') {
      octx.fillStyle = '#000000';
      octx.fillRect(0, 0, outW, outH);
    }
    octx.drawImage(work, padX, padY);

    var depthGrayInfo = env.info.dgray;
    var deInfo = env.info.dedge;

    var png;
    try {
      png = out.toDataURL('image/png');
    } catch (e) {
      throw new Error('导出失败：画布过大（' + outW + '×' + outH + '），请调小画布尺寸');
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
        x: padX + (idx % cols) * (cellW + gap),
        y: padY + Math.floor(idx / cols) * (cellH + gap),
        w: cellW,
        h: cellH
      };
    });

    return {
      png: png, cols: cols, rows: rows, cell: cellW, cellW: cellW, cellH: cellH, gap: gap,
      width: outW, height: outH, cells: cells,
      padX: padX, padY: padY, gridW: totalW, gridH: totalH,
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
  /* ---------------- 拆分模块的共享面 ----------------
   * 预览视口（m3d-preview.js）与材质插槽（m3d-slots.js）原是本文件闭包里的两段，
   * 2026-11-01 拆成独立脚本。file:// 下没有模块系统，所以把真正跨界的这几项
   * 挂到一个内部对象上；它不是公开 API —— 对外仍然只有 Model3D。 */
  var M = {
    ready: ready,
    load: load,
    bufToDataURL: bufToDataURL,
    saveDataURL: saveDataURL,
    clampNum: clampNum,
    baryGeometry: baryGeometry,
    wireMaterial: wireMaterial,
    fillMaterial: fillMaterial,
    pushBackDepth: pushBackDepth,
    addUvSeams: addUvSeams,
    quadViews: quadViews,
    renderThumb: renderThumb,
    VIEWS: VIEWS,
    VIEW_KEYS: VIEW_KEYS
  };
  global.__m3d = M;

  global.Model3D = {
    ready: ready,
    load: load,
    quadViews: quadViews,
    viewGrid: viewGrid,
    renderThumb: renderThumb,
    /* 预览在 m3d-preview.js：门面在这里定型，所以用转发函数——
     * 直接写 openPreview: openPreview 会在拆分脚本加载前把 undefined 写进公开接口。 */
    openPreview: function (src, opts) { return M.openPreview(src, opts); },
    /* 打开当前预览的参考图抽屉（模型库磁贴上的「参考」用它，省掉轮询 DOM） */
    openRefs: function () { var f = M.refOpener; if (f) f(); return !!f; },
    closePreview: function () { return M.closePreview(); },
    VIEWS: VIEWS,
    VIEW_KEYS: VIEW_KEYS,
    QUAD_NAMES: QUAD_NAMES
  };
})(window);
