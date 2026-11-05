/* UV 编辑内核（UV 编辑器 ② 数据层）
 *
 * 分工：
 *   - 存储仍然是 seed-mesh-core 的 face-varying uvs（每个面角一份）
 *   - 这里只做「读 UV → 组件 / 岛 → 变换 → 写回」，纯函数，不碰 DOM、不碰历史
 *   - 历史 / 撤销 / 选择联动由 model-desk.js 的 UV 窗口负责
 *
 * 三个概念先统一：
 *   ① 面角（corner）：uvs[corner*2] 的下标，长度 = faceIndices.length
 *   ② UV 点（group）：同一个顶点 + 同一 UV（容差 1e-5）的所有面角。
 *      接缝处同一顶点会有两个 UV 点 —— 这正是接缝的表达方式，不需要额外 seam 标记。
 *   ③ UV 岛（island）：seed-mesh-core.uvIslands() 的连通面集合。
 *
 * 为什么变换要按「UV 点」而不是按单个面角：
 *   立方体一个角被 3 个面共用，只动一个面角会把 UV 撕开；按点动才能保持岛内连续。
 *
 * 对外（window.SeedUV）：
 *   ensure(mesh) / hasUV(mesh)
 *   pointGroups(mesh) / cornersForFaces(mesh, faceIds) / faceIdsOfCorners(mesh, corners)
 *   pickPoint(mesh, u, v, tolUV) / pickEdge(...) / pickFace(mesh, u, v)
 *   islands(mesh, faceIds) / boundsOf(mesh, corners)
 *   writeMoved / writeRotated / writeScaled / align / flip / rotate90
 *   labels...
 *   boxProject(mesh) / projectPlanar(mesh, opts)
 *   unwrap(mesh, opts) / layoutIslands(mesh, islands, gap) / pack(mesh, opts)
 *   normalizeIslands(mesh, faceIds, size)
 */
