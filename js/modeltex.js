/* 模型贴图工具（经验固化 2026-10-30，源自 tools/_body.html 蓝发少女上色验证）
 *
 * 分工：语言模型只出「区域规则 JSON」（创作期）；落笔（并查集分岛 + 整岛填色 + 渲染）
 * 是这里的确定性代码（执行期重放）。与 svgtex.js（矢量绘制）、texpaint.js（投影烘焙）互补：
 *   - 岛区域上色：整块部位铺色，不依赖参考图像素，规则可版本化重放
 *   - SVG 贴图：AI 直接按 UV 坐标画细节
 *   - 投影烘焙：把已知正确的照片像素搬进 UV
 *
 * 依赖：three.js（vendor）、Model3D.load（模型加载，OBJ/GLB/GLTF 通吃）。
 *
 * API：
 *   ModelTex.analyze(src)                     加载模型 + UV 岛分析
 *                                             → { root, parts, islands, triIsland, box, h }
 *   ModelTex.paint(a, rules, baseColor, size) → { canvas, counts, assigned }
 *   ModelTex.previewGrid(a, mapCanvas, opt)   → dataURL（上排原始 / 下排上色 + 贴图格）
 *   ModelTex.objTrio(a)                       → { objText, mtlText }（配贴图 PNG 组成三件套）
 *
 * 规则格式（JSON 数组，按顺序首个命中生效；未命中用底色）：
 *   { "name":"头发", "color":"#8fd2e6",
 *     "yMin":91, "yMax":100,          质心 Y 范围（模型自身单位）
 *     "xAbsMin":30, "xAbsMax":40,     质心 |X| 范围（左右对称部件用绝对值）
 *     "zMin":20, "zMax":30,           质心 Z 范围
 *     "areaMin":0.02, "areaMax":0.5,  UV 面积范围
 *     "ring":true,                    扁环判定（Y 厚 < 4%h 且 XZ 宽 > 5%h，用来抓光环/腰带圈）
 *     "trisMin":100 }                 三角形数下限（抓大块、放过碎渣）
 *
 * 踩过的坑（别再犯）：
 *   - fov35 下相机距离必须按包围盒半径 fit（dist = radius/tan(fov/2)*1.15），
 *     按「高×1.15」拍 100 单位高的模型会整体出画（全黑）。
 *   - UV 原点在左下、图片原点在左上：写贴图必须 y=(1-v)*size。
 *   - 部位判定用「岛 3D 质心 + 包围盒」，不要用屏幕点选（单岛可跨多个屏幕区域）。
 *   - 一个大岛跨多个部位时质心会误判（本例胸甲大板被并进头区）——调规则时先看岛元数据。
 */
