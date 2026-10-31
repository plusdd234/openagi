/* 平面分件（parts segmentation）：上色稿/线稿 → 头发/身体/衣服等闭合曲面
 *
 * 为什么不能纯按颜色聚类：
 *   这张原画里头发是白、衣服也是白，皮肤和裙子高光很接近 —— 纯颜色聚类会把它们连成一整块。
 *   真正把部件分开的是**线稿描边**（深色细线）。所以做法是「颜色洪泛 + 线稿当墙」：
 *   墙挡住扩散，颜色只在同一块内部蔓延，得到的就是**闭合的部件色块**。
 *
 * 为什么洪泛要比「种子色」而不是比「相邻像素」：
 *   比相邻像素会沿着阴影渐变一路漏出去（皮肤→裙子高光只差几级灰），最后整张图连成一片。
 *   比种子色等于给每一块定一个颜色中心，超过容差就停。
 *
 * 但「种子色容差」本身会把平滑渐变切成一条条色带（实测一张原画切出 11605 块），
 * 所以后面还有一步**区域邻接图合并（RAG）**：把「互为邻居且颜色接近」的块反复并起来。
 * 因为线稿是墙、墙像素不属于任何块，头发和衣服在图上并不相邻 —— 合并不会把它们缝成一块。
 */
(function (global) {
  'use strict';

  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dist2(c1, c2) {
    var dr = c1[0] - c2[0], dg = c1[1] - c2[1], db = c1[2] - c2[2];
    return dr * dr + dg * dg + db * db;
  }
  function rgbOf(c) {
    if (!c) return null;
    if (typeof c === 'object') return [+c[0], +c[1], +c[2]];
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c).trim());
    return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : null;
  }

  function hex(c) {
    return '#' + [0, 1, 2].map(function (i) {
      return ('0' + clamp(Math.round(c[i]), 0, 255).toString(16)).slice(-2);
    }).join('');
  }

  /* ---------- ① 前景 + 线稿墙 ---------- */

  /* 前景：alpha 模式看透明度；light 模式从四边泛洪找背景，没被淹到的都算前景
   * （线稿内部是白的，但它属于图形，不能当背景）。 */
  function foreground(imgData, opts) {
    var w = imgData.width, h = imgData.height, d = imgData.data;
    var mode = opts.mode === 'alpha' ? 'alpha' : 'light';
    var th = opts.background != null ? Number(opts.background) : 238;
    var fg = new Uint8Array(w * h);
    var i, p;

    if (mode === 'alpha') {
      for (i = 0; i < w * h; i++) fg[i] = d[i * 4 + 3] > 24 ? 1 : 0;
      return { w: w, h: h, mask: fg, mode: mode };
    }

    var bg = new Uint8Array(w * h);
    var stack = [];
    function push(x, y) {
      var k = y * w + x;
      if (bg[k]) return;
      p = k * 4;
      if (d[p + 3] < 16 || lum(d[p], d[p + 1], d[p + 2]) > th) { bg[k] = 1; stack.push(k); }
    }
    for (i = 0; i < w; i++) { push(i, 0); push(i, h - 1); }
    for (i = 0; i < h; i++) { push(0, i); push(w - 1, i); }
    while (stack.length) {
      var k2 = stack.pop(), cx = k2 % w, cy = (k2 - cx) / w;
      if (cx > 0) push(cx - 1, cy);
      if (cx < w - 1) push(cx + 1, cy);
      if (cy > 0) push(cx, cy - 1);
      if (cy < h - 1) push(cx, cy + 1);
    }
    for (i = 0; i < w * h; i++) fg[i] = bg[i] ? 0 : 1;
    return { w: w, h: h, mask: fg, mode: mode };
  }

  /* 线稿墙：亮度低于 lineThreshold 的算墙，再膨胀 dilate 像素
   * —— 抗锯齿会让线稿边缘变成中间灰，不膨胀的话洪泛会从缝里漏过去。
   *
   * 只看「够不够黑」有个硬伤：原画里头发和衣服都是白的，分隔它们的描边常常是
   * **中等灰**（不是黑），按阈值一刀切就漏了 → 头发和裙子被洪水连成一块。
   * 所以再叠一层**梯度墙**：Sobel 算出亮度变化剧烈的位置，描边两侧必然有强梯度，
   * 与绝对亮度无关。两者取并集。 */
  function walls(imgData, fg, opts) {
    var w = fg.w, h = fg.h, d = imgData.data;
    var th = opts.lineThreshold != null ? Number(opts.lineThreshold) : 120;
    var dilate = opts.dilate != null ? Number(opts.dilate) : 1;
    var useEdge = opts.barrier !== 'dark';
    var edgeTh = opts.edgeThreshold != null ? Number(opts.edgeThreshold) : 36;

    var L = new Float32Array(w * h);
    var i;
    for (i = 0; i < w * h; i++) L[i] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);

    var wall = new Uint8Array(w * h);
    for (i = 0; i < w * h; i++) {
      if (!fg.mask[i]) continue;
      if (L[i] < th) { wall[i] = 1; continue; }
      if (!useEdge) continue;
      var x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
      /* Sobel（只算幅值，方向用不到） */
      var gx = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1] + L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
      var gy = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1] + L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
      if (Math.sqrt(gx * gx + gy * gy) / 4 > edgeTh) wall[i] = 1;
    }

    for (var r = 0; r < dilate; r++) {
      var next = wall.slice();
      for (var y2 = 0; y2 < h; y2++) {
        for (var x2 = 0; x2 < w; x2++) {
          if (wall[y2 * w + x2]) continue;
          if ((x2 > 0 && wall[y2 * w + x2 - 1]) || (x2 < w - 1 && wall[y2 * w + x2 + 1]) ||
              (y2 > 0 && wall[(y2 - 1) * w + x2]) || (y2 < h - 1 && wall[(y2 + 1) * w + x2])) next[y2 * w + x2] = 1;
        }
      }
      wall = next;
    }
    return wall;
  }

  /* ---------- ② 颜色洪泛分块 ---------- */

  function flood(labels, ok, d, w, h, seed, tol2, label) {
    var stack = [seed];
    labels[seed] = label;
    var sr = d[seed * 4], sg = d[seed * 4 + 1], sb = d[seed * 4 + 2];
    var count = 0, sx = 0, sy = 0, sc = [0, 0, 0];
    var tl = tol2;
    while (stack.length) {
      var k = stack.pop(), cx = k % w, cy = (k - cx) / w;
      count++; sx += cx; sy += cy;
      sc[0] += d[k * 4]; sc[1] += d[k * 4 + 1]; sc[2] += d[k * 4 + 2];
      for (var dir = 0; dir < 4; dir++) {
        var nx = cx + (dir === 0 ? -1 : dir === 1 ? 1 : 0);
        var ny = cy + (dir === 2 ? -1 : dir === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var nk = ny * w + nx;
        if (labels[nk] || !ok[nk]) continue;
        var dr = d[nk * 4] - sr, dg = d[nk * 4 + 1] - sg, db = d[nk * 4 + 2] - sb;
        if (dr * dr + dg * dg + db * db > tl) continue;
        labels[nk] = label;
        stack.push(nk);
      }
    }
    return { count: count, cx: sx / count, cy: sy / count, color: [sc[0] / count, sc[1] / count, sc[2] / count] };
  }

  function segment(imgData, opts) {
    opts = opts || {};
    var fg = foreground(imgData, opts);
    var wall = walls(imgData, fg, opts);
    var w = fg.w, h = fg.h, d = imgData.data;
    var tol = opts.tolerance != null ? Number(opts.tolerance) : 26;
    /* tolerance <= 0 = 纯连通域：完全不看颜色，只按墙（描边/梯度）切。
       对「头发和衣服都是白」的原画，这是唯一能按画师描边分开的口径。 */
    var tol2 = tol > 0 ? tol * tol : Number.MAX_VALUE;

    var ok = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) ok[i] = (fg.mask[i] && !wall[i]) ? 1 : 0;

    var labels = new Int32Array(w * h);
    var regions = [];
    /* 扫描顺序播种，保证同一张图结果稳定（可复现，便于对比参数） */
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x;
        if (labels[k] || !ok[k]) continue;
        var id = regions.length + 1;
        var r = flood(labels, ok, d, w, h, k, tol2, id);
        regions.push({ label: id, area: r.count, color: r.color, cx: r.cx, cy: r.cy });
      }
    }
    return { w: w, h: h, labels: labels, regions: regions, fg: fg, wall: wall, imgData: imgData, _next: regions.length + 1 };
  }

  /* 单遍统计：面积 / 颜色和 / 质心 / 包围盒（用类型化数组，几十万像素也只走一遍） */
  function labelStats(seg) {
    var w = seg.w, h = seg.h, labels = seg.labels, d = seg.imgData.data;
    var maxL = 0;
    for (var i = 0; i < labels.length; i++) if (labels[i] > maxL) maxL = labels[i];
    var area = new Int32Array(maxL + 1);
    var sr = new Float64Array(maxL + 1), sg = new Float64Array(maxL + 1), sb = new Float64Array(maxL + 1);
    var sx = new Float64Array(maxL + 1), sy = new Float64Array(maxL + 1);
    var minX = new Int32Array(maxL + 1).fill(w), minY = new Int32Array(maxL + 1).fill(h);
    var maxX = new Int32Array(maxL + 1).fill(-1), maxY = new Int32Array(maxL + 1).fill(-1);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x, L = labels[k];
        if (!L) continue;
        area[L]++; sx[L] += x; sy[L] += y;
        sr[L] += d[k * 4]; sg[L] += d[k * 4 + 1]; sb[L] += d[k * 4 + 2];
        if (x < minX[L]) minX[L] = x; if (x > maxX[L]) maxX[L] = x;
        if (y < minY[L]) minY[L] = y; if (y > maxY[L]) maxY[L] = y;
      }
    }
    return { maxL: maxL, area: area, sr: sr, sg: sg, sb: sb, sx: sx, sy: sy, minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  /* 区域邻接图合并：把「互为邻居 + 颜色接近」的块并起来。
   * 这是把「渐变被切成色带」收回来的一步，也是唯一能自动得到「整块头发」的步骤。 */
  function mergeAdjacent(seg, opts) {
    opts = opts || {};
    var w = seg.w, h = seg.h, labels = seg.labels;
    var st = labelStats(seg);
    var maxL = st.maxL;
    var mergeTol = opts.mergeTol != null ? Number(opts.mergeTol) : 22;

    /* 邻接对（右邻 + 下邻），key = a*maxL+b，同时累计接触像素数 */
    var pair = new Map();
    var BIG = maxL + 1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var a = labels[y * w + x];
        if (!a) continue;
        if (x < w - 1) {
          var b1 = labels[y * w + x + 1];
          if (b1 && b1 !== a) {
            var k1 = a < b1 ? a * BIG + b1 : b1 * BIG + a;
            pair.set(k1, (pair.get(k1) || 0) + 1);
          }
        }
        if (y < h - 1) {
          var b2 = labels[(y + 1) * w + x];
          if (b2 && b2 !== a) {
            var k2 = a < b2 ? a * BIG + b2 : b2 * BIG + a;
            pair.set(k2, (pair.get(k2) || 0) + 1);
          }
        }
      }
    }

    var par = new Int32Array(maxL + 1);
    for (var i = 0; i <= maxL; i++) par[i] = i;
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    /* 合并后的颜色取面积加权平均；面积也累加（判断「谁并谁」时用） */
    var cR = Float64Array.from(st.sr), cG = Float64Array.from(st.sg), cB = Float64Array.from(st.sb);
    var ar = Int32Array.from(st.area);
    function mean(L) { var n = Math.max(1, ar[L]); return [cR[L] / n, cG[L] / n, cB[L] / n]; }

    var edges = [];
    pair.forEach(function (cnt, k) {
      var a2 = Math.floor(k / BIG), b2 = k % BIG;
      edges.push({ a: a2, b: b2, c: cnt });
    });
    /* 颜色最接近的先并（单链聚类），避免「先并错了后面改不回来」 */
    edges.sort(function (p, q) { return dist2(mean(p.a), mean(p.b)) - dist2(mean(q.a), mean(q.b)); });

    edges.forEach(function (e) {
      var ra = find(e.a), rb = find(e.b);
      if (ra === rb) return;
      if (dist2(mean(ra), mean(rb)) > mergeTol * mergeTol) return;
      /* 大的当根，小的并进去 */
      if (ar[ra] < ar[rb]) { var t = ra; ra = rb; rb = t; }
      par[rb] = ra;
      var n = ar[ra] + ar[rb];
      cR[ra] += cR[rb]; cG[ra] += cG[rb]; cB[ra] += cB[rb];
      ar[ra] = n;
    });

    for (var i2 = 0; i2 < labels.length; i2++) if (labels[i2]) labels[i2] = find(labels[i2]);
    return seg;
  }

  /* 碎块清理：面积小于 minArea 的块并进「相邻且颜色最近」的块。
   * 不直接丢：丢掉会让衣服上出现空洞，外轮廓的并集也对不上原图。 */
  function cleanupSmall(seg, opts) {
    opts = opts || {};
    var w = seg.w, h = seg.h, labels = seg.labels;
    var minArea = opts.minArea != null ? Number(opts.minArea) : 260;

    for (var round = 0; round < 8; round++) {
      var st = labelStats(seg);
      var small = [];
      for (var L = 1; L <= st.maxL; L++) if (st.area[L] && st.area[L] < minArea) small.push(L);
      if (!small.length) break;

      /* 邻接（含接触数），只记「小块的邻居」 */
      var want = {};
      small.forEach(function (s) { want[s] = 1; });
      var adj = {};
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var a = labels[y * w + x];
          if (!a || !want[a]) continue;
          var nb = [];
          if (x > 0) nb.push(labels[y * w + x - 1]);
          if (x < w - 1) nb.push(labels[y * w + x + 1]);
          if (y > 0) nb.push(labels[(y - 1) * w + x]);
          if (y < h - 1) nb.push(labels[(y + 1) * w + x]);
          nb.forEach(function (b) {
            if (!b || b === a) return;
            (adj[a] = adj[a] || {})[b] = (adj[a][b] || 0) + 1;
          });
        }
      }

      var changed = false;
      small.forEach(function (s) {
        var cands = Object.keys(adj[s] || {});
        if (!cands.length) return;
        var own = [st.sr[s] / Math.max(1, st.area[s]), st.sg[s] / Math.max(1, st.area[s]), st.sb[s] / Math.max(1, st.area[s])];
        var pick = null, bestD = Infinity;
        cands.forEach(function (cid) {
          var c = Number(cid);
          var m = [st.sr[c] / Math.max(1, st.area[c]), st.sg[c] / Math.max(1, st.area[c]), st.sb[c] / Math.max(1, st.area[c])];
          var dd = dist2(own, m);
          if (dd < bestD) { bestD = dd; pick = c; }
        });
        if (pick == null) return;
        for (var i = 0; i < labels.length; i++) if (labels[i] === s) labels[i] = pick;
        changed = true;
      });
      if (!changed) break;
    }
    return seg;
  }

  /* 暗线像素归属：把墙像素分给周围出现最多的块。
   * 不分的话部件之间会留 1~3px 空缝，外轮廓的并集也对不上原图。 */
  function absorbWalls(seg) {
    var w = seg.w, h = seg.h, labels = seg.labels;
    for (var pass = 0; pass < 4; pass++) {
      var changed = 0;
      var next = Int32Array.from(labels);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var k = y * w + x;
          if (labels[k] || !seg.fg.mask[k]) continue;
          var votes = {}; var best = 0, bestN = 0;
          var nb = [];
          if (x > 0) nb.push(labels[k - 1]);
          if (x < w - 1) nb.push(labels[k + 1]);
          if (y > 0) nb.push(labels[k - w]);
          if (y < h - 1) nb.push(labels[k + w]);
          nb.forEach(function (L) { if (L) votes[L] = (votes[L] || 0) + 1; });
          for (var v in votes) if (votes[v] > bestN) { bestN = votes[v]; best = Number(v); }
          if (best) { next[k] = best; changed++; }
        }
      }
      labels.set(next);
      if (!changed) break;
    }
    return seg;
  }

  /* 按颜色把色块归组到「部件」（k-means，按面积加权）。
   *
   * 为什么需要这一步：头发内部的发丝线也是暗色，会被当成墙，把一头长发切成几十片；
   * 按像素连不连永远分不出「头发」这个**材质**概念。归组之后，「一头头发」就是一组，
   * 组里有几个连通片就是几块（左右双马尾自然各算一片），标签统一。
   *
   * 初始化不用随机：先取最大的块，再反复取「离已有中心最远」的块 —— 同一张图结果稳定，
   * 参数扫描才有可比性。距离用 RGB 欧氏距离但亮度加权（人眼对明度差更敏感）。 */
  function groupByColor(seg, opts) {
    opts = opts || {};
    var K = Math.max(1, Math.min(24, Number(opts.parts) || 6));
    var st = labelStats(seg);
    var labs = [];
    for (var L = 1; L <= st.maxL; L++) {
      if (!st.area[L]) continue;
      labs.push({
        L: L, a: st.area[L],
        c: [st.sr[L] / st.area[L], st.sg[L] / st.area[L], st.sb[L] / st.area[L]]
      });
    }
    if (!labs.length) return seg;
    K = Math.min(K, labs.length);
    labs.sort(function (x, y) { return y.a - x.a; });

    function d2(a, b) {
      var dl = (0.299 * (a[0] - b[0]) + 0.587 * (a[1] - b[1]) + 0.114 * (a[2] - b[2])) * 1.6;
      var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
      return dl * dl + dr * dr + dg * dg + db * db;
    }

    var centers = [labs[0].c.slice()];
    while (centers.length < K) {
      var best = null, bestD = -1;
      labs.forEach(function (s) {
        var dd = Infinity;
        centers.forEach(function (c) { dd = Math.min(dd, d2(s.c, c)); });
        if (dd > bestD) { bestD = dd; best = s; }
      });
      if (!best) break;
      centers.push(best.c.slice());
    }

    var assign = new Array(labs.length).fill(0);
    for (var iter = 0; iter < 10; iter++) {
      var changed = 0;
      labs.forEach(function (s, i) {
        var bi = 0, bd = Infinity;
        centers.forEach(function (c, ci) { var dd = d2(s.c, c); if (dd < bd) { bd = dd; bi = ci; } });
        if (assign[i] !== bi) { assign[i] = bi; changed++; }
      });
      var sum = centers.map(function () { return [0, 0, 0, 0]; });
      labs.forEach(function (s, i) {
        var g = assign[i], t = sum[g];
        t[0] += s.c[0] * s.a; t[1] += s.c[1] * s.a; t[2] += s.c[2] * s.a; t[3] += s.a;
      });
      centers = sum.map(function (t, gi) {
        if (t[3] > 0) return [t[0] / t[3], t[1] / t[3], t[2] / t[3]];
        return centers[gi];
      });
      if (!changed) break;
    }

    /* 标签重映射：像素标签 → 组号。组按面积从大到小重排（1 = 最大部件） */
    var gArea = new Array(K).fill(0);
    var gCol = centers.map(function () { return [0, 0, 0]; });
    labs.forEach(function (s, i) { gArea[assign[i]] += s.a; });
    var order = gArea.map(function (a, i) { return i; }).sort(function (x, y) { return gArea[y] - gArea[x]; });
    var rank = {};
    order.forEach(function (g, i) { rank[g] = i + 1; });

    var remap = new Int32Array(st.maxL + 1);
    labs.forEach(function (s, i) { remap[s.L] = rank[assign[i]]; });
    for (var i2 = 0; i2 < seg.labels.length; i2++) {
      var L2 = seg.labels[i2];
      if (L2) seg.labels[i2] = remap[L2];
    }
    seg.groups = order.map(function (g, i) {
      var n = Math.max(1, gArea[g]);
      var acc = [0, 0, 0];
      labs.forEach(function (s, j) { if (assign[j] === g) { acc[0] += s.c[0] * s.a; acc[1] += s.c[1] * s.a; acc[2] += s.c[2] * s.a; } });
      return { id: i + 1, color: hex([acc[0] / n, acc[1] / n, acc[2] / n]), areaPx: gArea[g] };
    });
    seg.maxLabel = K;
    return seg;
  }

  /* 把标签压实成 1..N（合并后标签是稀疏的），并返回按面积降序的块表 */
  function compact(seg) {
    var labels = seg.labels, map = new Map(), next = 1;
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      if (!L) continue;
      var v = map.get(L);
      if (!v) { v = next++; map.set(L, v); }
      labels[i] = v;
    }
    seg.maxLabel = next - 1;
    return seg;
  }

  /* 前景按空列切成若干「人物」，各自算外框。
   * 不切的话：正面+背面并排 -> 一个片的外框横跨两米宽、纵向拉满，位置判断全错
   * （实测所有片都被判成「头发」）。 */
  function figureBoxes(seg) {
    var w = seg.w, h = seg.h, mask = seg.fg.mask;
    var col = new Uint8Array(w);
    for (var x = 0; x < w; x++) {
      for (var y = 0; y < h; y++) if (mask[y * w + x]) { col[x] = 1; break; }
    }
    var boxes = [], start = -1, gap = 0, gapMin = Math.max(6, Math.round(w * 0.01));
    for (var x2 = 0; x2 <= w; x2++) {
      var on = x2 < w && col[x2];
      if (on) { if (start < 0) start = x2; gap = 0; }
      else if (start >= 0) {
        gap++;
        if (gap >= gapMin || x2 === w) {
          var x1 = x2 - gap;
          var y0 = h, y1 = -1;
          for (var yy = 0; yy < h; yy++) for (var xx = start; xx <= x1; xx++) {
            if (mask[yy * w + xx]) { if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; break; }
          }
          if (y1 >= 0) boxes.push([start, y0, x1, y1]);
          start = -1; gap = 0;
        }
      }
    }
    if (!boxes.length) boxes.push([0, 0, w - 1, h - 1]);
    return boxes;
  }

  /* ---------- ③ 每块 → 闭合轮廓（含内孔） ---------- */

  function inPoly(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /* 按块的**包围盒裁剪**再描边：整图逐块扫（1080×800 × 几百块）会慢到几十秒，
   * 裁到 bbox 后每块只扫自己那一小块，实测 35s → 3s 量级。 */
  function shapesOf(seg, opts) {
    opts = opts || {};
    var w = seg.w, h = seg.h, labels = seg.labels;
    var st = labelStats(seg);
    var tol = opts.simplify != null ? Number(opts.simplify) : 0.4;
    var T = global.Tracer;
    var out = [];

    for (var L = 1; L <= st.maxL; L++) {
      if (!st.area[L]) continue;
      var bx0 = st.minX[L], by0 = st.minY[L], bx1 = st.maxX[L], by1 = st.maxY[L];
      var bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      var mask = new Uint8Array(bw * bh);
      for (var y = by0; y <= by1; y++) {
        var row = y * w;
        for (var x = bx0; x <= bx1; x++) {
          if (labels[row + x] === L) mask[(y - by0) * bw + (x - bx0)] = 1;
        }
      }
      var loops = T.loopsOf({ w: bw, h: bh, mask: mask })
        .map(function (lp) {
          /* 裁出来的点先搬回全图坐标，再抽稀（抽稀容差是像素单位，坐标必须同尺度） */
          var full = lp.map(function (q) { return [q[0] + bx0, q[1] + by0]; });
          return T.simplify(full, tol);
        })
        .filter(function (lp) { return lp.length >= 3 && Math.abs(T.areaOf(lp)) >= 4; });

      var outers = [], holes = [];
      loops.forEach(function (lp) {
        var a = T.areaOf(lp);
        if (a > 0) outers.push({ poly: lp, holes: [], area: a });
        else holes.push(lp);
      });
      holes.forEach(function (hp) {
        var probe = hp[0], best = null;
        outers.forEach(function (o) {
          if (inPoly(probe, o.poly) && (!best || o.area < best.area)) best = o;
        });
        if (best) best.holes.push(hp);
      });

      var color = hex([st.sr[L] / st.area[L], st.sg[L] / st.area[L], st.sb[L] / st.area[L]]);
      var cx = st.sx[L] / st.area[L], cy = st.sy[L] / st.area[L];
      /* 一块可能被拆成几个外环（裙子被腿切开）→ 每个外环各算一件 */
      outers.forEach(function (o, oi) {
        out.push({
          key: 'p' + L + (outers.length > 1 ? ('-' + (oi + 1)) : ''),
          labelId: L, poly: o.poly, holes: o.holes, areaPx: o.area,
          color: color, cx: cx, cy: cy, bbox: [bx0, by0, bx1, by1], ring: oi
        });
      });
    }
    return out;
  }

  /* ---------- ④ 命名（启发式，可被 labels 覆盖） ---------- */

  /* 命名：这张原画几乎所有部件都是白，靠颜色认不出「头发 vs 裙子」。
   * 所以改用**位置 + 形状**猜：长发一定从头顶往下很长、腿一定在下 1/3、
   * 躯干一定在中段。猜错很正常，名字只是给 2D 控制用的初始标签，
   * 用 palette（按颜色定名）或 labels（按顺序硬指定）可以覆盖。
   * ref: 整个人物的包围盒（多视图时是两个人合起来的外框）。 */
  function guessName(p, ref) {
    var spanY = Math.max(1, ref[3] - ref[1]);
    var spanX = Math.max(1, ref[2] - ref[0]);
    var top = (p.bbox[1] - ref[1]) / spanY;
    var bot = (p.bbox[3] - ref[1]) / spanY;
    var hgt = bot - top;
    var wid = (p.bbox[2] - p.bbox[0]) / spanX;
    var c = p.color;
    var r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    var L = lum(r, g, b) / 255;
    var sat = Math.max(r, g, b) ? (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b) : 0;

    if (L < 0.25) return '暗部';
    if (sat > 0.16 && r >= g && g >= b && L > 0.55) {
      /* 暖色且亮 → 皮肤；细长在下半身就是腿，否则手臂/躯干 */
      if (top > 0.62) return '腿';
      if (wid < 0.12 && hgt > 0.2) return '手臂';
      return top < 0.35 ? '脸' : '躯干';
    }
    if (hgt > 0.45 || (top < 0.16 && wid > 0.3)) return '头发';
    if (top < 0.22 && hgt > 0.1) return '头发';
    if (top > 0.62) return '腿';
    if (top > 0.46) return '下装';
    if (top > 0.2) return '上身';
    return '部件';
  }

  /* ---------- ⑤ 建网格（可选挤出成闭合体积） ---------- */

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

  function build(imgData, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var seg = segment(imgData, opts);
    if (!seg.regions.length) throw new Error('没分出任何区域（背景阈值太高？或图里没有实体）');
    var rawCount = seg.regions.length;
    mergeAdjacent(seg, opts);
    cleanupSmall(seg, opts);
    groupByColor(seg, opts);            // 色块 → 部件（按材质归并）
    if (opts.absorbWalls !== false) absorbWalls(seg);
    compact(seg);

    /* 部件级统计（颜色 / 质心）用来命名：同一组的所有片共用同一个名字 */
    var gst = labelStats(seg);
    var gColor = {};
    for (var gl = 1; gl <= gst.maxL; gl++) {
      if (!gst.area[gl]) continue;
      gColor[gl] = hex([gst.sr[gl] / gst.area[gl], gst.sg[gl] / gst.area[gl], gst.sb[gl] / gst.area[gl]]);
    }
    var figBoxes = figureBoxes(seg);
    function boxOf(px) {
      for (var i = 0; i < figBoxes.length; i++) {
        if (px >= figBoxes[i][0] - 2 && px <= figBoxes[i][2] + 2) return figBoxes[i];
      }
      return figBoxes[0];
    }

    /* palette：[{name,color}] 按颜色定名（比按位置准，适合上色稿）；不给就按位置猜 */
    var palette = opts.palette || null;
    var palList = null;
    if (palette) {
      palList = (Array.isArray(palette) ? palette : []).map(function (q) {
        return { name: q.name || q[0], rgb: rgbOf(q.color || q[1]) };
      }).filter(function (q) { return q.name && q.rgb; });
    }
    function nameOfColor(hexColor) {
      if (!palList || !palList.length) return null;
      var c = rgbOf(hexColor), best = null, bd = Infinity;
      palList.forEach(function (q) { var dd = (c[0]-q.rgb[0])*(c[0]-q.rgb[0])+(c[1]-q.rgb[1])*(c[1]-q.rgb[1])+(c[2]-q.rgb[2])*(c[2]-q.rgb[2]); if (dd < bd) { bd = dd; best = q; } });
      return best ? best.name : null;
    }
    var parts = shapesOf(seg, opts);

    var k = (Number(opts.height) || 1.6) / seg.h;
    var depth = Number(opts.depth) || 0;
    var labels = opts.labels || null;
    var group = new THREE.Group();
    group.name = 'parts';
    var out = [];

    parts.sort(function (a, b) { return b.areaPx - a.areaPx; });
    var minPiece = opts.minPieceArea != null ? Number(opts.minPieceArea) : 80;
    var pieceNo = {};

    parts.forEach(function (p, idx) {
      var shape = new THREE.Shape();
      /* 平面躺在 XZ：Shape 建在 xy，再把 y 取负、整体绕 X 转 -90°。
       * y 取负是为了「正视」时和原画同向（屏幕向上 = +y）。 */
      p.poly.forEach(function (q, i) {
        var x = q[0] * k, y = -q[1] * k;
        if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
      });
      shape.closePath();
      p.holes.forEach(function (hp) {
        var path = new THREE.Path();
        hp.forEach(function (q, i) {
          var x = q[0] * k, y = -q[1] * k;
          if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
        });
        path.closePath();
        shape.holes.push(path);
      });

      var geo;
      try {
        geo = depth > 0
          /* ExtrudeGeometry 带盖 + 侧壁 = 真正的闭合体积；bevel 关掉，否则轮廓会被磨掉一圈 */
          ? new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: false, curveSegments: 1 })
          : new THREE.ShapeGeometry(shape);
      } catch (e) { return; }

      var pos = geo.attributes.position, uv = geo.attributes.uv;
      if (uv && pos) {
        var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (var i2 = 0; i2 < pos.count; i2++) {
          minX = Math.min(minX, pos.getX(i2)); maxX = Math.max(maxX, pos.getX(i2));
          minY = Math.min(minY, pos.getY(i2)); maxY = Math.max(maxY, pos.getY(i2));
        }
        var ws = Math.max(1e-6, maxX - minX), hs = Math.max(1e-6, maxY - minY);
        for (var i3 = 0; i3 < uv.count; i3++) uv.setXY(i3, (pos.getX(i3) - minX) / ws, (pos.getY(i3) - minY) / hs);
        uv.needsUpdate = true;
      }

      if (p.areaPx < minPiece) return;
      pieceNo[p.labelId] = (pieceNo[p.labelId] || 0) + 1;
      var base = nameOfColor(gColor[p.labelId]) || guessName({ bbox: p.bbox, color: gColor[p.labelId] }, boxOf(p.cx));
      /* assign：{ '头发': ['p12','p15'] } —— 跑完看一眼 id，再把它们贴到同一个部件名下。
         这是 2D 控制真正的入口：自动分区不可能次次对，按 id 打标签可以。 */
      var tag = null;
      if (opts.assign) {
        Object.keys(opts.assign).forEach(function (k) {
          var list = opts.assign[k] || [];
          if (list.indexOf(p.key) >= 0 || list.indexOf(String(p.labelId)) >= 0) tag = k;
        });
      }
      if (tag) base = tag;
      var name = (labels && labels[idx]) || (base + ' ' + pieceNo[p.labelId]);
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: new THREE.Color(p.color), metalness: 0, roughness: 0.85, side: THREE.DoubleSide
      }));
      mesh.name = name;
      mesh.userData.part = { id: p.key, color: p.color, areaPx: p.areaPx, holes: p.holes.length };
      mesh.rotation.x = -Math.PI / 2;
      group.add(mesh);

      out.push({
        id: p.key, label: name, tag: tag || '', group: p.labelId, groupColor: gColor[p.labelId] || '', color: p.color,
        points: p.poly.length, holes: p.holes.length,
        area2d: +(p.areaPx * k * k).toFixed(4),
        cyRatio: +(p.cy / seg.h).toFixed(3),
        bboxPx: p.bbox,
        tris: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3
      });
    });

    /* 覆盖校验：所有块的并集 vs 前景（暗线吸收后应接近 100%） */
    var union = new Uint8Array(seg.w * seg.h), i4;
    for (i4 = 0; i4 < seg.w * seg.h; i4++) if (seg.labels[i4]) union[i4] = 1;
    var fgN = 0, both = 0;
    for (i4 = 0; i4 < seg.w * seg.h; i4++) {
      if (seg.fg.mask[i4]) fgN++;
      if (seg.fg.mask[i4] && union[i4]) both++;
    }

    var tris = 0;
    group.traverse(function (mm) { if (mm.isMesh && mm.geometry) tris += mm.geometry.index ? mm.geometry.index.count / 3 : mm.geometry.attributes.position.count / 3; });

    return toGLB(group).then(function (dataURL) {
      return {
        dataURL: dataURL, group: group,
        stats: { rawRegions: rawCount, parts: out.length, tris: Math.round(tris), ms: Date.now() - t0 },
        parts: out,
        cover: { fgPx: fgN, coveredPx: both, ratio: +(both / Math.max(1, fgN)).toFixed(4) },
        seg: seg, scale: k
      };
    });
  }

  global.Segmenter = {
    foreground: foreground,
    walls: walls,
    segment: segment,
    labelStats: labelStats,
    mergeAdjacent: mergeAdjacent,
    groupByColor: groupByColor,
    cleanupSmall: cleanupSmall,
    absorbWalls: absorbWalls,
    compact: compact,
    shapesOf: shapesOf,
    guessName: guessName,
    build: build,
    fromDataURL: function (url, opts) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () {
          var cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          try { res(build(ctx.getImageData(0, 0, cv.width, cv.height), opts)); }
          catch (e) { rej(e); }
        };
        img.onerror = function () { rej(new Error('图片解码失败')); };
        img.src = url;
      });
    }
  };
})(window);
