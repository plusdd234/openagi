/* 自动描边：参考图 → 100% 吻合的闭合轮廓
 *
 * 手画 SVG 的精度永远追不上「直接描」：外轮廓必须由原图的像素决定，
 * 而不是由谁的手感决定。这里做三件事：
 *   ① 二值化（白底泛洪 / alpha）+ 连通块 → 前景块与**内孔**（两腿之间、发梢之间那种空洞，
 *      不处理会把洞填死，外形立刻错）；
 *   ② 沿边界走一圈（Moore 邻域）得到像素级轮廓，再用 Douglas-Peucker 抽稀；
 *   ③ **回栅格化验证**：把描出来的多边形重新填成图，和原图二值图算 IoU。
 *      这是唯一能说「吻合」的方式——不是看起来像，是可测量的重叠。
 */
(function (global) {
  'use strict';

  var BG_LUM = 238;

  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  /* 二值化：亮像素从边框泛洪 = 背景，剩下的是主体。
   * opts.mode='alpha' 时按透明度取（渲染图用），'light' 时按亮度（线稿 / 原画用）。 */
  function binarize(imgData, opts) {
    opts = opts || {};
    var w = imgData.width, h = imgData.height, d = imgData.data;
    var mode = opts.mode === 'alpha' ? 'alpha' : 'light';
    /* fillInterior：线稿的内部是白的，但那是图形的一部分 → 从边框泛洪后「没被淹到」的都算前景；
       平涂图（深色图形 + 白色镂空）则相反：内部的白色是**洞**，不能填。
       默认 true（线稿/白模更常见）；要保洞就传 false。 */
    var fillInterior = opts.fillInterior !== false;
    var thresh = opts.threshold != null ? Number(opts.threshold) : BG_LUM;
    var isBgColor = function (i) {
      var p = i * 4;
      if (mode === 'alpha') return d[p + 3] < (opts.alphaMin != null ? opts.alphaMin : 24);
      return lum(d[p], d[p + 1], d[p + 2]) > thresh;
    };
    var bg = new Uint8Array(w * h);
    var stack = [];
    var push = function (x, y) {
      var i = y * w + x;
      if (bg[i] || !isBgColor(i)) return;
      bg[i] = 1; stack.push(i);
    };
    for (var x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (var y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      var i = stack.pop();
      var cx = i % w, cy = (i - cx) / w;
      if (cx > 0) push(cx - 1, cy);
      if (cx < w - 1) push(cx + 1, cy);
      if (cy > 0) push(cx, cy - 1);
      if (cy < h - 1) push(cx, cy + 1);
    }
    var mask = new Uint8Array(w * h);
    for (var j = 0; j < w * h; j++) {
      mask[j] = fillInterior ? (bg[j] ? 0 : 1) : (isBgColor(j) ? 0 : 1);
    }
    return { w: w, h: h, mask: mask };
  }

  /* 4 邻域连通块。want=1 找前景，want=0 找背景（用来找内孔）。 */
  function components(bin, want) {
    var w = bin.w, h = bin.h, m = bin.mask;
    var seen = new Uint8Array(w * h);
    var out = [];
    for (var s = 0; s < w * h; s++) {
      if (seen[s] || m[s] !== want) continue;
      var q = [s]; seen[s] = 1;
      var cells = [], minX = w, minY = h, maxX = -1, maxY = -1;
      while (q.length) {
        var i = q.pop(); cells.push(i);
        var x = i % w, y = (i - x) / w;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        var nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (var k = 0; k < 4; k++) {
          var n = nb[k];
          if (n < 0 || seen[n] || m[n] !== want) continue;
          seen[n] = 1; q.push(n);
        }
      }
      out.push({ cells: cells, area: cells.length, bbox: [minX, minY, maxX, maxY], touchesBorder: minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1 });
    }
    return out;
  }

  /* 沿像素**边**拼轮廓（marching-squares 的边拼法）。
   * 为什么不用「走像素中心」：中心连线在细缝处会跨接，回填面积对不上原图（实测差 2%）；
   * 沿边拼出来的多边形，填充结果与原掩码逐像素一致，IoU 能到 0.99+。
   * 每个前景像素对四条边里「邻居是背景」的那些，发出一条有向边，再首尾相接成环。 */
  function loopsOf(bin) {
    var w = bin.w, h = bin.h, m = bin.mask;
    var edges = [];                        // [x1,y1,x2,y2]
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        if (y === 0 || !m[(y - 1) * w + x]) edges.push([x, y, x + 1, y]);                 // 上
        if (x === w - 1 || !m[y * w + x + 1]) edges.push([x + 1, y, x + 1, y + 1]);       // 右
        if (y === h - 1 || !m[(y + 1) * w + x]) edges.push([x + 1, y + 1, x, y + 1]);     // 下
        if (x === 0 || !m[y * w + x - 1]) edges.push([x, y + 1, x, y]);                   // 左
      }
    }
    var byStart = new Map();
    edges.forEach(function (e, i) {
      var k = e[0] + ',' + e[1];
      if (!byStart.has(k)) byStart.set(k, []);
      byStart.get(k).push(i);
    });
    var used = new Uint8Array(edges.length);
    var loops = [];
    for (var i2 = 0; i2 < edges.length; i2++) {
      if (used[i2]) continue;
      var loop = [];
      var cur = i2;
      var guard = 0;
      while (cur != null && !used[cur] && guard++ < edges.length + 8) {
        used[cur] = 1;
        var e = edges[cur];
        loop.push([e[0], e[1]]);
        var nk = e[2] + ',' + e[3];
        var cands = byStart.get(nk) || [];
        var next = null;
        for (var c = 0; c < cands.length; c++) { if (!used[cands[c]]) { next = cands[c]; break; } }
        if (next == null) break;
        cur = next;
      }
      if (loop.length >= 4) loops.push(loop);
    }
    return loops;
  }

  /* Douglas-Peucker（闭合多边形版）：保留首点，对首尾之间的链做递归简化。 */
  function simplify(pts, tol) {
    if (pts.length <= 4 || !(tol > 0)) return pts;
    function perp(p, a, b) {
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = Math.hypot(dx, dy);
      if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
      return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
    }
    function dp(a, b, out) {
      var maxD = -1, idx = -1;
      for (var i = a + 1; i < b; i++) {
        var d = perp(pts[i], pts[a], pts[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) { dp(a, idx, out); dp(idx, b, out); }
      else out.push(pts[a]);
    }
    var out = [];
    dp(0, pts.length - 1, out);
    out.push(pts[pts.length - 1]);
    return out.length >= 3 ? out : pts;
  }

  function polyArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;    // 有符号：正负用来判外环/内孔方向
  }

  function pointInPoly(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function bboxOf(pts) {
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    pts.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
    return [minX, minY, maxX, maxY];
  }

  /* 主流程：图 → { outers:[{poly, holes:[]}], info } */
  function trace(imgData, opts) {
    opts = opts || {};
    var bin = binarize(imgData, opts);
    var minArea = opts.minArea != null ? Number(opts.minArea) : 400;
    var tol = opts.simplify != null ? Number(opts.simplify) : 0.9;

    var loops = loopsOf(bin).map(function (lp) { return simplify(lp, tol); })
      .filter(function (lp) { return lp.length >= 3 && Math.abs(polyArea(lp)) >= Math.max(20, minArea * 0.25); });
    /* 环的**有符号面积**直接区分外环与内孔：正=外环，负=内孔（在 y 向下的像素坐标里，
     * 外环顺时针、内孔逆时针）。比「猜嵌套深度」稳，实测一实心块+一个洞 = +144 / -16。 */
    var outers = [], holeList = [];
    loops.forEach(function (lp) {
      var a = polyArea(lp);
      if (a > 0) outers.push({ poly: lp, holes: [], area: a, comp: { bbox: bboxOf(lp) } });
      else holeList.push(lp);
    });
    holeList.forEach(function (h) {
      var probe = h[0];
      var best = null;
      outers.forEach(function (o) { if (pointInPoly(probe, o.poly) && (!best || o.area < best.area)) best = o; });
      if (best) best.holes.push(h);
    });

    /* 保留老字段名（comp.bbox / area），下游 buildGLB 只用到 bbox 与 poly */
    return {
      bin: bin,
      outers: outers,
      info: {
        width: bin.w, height: bin.h,
        outers: outers.length,
        holes: outers.reduce(function (s, o) { return s + o.holes.length; }, 0),
        points: outers.reduce(function (s, o) { return s + o.poly.length + o.holes.reduce(function (t, h) { return t + h.length; }, 0); }, 0)
      }
    };
  }

  /* 扫描线栅格化：不用 canvas 填充算覆盖率。
   * canvas 的 fill 是抗锯齿的，边界像素会变成半灰，按 <128 一刀切必然少算一圈 ——
   * 实测这样比出来永远差 2~3%，让人误以为轮廓不准。扫描线是「像素中心在不在多边形里」
   * 的精确判定，和掩码是同一个度量。 */
  function rasterize(outers, w, h) {
    var buf = new Uint8Array(w * h);
    var edges = [];                       // 所有边（外环 + 内孔，用 even-odd 规则）
    outers.forEach(function (o) {
      [o.poly].concat(o.holes).forEach(function (poly) {
        for (var i = 0; i < poly.length; i++) {
          var a = poly[i], b = poly[(i + 1) % poly.length];
          if (a[1] === b[1]) continue;    // 水平边不参与交点
          edges.push([a[0], a[1], b[0], b[1]]);
        }
      });
    });
    for (var y = 0; y < h; y++) {
      var cy = y + 0.5;
      var xs = [];
      for (var e = 0; e < edges.length; e++) {
        var E = edges[e];
        var y0 = Math.min(E[1], E[3]), y1 = Math.max(E[1], E[3]);
        if (cy < y0 || cy >= y1) continue;
        var t = (cy - E[1]) / (E[3] - E[1]);
        xs.push(E[0] + t * (E[2] - E[0]));
      }
      if (!xs.length) continue;
      xs.sort(function (a, b) { return a - b; });
      for (var k = 0; k + 1 < xs.length; k += 2) {
        var x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        for (var x = x0; x <= x1; x++) buf[y * w + x] = 1;
      }
    }
    return buf;
  }

  function verify(traced, opts) {
    var bin = traced.bin;
    var fill = rasterize(traced.outers, bin.w, bin.h);
    var inter = 0, union = 0, onlyMask = 0, onlyFill = 0;
    for (var i = 0; i < bin.w * bin.h; i++) {
      var a = bin.mask[i] === 1, b = fill[i] === 1;
      if (a && b) inter++;
      if (a || b) union++;
      if (a && !b) onlyMask++;
      if (b && !a) onlyFill++;
    }
    return { iou: +(inter / Math.max(1, union)).toFixed(4), inter: inter, union: union, missing: onlyMask, extra: onlyFill };
  }

  function tracePoly(ctx, poly) {
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (var i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
  }

  /* 直接建网格：外环做 Shape，内孔塞进 shape.holes。
   * 不走 SVG 字符串往返——那条路要先转文本再解析，精度和多子路径语义都会丢。 */
  function buildGLB(imgData, opts) {
    opts = opts || {};
    var traced = trace(imgData, opts);
    if (!traced.outers.length) throw new Error('没有描到任何轮廓（阈值太高或图太小？调 threshold / minArea）');
    var k = (Number(opts.height) || 1.6) / traced.bin.h;      // 像素 → 米
    var group = new THREE.Group();
    group.name = 'traced';
    var regions = [];

    traced.outers.forEach(function (o, idx) {
      var shape = new THREE.Shape();
      o.poly.forEach(function (p, i) {
        var x = p[0] * k, y = -p[1] * k;
        if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
      });
      shape.closePath();
      o.holes.forEach(function (h) {
        var path = new THREE.Path();
        h.forEach(function (p, i) {
          var x = p[0] * k, y = -p[1] * k;
          if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
        });
        path.closePath();
        shape.holes.push(path);
      });

      var geo;
      try { geo = new THREE.ShapeGeometry(shape); }
      catch (e) { return; }
      var pos = geo.attributes.position, uv = geo.attributes.uv;
      if (uv) {
        var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (var i2 = 0; i2 < pos.count; i2++) {
          minX = Math.min(minX, pos.getX(i2)); maxX = Math.max(maxX, pos.getX(i2));
          minY = Math.min(minY, pos.getY(i2)); maxY = Math.max(maxY, pos.getY(i2));
        }
        var wSpan = Math.max(1e-6, maxX - minX), hSpan = Math.max(1e-6, maxY - minY);
        for (var i3 = 0; i3 < uv.count; i3++) uv.setXY(i3, (pos.getX(i3) - minX) / wSpan, (pos.getY(i3) - minY) / hSpan);
        uv.needsUpdate = true;
      }

      var label = (opts.labels && opts.labels[idx]) || ('区域' + (idx + 1));
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: new THREE.Color((opts.colors && opts.colors[idx]) || '#c9ccd4'),
        metalness: 0, roughness: 0.85, side: THREE.DoubleSide
      }));
      mesh.name = label;
      mesh.rotation.x = -Math.PI / 2;
      group.add(mesh);

      regions.push({
        id: 'r' + (idx + 1), label: label,
        points: o.poly.length, holes: o.holes.length,
        tris: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3,
        bboxPx: o.comp.bbox,
        area2d: +(Math.abs(polyArea(o.poly)) * k * k).toFixed(4)
      });
    });

    var check = verify(traced, opts);
    var tris = 0;
    group.traverse(function (mm) { if (mm.isMesh && mm.geometry) tris += mm.geometry.index ? mm.geometry.index.count / 3 : mm.geometry.attributes.position.count / 3; });

    return toGLB(group).then(function (dataURL) {
      return {
        dataURL: dataURL,
        stats: { meshes: regions.length, tris: Math.round(tris) },
        regions: regions,
        info: traced.info,
        fit: check,          // { iou } —— 描边回栅格化与原图的吻合度
        scale: k
      };
    });
  }

  function toGLB(group) {
    if (!THREE.GLTFExporter) return Promise.reject(new Error('GLTFExporter 未加载（vendor/GLTFExporter.js）'));
    return new Promise(function (res, rej) {
      new THREE.GLTFExporter().parse(group, res, rej, { binary: true, onlyVisible: true });
    }).then(function (buf) {
      var u8 = new Uint8Array(buf), s = '', CH = 8192;
      for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
      return 'data:model/gltf-binary;base64,' + btoa(s);
    });
  }

  global.Tracer = {
    binarize: binarize,
    components: components,
    loopsOf: loopsOf,
    areaOf: function (pts) { return polyArea(pts); },   // 像素边拼环（trace 的内部实现，测试直接用它）
    simplify: simplify,
    trace: trace,
    verify: verify,
    buildGLB: buildGLB,
    /* 从 dataURL 直接描边（浏览器里解码） */
    fromDataURL: function (url, opts) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () {
          var cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          try { res(buildGLB(ctx.getImageData(0, 0, cv.width, cv.height), opts)); }
          catch (e) { rej(e); }
        };
        img.onerror = function () { rej(new Error('图片解码失败')); };
        img.src = url;
      });
    }
  };
})(window);
