/* 软选择权重内核：体积（欧氏）/ 表面（测地）距离 + 衰减曲线 + 热力图配色。
 *
 * 专业口径（对标）：
 *   - Maya Soft Selection：Falloff Mode = Volume（空间直线距离）/ Surface（沿网格表面走）；
 *   - 3ds Max Soft Selection：Use Edge Distances 打开后按边距（表面），关闭按欧氏；
 *   - Blender Proportional Editing：Connected Only = 沿拓扑连接（表面），关闭按欧氏。
 * 两种口径只在「谁算近」上不同：折叠 / 双层 / 凹槽结构里空间很近但表面很远的顶点，
 * 体积模式会带上，表面模式不会 —— 这正是 Maya 的 Volume / Surface 差异。
 *
 * 这里是纯计算模块：不碰 DOM、不碰 three.js 场景；结果按 mesh.version + 选择签名缓存，
 * 撤销 / 改拓扑后版本号一变就自动失效。对外 window.MDSoft：
 *   weights(mesh, selectedIdx, opts) → { mode, radius, w, dist, selected, affected, count }
 *   falloff / customAt / weightAt / heatColor / hashIndices
 */
(function (global) {
  'use strict';

  var INF = Infinity;

  function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }

  /* 衰减曲线：x = 距离 / 半径（0 = 选中点，1 = 半径边缘）。
   * 与 Maya 的 four falloff curves / Blender 的 proportional falloff 同一类口径：
   * 边缘必须归零，否则「半径」没有意义。 */
  function falloff(kind, x) {
    x = clamp01(x);
    if (kind === 'constant') return 1;
    if (kind === 'linear') return 1 - x;
    if (kind === 'sharp') { var a = 1 - x; return a * a * a; }
    if (kind === 'sphere') return Math.sqrt(Math.max(0, 1 - x * x));
    /* smooth：smoothstep 的反向（1 到 0 平滑过渡） */
    return 1 - (x * x * (3 - 2 * x));
  }

  function customAt(pts, x) {
    if (!pts || !pts.length) return falloff('smooth', x);
    var t = clamp01(x) * (pts.length - 1);
    var i = Math.floor(t), f = t - i;
    if (i >= pts.length - 1) return pts[pts.length - 1];
    return pts[i] * (1 - f) + pts[i + 1] * f;
  }

  function weightAt(opts, x) {
    opts = opts || {};
    return opts.falloff === 'custom' ? customAt(opts.custom, x) : falloff(opts.falloff, x);
  }

  /* 选择集签名：同一组顶点顺序不同也算同一份权重，但这里调用方给的是
   * selVertexIndices() 的稳定输出，不需要额外排序。FNV-1a 足够避免
   * 「改了一个点但缓存还命中」这类错误。 */
  function hashIndices(idx) {
    var h = 2166136261 >>> 0;
    h = (h ^ (idx.length | 0)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    for (var i = 0; i < idx.length; i++) {
      h = (h ^ (idx[i] | 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /* 顶点邻接表（CSR）：表面距离只沿真实网格边走，跨 UV 缝也算连通（拓扑连通）。
   * 按 mesh.version 缓存；拓扑一变版本号变，旧表自然弃用。 */
  function adjacency(mesh) {
    var ver = mesh.version || 0;
    if (mesh._softAdj && mesh._softAdjVersion === ver) return mesh._softAdj;
    var edges = (global.SeedModel && global.SeedModel.Mesh)
      ? global.SeedModel.Mesh.ensureEdges(mesh).edges : [];
    var n = mesh.vertexIds.length;
    var deg = new Int32Array(n);
    var i;
    for (i = 0; i < edges.length; i++) {
      deg[edges[i].a]++;
      deg[edges[i].b]++;
    }
    var start = new Int32Array(n + 1);
    for (i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
    var total = start[n];
    var adj = new Int32Array(total);
    var len = new Float32Array(total);
    var cursor = start.slice(0, n);
    var p = mesh.positions;
    for (i = 0; i < edges.length; i++) {
      var e = edges[i], a = e.a, b = e.b;
      var dx = p[a * 3] - p[b * 3];
      var dy = p[a * 3 + 1] - p[b * 3 + 1];
      var dz = p[a * 3 + 2] - p[b * 3 + 2];
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      adj[cursor[a]] = b;
      len[cursor[a]++] = d;
      adj[cursor[b]] = a;
      len[cursor[b]++] = d;
    }
    var out = { start: start, adj: adj, len: len };
    mesh._softAdj = out;
    mesh._softAdjVersion = ver;
    return out;
  }

  /* 最小堆：只服务 Dijkstra。存 [距离, 顶点]，元素量级 = 边数，不用更复杂的结构。 */
  function MinHeap() {
    this.h = [];
  }
  MinHeap.prototype.size = function () { return this.h.length; };
  MinHeap.prototype.push = function (v, d) {
    var h = this.h, i = h.length;
    h.push([d, v]);
    while (i > 0) {
      var up = (i - 1) >> 1;
      if (h[up][0] <= d) break;
      h[i] = h[up];
      i = up;
    }
    h[i] = [d, v];
  };
  MinHeap.prototype.pop = function () {
    var h = this.h, top = h[0], last = h.pop();
    if (!h.length) return top;
    var i = 0, n = h.length;
    while (true) {
      var l = i * 2 + 1, r = l + 1, small = i;
      if (l < n && h[l][0] < h[small][0]) small = l;
      if (r < n && h[r][0] < h[small][0]) small = r;
      if (small === i) break;
      var tmp = h[i]; h[i] = h[small]; h[small] = tmp;
      i = small;
    }
    h[i] = last;
    return top;
  };

  /* 表面距离：多源 Dijkstra，只走到半径内。边界（开放边）自然停，
   * 不跨接缝以外的空间「跳」过去 —— 与 3ds Max 的 Edge Distance、
   * Blender 的 Connected Only 一致。 */
  function surfaceDistances(mesh, seeds, radius, adj) {
    var n = mesh.vertexIds.length;
    var dist = new Float32Array(n);
    var i;
    for (i = 0; i < n; i++) dist[i] = INF;
    var heap = new MinHeap();
    for (i = 0; i < seeds.length; i++) {
      var s = seeds[i];
      if (s < 0 || s >= n) continue;
      dist[s] = 0;
      heap.push(s, 0);
    }
    while (heap.size()) {
      var top = heap.pop();
      var d = top[0], v = top[1];
      if (d > dist[v] + 1e-7) continue;
      if (d >= radius) continue;
      var s0 = adj.start[v], s1 = adj.start[v + 1];
      for (var k = s0; k < s1; k++) {
        var u = adj.adj[k];
        var nd = d + adj.len[k];
        if (nd < dist[u] && nd <= radius + 1e-9) {
          dist[u] = nd;
          heap.push(u, nd);
        }
      }
    }
    return dist;
  }

  /* 体积距离：多源欧氏最近距离。用「半径大小」做网格边长，
   * 每个顶点只查周围 27 格；常见选择（几十个种点）是 O(N) 量级。 */
  function volumeDistances(mesh, seeds, radius) {
    var n = mesh.vertexIds.length;
    var dist = new Float32Array(n);
    var i;
    for (i = 0; i < n; i++) dist[i] = INF;
    if (!seeds.length) return dist;
    var cell = Math.max(radius, 1e-4);
    var grid = Object.create(null);
    var p = mesh.positions;
    for (i = 0; i < seeds.length; i++) {
      var s = seeds[i];
      if (s < 0 || s >= n) continue;
      dist[s] = 0;
      var key = cellKey(p[s * 3], p[s * 3 + 1], p[s * 3 + 2], cell);
      (grid[key] || (grid[key] = [])).push(s);
    }
    var rr = radius * radius;
    for (i = 0; i < n; i++) {
      if (dist[i] === 0) continue;
      var x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      var cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      var best = rr;
      for (var ox = -1; ox <= 1; ox++) {
        for (var oy = -1; oy <= 1; oy++) {
          for (var oz = -1; oz <= 1; oz++) {
            var bucket = grid[(cx + ox) + '|' + (cy + oy) + '|' + (cz + oz)];
            if (!bucket) continue;
            for (var b = 0; b < bucket.length; b++) {
              var q = bucket[b];
              var dx = x - p[q * 3], dy = y - p[q * 3 + 1], dz = z - p[q * 3 + 2];
              var d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < best) best = d2;
            }
          }
        }
      }
      dist[i] = best < rr ? Math.sqrt(best) : INF;
    }
    return dist;
  }

  function cellKey(x, y, z, cell) {
    return Math.floor(x / cell) + '|' + Math.floor(y / cell) + '|' + Math.floor(z / cell);
  }

  /* 主入口：给定选中顶点下标，算全网格权重。
   * opts = { mode:'volume'|'surface', radius, falloff, custom }
   * 返回的 affected 不含选中点（它们权重恒 1，变换时本来就整体移动）。 */
  function weights(mesh, selectedIdx, opts) {
    opts = opts || {};
    var n = mesh ? mesh.vertexIds.length : 0;
    var radius = Math.max(1e-5, Number(opts.radius) || 0);
    var mode = opts.mode === 'surface' ? 'surface' : 'volume';
    var kind = opts.falloff || 'smooth';
    var csig = (kind === 'custom' && opts.custom && opts.custom.join) ? opts.custom.join(',') : '';
    var idx = selectedIdx || [];
    var sig = (mesh ? (mesh.version || 0) : 0) + '|' + mode + '|' + radius + '|' + kind + '|' +
      csig + '|' + idx.length + '|' + hashIndices(idx);

    if (mesh && mesh._softCache && mesh._softCache.sig === sig) return mesh._softCache.value;

    var selected = new Uint8Array(n);
    var i;
    for (i = 0; i < idx.length; i++) {
      var si = idx[i] | 0;
      if (si >= 0 && si < n) selected[si] = 1;
    }
    var dist;
    if (mode === 'surface') {
      dist = surfaceDistances(mesh, idx, radius, adjacency(mesh));
    } else {
      dist = volumeDistances(mesh, idx, radius);
    }
    var w = new Float32Array(n);
    var affected = [];
    for (i = 0; i < n; i++) {
      if (selected[i]) { w[i] = 1; continue; }
      if (!(dist[i] < radius)) continue;
      var wi = weightAt(opts, dist[i] / radius);
      if (wi > 1e-4) {
        w[i] = wi;
        affected.push(i);
      }
    }
    var value = {
      mode: mode,
      radius: radius,
      w: w,
      dist: dist,
      selected: selected,
      affected: affected,
      count: affected.length
    };
    if (mesh) mesh._softCache = { sig: sig, value: value };
    return value;
  }

  /* 热力配色：冷蓝 → 青 → 绿 → 黄 → 红（权重越大越暖）。
   * 只用于视口叠加层；选中点权重 1 显示为红心，周围按衰减过渡。 */
  var STOPS = [
    [0.00, 0.10, 0.35, 1.00],
    [0.25, 0.00, 0.85, 1.00],
    [0.50, 0.15, 0.95, 0.35],
    [0.75, 1.00, 0.85, 0.10],
    [1.00, 1.00, 0.16, 0.10]
  ];
  function heatColor(t, out) {
    t = clamp01(t);
    var a = 0, b = STOPS.length - 1;
    for (var i = 0; i < STOPS.length - 1; i++) {
      if (t >= STOPS[i][0] && t <= STOPS[i + 1][0]) { a = i; b = i + 1; break; }
    }
    var s0 = STOPS[a], s1 = STOPS[b];
    var f = s1[0] === s0[0] ? 0 : (t - s0[0]) / (s1[0] - s0[0]);
    var o = out || [0, 0, 0];
    o[0] = s0[1] + (s1[1] - s0[1]) * f;
    o[1] = s0[2] + (s1[2] - s0[2]) * f;
    o[2] = s0[3] + (s1[3] - s0[3]) * f;
    return o;
  }

  global.MDSoft = {
    weights: weights,
    falloff: falloff,
    customAt: customAt,
    weightAt: weightAt,
    heatColor: heatColor,
    hashIndices: hashIndices
  };
})(window);