(function () {
  'use strict';

  /* ---------------- UV 岛：按「共享 UV 边」把三角形并起来（并查集） ---------------- */

  function buildIslandsPart(part) {
    var pos = part.pos, uv = part.uv, idx = part.idx;
    var triCount = part.tri;
    var parent = new Int32Array(triCount);
    for (var i = 0; i < triCount; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function uni(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }
    function vi(t, k) { return idx ? idx.getX(t * 3 + k) : t * 3 + k; }
    function q(v) { return Math.round(v * 1e4) / 1e4; }
    var edgeMap = {};
    for (var t = 0; t < triCount; t++) {
      for (var k = 0; k < 3; k++) {
        var a = vi(t, k), b = vi(t, (k + 1) % 3);
        var ua = q(uv.getX(a)) + ',' + q(uv.getY(a));
        var ub = q(uv.getX(b)) + ',' + q(uv.getY(b));
        var key = ua < ub ? ua + '|' + ub : ub + '|' + ua;
        if (edgeMap[key] === undefined) edgeMap[key] = t;
        else uni(edgeMap[key], t);
      }
    }
    var groups = {};
    for (var t2 = 0; t2 < triCount; t2++) {
      var r = find(t2);
      (groups[r] || (groups[r] = [])).push(t2);
    }
    return groups;
  }

  /* ---------------- 分析：加载 + 全模型分岛（跨 mesh 合并，三角形全局编号） ---------------- */

  async function analyze(src) {
    if (!window.Model3D) throw new Error('model3d.js 未加载');
    if (!Model3D.ready()) throw new Error('3D 组件未就绪（缺少 three.js）');
    const m = await Model3D.load(src);
    const meshes = [];
    m.root.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
    if (!meshes.length) throw new Error('模型里没有网格');

    const parts = meshes.map(o => {
      const g = o.geometry;
      if (!g.attributes.uv) throw new Error('模型网格缺少 UV——没有 UV 无法按岛上色（Tripo 模型一般自带；可换导出格式重生成）');
      return {
        g,
        pos: g.attributes.position,
        uv: g.attributes.uv,
        idx: g.index,
        tri: Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3),
        mw: o.matrixWorld.clone()
      };
    });

    /* 世界空间包围盒（决定相机与规则坐标系） */
    const vTmp = new THREE.Vector3();
    function worldPos(part, vi, out) {
      out.set(part.pos.getX(vi), part.pos.getY(vi), part.pos.getZ(vi));
      out.applyMatrix4(part.mw);
      return out;
    }

    const islandsRaw = [];   // { tris:[{part,t}], area }
    let triTotal = 0;
    parts.forEach((part, pi) => {
      const groups = buildIslandsPart(part);
      const vi = (t, k) => part.idx ? part.idx.getX(t * 3 + k) : t * 3 + k;
      Object.keys(groups).forEach(key => {
        const tris = groups[key];
        let area = 0;
        const triRefs = tris.map(t => {
          const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
          area += Math.abs(
            (part.uv.getX(b) - part.uv.getX(a)) * (part.uv.getY(c) - part.uv.getY(a)) -
            (part.uv.getX(c) - part.uv.getX(a)) * (part.uv.getY(b) - part.uv.getY(a))) / 2;
          return { part: pi, t };
        });
        islandsRaw.push({ tris: triRefs, area });
      });
      triTotal += part.tri;
    });
    islandsRaw.sort((p, q2) => q2.area - p.area);
    islandsRaw.forEach((o, i) => { o.id = i; });

    /* 每岛：3D 质心 + 包围盒（世界空间，模型自身单位） */
    const wp = new THREE.Vector3();
    islandsRaw.forEach(o => {
      let sx = 0, sy = 0, sz = 0, n = 0;
      let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
      o.tris.forEach(ref => {
        const part = parts[ref.part];
        const vi = (t, k) => part.idx ? part.idx.getX(t * 3 + k) : t * 3 + k;
        for (let k = 0; k < 3; k++) {
          worldPos(part, vi(ref.t, k), wp);
          sx += wp.x; sy += wp.y; sz += wp.z; n++;
          if (wp.x < mnx) mnx = wp.x; if (wp.x > mxx) mxx = wp.x;
          if (wp.y < mny) mny = wp.y; if (wp.y > mxy) mxy = wp.y;
          if (wp.z < mnz) mnz = wp.z; if (wp.z > mxz) mxz = wp.z;
        }
      });
      o.centroid = [sx / n, sy / n, sz / n];
      o.bbox = [mnx, mny, mnz, mxx, mxy, mxz];

      /* UV 包围盒（归一化 0–1，给「细节规则 / SVG 落笔」定位用） */
      let umin = 1e9, vmin = 1e9, umax = -1e9, vmax = -1e9;
      o.tris.forEach(ref => {
        const part = parts[ref.part];
        const vi = (t, k) => part.idx ? part.idx.getX(t * 3 + k) : t * 3 + k;
        for (let k = 0; k < 3; k++) {
          const v = vi(ref.t, k);
          const u = part.uv.getX(v), vv = part.uv.getY(v);
          if (u < umin) umin = u; if (u > umax) umax = u;
          if (vv < vmin) vmin = vv; if (vv > vmax) vmax = vv;
        }
      });
      o.uvBBox = [umin, vmin, umax, vmax];
    });

    /* 三角形 → 岛（全局编号） */
    const triIsland = new Int32Array(triTotal);
    islandsRaw.forEach(o => o.tris.forEach(ref => {
      let off = 0;
      for (let k = 0; k < ref.part; k++) off += parts[k].tri;
      triIsland[off + ref.t] = o.id;
    }));

    const box = new THREE.Box3();
    islandsRaw.forEach(o => {
      box.expandByPoint(new THREE.Vector3(o.bbox[0], o.bbox[1], o.bbox[2]));
      box.expandByPoint(new THREE.Vector3(o.bbox[3], o.bbox[4], o.bbox[5]));
    });
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    return {
      root: m.root, parts, islands: islandsRaw, triIsland,
      box, center, h: Math.max(size.y, 1e-6), radius: Math.max(size.length() / 2, 1e-6)
    };
  }

  /* ---------------- 规则匹配：首个命中生效 ---------------- */

  function matchRule(o, rules, h) {
    if (!Array.isArray(rules)) return null;
    for (let r = 0; r < rules.length; r++) {
      const u = rules[r];
      if (!u || !u.color) continue;
      const c = o.centroid, b = o.bbox;
      if (u.ring === true) {
        const flat = (b[4] - b[1]) < h * 0.04;
        const wide = (b[3] - b[0]) > h * 0.05 && (b[5] - b[2]) > h * 0.05;
        if (!flat || !wide) continue;
      }
      if (u.yMin !== undefined && c[1] < u.yMin) continue;
      if (u.yMax !== undefined && c[1] > u.yMax) continue;
      const ax = Math.abs(c[0]);
      if (u.xAbsMin !== undefined && ax < u.xAbsMin) continue;
      if (u.xAbsMax !== undefined && ax > u.xAbsMax) continue;
      if (u.zMin !== undefined && c[2] < u.zMin) continue;
      if (u.zMax !== undefined && c[2] > u.zMax) continue;
      if (u.areaMin !== undefined && o.area < u.areaMin) continue;
      if (u.areaMax !== undefined && o.area > u.areaMax) continue;
      if (u.trisMin !== undefined && o.tris.length < u.trisMin) continue;
      /* spanYMin/spanYMax：岛的 3D 包围盒高度跨度（绝对单位）——抓「垂发瀑布」「披纱」
       * 这类质心在发根、几何却跨大半个身体的岛，比质心条件可靠 */
      if (u.spanYMin !== undefined && (b[4] - b[1]) < u.spanYMin) continue;
      if (u.spanYMax !== undefined && (b[4] - b[1]) > u.spanYMax) continue;
      return u;
    }
    return null;
  }

  /* ---------------- 上色：整岛填色（UV v 翻转） ---------------- */

  function fillTri(ctx, part, t, color, size) {
    const vi = (t, k) => part.idx ? part.idx.getX(t * 3 + k) : t * 3 + k;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const v = vi(t, k);
      const x = part.uv.getX(v) * size, y = (1 - part.uv.getY(v)) * size;   // UV 原点左下 → 图片原点左上
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return [255, 255, 255];
    const n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }

  /* 细节规则：3D 条件 + 颜色，逐 texel 覆盖底色层。wave 让上边界起伏（蕾丝/花边） */
  function detailMatch(P, rules) {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!r || !r.color) continue;
      const x = P.x, ax = Math.abs(x), y = P.y, z = P.z;
      if (r.yMin !== undefined && y < r.yMin) continue;
      let yMax = r.yMax;
      if (r.wave && yMax !== undefined) {
        const wv = r.wave;
        yMax = yMax + (wv.amp || 0) * Math.cos((wv.axis === 'z' ? z : x) * (wv.freq || 1) + (wv.phase || 0));
      }
      if (yMax !== undefined && y > yMax) continue;
      if (r.xAbsMin !== undefined && ax < r.xAbsMin) continue;
      if (r.xAbsMax !== undefined && ax > r.xAbsMax) continue;
      if (r.zMin !== undefined && z < r.zMin) continue;
      if (r.zMax !== undefined && z > r.zMax) continue;
      return r;
    }
    return null;
  }

  function paintDetail(a, canvas, rules, size) {
    size = size || canvas.width;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, size, size);
    const data = img.data;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), P = new THREE.Vector3();
    const counts = {};
    let hits = 0;
    a.parts.forEach(part => {
      const uv = part.uv, pos = part.pos, idx = part.idx, mw = part.mw;
      const vi = (t, k) => idx ? idx.getX(t * 3 + k) : t * 3 + k;
      const wp = (v, out) => { out.set(pos.getX(v), pos.getY(v), pos.getZ(v)); out.applyMatrix4(mw); return out; };
      for (let t = 0; t < part.tri; t++) {
        const v0 = vi(t, 0), v1 = vi(t, 1), v2 = vi(t, 2);
        const x0 = uv.getX(v0) * size, y0 = (1 - uv.getY(v0)) * size;
        const x1 = uv.getX(v1) * size, y1 = (1 - uv.getY(v1)) * size;
        const x2 = uv.getX(v2) * size, y2 = (1 - uv.getY(v2)) * size;
        let mnx = Math.floor(Math.min(x0, x1, x2)), mxx = Math.ceil(Math.max(x0, x1, x2));
        let mny = Math.floor(Math.min(y0, y1, y2)), mxy = Math.ceil(Math.max(y0, y1, y2));
        if (mxx < 0 || mnx >= size || mxy < 0 || mny >= size) continue;
        if (mnx < 0) mnx = 0; if (mny < 0) mny = 0;
        if (mxx > size) mxx = size; if (mxy > size) mxy = size;
        const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        if (Math.abs(den) < 1e-9) continue;
        wp(v0, A); wp(v1, B); wp(v2, C);
        for (let py = mny; py < mxy; py++) {
          for (let px = mnx; px < mxx; px++) {
            const fx = px + 0.5, fy = py + 0.5;
            const l0 = ((y1 - y2) * (fx - x2) + (x2 - x1) * (fy - y2)) / den;
            const l1 = ((y2 - y0) * (fx - x2) + (x0 - x2) * (fy - y2)) / den;
            const l2 = 1 - l0 - l1;
            if (l0 < -0.001 || l1 < -0.001 || l2 < -0.001) continue;
            P.set(A.x * l0 + B.x * l1 + C.x * l2, A.y * l0 + B.y * l1 + C.y * l2, A.z * l0 + B.z * l1 + C.z * l2);
            const r = detailMatch(P, rules);
            if (!r) continue;
            const rgb = hexRgb(r.color);
            const i = (py * size + px) * 4;
            data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
            hits++;
            const nm = r.name || '细节';
            counts[nm] = (counts[nm] || 0) + 1;
          }
        }
      }
    });
    ctx.putImageData(img, 0, 0);
    return { hits, counts };
  }

  function paint(a, rules, baseColor, size, opts) {
    size = size || 1024;
    opts = opts || {};
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = baseColor || '#f4f7fb';
    ctx.fillRect(0, 0, size, size);
    const counts = {}, assigned = [];
    const colorOf = (o, ruleSet) => {
      if (ruleSet === 'rainbow') return ['岛' + o.id, 'hsl(' + ((o.id * 137.508) % 360).toFixed(1) + ',72%,58%)'];
      const u = matchRule(o, ruleSet, a.h);
      return [u ? (u.name || '未命名') : 'base', u ? u.color : (baseColor || '#f4f7fb')];
    };

    if (opts.matchBy === 'triangle') {
      /* 逐三角形判定：按三角形质心决定归属，面积/扁环/三角数条件仍沿用所属岛，
         解决「一个大 UV 岛横跨多个部位」导致的整岛误判 */
      let off = 0;
      const wp = new THREE.Vector3();
      a.parts.forEach(part => {
        const uv = part.uv, pos = part.pos, idx = part.idx, mw = part.mw;
        const vi = (t, k) => idx ? idx.getX(t * 3 + k) : t * 3 + k;
        for (let t = 0; t < part.tri; t++) {
          const isl = a.islands[a.triIsland[off + t]];
          const v0 = vi(t, 0), v1 = vi(t, 1), v2 = vi(t, 2);
          let cx = 0, cy = 0, cz = 0;
          [v0, v1, v2].forEach(v => {
            wp.set(pos.getX(v), pos.getY(v), pos.getZ(v)).applyMatrix4(mw);
            cx += wp.x; cy += wp.y; cz += wp.z;
          });
          const pseudo = {
            id: isl.id, centroid: [cx / 3, cy / 3, cz / 3], bbox: isl.bbox,
            area: isl.area, uvBBox: isl.uvBBox, tris: isl.tris
          };
          const [region, color] = colorOf(pseudo, rules);
          counts[region] = (counts[region] || 0) + 1;
          fillTri(ctx, part, t, color, size);
        }
        off += part.tri;
      });
    } else {
      a.islands.forEach(o => {
        const [region, color] = colorOf(o, rules);
        counts[region] = (counts[region] || 0) + 1;
        assigned.push({ island: o.id, region, tris: o.tris.length });
        o.tris.forEach(ref => fillTri(ctx, a.parts[ref.part], ref.t, color, size));
      });
    }

    let detail = null;
    if (Array.isArray(opts.detail) && opts.detail.length) detail = paintDetail(a, cv, opts.detail, size);
    return { canvas: cv, counts, assigned, detail };
  }

  /* ---------------- 岛图：每岛一色 + 编号标注（给 AI / 细节规则寻址用） ---------------- */

  /* opts: { labels:true, bg:'#20242b', parts:[0] }
   * parts 用于「插槽隔离」：一个模型可能有多个 mesh，各自占满 0–1 UV 空间，
   * 叠在一张图上就互相遮挡；只看某个插槽时只画属于它的三角形。 */
  function islandAtlas(a, size, opts) {
    size = size || 1024;
    opts = opts || {};
    const only = Array.isArray(opts.parts) ? new Set(opts.parts) : null;
    const inPart = ref => !only || only.has(ref.part);
    const islandIn = o => !only || o.tris.some(inPart);
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = opts.bg || '#20242b';
    ctx.fillRect(0, 0, size, size);
    a.islands.forEach(o => {
      if(!islandIn(o)) return;
      const color = 'hsl(' + ((o.id * 137.508) % 360).toFixed(1) + ',72%,58%)';
      o.tris.forEach(ref => { if(inPart(ref)) fillTri(ctx, a.parts[ref.part], ref.t, color, size); });
    });
    if (opts.labels !== false) {
      const k = size / 1024;
      ctx.font = '600 ' + Math.round(13 * k) + 'px system-ui,"Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      a.islands.forEach(o => {
        if(!islandIn(o)) return;
        if (o.area * size * size < 900) return;         // 太小的岛标不下，靠颜色区分
        const b = o.uvBBox;
        const x = (b[0] + b[2]) / 2 * size, y = (1 - (b[1] + b[3]) / 2) * size;
        ctx.lineWidth = 3 * k; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(o.id, x, y);
        ctx.fillStyle = '#fff'; ctx.fillText(o.id, x, y);
      });
    }
    return cv;
  }

  /* ---------------- 离屏渲染：多视角网格（上排原始 / 下排贴图） ---------------- */

  let _rd = null;
  function renderer(cell) {
    if (!_rd) {
      _rd = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      _rd.setPixelRatio(1);
      _rd.domElement.style.display = 'none';
      document.body.appendChild(_rd.domElement);
    }
    _rd.setSize(cell, cell, false);
    return _rd;
  }

  function shotCell(a, map, deg, cell) {
    const rd = renderer(cell);
    const scene = new THREE.Scene();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    if (map) { mat.map = (map.isTexture) ? map : new THREE.CanvasTexture(map); mat.map.anisotropy = 4; mat.needsUpdate = true; }
    const clone = a.root.clone(true);
    clone.traverse(o => { if (o.isMesh) o.material = mat; });
    scene.add(clone);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const l1 = new THREE.DirectionalLight(0xffffff, 0.5); l1.position.set(2, 4, 5); scene.add(l1);
    const l2 = new THREE.DirectionalLight(0xffffff, 0.25); l2.position.set(-3, 2, -4); scene.add(l2);

    const fov = 35;
    const cam = new THREE.PerspectiveCamera(fov, 1, a.radius / 100, a.radius * 40);
    const dist = a.radius / Math.tan(fov * Math.PI / 360) * 1.15;   // 按半径 fit，别按高×1.15（会出画）
    const ang = deg * Math.PI / 180;
    cam.position.set(
      a.center.x + Math.sin(ang) * dist,
      a.center.y,
      a.center.z + Math.cos(ang) * dist);
    cam.lookAt(a.center);
    cam.updateMatrixWorld(true);

    rd.setClearColor(new THREE.Color('#16181c'), 1);
    rd.clear(true, true, true);
    rd.render(scene, cam);
    const c = document.createElement('canvas');
    c.width = cell; c.height = cell;
    c.getContext('2d').drawImage(rd.domElement, 0, 0);
    return c;
  }

  function labelCell(ctx, x, y, w, text) {
    ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fillRect(x, y, w, 26);
    ctx.fillStyle = '#e6e8ea'; ctx.font = '500 14px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'middle'; ctx.fillText(text, x + 8, y + 14);
  }

  /* opt: { cell:400, texLabel:'贴图', angles:[0,35,180], compare:true } */
  function previewGrid(a, mapCanvas, opt) {
    opt = opt || {};
    const cell = opt.cell || 400, gap = 8;
    const angles = opt.angles || [0, 35, 180];
    const cols = angles.length;
    const rows = (opt.compare === false) ? 1 : 2;
    const cells = [];
    if (opt.compare !== false) {
      angles.forEach(d => cells.push({ img: shotCell(a, null, d, cell), label: '原始 · ' + d + '°' }));
    }
    angles.forEach(d => cells.push({ img: shotCell(a, mapCanvas, d, cell), label: (opt.paintedLabel || '上色') + ' · ' + d + '°' }));
    if (mapCanvas) cells.push({ img: mapCanvas, label: opt.texLabel || 'UV 贴图' });

    const out = document.createElement('canvas');
    out.width = cols * (cell + gap) - gap;
    out.height = Math.ceil(cells.length / cols) * (cell + gap) - gap;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#16181c'; ctx.fillRect(0, 0, out.width, out.height);
    cells.forEach((c, i) => {
      const cx = (i % cols) * (cell + gap), cy = Math.floor(i / cols) * (cell + gap);
      ctx.drawImage(c.img, cx, cy, cell, cell);
      labelCell(ctx, cx, cy, cell, c.label);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
      ctx.strokeRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1);
    });
    return out.toDataURL('image/png');
  }

  /* ---------------- OBJ 三件套导出（配外部贴图 PNG，任何查看器可加载） ---------------- */

  function objTrio(a) {
    let out = '# 导出自 Open AGI · 模型区域上色\r\nmtllib body.mtl\r\nusemtl body\r\n';
    let vOff = 1, vtOff = 1;
    const wp = new THREE.Vector3();
    a.parts.forEach(part => {
      const vi = (t, k) => part.idx ? part.idx.getX(t * 3 + k) : t * 3 + k;
      const pos = part.pos, uv = part.uv;
      for (let i = 0; i < pos.count; i++) {
        wp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        wp.applyMatrix4(part.mw);
        out += 'v ' + wp.x.toFixed(6) + ' ' + wp.y.toFixed(6) + ' ' + wp.z.toFixed(6) + '\r\n';
      }
      for (let i = 0; i < uv.count; i++) {
        out += 'vt ' + uv.getX(i).toFixed(6) + ' ' + uv.getY(i).toFixed(6) + '\r\n';
      }
      const tri = part.tri;
      for (let t = 0; t < tri; t++) {
        const a0 = vi(t, 0) + vOff, b0 = vi(t, 1) + vOff, c0 = vi(t, 2) + vOff;
        const at = vi(t, 0) + vtOff, bt = vi(t, 1) + vtOff, ct = vi(t, 2) + vtOff;
        out += 'f ' + a0 + '/' + at + ' ' + b0 + '/' + bt + ' ' + c0 + '/' + ct + '\r\n';
      }
      vOff += pos.count; vtOff += uv.count;
    });
    const mtl = [
      'newmtl body', 'Ka 1.000 1.000 1.000', 'Kd 1.000 1.000 1.000',
      'Ks 0.000 0.000 0.000', 'Ns 10.0', 'd 1.0', 'illum 1', 'map_Kd texture.png', ''
    ].join('\r\n');
    return { objText: out, mtlText: mtl };
  }

  function toDataURL(text, mime) {
    return 'data:' + (mime || 'text/plain') + ';charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(text)));
  }

  /* 触发浏览器下载；data 是文本时先转 dataURL，是 dataURL 时原样用 */
  function download(name, data, mime) {
    const url = /^data:/.test(String(data)) ? data : toDataURL(data, mime);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  window.ModelTex = { analyze, paint, paintDetail, islandAtlas, previewGrid, objTrio, toDataURL, download, matchRule };
})();
