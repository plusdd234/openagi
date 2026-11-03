/* 拾取内核（架构层 ⑩ selection · S1 / M3 第一步）
 *
 * 职责只有一个：给一个屏幕点，回答「点到的是哪个点 / 边 / 面」。
 * 不碰 DOM、不碰场景对象、不持有状态 —— 选择集与高亮都留在 model-desk.js，
 * 这样同一条拾取逻辑以后能被框选（S3）、软选择（S2）、UV 视图（P3）复用。
 *
 * 为什么不用 THREE.Raycaster.intersectObject：
 *   1) 它只会给出「命中的三角形」，不会告诉你这个三角形属于文档里第几个面
 *      （GLB 几何是三角化的，一个四边形拆成两个）；而选择集必须存**文档里的面 ID**。
 *   2) 顶点 / 边的屏幕阈值拾取它完全不支持 —— 这是建模软件里最常用的手势。
 *   所以这里自己做：三角形用 Möller–Trumbore 求交（顺序即优先级），
 *   顶点与边先投影到屏幕算像素距离，再用「到相机距离 vs 最近面命中距离」做遮挡剔除。
 *
 * 坐标约定：
 *   x / y     canvas 内的 CSS 像素（先减掉 getBoundingClientRect 的 left/top）
 *   rect      { width, height }，只用来换算 NDC，不用 left/top（传进来之前已经减过）
 *   matrix    节点的世界矩阵（pivot.matrixWorld）；射线反变换到局部，省掉逐点变换
 *   through   true = 穿透选择（背面也命中）；false = 只选看得见的
 *
 * 对外（window.SeedSelection）：
 *   pick(opts)     → { kind, index, id, pixel:{x,y}, world:{x,y,z}, distance } | null
 *   pickBox(opts)  → { kind, indices:[], ids:[] }
 *   VERT_PX / EDGE_PX 默认阈值
 */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var VERT_PX = 8;
  var EDGE_PX = 6;

  function ok() { return !!(THREE && THREE.Raycaster); }

  function rayFromPixel(camera, rect, x, y) {
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(
      (x / rect.width) * 2 - 1,
      -(y / rect.height) * 2 + 1
    ), camera);
    return rc.ray.clone();
  }

  /* 射线搬到网格的局部空间：一次逆矩阵，胜过给上万个顶点各乘一次 */
  function toLocal(ray, matrix) {
    if (!matrix) return ray;
    var inv = new THREE.Matrix4().copy(matrix).invert();
    var r = ray.clone();
    r.origin.applyMatrix4(inv);
    r.direction.transformDirection(inv).normalize();
    return r;
  }

  /* Möller–Trumbore，返回沿射线的参数 t（>0 为前方） */
  function triHit(ox, oy, oz, dx, dy, dz,
                  ax, ay, az, bx, by, bz, cx, cy, cz) {
    var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    var px = dy * e2z - dz * e2y;
    var py = dz * e2x - dx * e2z;
    var pz = dx * e2y - dy * e2x;
    var det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) return -1;          // 射线与三角形平行
    var inv = 1 / det;
    var tx = ox - ax, ty = oy - ay, tz = oz - az;
    var u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) return -1;
    var qx = ty * e1z - tz * e1y;
    var qy = tz * e1x - tx * e1z;
    var qz = tx * e1y - ty * e1x;
    var v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) return -1;
    var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-6 ? t : -1;
  }

  /* 逐面扇形三角化求交，返回最近的 { face, point:[x,y,z] }（局部坐标） */
  function nearestFace(mesh, ray) {
    var pos = mesh.positions, off = mesh.faceOffsets, idx = mesh.faceIndices;
    var o = ray.origin, d = ray.direction;
    var bestT = Infinity, bestF = -1, bpx = 0, bpy = 0, bpz = 0;
    for (var f = 0; f < mesh.faceIds.length; f++) {
      var s = off[f], e = off[f + 1];
      if (e - s < 3) continue;
      var i0 = idx[s] * 3;
      var ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
      for (var k = s + 1; k < e - 1; k++) {
        var i1 = idx[k] * 3, i2 = idx[k + 1] * 3;
        var t = triHit(o.x, o.y, o.z, d.x, d.y, d.z,
          ax, ay, az,
          pos[i1], pos[i1 + 1], pos[i1 + 2],
          pos[i2], pos[i2 + 1], pos[i2 + 2]);
        if (t > 0 && t < bestT) {
          bestT = t; bestF = f;
          bpx = o.x + d.x * t; bpy = o.y + d.y * t; bpz = o.z + d.z * t;
        }
      }
    }
    if (bestF < 0) return null;
    return { face: bestF, t: bestT, point: [bpx, bpy, bpz] };
  }

  function projectionCache(mesh, matrix, camera, rect) {
    var n = mesh.vertexIds.length;
    var scr = new Float64Array(n * 2);
    var world = new Float64Array(n * 3);
    var v = new THREE.Vector3();
    for (var i = 0; i < n; i++) {
      v.set(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
      if (matrix) v.applyMatrix4(matrix);
      world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
      var p = v.clone().project(camera);
      scr[i * 2] = (p.x * 0.5 + 0.5) * rect.width;
      scr[i * 2 + 1] = (-p.y * 0.5 + 0.5) * rect.height;
    }
    return { scr: scr, world: world, count: n };
  }

  function distToCam(world, i, camPos) {
    var dx = world[i * 3] - camPos.x, dy = world[i * 3 + 1] - camPos.y, dz = world[i * 3 + 2] - camPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* 命中距离（世界单位）：把最近命中点从局部搬回世界 */
  function hitDistance(hit, matrix, camera) {
    if (!hit) return Infinity;
    var v = new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]);
    if (matrix) v.applyMatrix4(matrix);
    return v.distanceTo(camera.position);
  }

  function pickVertex(proj, mesh, camera, x, y, tolPx, hitDist, through) {
    var tolW = Math.max(hitDist * 0.004, 1e-4);
    var best = null, bestD2 = tolPx * tolPx;
    for (var i = 0; i < proj.count; i++) {
      var dx = proj.scr[i * 2] - x, dy = proj.scr[i * 2 + 1] - y;
      var d2 = dx * dx + dy * dy;
      if (d2 > bestD2) continue;
      if (!through) {
        var cd = distToCam(proj.world, i, camera.position);
        if (cd > hitDist + tolW) continue;      /* 被面挡住 */
      }
      best = i; bestD2 = d2;
    }
    if (best == null) return null;
    return {
      kind: 'vertex',
      index: best,
      id: mesh.vertexIds[best],
      pixel: { x: proj.scr[best * 2], y: proj.scr[best * 2 + 1] },
      world: { x: proj.world[best * 3], y: proj.world[best * 3 + 1], z: proj.world[best * 3 + 2] }
    };
  }

  function pickEdge(proj, mesh, camera, x, y, tolPx, hitDist, through) {
    var e = global.SeedModel.Mesh.ensureEdges(mesh);
    var tolW = Math.max(hitDist * 0.004, 1e-4);
    var best = null, bestD2 = tolPx * tolPx;
    for (var i = 0; i < e.edges.length; i++) {
      var rec = e.edges[i];
      var ax = proj.scr[rec.a * 2], ay = proj.scr[rec.a * 2 + 1];
      var bx = proj.scr[rec.b * 2], by = proj.scr[rec.b * 2 + 1];
      var ex = bx - ax, ey = by - ay;
      var len2 = ex * ex + ey * ey;
      var t = len2 > 1e-9 ? ((x - ax) * ex + (y - ay) * ey) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var px = ax + ex * t, py = ay + ey * t;
      var dx = x - px, dy = y - py;
      var d2 = dx * dx + dy * dy;
      if (d2 > bestD2) continue;
      if (!through) {
        /* 用边的中点判遮挡：两端都在背后的边只有中点也够用（边是直线段） */
        var mid = midDistance(proj.world, rec.a, rec.b, camera.position);
        if (mid > hitDist + tolW) continue;
      }
      best = { rec: rec, d2: d2 };
      bestD2 = d2;
    }
    if (!best) return null;
    return {
      kind: 'edge',
      index: best.rec.id,
      id: best.rec.id,
      pixel: { x: x, y: y },
      edge: { a: best.rec.aId, b: best.rec.bId }
    };
  }

  function midDistance(world, a, b, camPos) {
    var ax = (world[a * 3] + world[b * 3]) / 2;
    var ay = (world[a * 3 + 1] + world[b * 3 + 1]) / 2;
    var az = (world[a * 3 + 2] + world[b * 3 + 2]) / 2;
    var dx = ax - camPos.x, dy = ay - camPos.y, dz = az - camPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function pick(opts) {
    if (!ok()) return null;
    var mesh = opts.mesh, camera = opts.camera, rect = opts.rect;
    if (!mesh || !camera || !rect || !rect.width || !rect.height) return null;
    var mode = opts.mode || 'face';
    var through = !!opts.through;
    var x = opts.x, y = opts.y;

    var rayW = rayFromPixel(camera, rect, x, y);
    var hit = nearestFace(mesh, toLocal(rayW, opts.matrix));
    var hd = hitDistance(hit, opts.matrix, camera);

    if (mode === 'object') {
      return hit ? { kind: 'object', index: 0, id: 1, pixel: { x: x, y: y }, distance: hd } : null;
    }
    if (mode === 'face') {
      if (!hit) return null;
      return {
        kind: 'face',
        index: hit.face,
        id: mesh.faceIds[hit.face],
        pixel: { x: x, y: y },
        distance: hd
      };
    }

    /* 点 / 边必须投影：只在命中面附近才可能被选中，但整表投影一次更简单也更稳
     * （5k 顶点 ≈ 1ms，点击频率下完全够用） */
    var proj = projectionCache(mesh, opts.matrix, camera, rect);
    if (mode === 'vertex') {
      return pickVertex(proj, mesh, camera, x, y, opts.vertPx || VERT_PX, hd, through);
    }
    if (mode === 'edge') {
      return pickEdge(proj, mesh, camera, x, y, opts.edgePx || EDGE_PX, hd, through);
    }
    return null;
  }

  /* 通用区域选择：屏幕空间的判定谓词 test(x, y) → bool。
   * 框选、套索、笔刷只差这一个函数，投影只做一次（5k 顶点 ≈ 1ms）。
   *   vertex 看自身像素点；edge 要求两端都在区域内；face 看重心。 */
  function pickRegion(opts) {
    if (!ok()) return null;
    var mesh = opts.mesh, camera = opts.camera, rect = opts.rect, test = opts.test;
    var mode = opts.mode || 'vertex';
    if (!mesh || !camera || !rect || typeof test !== 'function') return null;
    var proj = projectionCache(mesh, opts.matrix, camera, rect);
    var out = { kind: mode, indices: [], ids: [] };
    if (mode === 'vertex') {
      for (var i = 0; i < proj.count; i++) {
        if (!test(proj.scr[i * 2], proj.scr[i * 2 + 1])) continue;
        out.indices.push(i);
        out.ids.push(mesh.vertexIds[i]);
      }
      return out;
    }
    if (mode === 'edge') {
      var e = global.SeedModel.Mesh.ensureEdges(mesh);
      for (var j = 0; j < e.edges.length; j++) {
        var rec = e.edges[j];
        if (!test(proj.scr[rec.a * 2], proj.scr[rec.a * 2 + 1])) continue;
        if (!test(proj.scr[rec.b * 2], proj.scr[rec.b * 2 + 1])) continue;
        out.indices.push(j);
        out.ids.push(rec.id);
      }
      return out;
    }
    if (mode === 'face') {
      for (var f = 0; f < mesh.faceIds.length; f++) {
        var s0 = mesh.faceOffsets[f], e0 = mesh.faceOffsets[f + 1];
        if (e0 - s0 < 3) continue;
        var cx = 0, cy = 0, n = 0;
        for (var k = s0; k < e0; k++) {
          cx += proj.scr[mesh.faceIndices[k] * 2];
          cy += proj.scr[mesh.faceIndices[k] * 2 + 1];
          n++;
        }
        if (!n) continue;
        if (!test(cx / n, cy / n)) continue;
        out.indices.push(f);
        out.ids.push(mesh.faceIds[f]);
      }
      return out;
    }
    return out;
  }

  /* 框选 = 矩形谓词 */
  function pickBox(opts) {
    var box = opts.box;
    if (!box) return null;
    var o = {};
    for (var k in opts) o[k] = opts[k];
    o.test = function (x, y) { return x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2; };
    return pickRegion(o);
  }

  /* 射线法判断点是否在多边形内（套索用）。pts 是 [[x,y], …] 的屏幕点。 */
  function pointInPolygon(x, y, pts) {
    var inside = false, n = pts.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /* 套索：多边形谓词（点太少就退化成点选，避免一次轻点把全场景清空） */
  function pickLasso(opts) {
    var pts = opts.polygon || [];
    if (pts.length < 3) return { kind: opts.mode || 'vertex', indices: [], ids: [] };
    var o = {};
    for (var k in opts) o[k] = opts[k];
    o.test = function (x, y) { return pointInPolygon(x, y, pts); };
    return pickRegion(o);
  }

  /* ---------------- 选择集按包含关系转换（S2b） ----------------
   * 纯数据层：不碰 DOM、不碰高亮，输入 sel 一个字节都不改，返回普通对象
   * { vertexIds, edgeIds, faceIds }。
   * 规则统一按「包含关系」：目标单元必须被源集合**完整覆盖**，
   * 半覆盖的一律丢弃（少选一个顶点的面不会出现在面选择里）。
   * island 在转换里等同面集：作为源按面集算，作为目标则算完面集再按 UV 岛展开一次。
   * 输出顺序统一按 mesh 的自然顺序（vertexIds / 拓扑边 / faceIds），重复 id 被集合吞掉。
   * 目标 id 不存在于 mesh 的直接丢弃；sel 缺字段按空数组处理。 */

  var EDGE_STRIDE_FALLBACK = 67108864;      // 2^26，与 mesh-core 的边 ID 编码一致

  function emptySel() {
    return { vertexIds: [], edgeIds: [], faceIds: [] };
  }

  function normMode(mode) {
    return (mode === 'vertex' || mode === 'edge' || mode === 'face' || mode === 'island')
      ? mode : 'object';
  }

  /* ID 数组 → 「id 是否存在」的查表；用来把未知 id 挡在门外 */
  function idIndex(list) {
    var map = Object.create(null);
    for (var i = 0; i < (list ? list.length : 0); i++) map[list[i]] = i;
    return map;
  }

  function collect(list, validMap) {
    var set = Object.create(null);
    for (var i = 0; i < (list ? list.length : 0); i++) {
      var id = list[i];
      if (id == null || validMap[id] == null) continue;      // 未知 id 丢弃
      set[id] = 1;
    }
    return set;
  }

  /* 按自然顺序把集合摊成数组 */
  function orderBy(natural, set) {
    var out = [];
    for (var i = 0; i < natural.length; i++) {
      if (set[natural[i]]) out.push(natural[i]);
    }
    return out;
  }

  function edgeTable(mesh) {
    var M = global.SeedModel && global.SeedModel.Mesh;
    if (!M || typeof M.ensureEdges !== 'function') return null;
    try { return M.ensureEdges(mesh); } catch (e) { return null; }
  }

  function edgeStride() {
    var M = global.SeedModel && global.SeedModel.Mesh;
    return (M && M.EDGE_STRIDE) || EDGE_STRIDE_FALLBACK;
  }

  /* 面角下标对 → 拓扑边 ID（与 ensureEdges 的编码完全一致） */
  function edgeIdOf(mesh, stride, ia, ib) {
    var a = mesh.vertexIds[ia], b = mesh.vertexIds[ib];
    if (a == null || b == null) return -1;
    var lo = a < b ? a : b, hi = a < b ? b : a;
    return lo * stride + hi;
  }

  /* 按 UV 岛把面集展开；UV 做不到（没有 UV 数据 / 接口缺失 / 抛错）就返回 null，
   * 调用方退化成「按面集拷贝」，绝不抛异常。 */
  function expandIslands(mesh, faceSet) {
    var M = global.SeedModel && global.SeedModel.Mesh;
    if (!M || typeof M.uvIslands !== 'function') return null;
    try {
      if (typeof M.ensureUV === 'function' && typeof M.hasUV === 'function' && !M.hasUV(mesh)) {
        M.ensureUV(mesh);                    // 与岛模式进入时的兜底一致：盒式投影补一份 UV
      }
      var isl = M.uvIslands(mesh);
      var islands = (isl && isl.islands) || [];
      var out = Object.create(null);
      for (var i = 0; i < islands.length; i++) {
        var faces = islands[i].faces || [], hit = false, k;
        for (k = 0; k < faces.length; k++) {
          if (faceSet[mesh.faceIds[faces[k]]]) { hit = true; break; }
        }
        if (!hit) continue;
        for (k = 0; k < faces.length; k++) out[mesh.faceIds[faces[k]]] = 1;
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  function convertSelection(mesh, fromMode, toMode, sel) {
    if (!mesh) return emptySel();
    sel = sel || {};
    var from = normMode(fromMode), to = normMode(toMode);

    /* 任意 → object：对象选择不携带组件级信息，三组清空 */
    if (to === 'object' || from === 'object') return emptySel();

    var vMap = idIndex(mesh.vertexIds);
    var fMap = idIndex(mesh.faceIds);
    /* 同模式也要过边表：原样拷贝里的 edgeIds 同样需要按 mesh 校验 */
    var needEdges = from === 'edge' || to === 'edge' ||
      (from === to && sel.edgeIds && sel.edgeIds.length > 0);
    var table = needEdges ? edgeTable(mesh) : null;
    var eList = (table && table.edges) || [];
    var eMap = Object.create(null);
    var eIds = new Array(eList.length);
    for (var i = 0; i < eList.length; i++) { eMap[eList[i].id] = i; eIds[i] = eList[i].id; }

    /* 同模式：原样拷贝，但仍然过一遍合法性 / 去重 / 自然排序 */
    if (from === to) {
      return {
        vertexIds: orderBy(mesh.vertexIds, collect(sel.vertexIds, vMap)),
        edgeIds: orderBy(eIds, collect(sel.edgeIds, eMap)),
        faceIds: orderBy(mesh.faceIds, collect(sel.faceIds, fMap))
      };
    }

    var srcMode = (from === 'island') ? 'face' : from;      // 岛按面集处理
    var vSel = (srcMode === 'vertex') ? collect(sel.vertexIds, vMap) : Object.create(null);
    var eSel = (srcMode === 'edge') ? collect(sel.edgeIds, eMap) : Object.create(null);
    var fSel = (srcMode === 'face') ? collect(sel.faceIds, fMap) : Object.create(null);

    var outV = Object.create(null), outE = Object.create(null), outF = Object.create(null);
    var stride = edgeStride(), f, k, rec, s0, e0, nv, all, id;

    if (to === 'vertex') {
      if (srcMode === 'vertex') {
        outV = vSel;
      } else if (srcMode === 'edge') {
        for (i = 0; i < eList.length; i++) {                /* 选中边的两端点 */
          rec = eList[i];
          if (!eSel[rec.id]) continue;
          if (vMap[rec.aId] != null) outV[rec.aId] = 1;
          if (vMap[rec.bId] != null) outV[rec.bId] = 1;
        }
      } else {
        for (f = 0; f < mesh.faceIds.length; f++) {          /* 选中面的所有顶点 */
          if (!fSel[mesh.faceIds[f]]) continue;
          s0 = mesh.faceOffsets[f]; e0 = mesh.faceOffsets[f + 1];
          for (k = s0; k < e0; k++) {
            id = mesh.vertexIds[mesh.faceIndices[k]];
            if (id != null) outV[id] = 1;
          }
        }
      }
      return { vertexIds: orderBy(mesh.vertexIds, outV), edgeIds: [], faceIds: [] };
    }

    if (to === 'edge') {
      if (srcMode === 'edge') {
        outE = eSel;
      } else if (srcMode === 'vertex') {
        for (i = 0; i < eList.length; i++) {                /* 两端点都被选中 */
          rec = eList[i];
          if (vSel[rec.aId] && vSel[rec.bId]) outE[rec.id] = 1;
        }
      } else {
        for (i = 0; i < eList.length; i++) {                /* 至少属于一个选中面的拓扑边 */
          rec = eList[i];
          all = false;
          for (k = 0; k < rec.faces.length; k++) {
            if (fSel[mesh.faceIds[rec.faces[k]]]) { all = true; break; }
          }
          if (all) outE[rec.id] = 1;
        }
      }
      return { vertexIds: [], edgeIds: orderBy(eIds, outE), faceIds: [] };
    }

    /* to === 'face'（含 island，先当面集算，最后再展开） */
    if (srcMode === 'face') {
      outF = fSel;
    } else if (srcMode === 'vertex') {
      for (f = 0; f < mesh.faceIds.length; f++) {            /* 所有顶点都被选中 */
        s0 = mesh.faceOffsets[f]; e0 = mesh.faceOffsets[f + 1];
        if (e0 - s0 < 3) continue;
        all = true;
        for (k = s0; k < e0; k++) {
          if (!vSel[mesh.vertexIds[mesh.faceIndices[k]]]) { all = false; break; }
        }
        if (all) outF[mesh.faceIds[f]] = 1;
      }
    } else {
      for (f = 0; f < mesh.faceIds.length; f++) {            /* 所有拓扑边都被选中 */
        s0 = mesh.faceOffsets[f]; e0 = mesh.faceOffsets[f + 1];
        nv = e0 - s0;
        if (nv < 3) continue;
        all = true;
        for (k = 0; k < nv; k++) {
          id = edgeIdOf(mesh, stride, mesh.faceIndices[s0 + k], mesh.faceIndices[s0 + ((k + 1) % nv)]);
          if (id < 0 || !eSel[id]) { all = false; break; }
        }
        if (all) outF[mesh.faceIds[f]] = 1;
      }
    }

    if (to === 'island') {
      var expanded = expandIslands(mesh, outF);
      if (expanded) outF = expanded;                        /* 展开不了就沿用面集拷贝 */
    }
    return { vertexIds: [], edgeIds: [], faceIds: orderBy(mesh.faceIds, outF) };
  }

  global.SeedSelection = {
    pick: pick,
    pickBox: pickBox,
    pickLasso: pickLasso,
    pickRegion: pickRegion,
    pointInPolygon: pointInPolygon,
    convertSelection: convertSelection,
    VERT_PX: VERT_PX,
    EDGE_PX: EDGE_PX
  };
})(typeof window !== 'undefined' ? window : globalThis);