(function (global) {
  'use strict';

  var M = global.SeedModel;
  var EPS = 1e-5;
  var GRID = 0.1;

  function meshOf(mesh) { return mesh && mesh.faceIds ? mesh : null; }
  function faceCount(mesh) { return mesh ? mesh.faceIds.length : 0; }

  function hasUV(mesh) {
    return !!(M && mesh && M.Mesh && M.Mesh.hasUV(mesh));
  }

  function ensure(mesh) {
    if (!M || !mesh) return null;
    M.Mesh.ensureUV(mesh);
    return mesh;
  }

  /* ---------------- 面角 ↔ 面下标 ---------------- */
  function cornerFaceMap(mesh) {
    if (!mesh) return null;
    if (mesh._uvCornerFace && mesh._uvCornerFaceVersion === mesh.version) return mesh._uvCornerFace;
    var arr = new Int32Array(mesh.faceIndices.length);
    for (var f = 0; f < faceCount(mesh); f++) {
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      for (var c = s; c < e; c++) arr[c] = f;
    }
    mesh._uvCornerFace = arr;
    mesh._uvCornerFaceVersion = mesh.version;
    return arr;
  }

  /* ---------------- UV 点（group） ----------------
   * 缓存挂在 mesh 上，跟着 version 失效。version 由调用方在写完 UV 后 bump。 */
  function pointGroups(mesh) {
    if (!mesh) return { groups: [], cornerGroup: new Int32Array(0), faceOfCorner: new Int32Array(0) };
    if (mesh._uvGroups && mesh._uvGroupsVersion === mesh.version) return mesh._uvGroups;
    var groups = [], byKey = Object.create(null);
    var cornerGroup = new Int32Array(mesh.faceIndices.length);
    var faceOfCorner = cornerFaceMap(mesh);
    for (var c = 0; c < mesh.faceIndices.length; c++) {
      var vi = mesh.faceIndices[c];
      var u = mesh.uvs ? (mesh.uvs[c * 2] || 0) : 0;
      var v = mesh.uvs ? (mesh.uvs[c * 2 + 1] || 0) : 0;
      /* 量化到 1e-5：与 uvIslands 的容差同一把尺子 */
      var key = vi + ':' + Math.round(u * 100000) + ',' + Math.round(v * 100000);
      var g = byKey[key];
      if (!g) {
        g = {
          id: groups.length, vertex: vi, u: u, v: v,
          corners: [], faces: []
        };
        byKey[key] = g;
        groups.push(g);
      }
      cornerGroup[c] = g.id;
      g.corners.push(c);
      var f = faceOfCorner[c];
      if (g.faces.indexOf(f) < 0) g.faces.push(f);
    }
    cornerGroup.faceOfCorner = faceOfCorner;
    var out = { groups: groups, cornerGroup: cornerGroup, faceOfCorner: faceOfCorner };
    mesh._uvGroups = out;
    mesh._uvGroupsVersion = mesh.version;
    return out;
  }

  /* 一组面 ID → 这些面的全部面角（去重） */
  function cornersForFaces(mesh, faceIds) {
    if (!mesh) return [];
    var map = null, out = [], seen = Object.create(null);
    if (faceIds && faceIds.length) {
      map = Object.create(null);
      for (var i = 0; i < faceCount(mesh); i++) map[mesh.faceIds[i]] = i;
    }
    for (var f = 0; f < faceCount(mesh); f++) {
      if (map && map[mesh.faceIds[f]] === undefined) continue;
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      for (var c = s; c < e; c++) {
        if (seen[c]) continue;
        seen[c] = 1;
        out.push(c);
      }
    }
    return out;
  }

  /* 面角集合 → 涉及的面的稳定 ID（选择联动用） */
  function faceIdsOfCorners(mesh, corners) {
    if (!mesh || !corners || !corners.length) return [];
    var faceOf = cornerFaceMap(mesh);
    var out = [], seen = Object.create(null);
    for (var i = 0; i < corners.length; i++) {
      var f = faceOf[corners[i]];
      if (f == null) continue;
      var id = mesh.faceIds[f];
      if (seen[id]) continue;
      seen[id] = 1;
      out.push(id);
    }
    return out;
  }

  function boundsOf(mesh, corners) {
    if (!mesh || !corners || !corners.length) return null;
    var u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      var u = mesh.uvs[c * 2] || 0, v = mesh.uvs[c * 2 + 1] || 0;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    return { u0: u0, v0: v0, u1: u1, v1: v1, cu: (u0 + u1) / 2, cv: (v0 + v1) / 2, w: u1 - u0, h: v1 - v0 };
  }

  /* ---------------- 拾取（UV 单位；屏幕容差由 UI 换算成 UV 容差） ---------------- */
  function pickPoint(mesh, u, v, tolUV) {
    var pg = pointGroups(mesh);
    var best = null, bestD = tolUV * tolUV;
    for (var i = 0; i < pg.groups.length; i++) {
      var g = pg.groups[i];
      var du = g.u - u, dv = g.v - v, d = du * du + dv * dv;
      if (d <= bestD) { bestD = d; best = g; }
    }
    return best ? { kind: 'point', group: best, corners: best.corners.slice() } : null;
  }

  function pointSegmentDist2(px, py, ax, ay, bx, by) {
    var abx = bx - ax, aby = by - ay;
    var t = ((px - ax) * abx + (py - ay) * aby) / ((abx * abx + aby * aby) || 1);
    t = Math.max(0, Math.min(1, t));
    var dx = px - (ax + abx * t), dy = py - (ay + aby * t);
    return dx * dx + dy * dy;
  }

  function pickEdge(mesh, u, v, tolUV) {
    if (!mesh) return null;
    var pg = pointGroups(mesh);
    var best = null, bestD = tolUV * tolUV;
    for (var f = 0; f < faceCount(mesh); f++) {
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      if (e - s < 2) continue;
      for (var k = s; k < e; k++) {
        var c0 = k, c1 = (k + 1 < e) ? k + 1 : s;
        var au = mesh.uvs[c0 * 2], av = mesh.uvs[c0 * 2 + 1];
        var bu = mesh.uvs[c1 * 2], bv = mesh.uvs[c1 * 2 + 1];
        var d = pointSegmentDist2(u, v, au, av, bu, bv);
        if (d <= bestD) {
          bestD = d;
          var g0 = pg.groups[pg.cornerGroup[c0]], g1 = pg.groups[pg.cornerGroup[c1]];
          var cs = [];
          if (g0) cs = cs.concat(g0.corners);
          if (g1) cs = cs.concat(g1.corners);
          best = { kind: 'edge', face: f, c0: c0, c1: c1, corners: cs };
        }
      }
    }
    return best;
  }

  function pointInPoly(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      var xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }

  function pickFace(mesh, u, v) {
    if (!mesh) return null;
    for (var f = faceCount(mesh) - 1; f >= 0; f--) {
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      if (e - s < 3) continue;
      var pts = [];
      for (var c = s; c < e; c++) pts.push(mesh.uvs[c * 2], mesh.uvs[c * 2 + 1]);
      if (pointInPoly(u, v, pts)) return { kind: 'face', face: f };
    }
    return null;
  }

  /* ---------------- 岛 ---------------- */
  function islands(mesh, faceIds) {
    if (!mesh) return [];
    var isl = M.Mesh.uvIslands(mesh);
    var want = null;
    if (faceIds && faceIds.length) {
      want = Object.create(null);
      for (var i = 0; i < faceIds.length; i++) want[faceIds[i]] = 1;
    }
    var out = [];
    for (var k = 0; k < isl.islands.length; k++) {
      var rec = isl.islands[k];
      var take = !want;
      if (want) {
        for (var j = 0; j < rec.faces.length; j++) {
          if (want[mesh.faceIds[rec.faces[j]]]) { take = true; break; }
        }
      }
      if (!take) continue;
      var corners = [];
      for (var j2 = 0; j2 < rec.faces.length; j2++) {
        var f2 = rec.faces[j2], s2 = mesh.faceOffsets[f2], e2 = mesh.faceOffsets[f2 + 1];
        for (var c2 = s2; c2 < e2; c2++) corners.push(c2);
      }
      var b = boundsOf(mesh, corners);
      out.push({ id: rec.id, faces: rec.faces.slice(), corners: corners, bounds: b });
    }
    return out;
  }

  /* ---------------- 变换（从 base 重算，不叠乘） ---------------- */
  function baseOf(mesh, corners) {
    var base = new Float64Array(corners.length * 2);
    for (var i = 0; i < corners.length; i++) {
      base[i * 2] = mesh.uvs[corners[i] * 2] || 0;
      base[i * 2 + 1] = mesh.uvs[corners[i] * 2 + 1] || 0;
    }
    return base;
  }

  function writeMoved(mesh, corners, base, du, dv, step) {
    if (!mesh || !corners || !corners.length) return false;
    if (step && step > 0) {
      du = Math.round(du / step) * step;
      dv = Math.round(dv / step) * step;
    }
    for (var i = 0; i < corners.length; i++) {
      mesh.uvs[corners[i] * 2] = base[i * 2] + du;
      mesh.uvs[corners[i] * 2 + 1] = base[i * 2 + 1] + dv;
    }
    return true;
  }

  function writeRotated(mesh, corners, base, angle, pivot, snapDeg) {
    if (!mesh || !corners || !corners.length) return false;
    if (snapDeg && snapDeg > 0) {
      var rad = Math.PI / 180 * snapDeg;
      angle = Math.round(angle / rad) * rad;
    }
    var cs = Math.cos(angle), sn = Math.sin(angle);
    for (var i = 0; i < corners.length; i++) {
      var du = base[i * 2] - pivot.u, dv = base[i * 2 + 1] - pivot.v;
      mesh.uvs[corners[i] * 2] = pivot.u + du * cs - dv * sn;
      mesh.uvs[corners[i] * 2 + 1] = pivot.v + du * sn + dv * cs;
    }
    return true;
  }

  function writeScaled(mesh, corners, base, factor, pivot, snapStep) {
    if (!mesh || !corners || !corners.length) return false;
    factor = Math.max(0.02, Math.min(50, factor));
    if (snapStep && snapStep > 0) factor = Math.max(snapStep, Math.round(factor / snapStep) * snapStep);
    for (var i = 0; i < corners.length; i++) {
      mesh.uvs[corners[i] * 2] = pivot.u + (base[i * 2] - pivot.u) * factor;
      mesh.uvs[corners[i] * 2 + 1] = pivot.v + (base[i * 2 + 1] - pivot.v) * factor;
    }
    return true;
  }

  /* 对齐：改一条轴，另一条保持 */
  function align(mesh, corners, mode) {
    var b = boundsOf(mesh, corners);
    if (!b) return false;
    var u = b.u0, v = b.v0;
    if (mode === 'u1') u = b.u1;
    else if (mode === 'uc') u = b.cu;
    else if (mode === 'v1') v = b.v1;
    else if (mode === 'vc') v = b.cv;
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      if (mode.charAt(0) === 'u') mesh.uvs[c * 2] = u;
      else mesh.uvs[c * 2 + 1] = v;
    }
    return true;
  }

  function flip(mesh, corners, axis) {
    var b = boundsOf(mesh, corners);
    if (!b) return false;
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      if (axis === 'u') mesh.uvs[c * 2] = 2 * b.cu - mesh.uvs[c * 2];
      else mesh.uvs[c * 2 + 1] = 2 * b.cv - mesh.uvs[c * 2 + 1];
    }
    return true;
  }

  function rotate90(mesh, corners, dir) {
    var b = boundsOf(mesh, corners);
    if (!b) return false;
    var angle = (dir < 0 ? -1 : 1) * Math.PI / 2;
    var base = baseOf(mesh, corners);
    return writeRotated(mesh, corners, base, angle, { u: b.cu, v: b.cv }, 0);
  }

  /* ---------------- 投影 / 展开 / 排布 ---------------- */
  /* 盒式投影：直接复用网格内核的兜底算法（6 个 tile） */
  function boxProject(mesh) {
    if (!mesh || !M) return false;
    mesh.uvs = [];
    M.Mesh.ensureUV(mesh);
    return true;
  }

  /* 平面投影：把选中面按世界轴平面拍平到 0–1（按包围盒归一化） */
  function projectPlanar(mesh, opts) {
    if (!mesh) return false;
    opts = opts || {};
    var axis = opts.axis || 'y';
    var faceIds = opts.faceIds && opts.faceIds.length ? opts.faceIds : null;
    /* 没有选择集时 ids 必须是 null：空对象会让下面的「跳过未选中」把全部面都跳过 */
    var ids = null;
    if (faceIds) { ids = Object.create(null); faceIds.forEach(function (id) { ids[id] = 1; }); }
    var a, b;
    if (axis === 'x') { a = 1; b = 2; }        /* 丢掉 X：看 YZ */
    else if (axis === 'z') { a = 0; b = 1; }   /* 丢掉 Z：看 XY */
    else { a = 0; b = 2; }                     /* 丢掉 Y：看 XZ */
    var minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    var pos = mesh.positions;
    for (var f = 0; f < faceCount(mesh); f++) {
      if (ids && !ids[mesh.faceIds[f]]) continue;
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      for (var c = s; c < e; c++) {
        var vi = mesh.faceIndices[c];
        var va = pos[vi * 3 + a], vb = pos[vi * 3 + b];
        if (va < minA) minA = va;
        if (va > maxA) maxA = va;
        if (vb < minB) minB = vb;
        if (vb > maxB) maxB = vb;
      }
    }
    if (!isFinite(minA)) return false;
    var spanA = (maxA - minA) || 1, spanB = (maxB - minB) || 1;
    for (var f2 = 0; f2 < faceCount(mesh); f2++) {
      if (ids && !ids[mesh.faceIds[f2]]) continue;
      var s2 = mesh.faceOffsets[f2], e2 = mesh.faceOffsets[f2 + 1];
      for (var c2 = s2; c2 < e2; c2++) {
        var vi2 = mesh.faceIndices[c2];
        mesh.uvs[c2 * 2] = (pos[vi2 * 3 + a] - minA) / spanA;
        mesh.uvs[c2 * 2 + 1] = (pos[vi2 * 3 + b] - minB) / spanB;
      }
    }
    return true;
  }

  /* 圆柱 / 球形投影：轴 = 圆周所在的旋转轴。
   * 每个面单独把角度展开（相邻角差 > π 就 ±2π），避免面跨 0/1 接缝时被拉满整圈；
   * 代价是接缝两侧顶点会得到相差 1 的 u —— 那正是 UV 缝，交给展开/排布处理。 */
  function axisTriple(axis) {
    if (axis === 'x') return { a: 1, b: 2, n: 0 };
    if (axis === 'z') return { a: 0, b: 1, n: 2 };
    return { a: 0, b: 2, n: 1 };
  }

  function meshBox(mesh, ax) {
    var pos = mesh.positions, n = pos.length / 3;
    var c = { a: 0, b: 0, n: 0 }, minN = Infinity, maxN = -Infinity;
    var i;
    for (i = 0; i < n; i++) {
      c.a += pos[i * 3 + ax.a];
      c.b += pos[i * 3 + ax.b];
      c.n += pos[i * 3 + ax.n];
    }
    if (!n) return null;
    c.a /= n; c.b /= n; c.n /= n;
    for (i = 0; i < n; i++) {
      var pn = pos[i * 3 + ax.n];
      if (pn < minN) minN = pn;
      if (pn > maxN) maxN = pn;
    }
    return { c: c, minN: minN, maxN: maxN, spanN: (maxN - minN) || 1 };
  }

  /* 投影完把结果缩放到 0–1：圆柱/球形可能算出 -0.1..1.1 的 u（跨接缝面） */
  function normalizeCorners(mesh, corners) {
    if (!corners || !corners.length) return;
    var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, i, k;
    for (i = 0; i < corners.length; i++) {
      k = corners[i];
      var u = mesh.uvs[k * 2], v = mesh.uvs[k * 2 + 1];
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    var su = (maxU - minU) || 1, sv = (maxV - minV) || 1;
    for (i = 0; i < corners.length; i++) {
      k = corners[i];
      mesh.uvs[k * 2] = (mesh.uvs[k * 2] - minU) / su;
      mesh.uvs[k * 2 + 1] = (mesh.uvs[k * 2 + 1] - minV) / sv;
    }
  }

  function projectCylindrical(mesh, opts) {
    if (!mesh) return false;
    opts = opts || {};
    var ax = axisTriple(opts.axis || 'y');
    var box = meshBox(mesh, ax);
    if (!box) return false;
    var ids = null, faceIds = opts.faceIds && opts.faceIds.length ? opts.faceIds : null;
    if (faceIds) { ids = Object.create(null); faceIds.forEach(function (id) { ids[id] = 1; }); }
    var pos = mesh.positions, done = 0, written = [];
    for (var f = 0; f < faceCount(mesh); f++) {
      if (ids && ids[mesh.faceIds[f]] === undefined) continue;
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      if (e - s < 3) continue;
      var base = 0, first = true;
      for (var k = s; k < e; k++) {
        var vi = mesh.faceIndices[k] * 3;
        var pa = pos[vi + ax.a] - box.c.a, pb = pos[vi + ax.b] - box.c.b;
        var ang = Math.atan2(pb, pa);
        if (first) { base = ang; first = false; }
        while (ang - base > Math.PI) ang -= Math.PI * 2;
        while (ang - base < -Math.PI) ang += Math.PI * 2;
        mesh.uvs[k * 2] = ang / (Math.PI * 2) + 0.5;
        mesh.uvs[k * 2 + 1] = (pos[vi + ax.n] - box.minN) / box.spanN;
        written.push(k);
      }
      done++;
    }
    normalizeCorners(mesh, written);
    return done ? { faces: done } : false;
  }

  function projectSpherical(mesh, opts) {
    if (!mesh) return false;
    opts = opts || {};
    var ax = axisTriple(opts.axis || 'y');
    var box = meshBox(mesh, ax);
    if (!box) return false;
    var ids = null, faceIds = opts.faceIds && opts.faceIds.length ? opts.faceIds : null;
    if (faceIds) { ids = Object.create(null); faceIds.forEach(function (id) { ids[id] = 1; }); }
    var pos = mesh.positions, done = 0, written = [];
    for (var f = 0; f < faceCount(mesh); f++) {
      if (ids && ids[mesh.faceIds[f]] === undefined) continue;
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      if (e - s < 3) continue;
      var base = 0, first = true;
      for (var k = s; k < e; k++) {
        var vi = mesh.faceIndices[k] * 3;
        var pa = pos[vi + ax.a] - box.c.a, pb = pos[vi + ax.b] - box.c.b;
        var pn = pos[vi + ax.n] - box.c.n;
        var r = Math.sqrt(pa * pa + pb * pb + pn * pn) || 1;
        var ang = Math.atan2(pb, pa);
        if (first) { base = ang; first = false; }
        while (ang - base > Math.PI) ang -= Math.PI * 2;
        while (ang - base < -Math.PI) ang += Math.PI * 2;
        var phi = Math.acos(Math.max(-1, Math.min(1, pn / r)));   /* 0 = 轴正端 */
        mesh.uvs[k * 2] = ang / (Math.PI * 2) + 0.5;
        mesh.uvs[k * 2 + 1] = 1 - phi / Math.PI;
        written.push(k);
      }
      done++;
    }
    normalizeCorners(mesh, written);
    return done ? { faces: done } : false;
  }

  /* 缝合：把选中且在容差内的 UV 点并到同一点（坐标取平均）。
   * 只动选中的角；未选中的相邻面角保持原位，于是并完就是一条共享缝。 */
  function stitch(mesh, corners, tol) {
    if (!mesh || !corners || corners.length < 2) return false;
    tol = tol == null ? 0.02 : Math.max(0, tol);
    var pg = pointGroups(mesh);
    var pts = [], seen = Object.create(null);
    corners.forEach(function (c) {
      var gi = pg.cornerGroup[c];
      if (gi == null || seen[gi]) return;
      seen[gi] = 1;
      var g = pg.groups[gi];
      if (g) pts.push({ u: g.u, v: g.v, corners: g.corners.slice() });
    });
    if (pts.length < 2) return false;
    var used = Object.create(null), merged = 0;
    for (var i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      var cluster = [i];
      used[i] = 1;
      for (var j = i + 1; j < pts.length; j++) {
        if (used[j]) continue;
        var du = pts[j].u - pts[i].u, dv = pts[j].v - pts[i].v;
        if (Math.sqrt(du * du + dv * dv) <= tol) { used[j] = 1; cluster.push(j); }
      }
      if (cluster.length < 2) continue;
      var su = 0, sv = 0;
      for (var k = 0; k < cluster.length; k++) { su += pts[cluster[k]].u; sv += pts[cluster[k]].v; }
      su /= cluster.length; sv /= cluster.length;
      for (var k2 = 0; k2 < cluster.length; k2++) {
        var pp = pts[cluster[k2]];
        for (var c2 = 0; c2 < pp.corners.length; c2++) {
          mesh.uvs[pp.corners[c2] * 2] = su;
          mesh.uvs[pp.corners[c2] * 2 + 1] = sv;
        }
      }
      merged += cluster.length;
    }
    return merged ? { merged: merged } : false;
  }

  /* 选中面的边界边：一侧在选中集里、另一侧不在。
   * 返回 [顶点数组下标, 顶点数组下标] 的数组，直接喂给 Mesh.setSeam。
   * 为什么按「面的边界」切而不是按 UV 边切：选择集只存面角（点 / 边 / 壳都是面角的子集），
   * 从面角反推「用户具体点了哪条边」并不可靠；而面的边界边是确定的，
   * 选一个面环 → 切出来的正是那圈边，语义和 DCC 的「沿边切割」一致。 */
  function boundaryEdges(mesh, faceIds) {
    if (!mesh || !M || !M.Mesh || !faceIds || !faceIds.length) return [];
    var ids = Object.create(null);
    for (var i = 0; i < faceIds.length; i++) ids[faceIds[i]] = 1;
    var byEdge = Object.create(null);
    for (var f = 0; f < faceCount(mesh); f++) {
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1], nv = e - s;
      if (nv < 3) continue;
      var sel = !!ids[mesh.faceIds[f]];
      for (var k = 0; k < nv; k++) {
        var c0 = s + k, c1 = s + ((k + 1) % nv);
        var ia = mesh.faceIndices[c0], ib = mesh.faceIndices[c1];
        var key = M.Mesh.seamKey(mesh, ia, ib);
        var rec = byEdge[key] || (byEdge[key] = { ia: ia, ib: ib, inSel: 0, outSel: 0 });
        if (sel) rec.inSel++; else rec.outSel++;
      }
    }
    var out = [];
    Object.keys(byEdge).forEach(function (key) {
      var rec = byEdge[key];
      /* 只切「选中 / 未选中」之间的边；纯网格边界（只有一侧有面）切了也没意义 */
      if (rec.inSel > 0 && rec.outSel > 0) out.push([rec.ia, rec.ib]);
    });
    return out;
  }

  /* 沿边切割：把选中面的边界标成 UV 缝。只加标记，不动顶点 / UV。
   * 返回新增缝的数量（0 = 没有可切的边界）。 */
  function cutSeams(mesh, faceIds) {
    if (!mesh || !M || !M.Mesh) return 0;
    var edges = boundaryEdges(mesh, faceIds);
    var added = 0;
    for (var i = 0; i < edges.length; i++) {
      if (M.Mesh.setSeam(mesh, edges[i][0], edges[i][1], true)) added++;
    }
    return added;
  }

  /* 分离 UV 壳：先在选中面的边界切开，再把所有岛重新装箱（留 gap）。
   * 不切边界直接平移也可以「看起来分开」，但那只是挪位置，拓扑上仍是一个岛，
   * 之后自动展开 / 排布又会把它拼回去 —— 所以这里必须先落缝。 */
  function separateShells(mesh, faceIds, gap) {
    if (!mesh || !M || !M.Mesh) return null;
    var edges = boundaryEdges(mesh, faceIds);
    var added = 0;
    for (var i = 0; i < edges.length; i++) {
      if (M.Mesh.setSeam(mesh, edges[i][0], edges[i][1], true)) added++;
    }
    if (added) M.Mesh.bump(mesh);     /* 缝变了 → 岛缓存必须重算 */
    var list = islands(mesh, null);
    if (!list.length) return null;
    var lay = layoutIslands(mesh, list, gap == null ? 0.02 : gap);
    return { seams: added, islands: list.length, layout: lay };
  }

  /* 岛的近似平面：按面积加权的面法线 */
  function islandNormal(mesh, island) {
    var pos = mesh.positions, nx = 0, ny = 0, nz = 0;
    for (var k = 0; k < island.faces.length; k++) {
      var f = island.faces[k], s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      if (e - s < 3) continue;
      var p0 = mesh.faceIndices[s] * 3, p1 = mesh.faceIndices[s + 1] * 3, p2 = mesh.faceIndices[s + 2] * 3;
      var ax = pos[p1] - pos[p0], ay = pos[p1 + 1] - pos[p0 + 1], az = pos[p1 + 2] - pos[p0 + 2];
      var bx = pos[p2] - pos[p0], by = pos[p2 + 1] - pos[p0 + 1], bz = pos[p2 + 2] - pos[p0 + 2];
      nx += ay * bz - az * by;
      ny += az * bx - ax * bz;
      nz += ax * by - ay * bx;
    }
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  function basisFromNormal(n) {
    /* 选一个与法线不平行的参考轴，避免叉积退化为 0 */
    var ref = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    var tx = ref.y * n.z - ref.z * n.y;
    var ty = ref.z * n.x - ref.x * n.z;
    var tz = ref.x * n.y - ref.y * n.x;
    var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    var bx = n.y * tz - n.z * ty;
    var by = n.z * tx - n.x * tz;
    var bz = n.x * ty - n.y * tx;
    return { t: { x: tx, y: ty, z: tz }, b: { x: bx, y: by, z: bz } };
  }

  /* 自动展开：每个岛按自己的主平面拍平，然后装箱。
   * 不保证零拉伸（那需要 LSCM / ABF），但保证「岛与岛不重叠、岛内连续」。 */
  function unwrap(mesh, opts) {
    if (!mesh) return null;
    opts = opts || {};
    var list = islands(mesh, opts.faceIds);
    if (!list.length) return null;
    var pos = mesh.positions;
    for (var k = 0; k < list.length; k++) {
      var isl = list[k];
      var n = islandNormal(mesh, isl);
      var basis = basisFromNormal(n);
      var u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (var c = 0; c < isl.corners.length; c++) {
        var vi = mesh.faceIndices[isl.corners[c]];
        var x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
        var u = x * basis.t.x + y * basis.t.y + z * basis.t.z;
        var v = x * basis.b.x + y * basis.b.y + z * basis.b.z;
        mesh.uvs[isl.corners[c] * 2] = u;
        mesh.uvs[isl.corners[c] * 2 + 1] = v;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
      isl.bounds = { u0: u0, v0: v0, u1: u1, v1: v1, w: u1 - u0, h: v1 - v0 };
    }
    var lay = layoutIslands(mesh, list, opts.gap == null ? 0.02 : opts.gap);
    return { islands: list.length, layout: lay };
  }

  /* 货架装箱：按高度降序、从左到右、放不下换行；最后整体缩放到 0–1 内 */
  function layoutIslands(mesh, list, gap) {
    gap = gap == null ? 0.02 : Math.max(0, gap);
    if (!list || !list.length) return { count: 0 };
    var items = list.map(function (isl) {
      var b = isl.bounds || boundsOf(mesh, isl.corners);
      return { isl: isl, b: b, w: Math.max(b.w, 1e-6), h: Math.max(b.h, 1e-6) };
    });
    items.sort(function (a, b) { return b.h - a.h || a.w - b.w; });
    var x = gap, y = gap, rowH = 0, maxX = 0, maxY = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (x + it.w > 1 - gap && x > gap) {
        x = gap;
        y += rowH + gap;
        rowH = 0;
      }
      var du = x - it.b.u0, dv = y - it.b.v0;
      for (var c = 0; c < it.isl.corners.length; c++) {
        var cc = it.isl.corners[c];
        mesh.uvs[cc * 2] += du;
        mesh.uvs[cc * 2 + 1] += dv;
      }
      it.b.u0 = x; it.b.v0 = y; it.b.u1 = x + it.w; it.b.v1 = y + it.h;
      x += it.w + gap;
      if (it.h > rowH) rowH = it.h;
      if (x > maxX) maxX = x;
      if (y + it.h > maxY) maxY = y + it.h;
    }
    /* 放不进 0–1 时整体等比缩小（只缩这批岛，不动没参与排布的） */
    if (maxX > 1 || maxY > 1) {
      var s = Math.min(1 / maxX, 1 / maxY);
      for (var k = 0; k < items.length; k++) {
        var cs = items[k].isl.corners;
        for (var c2 = 0; c2 < cs.length; c2++) {
          mesh.uvs[cs[c2] * 2] *= s;
          mesh.uvs[cs[c2] * 2 + 1] *= s;
        }
      }
      maxX *= s; maxY *= s;
      return { count: items.length, scale: s, maxX: maxX, maxY: maxY };
    }
    return { count: items.length, scale: 1, maxX: maxX, maxY: maxY };
  }

  function pack(mesh, opts) {
    if (!mesh) return null;
    opts = opts || {};
    var list = islands(mesh, opts.faceIds);
    if (!list.length) return null;
    return layoutIslands(mesh, list, opts.gap == null ? 0.02 : opts.gap);
  }

  /* 统一尺寸：每个岛缩放到同样的最长边（默认 0.35） */
  function normalizeIslands(mesh, faceIds, size) {
    var list = islands(mesh, faceIds);
    if (!list.length) return null;
    size = size == null ? 0.35 : Math.max(0.01, Math.min(1, size));
    for (var i = 0; i < list.length; i++) {
      var b = list[i].bounds;
      if (!b || !b.w && !b.h) continue;
      var s = size / Math.max(b.w, b.h, 1e-6);
      for (var c = 0; c < list[i].corners.length; c++) {
        var cc = list[i].corners[c];
        mesh.uvs[cc * 2] = b.cu + (mesh.uvs[cc * 2] - b.cu) * s;
        mesh.uvs[cc * 2 + 1] = b.cv + (mesh.uvs[cc * 2 + 1] - b.cv) * s;
      }
    }
    return { count: list.length };
  }

  global.SeedUV = {
    EPS: EPS,
    GRID: GRID,
    hasUV: hasUV,
    ensure: ensure,
    pointGroups: pointGroups,
    cornersForFaces: cornersForFaces,
    faceIdsOfCorners: faceIdsOfCorners,
    boundsOf: boundsOf,
    baseOf: baseOf,
    pickPoint: pickPoint,
    pickEdge: pickEdge,
    pickFace: pickFace,
    islands: islands,
    writeMoved: writeMoved,
    writeRotated: writeRotated,
    writeScaled: writeScaled,
    align: align,
    flip: flip,
    rotate90: rotate90,
    boxProject: boxProject,
    projectPlanar: projectPlanar,
    projectCylindrical: projectCylindrical,
    projectSpherical: projectSpherical,
    stitch: stitch,
    boundaryEdges: boundaryEdges,
    cutSeams: cutSeams,
    separateShells: separateShells,
    unwrap: unwrap,
    layoutIslands: layoutIslands,
    pack: pack,
    normalizeIslands: normalizeIslands
  };
})(window);
