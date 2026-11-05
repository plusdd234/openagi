/* ============================================================
 * seed-operators.js —— 拓扑算子（M6b）
 *
 * 一批纯函数：拿 mesh + 选项 → 返回**新 mesh**（绝不原地改旧的）。
 * 外壳（model-desk）负责把结果喂给 applyMesh（一条历史）。
 *
 * 铁律：
 *   ① **产出新 mesh**（Mesh.clone 或 Mesh.create 新建），禁止在旧 mesh 上改。
 *   ② 改拓扑时**同步改 rawIndices / uvs**（见 seed-mesh-core 的 setFaceCorners），
 *      否则 UV 岛判定会崩。
 *   ③ 顶点 ID / 面 ID 沿用原值（未删的不换 ID），新顶点 / 新面从 next*Id 起递增。
 *
 * 对外：window.SeedOps = { extrudeFaces, insetFaces, deleteFaces, mergeVertices }
 * ============================================================ */
(function (global) {
  'use strict';

  function meshCore() {
    return (global.SeedModel && global.SeedModel.Mesh) || null;
  }

  /* 把「面 ID 集合」换成「面下标数组」（升序、去重） */
  function faceIndicesOf(mesh, faceIds) {
    if (!mesh || !faceIds || !faceIds.length) return [];
    var want = Object.create(null);
    for (var i = 0; i < faceIds.length; i++) want[faceIds[i]] = 1;
    var out = [];
    for (var f = 0; f < mesh.faceIds.length; f++) {
      if (want[mesh.faceIds[f]]) out.push(f);
    }
    return out;
  }

  /* 面的质心（局部坐标） */
  function faceCenter(mesh, f, out) {
    var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
    var o = out || [0, 0, 0];
    o[0] = o[1] = o[2] = 0;
    var n = e - s;
    if (!n) return o;
    for (var k = s; k < e; k++) {
      var vi = mesh.faceIndices[k] * 3;
      o[0] += mesh.positions[vi];
      o[1] += mesh.positions[vi + 1];
      o[2] += mesh.positions[vi + 2];
    }
    o[0] /= n; o[1] /= n; o[2] /= n;
    return o;
  }

  /* ---------------- 挤出（M6b，M6c 参数化） ----------------
   * 参数（Maya polyExtrudeFace 的子集）：
   *   dist        厚度：沿区域法向（顶点平均法向）挤出的距离
   *   localZ      局部平移 Z：再沿同一法向附加的位移（与厚度叠加）
   *   offset      偏移：顶面沿面平面外扩（正）/ 内缩（负）
   *   divisions   分段：侧壁沿挤出方向的分段数（顶面仍是一张面）
   *   keepTogether 保持面的连续性
   *       true  → 相连的选中面作为一整块壳体挤出：新顶点按「原顶点」共享，
   *               侧壁只长在区域外边界，内部共享边上**不生成隐藏的内接面**
   *       false → 每张面各自挤出（相邻面各长一圈侧壁，内部会出现隐藏面）
   * faceIds 空 = 整个网格沿顶点法线外推（inflate 的真算子版本）。 */
  function extrudeFaces(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var dist = Number(opts.dist);
    if (!isFinite(dist)) dist = 0.1;
    var localZ = Number(opts.localZ);
    if (!isFinite(localZ)) localZ = 0;
    var offset = Number(opts.offset);
    if (!isFinite(offset)) offset = 0;
    var divs = Math.round(Number(opts.divisions));
    if (!isFinite(divs) || divs < 1) divs = 1;
    divs = Math.min(8, divs);
    var together = opts.keepTogether == null ? true : !!opts.keepTogether;
    var push = dist + localZ;

    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var fIdx = faceIndicesOf(src, opts.faceIds);
    if (!fIdx.length) {
      /* 没有面选择：整体沿顶点法线外推（演示工具的正式版） */
      return inflateAll(src, push);
    }

    var pick = Object.create(null);
    for (var i0 = 0; i0 < fIdx.length; i0++) pick[fIdx[i0]] = 1;

    /* 选中面之间的边表：判「区域外边界」，也用来把相连的面并成一组 */
    var edgeUse = Object.create(null), edgeRecs = [];
    for (var fi = 0; fi < fIdx.length; fi++) {
      var f = fIdx[fi];
      var s = src.faceOffsets[f], e = src.faceOffsets[f + 1], n = e - s;
      for (var c = 0; c < n; c++) {
        var a = src.faceIndices[s + c];
        var b = src.faceIndices[s + ((c + 1) % n)];
        var key = a < b ? a + '_' + b : b + '_' + a;
        (edgeUse[key] || (edgeUse[key] = [])).push(edgeRecs.length);
        edgeRecs.push({ f: f, c: c, n: n, s: s, a: a, b: b, key: key });
      }
    }

    /* 连通分组：闭合时按共享边并块，关闭时每张面自成一块 */
    var groups = [];
    if (together) {
      var seen = Object.create(null);
      for (var g0 = 0; g0 < fIdx.length; g0++) {
        var root = fIdx[g0];
        if (seen[root]) continue;
        var stack = [root], faces = [];
        seen[root] = 1;
        while (stack.length) {
          var fx = stack.pop();
          faces.push(fx);
          var sx = src.faceOffsets[fx], ex = src.faceOffsets[fx + 1], nx = ex - sx;
          for (var cx = 0; cx < nx; cx++) {
            var ax = src.faceIndices[sx + cx];
            var bx = src.faceIndices[sx + ((cx + 1) % nx)];
            var kx = ax < bx ? ax + '_' + bx : bx + '_' + ax;
            var recs = edgeUse[kx] || [];
            for (var rx = 0; rx < recs.length; rx++) {
              var nf = edgeRecs[recs[rx]].f;
              if (!seen[nf]) { seen[nf] = 1; stack.push(nf); }
            }
          }
        }
        groups.push(faces);
      }
    } else {
      for (var g1 = 0; g1 < fIdx.length; g1++) groups.push([fIdx[g1]]);
    }

    var out = M.create();
    out.nextVertexId = src.nextVertexId;
    out.nextFaceId = src.nextFaceId;
    out.positions = src.positions.slice();
    out.vertexIds = src.vertexIds.slice();
    out.faceOffsets = [0];
    out.faceIndices = [];
    out.faceIds = [];
    out.faceSlots = [];
    out.uvs = [];
    out.rawIndices = [];

    /* 每张选中面的新顶点映射（重建顶面时用）；键 = 面下标 */
    var capMaps = Object.create(null);
    var ctr = [0, 0, 0], nrm = [0, 0, 0];

    for (var gi = 0; gi < groups.length; gi++) {
      var gf = groups[gi];

      /* 本组面法向、顶点集合、顶点平均法向 */
      var vsel = Object.create(null), vf = Object.create(null), fNrm = Object.create(null);
      for (var q = 0; q < gf.length; q++) {
        var fq = gf[q];
        M.triNormal(src, fq, nrm);
        fNrm[fq] = [nrm[0], nrm[1], nrm[2]];
        var sq = src.faceOffsets[fq], eq = src.faceOffsets[fq + 1];
        for (var kq = sq; kq < eq; kq++) {
          var vq = src.faceIndices[kq];
          vsel[vq] = 1;
          (vf[vq] || (vf[vq] = [])).push(fq);
        }
      }
      var vNrm = Object.create(null);
      for (var vk in vsel) {
        var nd = [0, 0, 0], fl = vf[+vk];
        for (var q1 = 0; q1 < fl.length; q1++) {
          var nn = fNrm[fl[q1]];
          nd[0] += nn[0]; nd[1] += nn[1]; nd[2] += nn[2];
        }
        var nl = Math.sqrt(nd[0] * nd[0] + nd[1] * nd[1] + nd[2] * nd[2]) || 1;
        vNrm[vk] = [nd[0] / nl, nd[1] / nl, nd[2] / nl];
      }

      /* 组边界边：整块壳体只看区域外边界；各自挤出的模式没有「内部边」，每条边都要侧壁 */
      var bEdges = [], inbound = Object.create(null);
      var gset = Object.create(null);
      for (var q2 = 0; q2 < gf.length; q2++) gset[gf[q2]] = 1;
      for (var re = 0; re < edgeRecs.length; re++) {
        var rec = edgeRecs[re];
        if (!gset[rec.f]) continue;
        if (together && edgeUse[rec.key].length !== 1) continue;
        bEdges.push(rec);
        faceCenter(src, rec.f, ctr);
        var m3a = src.positions[rec.a * 3], m3b = src.positions[rec.b * 3];
        var dx = ctr[0] - (m3a + m3b) * 0.5;
        var dy = ctr[1] - (src.positions[rec.a * 3 + 1] + src.positions[rec.b * 3 + 1]) * 0.5;
        var dz = ctr[2] - (src.positions[rec.a * 3 + 2] + src.positions[rec.b * 3 + 2]) * 0.5;
        var fn = fNrm[rec.f];
        var dn = dx * fn[0] + dy * fn[1] + dz * fn[2];
        dx -= fn[0] * dn; dy -= fn[1] * dn; dz -= fn[2] * dn;
        var dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;
        var ends = [rec.a, rec.b];
        for (var en = 0; en < 2; en++) {
          var inb = inbound[ends[en]] || (inbound[ends[en]] = [0, 0, 0]);
          inb[0] += dx; inb[1] += dy; inb[2] += dz;
        }
      }

      /* 组内每个原顶点 → 一份新顶点（共享边上只建一次，这是「整块壳体」的关键） */
      var finalMap = Object.create(null);
      for (var vkr in vsel) {
        var vi = +vkr;
        var px = src.positions[vi * 3], py = src.positions[vi * 3 + 1], pz = src.positions[vi * 3 + 2];
        var nv = vNrm[vkr];
        var inb2 = inbound[vi];
        var ox = 0, oy = 0, oz = 0;
        if (inb2 && offset) {
          var il = Math.sqrt(inb2[0] * inb2[0] + inb2[1] * inb2[1] + inb2[2] * inb2[2]) || 1;
          /* 正 offset = 外扩：沿「朝外」反着推 */
          ox = -inb2[0] / il * offset;
          oy = -inb2[1] / il * offset;
          oz = -inb2[2] / il * offset;
        }
        finalMap[vi] = out.positions.length / 3;
        out.positions.push(
          px + nv[0] * push + ox,
          py + nv[1] * push + oy,
          pz + nv[2] * push + oz
        );
        out.vertexIds.push(out.nextVertexId++);
      }

      /* 分段的中间环：只给边界点建（内部点不参与侧壁，不需要） */
      var rings = null;
      if (divs > 1) {
        var bVerts = Object.create(null);
        for (var be0 = 0; be0 < bEdges.length; be0++) {
          bVerts[bEdges[be0].a] = 1;
          bVerts[bEdges[be0].b] = 1;
        }
        rings = [Object.create(null)];
        for (var bv0 in bVerts) rings[0][bv0] = +bv0;
        for (var d = 1; d < divs; d++) {
          var rr = Object.create(null), t = d / divs;
          for (var bv1 in bVerts) {
            var bvi = +bv1, fm = finalMap[bvi];
            rr[bv1] = out.positions.length / 3;
            out.positions.push(
              src.positions[bvi * 3] * (1 - t) + out.positions[fm * 3] * t,
              src.positions[bvi * 3 + 1] * (1 - t) + out.positions[fm * 3 + 1] * t,
              src.positions[bvi * 3 + 2] * (1 - t) + out.positions[fm * 3 + 2] * t
            );
            out.vertexIds.push(out.nextVertexId++);
          }
          rings[d] = rr;
        }
        rings[divs] = finalMap;
      }

      /* 侧壁：只在组边界边上长，每条边按分段拆成 divs 个四边形 */
      for (var be = 0; be < bEdges.length; be++) {
        var br = bEdges[be];
        for (var d2 = 1; d2 <= divs; d2++) {
          var ringPrev = d2 === 1 ? null : rings[d2 - 1];
          var ringCur = d2 === divs ? finalMap : (rings ? rings[d2] : finalMap);
          var va0 = d2 === 1 ? br.a : ringPrev[br.a];
          var vb0 = d2 === 1 ? br.b : ringPrev[br.b];
          var va1 = ringCur[br.a], vb1 = ringCur[br.b];
          /* 侧壁 UV 沿用边界边两个角的 UV（现代建模软件（Blender / Maya）的默认做法：
           * 新面把相邻面上那条边的贴图拉出来，而不是给 (0,0) 采到一个孤立 texel）。 */
          pushFaceRaw(out, src, -1, [va0, vb0, vb1, va1], out.nextFaceId++,
            [br.s + br.c, br.s + ((br.c + 1) % br.n),
              br.s + ((br.c + 1) % br.n), br.s + br.c], src.faceSlots[br.f]);
        }
      }

      for (var q3 = 0; q3 < gf.length; q3++) capMaps[gf[q3]] = finalMap;
    }

    /* 顶面 / 未选面：按原面序重建，顶面沿用原面 ID，UV 抄原角 */
    for (var f2 = 0; f2 < src.faceIds.length; f2++) {
      var s2 = src.faceOffsets[f2], e2 = src.faceOffsets[f2 + 1];
      if (e2 - s2 < 3) continue;
      if (!pick[f2]) { pushFace(out, src, f2, null); continue; }
      var map2 = capMaps[f2], newV = [], corners2 = [], ok2 = true;
      for (var k2 = s2; k2 < e2; k2++) {
        var dense2 = map2[src.faceIndices[k2]];
        if (dense2 == null) { ok2 = false; break; }
        newV.push(dense2);
        corners2.push(src.rawIndices ? src.rawIndices[k2] : -1);
      }
      if (!ok2) { pushFace(out, src, f2, null); continue; }
      pushFaceRaw(out, src, f2, newV, src.faceIds[f2], corners2, src.faceSlots[f2]);
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 内插（M6b） ----------------
   * 每个选中面：沿质心缩一圈新顶点，原面改指新顶点，外面补一圈侧面。
   * thick = 缩进比例（0~1，按「到质心的距离」缩）。 */
  function insetFaces(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var thick = Number(opts.thick);
    if (!isFinite(thick)) thick = 0.2;
    thick = Math.max(0, Math.min(0.95, thick));
    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var fIdx = faceIndicesOf(src, opts.faceIds);
    if (!fIdx.length) return null;

    var out = M.create();
    out.nextVertexId = src.nextVertexId;
    out.nextFaceId = src.nextFaceId;
    out.positions = src.positions.slice();
    out.vertexIds = src.vertexIds.slice();
    out.faceOffsets = [0];
    out.faceIndices = [];
    out.faceIds = [];
    out.faceSlots = [];
    out.uvs = [];
    out.rawIndices = [];

    var pick = Object.create(null);
    for (var i = 0; i < fIdx.length; i++) pick[fIdx[i]] = 1;
    var ctr = [0, 0, 0];

    for (var f = 0; f < src.faceIds.length; f++) {
      var s0 = src.faceOffsets[f], e0 = src.faceOffsets[f + 1];
      var n = e0 - s0;
      if (n < 3) continue;
      if (!pick[f]) { pushFace(out, src, f, null); continue; }
      faceCenter(src, f, ctr);
      var newVi = [];
      for (var k = s0; k < e0; k++) {
        var oldVi = src.faceIndices[k];
        var dense = out.positions.length / 3;
        out.positions.push(
          src.positions[oldVi * 3] * (1 - thick) + ctr[0] * thick,
          src.positions[oldVi * 3 + 1] * (1 - thick) + ctr[1] * thick,
          src.positions[oldVi * 3 + 2] * (1 - thick) + ctr[2] * thick
        );
        out.vertexIds.push(out.nextVertexId++);
        newVi.push(dense);
      }
      pushFaceRaw(out, src, f, newVi, src.faceIds[f]);
      for (var c = 0; c < n; c++) {
        var c2 = (c + 1) % n;
        var side = [
          src.faceIndices[s0 + c],
          src.faceIndices[s0 + c2],
          newVi[c2],
          newVi[c]
        ];
        pushFaceRaw(out, src, -1, side, out.nextFaceId++, [s0 + c, s0 + c2, s0 + c2, s0 + c], src.faceSlots[f]);
      }
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 删除面（M6b） ----------------
   * 选中面整块删掉；opts.clean = true 时顺手删掉不再被任何面引用的顶点。 */
  function deleteFaces(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var fIdx = faceIndicesOf(src, opts.faceIds);
    if (!fIdx.length) return null;

    var drop = Object.create(null);
    for (var i = 0; i < fIdx.length; i++) drop[fIdx[i]] = 1;

    var out = M.create();
    out.nextVertexId = src.nextVertexId;
    out.nextFaceId = src.nextFaceId;
    out.positions = [];
    out.vertexIds = [];
    out.faceOffsets = [0];
    out.faceIndices = [];
    out.faceIds = [];
    out.faceSlots = [];
    out.uvs = [];
    out.rawIndices = [];

    /* 顶点重映射：clean 时只保留仍被引用的 */
    var remap = new Array(src.vertexIds.length);
    var keepVertex = null;
    if (opts.clean) {
      keepVertex = Object.create(null);
      for (var f = 0; f < src.faceIds.length; f++) {
        if (drop[f]) continue;
        var s0 = src.faceOffsets[f], e0 = src.faceOffsets[f + 1];
        for (var k = s0; k < e0; k++) keepVertex[src.faceIndices[k]] = 1;
      }
    }
    for (var v = 0; v < src.vertexIds.length; v++) {
      if (keepVertex && !keepVertex[v]) { remap[v] = -1; continue; }
      var dense = out.positions.length / 3;
      out.positions.push(src.positions[v * 3], src.positions[v * 3 + 1], src.positions[v * 3 + 2]);
      out.vertexIds.push(src.vertexIds[v]);
      remap[v] = dense;
    }

    for (var f2 = 0; f2 < src.faceIds.length; f2++) {
      if (drop[f2]) continue;
      var s1 = src.faceOffsets[f2], e1 = src.faceOffsets[f2 + 1];
      var verts = [], corners = [];
      for (var k2 = s1; k2 < e1; k2++) {
        var rv = remap[src.faceIndices[k2]];
        if (rv == null || rv < 0) continue;
        verts.push(rv);
        corners.push(src.rawIndices ? src.rawIndices[k2] : k2);
      }
      if (verts.length < 3) continue;
      pushFaceRaw(out, src, -1, verts, src.faceIds[f2], corners, src.faceSlots[f2]);
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 合并顶点（M6b） ----------------
   * 选中顶点焊到它们的质心；opts.thr > 0 时顺带把距离 < thr 的顶点也焊掉。
   * 焊完清理退化面（同一顶点出现两次的面）。 */
  function mergeVertices(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var thr = Number(opts.thr);
    if (!isFinite(thr) || thr < 0) thr = 0;
    var src = M.clone(mesh);
    M.ensureRawIndices(src);

    /* 并查集：先把选中顶点并成一组，再按阈值并邻近点 */
    var n = src.vertexIds.length;
    var parent = new Array(n);
    for (var i = 0; i < n; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }

    var selMap = Object.create(null);
    if (opts.vertexIds && opts.vertexIds.length) {
      for (var vi = 0; vi < n; vi++) selMap[src.vertexIds[vi]] = vi;
      var group = [];
      for (var j = 0; j < opts.vertexIds.length; j++) {
        var at = selMap[opts.vertexIds[j]];
        if (at != null) group.push(at);
      }
      for (var g = 1; g < group.length; g++) union(group[0], group[g]);
    }

    if (thr > 0) {
      var q = Math.max(1, Math.round(1 / thr));
      var cell = Object.create(null);
      for (var p = 0; p < n; p++) {
        var cx = Math.floor(src.positions[p * 3] * q),
            cy = Math.floor(src.positions[p * 3 + 1] * q),
            cz = Math.floor(src.positions[p * 3 + 2] * q);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
          var key = (cx + dx) + ',' + (cy + dy) + ',' + (cz + dz);
          var bucket = cell[key];
          if (!bucket) { cell[key] = [p]; continue; }
          for (var b = 0; b < bucket.length; b++) {
            var qj = bucket[b];
            var ddx = src.positions[p * 3] - src.positions[qj * 3];
            var ddy = src.positions[p * 3 + 1] - src.positions[qj * 3 + 1];
            var ddz = src.positions[p * 3 + 2] - src.positions[qj * 3 + 2];
            if (ddx * ddx + ddy * ddy + ddz * ddz <= thr * thr) union(p, qj);
          }
          bucket.push(p);
        }
      }
    }

    /* 每组算质心，作为焊接后的新位置 */
    var acc = Object.create(null);
    for (var v2 = 0; v2 < n; v2++) {
      var r = find(v2);
      var a = acc[r];
      if (!a) { a = acc[r] = { x: 0, y: 0, z: 0, n: 0, first: v2 }; }
      a.x += src.positions[v2 * 3];
      a.y += src.positions[v2 * 3 + 1];
      a.z += src.positions[v2 * 3 + 2];
      a.n++;
    }

    /* 输出网格：每个并查集组只留一个顶点（保留组内最小 vertexId，ID 稳定） */
    var out = M.create();
    out.nextVertexId = src.nextVertexId;
    out.nextFaceId = src.nextFaceId;
    out.positions = [];
    out.vertexIds = [];
    out.faceOffsets = [0];
    out.faceIndices = [];
    out.faceIds = [];
    out.faceSlots = [];
    out.uvs = [];
    out.rawIndices = [];

    var remap = new Array(n);
    var bestId = Object.create(null);
    for (var v3 = 0; v3 < n; v3++) {
      var r3 = find(v3);
      if (bestId[r3] == null || src.vertexIds[v3] < bestId[r3]) bestId[r3] = src.vertexIds[v3];
    }
    var seenRoot = Object.create(null);
    for (var v4 = 0; v4 < n; v4++) {
      var r4 = find(v4);
      if (seenRoot[r4] == null) {
        seenRoot[r4] = out.positions.length / 3;
        var ag = acc[r4];
        out.positions.push(ag.x / ag.n, ag.y / ag.n, ag.z / ag.n);
        out.vertexIds.push(bestId[r4]);
      }
      remap[v4] = seenRoot[r4];
    }

    for (var f4 = 0; f4 < src.faceIds.length; f4++) {
      var s4 = src.faceOffsets[f4], e4 = src.faceOffsets[f4 + 1];
      var verts4 = [], corners4 = [], uniq = Object.create(null), degen = false;
      for (var k4 = s4; k4 < e4; k4++) {
        var rv4 = remap[src.faceIndices[k4]];
        if (uniq[rv4]) { degen = true; break; }
        uniq[rv4] = 1;
        verts4.push(rv4);
        corners4.push(src.rawIndices ? src.rawIndices[k4] : k4);
      }
      if (degen || verts4.length < 3) continue;   /* 退化面直接丢 */
      pushFaceRaw(out, src, -1, verts4, src.faceIds[f4], corners4, src.faceSlots[f4]);
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 内部：面搬运 ---------------- */

  /* 原样搬第 f 个面（角号 / UV 跟着走） */
  function pushFace(out, src, f, _unused) {
    var s = src.faceOffsets[f], e = src.faceOffsets[f + 1];
    var verts = [], corners = [];
    for (var k = s; k < e; k++) {
      verts.push(src.faceIndices[k]);
      corners.push(src.rawIndices ? src.rawIndices[k] : k);
    }
    pushFaceRaw(out, src, -1, verts, src.faceIds[f], corners, src.faceSlots[f]);
  }

  /* 把「一组顶点下标」写成 out 的一个面；corners 是对应的原始面角号（用于 UV）。
   * srcFace >= 0 表示「这是原面改写的顶」，UV 从原面角逐个抄。 */
  function pushFaceRaw(out, src, srcFace, verts, faceId, corners, slot) {
    if (!verts || verts.length < 3) return;
    var start = out.faceIndices.length;
    for (var i = 0; i < verts.length; i++) out.faceIndices.push(verts[i]);
    out.faceOffsets.push(out.faceIndices.length);
    out.faceIds.push(faceId != null ? faceId : out.nextFaceId++);
    out.faceSlots.push(slot != null ? slot : 0);
    /* rawIndices / uvs 与 faceIndices 等长。rawIndices 记的是**本网格的角号**，
     * 后续算子拿它索引自己的 uvs 就能取到这份拷贝（-1 = 没有来源，UV 补 0）。 */
    var raw = out.rawIndices || (out.rawIndices = []);
    var uv = out.uvs || (out.uvs = []);
    var hasUv = !!(src.uvs && src.uvs.length === src.faceIndices.length * 2);
    for (var j = 0; j < verts.length; j++) {
      var sc = corners ? corners[j] : -1;
      if (!hasUv || sc == null || sc < 0) {
        raw.push(-1);
        uv.push(0, 0);
      } else {
        var uu = src.uvs[sc * 2], vv = src.uvs[sc * 2 + 1];
        if (!isFinite(uu)) uu = 0;
        if (!isFinite(vv)) vv = 0;
        uv.push(uu, vv);
        raw.push(start + j);
      }
    }
    return start;
  }

  /* 沿顶点法线外推（整网格，无选择）：从质心指向顶点的方向 */
  function inflateAll(mesh, d) {
    var M = meshCore();
    if (!M || !mesh || !d) return mesh;
    var out = M.clone(mesh);
    M.ensureRawIndices(out);
    var vCount = out.positions.length / 3;
    var fCount = out.faceOffsets.length - 1;
    for (var i = 0; i < vCount; i++) {
      var cx = 0, cy = 0, cz = 0, cnt = 0;
      for (var f = 0; f < fCount; f++) {
        var st0 = out.faceOffsets[f], en = out.faceOffsets[f + 1];
        for (var k = st0; k < en; k++) {
          if (out.faceIndices[k] === i) {
            cx += out.positions[out.faceIndices[st0] * 3];
            cy += out.positions[out.faceIndices[st0] * 3 + 1];
            cz += out.positions[out.faceIndices[st0] * 3 + 2];
            cnt++;
          }
        }
      }
      if (!cnt) continue;
      cx /= cnt; cy /= cnt; cz /= cnt;
      var vx = out.positions[i * 3], vy = out.positions[i * 3 + 1], vz = out.positions[i * 3 + 2];
      var dx = vx - cx, dy = vy - cy, dz = vz - cz;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      out.positions[i * 3] = vx + (dx / len) * d;
      out.positions[i * 3 + 1] = vy + (dy / len) * d;
      out.positions[i * 3 + 2] = vz + (dz / len) * d;
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 新算子共用：复制外壳 ---------------- */
  /* 与 extrude/inset 里的建壳逻辑一致：顶点整份继承，面表清空后按需重写。 */
  function newShell(src) {
    var M = meshCore();
    var out = M.create();
    out.nextVertexId = src.nextVertexId;
    out.nextFaceId = src.nextFaceId;
    out.positions = src.positions.slice();
    out.vertexIds = src.vertexIds.slice();
    out.faceOffsets = [0];
    out.faceIndices = [];
    out.faceIds = [];
    out.faceSlots = [];
    out.uvs = [];
    out.rawIndices = [];
    return out;
  }

  /* 顶点 ID → 密集下标 */
  function vertexIndexMap(mesh) {
    var map = Object.create(null);
    for (var i = 0; i < mesh.vertexIds.length; i++) map[mesh.vertexIds[i]] = i;
    return map;
  }

  /* 追加一个新顶点，返回密集下标 */
  function addVertex(out, x, y, z) {
    var dense = out.positions.length / 3;
    out.positions.push(x, y, z);
    out.vertexIds.push(out.nextVertexId++);
    return dense;
  }

  /* ---------------- 平滑（拉普拉斯） ----------------
   * 对选中顶点（不选 = 整个网格）做若干次「向邻居平均位置收缩」。
   * 只改坐标不动拓扑；边界顶点照样平均，不会跑飞。 */
  function smoothVertices(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var strength = Number(opts.strength);
    if (!isFinite(strength)) strength = 0.5;
    strength = Math.max(0, Math.min(1, strength));
    var iterations = Math.round(Number(opts.iterations) || 1);
    iterations = Math.max(1, Math.min(10, iterations));

    var out = M.clone(mesh);
    M.ensureRawIndices(out);
    var n = out.vertexIds.length;
    if (!n) return null;

    var want = null;
    if (opts.vertexIds && opts.vertexIds.length) {
      var map = vertexIndexMap(out);
      want = Object.create(null);
      var hit = 0;
      for (var j = 0; j < opts.vertexIds.length; j++) {
        var at = map[opts.vertexIds[j]];
        if (at != null) { want[at] = 1; hit++; }
      }
      if (!hit) return null;
    }

    /* 邻接表：共享一条面边即为邻居 */
    var adj = new Array(n);
    for (var a = 0; a < n; a++) adj[a] = [];
    for (var f = 0; f < out.faceIds.length; f++) {
      var s0 = out.faceOffsets[f], e0 = out.faceOffsets[f + 1];
      for (var k = s0; k < e0; k++) {
        var va = out.faceIndices[k];
        var vb = out.faceIndices[k + 1 < e0 ? k + 1 : s0];
        if (adj[va].indexOf(vb) < 0) adj[va].push(vb);
        if (adj[vb].indexOf(va) < 0) adj[vb].push(va);
      }
    }

    var cur = out.positions.slice();
    var next = cur.slice();
    for (var it = 0; it < iterations; it++) {
      for (var v = 0; v < n; v++) {
        if (want && !want[v]) continue;
        var nb = adj[v];
        if (!nb.length) continue;
        var ax = 0, ay = 0, az = 0;
        for (var q = 0; q < nb.length; q++) {
          var qi = nb[q] * 3;
          ax += cur[qi]; ay += cur[qi + 1]; az += cur[qi + 2];
        }
        ax /= nb.length; ay /= nb.length; az /= nb.length;
        var vi = v * 3;
        next[vi] = cur[vi] + (ax - cur[vi]) * strength;
        next[vi + 1] = cur[vi + 1] + (ay - cur[vi + 1]) * strength;
        next[vi + 2] = cur[vi + 2] + (az - cur[vi + 2]) * strength;
      }
      for (var t = 0; t < cur.length; t++) cur[t] = next[t];
    }
    out.positions = cur;
    M.bump(out);
    return out;
  }

  /* ---------------- 面倒角（内缩环 + 深度） ----------------
   * Blender 的 bevel 是边级算法；这里给一个稳定的「面倒角」子集：
   * 选中面按 width（0~0.45 的质心比例）缩进 seg 圈，每圈之间补四边形，
   * 内圈整体沿法线偏移 depth。对多边形面同样成立，不改动其它面。 */
  function bevelFaces(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var width = Number(opts.width);
    if (!isFinite(width)) width = 0.08;
    width = Math.max(0.001, Math.min(0.45, width));
    var seg = Math.round(Number(opts.seg) || 1);
    seg = Math.max(1, Math.min(4, seg));
    var depth = Number(opts.depth);
    if (!isFinite(depth)) depth = 0;

    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var fIdx = faceIndicesOf(src, opts.faceIds);
    if (!fIdx.length) return null;

    var out = newShell(src);
    var pick = Object.create(null);
    for (var i = 0; i < fIdx.length; i++) pick[fIdx[i]] = 1;
    var ctr = [0, 0, 0], nrm = [0, 0, 0];

    for (var f = 0; f < src.faceIds.length; f++) {
      var s0 = src.faceOffsets[f], e0 = src.faceOffsets[f + 1];
      var n = e0 - s0;
      if (n < 3) continue;
      if (!pick[f]) { pushFace(out, src, f, null); continue; }

      faceCenter(src, f, ctr);
      M.triNormal(src, f, nrm);
      var slot = src.faceSlots[f];

      /* ring 0 直接引用原顶点；ring r 新建一圈 */
      var ring = [];
      for (var k = s0; k < e0; k++) ring.push(src.faceIndices[k]);
      for (var r = 1; r <= seg; r++) {
        var t2 = width * (r / seg);
        var nextRing = [];
        for (var k2 = s0; k2 < e0; k2++) {
          var oldVi = src.faceIndices[k2];
          nextRing.push(addVertex(out,
            src.positions[oldVi * 3] * (1 - t2) + ctr[0] * t2 + nrm[0] * depth,
            src.positions[oldVi * 3 + 1] * (1 - t2) + ctr[1] * t2 + nrm[1] * depth,
            src.positions[oldVi * 3 + 2] * (1 - t2) + ctr[2] * t2 + nrm[2] * depth));
        }
        /* ring(r-1) → ring(r) 每个角一个四边形 */
        for (var c = 0; c < n; c++) {
          var c2 = (c + 1) % n;
          var corners = [s0 + c, s0 + c2, -1, -1];
          pushFaceRaw(out, src, -1, [ring[c], ring[c2], nextRing[c2], nextRing[c]], out.nextFaceId++, corners, slot);
        }
        ring = nextRing;
      }
      /* 中央面（最内圈），ID 沿用原面，UV 抄原角 */
      pushFaceRaw(out, src, f, ring, src.faceIds[f], null, slot);
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 桥接（两个面环） ----------------
   * 选中恰好两个顶点数相同的面：删掉它们，在两条环之间补四边形带。
   * 自动尝试旋转 / 反向匹配，选距离和最小的一种。 */
  function bridgeFaces(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var seg = Math.round(Number(opts.segments) || 1);
    seg = Math.max(1, Math.min(8, seg));

    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var fIdx = faceIndicesOf(src, opts.faceIds);
    if (fIdx.length !== 2) return null;
    var fA = fIdx[0], fB = fIdx[1];
    var sA = src.faceOffsets[fA], eA = src.faceOffsets[fA + 1];
    var sB = src.faceOffsets[fB], eB = src.faceOffsets[fB + 1];
    var n = eA - sA;
    if (n < 3 || eB - sB !== n) return null;

    var loopA = [], loopB = [];
    for (var i = 0; i < n; i++) loopA.push(src.faceIndices[sA + i]);
    for (var j = 0; j < n; j++) loopB.push(src.faceIndices[sB + j]);

    /* 选最优旋转 + 方向 */
    function dist2(pa, ia, pb, ib) {
      var a3 = pa[ia] * 3, b3 = pb[ib] * 3;
      var dx = src.positions[a3] - src.positions[b3];
      var dy = src.positions[a3 + 1] - src.positions[b3 + 1];
      var dz = src.positions[a3 + 2] - src.positions[b3 + 2];
      return dx * dx + dy * dy + dz * dz;
    }
    var best = null;
    for (var dir = 0; dir < 2; dir++) {
      for (var rot = 0; rot < n; rot++) {
        var cost = 0;
        for (var q = 0; q < n; q++) {
          var bAt = dir ? ((rot - q) % n + n) % n : (rot + q) % n;
          cost += dist2(loopA, q, loopB, bAt);
        }
        if (!best || cost < best.cost) best = { dir: dir, rot: rot, cost: cost };
      }
    }
    var bLoop = [];
    for (var q2 = 0; q2 < n; q2++) {
      bLoop.push(loopB[best.dir ? ((best.rot - q2) % n + n) % n : (best.rot + q2) % n]);
    }

    var out = newShell(src);
    for (var f = 0; f < src.faceIds.length; f++) {
      if (f === fA || f === fB) continue;
      pushFace(out, src, f, null);
    }
    var slot = src.faceSlots[fA];

    var prev = loopA;
    /* segments=1 直接连两条环；segments=2 中间插一圈，依此类推 */
    for (var r = 1; r <= seg - 1; r++) {
      var t = r / seg;
      var ring = [];
      for (var c = 0; c < n; c++) {
        var ai = loopA[c] * 3, bi = bLoop[c] * 3;
        ring.push(addVertex(out,
          src.positions[ai] * (1 - t) + src.positions[bi] * t,
          src.positions[ai + 1] * (1 - t) + src.positions[bi + 1] * t,
          src.positions[ai + 2] * (1 - t) + src.positions[bi + 2] * t));
      }
      for (var c2 = 0; c2 < n; c2++) {
        var c3 = (c2 + 1) % n;
        pushFaceRaw(out, src, -1, [prev[c2], prev[c3], ring[c3], ring[c2]], out.nextFaceId++, null, slot);
      }
      prev = ring;
    }
    for (var c4 = 0; c4 < n; c4++) {
      var c5 = (c4 + 1) % n;
      pushFaceRaw(out, src, -1, [prev[c4], prev[c5], bLoop[c5], bLoop[c4]], out.nextFaceId++, null, slot);
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 添加分段（细分一遍） ----------------
   * 选中面：取每条边中点 + 面质心，一切四（三角形切三）。
   * 相邻的未选面若共享被切边，把中点插进它的环里，避免 T 形缝。 */
  function subdivideFaces(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var fIdx = faceIndicesOf(src, opts.faceIds);
    if (!fIdx.length) return null;

    var pick = Object.create(null);
    for (var i = 0; i < fIdx.length; i++) pick[fIdx[i]] = 1;

    var out = newShell(src);
    var mid = Object.create(null);      /* "a_b" → 新顶点密集下标 */

    function edgeKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
    function midpoint(a, b) {
      var key = edgeKey(a, b);
      var got = mid[key];
      if (got != null) return got;
      var a3 = a * 3, b3 = b * 3;
      got = addVertex(out,
        (src.positions[a3] + src.positions[b3]) * 0.5,
        (src.positions[a3 + 1] + src.positions[b3 + 1]) * 0.5,
        (src.positions[a3 + 2] + src.positions[b3 + 2]) * 0.5);
      mid[key] = got;
      return got;
    }

    /* 第一遍：为选中面的边建中点（共享边只建一次） */
    for (var f0 = 0; f0 < src.faceIds.length; f0++) {
      if (!pick[f0]) continue;
      var sA = src.faceOffsets[f0], eA = src.faceOffsets[f0 + 1];
      for (var k0 = sA; k0 < eA; k0++) {
        midpoint(src.faceIndices[k0], src.faceIndices[k0 + 1 < eA ? k0 + 1 : sA]);
      }
    }

    /* 第二遍：搬面 / 切面 */
    for (var f = 0; f < src.faceIds.length; f++) {
      var s0 = src.faceOffsets[f], e0 = src.faceOffsets[f + 1];
      var n = e0 - s0;
      if (n < 3) continue;
      if (!pick[f]) {
        var verts0 = [], corners0 = [];
        for (var k = s0; k < e0; k++) {
          var a = src.faceIndices[k];
          var b = src.faceIndices[k + 1 < e0 ? k + 1 : s0];
          verts0.push(a);
          corners0.push(src.rawIndices ? src.rawIndices[k] : k);
          var m = mid[edgeKey(a, b)];
          if (m != null) { verts0.push(m); corners0.push(-1); }
        }
        pushFaceRaw(out, src, -1, verts0, src.faceIds[f], corners0, src.faceSlots[f]);
        continue;
      }
      /* 选中面：角 i 的四边形 [v_i, m_i, C, m_{i-1}] */
      var ctr = [0, 0, 0];
      faceCenter(src, f, ctr);
      var centerVi = addVertex(out, ctr[0], ctr[1], ctr[2]);
      for (var c = 0; c < n; c++) {
        var prevC = (c - 1 + n) % n;
        var va = src.faceIndices[s0 + c];
        var vb = src.faceIndices[s0 + (c + 1) % n];
        var vp = src.faceIndices[s0 + prevC];
        var mNext = midpoint(va, vb);
        var mPrev = midpoint(vp, va);
        var faceId = c === 0 ? src.faceIds[f] : out.nextFaceId++;
        pushFaceRaw(out, src, -1, [va, mNext, centerVi, mPrev], faceId,
          [s0 + c, -1, -1, -1], src.faceSlots[f]);
      }
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 连接（两点切面） ----------------
   * 选中恰好两个顶点：在同时包含它们的面上，沿两点连线把该面切成两个多边形。
   * 两点本来就相邻（已有边）的面保持不动。 */
  function connectVertices(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var ids = opts.vertexIds || [];
    if (ids.length !== 2) return null;
    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var map = vertexIndexMap(src);
    var a = map[ids[0]], b = map[ids[1]];
    if (a == null || b == null || a === b) return null;

    var out = newShell(src);
    var changed = false;
    for (var f = 0; f < src.faceIds.length; f++) {
      var s0 = src.faceOffsets[f], e0 = src.faceOffsets[f + 1];
      var n = e0 - s0;
      if (n < 4) { pushFace(out, src, f, null); continue; }
      var pa = -1, pb = -1;
      for (var k = s0; k < e0; k++) {
        var vi = src.faceIndices[k];
        if (vi === a) pa = k - s0;
        if (vi === b) pb = k - s0;
      }
      if (pa < 0 || pb < 0) { pushFace(out, src, f, null); continue; }
      /* 相邻角：已是同一条边，不切 */
      if (Math.abs(pa - pb) === 1 || Math.abs(pa - pb) === n - 1) { pushFace(out, src, f, null); continue; }

      /* 两条链：pa→pb、pb→pa（各自包含端点） */
      var chain1V = [], chain1C = [], chain2V = [], chain2C = [];
      var idx = pa;
      while (true) {
        chain1V.push(src.faceIndices[s0 + idx]);
        chain1C.push(src.rawIndices ? src.rawIndices[s0 + idx] : s0 + idx);
        if (idx === pb) break;
        idx = (idx + 1) % n;
      }
      idx = pb;
      while (true) {
        chain2V.push(src.faceIndices[s0 + idx]);
        chain2C.push(src.rawIndices ? src.rawIndices[s0 + idx] : s0 + idx);
        if (idx === pa) break;
        idx = (idx + 1) % n;
      }
      if (chain1V.length < 3 || chain2V.length < 3) { pushFace(out, src, f, null); continue; }
      pushFaceRaw(out, src, -1, chain1V, src.faceIds[f], chain1C, src.faceSlots[f]);
      pushFaceRaw(out, src, -1, chain2V, out.nextFaceId++, chain2C, src.faceSlots[f]);
      changed = true;
    }
    if (!changed) return null;
    M.bump(out);
    return out;
  }

  /* ---------------- 目标焊接 ----------------
   * 选中顶点按选择顺序排列，最后一个 = 目标；其余全部焊到目标位置。
   * 清掉退化面，ID 稳定。 */
  function targetWeld(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var ids = opts.vertexIds || [];
    if (ids.length < 2) return null;
    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var map = vertexIndexMap(src);
    var target = map[ids[ids.length - 1]];
    if (target == null) return null;
    var drop = Object.create(null);
    var used = Object.create(null);
    for (var i = 0; i < ids.length; i++) {
      var at = map[ids[i]];
      if (at == null || used[at]) continue;
      used[at] = 1;
      if (at !== target) drop[at] = 1;
    }
    if (!Object.keys(drop).length) return null;

    var out = M.create();
    out.nextVertexId = src.nextVertexId;
    out.nextFaceId = src.nextFaceId;
    out.positions = [];
    out.vertexIds = [];
    out.faceOffsets = [0];
    out.faceIndices = [];
    out.faceIds = [];
    out.faceSlots = [];
    out.uvs = [];
    out.rawIndices = [];

    var remap = new Array(src.vertexIds.length);
    var targetDense = -1;
    for (var v = 0; v < src.vertexIds.length; v++) {
      if (drop[v]) { remap[v] = -1; continue; }
      var dense = out.positions.length / 3;
      out.positions.push(src.positions[v * 3], src.positions[v * 3 + 1], src.positions[v * 3 + 2]);
      out.vertexIds.push(src.vertexIds[v]);
      remap[v] = dense;
      if (v === target) targetDense = dense;
    }
    for (var v2 = 0; v2 < src.vertexIds.length; v2++) {
      if (remap[v2] < 0) remap[v2] = targetDense;
    }

    for (var f = 0; f < src.faceIds.length; f++) {
      var s0 = src.faceOffsets[f], e0 = src.faceOffsets[f + 1];
      var verts = [], corners = [], uniq = Object.create(null), degen = false;
      for (var k = s0; k < e0; k++) {
        var rv = remap[src.faceIndices[k]];
        if (uniq[rv]) { degen = true; break; }
        uniq[rv] = 1;
        verts.push(rv);
        corners.push(src.rawIndices ? src.rawIndices[k] : -1);
      }
      if (degen || verts.length < 3) continue;
      pushFaceRaw(out, src, -1, verts, src.faceIds[f], corners, src.faceSlots[f]);
    }
    M.bump(out);
    return out;
  }

  /* ---------------- 四边形绘制（4 点成面） ----------------
   * 选中 4 个顶点 → 追加一个四边形面。顶点顺序按选择顺序。 */
  function createQuadFace(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var ids = opts.vertexIds || [];
    if (ids.length !== 4) return null;
    var map = vertexIndexMap(mesh);
    var verts = [];
    var uniq = Object.create(null);
    for (var i = 0; i < 4; i++) {
      var at = map[ids[i]];
      if (at == null || uniq[at]) return null;
      uniq[at] = 1;
      verts.push(at);
    }
    var out = M.clone(mesh);
    M.ensureRawIndices(out);
    pushFaceRaw(out, out, -1, verts, out.nextFaceId++, [-1, -1, -1, -1], 0);
    M.bump(out);
    return out;
  }

  /* ---------------- 分离（按连通块） ----------------
   * 返回 mesh 数组：共享顶点的面归为一块。每块保留原顶点 / 面 ID。 */
  function splitLooseParts(mesh) {
    var M = meshCore();
    if (!M || !mesh) return [];
    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var n = src.vertexIds.length;
    var parent = new Array(n);
    for (var i = 0; i < n; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }
    for (var f = 0; f < src.faceIds.length; f++) {
      var s0 = src.faceOffsets[f], e0 = src.faceOffsets[f + 1];
      for (var k = s0 + 1; k < e0; k++) union(src.faceIndices[s0], src.faceIndices[k]);
    }

    var groups = Object.create(null), roots = [];
    for (var f2 = 0; f2 < src.faceIds.length; f2++) {
      var s2 = src.faceOffsets[f2], e2 = src.faceOffsets[f2 + 1];
      if (e2 - s2 < 3) continue;
      var r = find(src.faceIndices[s2]);
      if (!groups[r]) { groups[r] = []; roots.push(r); }
      groups[r].push(f2);
    }
    var parts = [];
    for (var g = 0; g < roots.length; g++) {
      var faces = groups[roots[g]];
      var out = M.create();
      out.positions = [];
      out.vertexIds = [];
      out.faceOffsets = [0];
      out.faceIndices = [];
      out.faceIds = [];
      out.faceSlots = [];
      out.uvs = [];
      out.rawIndices = [];
      var remap = Object.create(null);
      var maxVertexId = 0;
      for (var ff = 0; ff < faces.length; ff++) {
        var fi = faces[ff];
        var s3 = src.faceOffsets[fi], e3 = src.faceOffsets[fi + 1];
        var verts = [], corners = [];
        for (var k3 = s3; k3 < e3; k3++) {
          var old = src.faceIndices[k3];
          if (remap[old] == null) {
            remap[old] = out.positions.length / 3;
            out.positions.push(src.positions[old * 3], src.positions[old * 3 + 1], src.positions[old * 3 + 2]);
            var vid = src.vertexIds[old];
            out.vertexIds.push(vid);
            if (vid > maxVertexId) maxVertexId = vid;
          }
          verts.push(remap[old]);
          corners.push(src.rawIndices ? src.rawIndices[k3] : -1);
        }
        pushFaceRaw(out, src, -1, verts, src.faceIds[fi], corners, src.faceSlots[fi]);
      }
      out.nextVertexId = maxVertexId + 1;
      out.nextFaceId = src.nextFaceId;
      M.bump(out);
      parts.push(out);
    }
    return parts;
  }

  /* ---------------- 多切割（平面切） ----------------
   * 用一个局部平面切整个网格：每个被切面沿两个交点分成两个多边形。
   * 交点多于 2 个的面（非凸 / 自交）跳过，保证不产生碎面。 */
  function knifePlaneCut(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var p = opts.plane || {};
    var nx = Number(p.nx), ny = Number(p.ny), nz = Number(p.nz);
    var d = Number(p.d);
    if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz) || !isFinite(d)) return null;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len; d /= len;

    var src = M.clone(mesh);
    M.ensureRawIndices(src);
    var out = newShell(src);
    var cut = false;

    for (var f = 0; f < src.faceIds.length; f++) {
      var s0 = src.faceOffsets[f], e0 = src.faceOffsets[f + 1];
      var n = e0 - s0;
      if (n < 3) continue;
      var signs = [];
      var anyPos = false, anyNeg = false;
      for (var k = s0; k < e0; k++) {
        var vi = src.faceIndices[k] * 3;
        var sd = nx * src.positions[vi] + ny * src.positions[vi + 1] + nz * src.positions[vi + 2] - d;
        signs.push(sd);
        if (sd > 1e-7) anyPos = true;
        if (sd < -1e-7) anyNeg = true;
      }
      if (!anyPos || !anyNeg) { pushFace(out, src, f, null); continue; }

      /* 收集交点（每条被跨的边一个） */
      var crosses = [];   /* {after: 角序, vi: 新顶点} */
      for (var c = 0; c < n; c++) {
        var c2 = (c + 1) % n;
        var sa = signs[c], sb = signs[c2];
        if (sa > 1e-7 && sb < -1e-7 || sa < -1e-7 && sb > 1e-7) {
          var t = sa / (sa - sb);
          var ia = (s0 + c) * 3, ib = (s0 + c2) * 3;
          var pos = [
            src.positions[ia] * (1 - t) + src.positions[ib] * t,
            src.positions[ia + 1] * (1 - t) + src.positions[ib + 1] * t,
            src.positions[ia + 2] * (1 - t) + src.positions[ib + 2] * t
          ];
          crosses.push({ after: c, vi: addVertex(out, pos[0], pos[1], pos[2]) });
        }
      }
      if (crosses.length !== 2) { pushFace(out, src, f, null); continue; }

      /* 按环序重建：第 c 个角之后再插入 after===c 的交点 */
      var aug = [];
      for (var c4 = 0; c4 < n; c4++) {
        aug.push({ v: src.faceIndices[s0 + c4], c: src.rawIndices ? src.rawIndices[s0 + c4] : s0 + c4, cross: false });
        for (var x2 = 0; x2 < crosses.length; x2++) {
          if (crosses[x2].after === c4) aug.push({ v: crosses[x2].vi, c: -1, cross: true });
        }
      }
      var p1 = -1, p2 = -1;
      for (var q2 = 0; q2 < aug.length; q2++) {
        if (!aug[q2].cross) continue;
        if (p1 < 0) p1 = q2; else p2 = q2;
      }
      if (p1 < 0 || p2 < 0) { pushFace(out, src, f, null); continue; }

      var chainA = [], chainB = [];
      for (var q3 = p1; ; q3 = (q3 + 1) % aug.length) {
        chainA.push(aug[q3]);
        if (q3 === p2) break;
      }
      for (var q4 = p2; ; q4 = (q4 + 1) % aug.length) {
        chainB.push(aug[q4]);
        if (q4 === p1) break;
      }
      if (chainA.length < 3 || chainB.length < 3) { pushFace(out, src, f, null); continue; }
      function pushChain(chain, faceId) {
        var verts = [], corners = [];
        for (var ci = 0; ci < chain.length; ci++) { verts.push(chain[ci].v); corners.push(chain[ci].c); }
        pushFaceRaw(out, src, -1, verts, faceId, corners, src.faceSlots[f]);
      }
      pushChain(chainA, src.faceIds[f]);
      pushChain(chainB, out.nextFaceId++);
      cut = true;
    }
    if (!cut) return null;
    M.bump(out);
    return out;
  }

  /* ---------------- 布尔（BSP / CSG） ----------------
   * 稳定的凸多面体布尔子集：三角形进 BSP，输出多边形面。
   * 两个网格必须已在同一坐标系里（由外壳先把 B 烘进 A 的局部空间）。 */
  var CSG_EPS = 1e-6;
  function polyNormal(poly) {
    var n = [0, 0, 0];
    var v = poly.verts;
    for (var i = 0; i < v.length; i++) {
      var a = v[i], b = v[(i + 1) % v.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    var len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if (len < 1e-12) return [0, 0, 1];
    return [n[0] / len, n[1] / len, n[2] / len];
  }
  function makePoly(verts, slot, plane) {
    if (verts.length < 3) return null;
    var n = plane ? plane.n : polyNormal({ verts: verts });
    var poly = {
      verts: verts,
      slot: slot || 0,
      plane: { n: [n[0], n[1], n[2]], w: n[0] * verts[0][0] + n[1] * verts[0][1] + n[2] * verts[0][2] }
    };
    return poly;
  }
  function flipPoly(poly) {
    poly.verts.reverse();
    poly.plane.n[0] *= -1; poly.plane.n[1] *= -1; poly.plane.n[2] *= -1;
    poly.plane.w *= -1;
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function classify(plane, v) {
    var t = dot3(plane.n, v) - plane.w;
    return t < -CSG_EPS ? 2 : t > CSG_EPS ? 1 : 0;   /* 0 共面 / 1 前 / 2 后 */
  }
  function splitPoly(plane, poly, coFront, coBack, front, back) {
    var types = [], polyType = 0;
    for (var i = 0; i < poly.verts.length; i++) {
      var t = classify(plane, poly.verts[i]);
      types.push(t);
      polyType |= t;
    }
    if (polyType === 0) {
      (dot3(plane.n, poly.plane.n) > 0 ? coFront : coBack).push(poly);
    } else if (polyType === 1) {
      front.push(poly);
    } else if (polyType === 2) {
      back.push(poly);
    } else {
      var f = [], b = [];
      for (var j = 0; j < poly.verts.length; j++) {
        var ti = types[j], tj = types[(j + 1) % poly.verts.length];
        var vi = poly.verts[j], vj = poly.verts[(j + 1) % poly.verts.length];
        if (ti !== 2) f.push(vi);
        if (ti !== 1) b.push(vi);
        if ((ti | tj) === 3) {
          var denom = dot3(plane.n, [vj[0] - vi[0], vj[1] - vi[1], vj[2] - vi[2]]) || 1e-12;
          var tt = (plane.w - dot3(plane.n, vi)) / denom;
          var vv = [vi[0] + (vj[0] - vi[0]) * tt, vi[1] + (vj[1] - vi[1]) * tt, vi[2] + (vj[2] - vi[2]) * tt];
          f.push(vv); b.push(vv);
        }
      }
      if (f.length >= 3) front.push(makePoly(f, poly.slot, plane));
      if (b.length >= 3) back.push(makePoly(b, poly.slot, plane));
    }
  }
  function CsgNode(polys) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polys && polys.length) this.build(polys);
  }
  CsgNode.prototype.build = function (polys) {
    if (!polys.length) return;
    if (!this.plane) this.plane = { n: polys[0].plane.n.slice(), w: polys[0].plane.w };
    var front = [], back = [];
    for (var i = 0; i < polys.length; i++) splitPoly(this.plane, polys[i], this.polygons, this.polygons, front, back);
    if (front.length) {
      if (!this.front) this.front = new CsgNode();
      this.front.build(front);
    }
    if (back.length) {
      if (!this.back) this.back = new CsgNode();
      this.back.build(back);
    }
  };
  CsgNode.prototype.invert = function () {
    for (var i = 0; i < this.polygons.length; i++) flipPoly(this.polygons[i]);
    if (this.plane) { this.plane.n[0] *= -1; this.plane.n[1] *= -1; this.plane.n[2] *= -1; this.plane.w *= -1; }
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    var tmp = this.front; this.front = this.back; this.back = tmp;
  };
  CsgNode.prototype.clipPolygons = function (polys) {
    if (!this.plane) return polys.slice();
    var front = [], back = [];
    for (var i = 0; i < polys.length; i++) splitPoly(this.plane, polys[i], front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    if (this.back) back = this.back.clipPolygons(back); else back = [];
    return front.concat(back);
  };
  CsgNode.prototype.clipTo = function (bsp) {
    if (!this.plane) return;
    if (this.front) this.front.clipTo(bsp);
    if (this.back) this.back.clipTo(bsp);
    this.polygons = bsp.clipPolygons(this.polygons);
  };
  CsgNode.prototype.allPolygons = function () {
    var out = this.polygons.slice();
    if (this.front) out = out.concat(this.front.allPolygons());
    if (this.back) out = out.concat(this.back.allPolygons());
    return out;
  };

  function meshToPolys(mesh) {
    var polys = [];
    for (var f = 0; f < mesh.faceIds.length; f++) {
      var s0 = mesh.faceOffsets[f], e0 = mesh.faceOffsets[f + 1];
      var n = e0 - s0;
      if (n < 3) continue;
      var v0 = mesh.faceIndices[s0] * 3, v1 = mesh.faceIndices[s0 + 1] * 3, v2 = mesh.faceIndices[s0 + 2] * 3;
      var p0 = [mesh.positions[v0], mesh.positions[v0 + 1], mesh.positions[v0 + 2]];
      var p1 = [mesh.positions[v1], mesh.positions[v1 + 1], mesh.positions[v1 + 2]];
      var p2 = [mesh.positions[v2], mesh.positions[v2 + 1], mesh.positions[v2 + 2]];
      var nrm = polyNormal({ verts: [p0, p1, p2] });
      var plane = { n: nrm, w: dot3(nrm, p0) };
      /* 扇形三角化，保证进入 BSP 的都是凸多边形 */
      for (var k = 1; k + 1 < n; k++) {
        var a = mesh.faceIndices[s0 + k] * 3, b = mesh.faceIndices[s0 + k + 1] * 3;
        var pa = [mesh.positions[a], mesh.positions[a + 1], mesh.positions[a + 2]];
        var pb = [mesh.positions[b], mesh.positions[b + 1], mesh.positions[b + 2]];
        var tri = makePoly([p0, pa, pb], mesh.faceSlots[f], plane);
        if (tri) polys.push(tri);
      }
    }
    return polys;
  }

  function polysToMesh(polys) {
    var M = meshCore();
    var out = M.create();
    out.positions = [];
    out.vertexIds = [];
    out.faceOffsets = [0];
    out.faceIndices = [];
    out.faceIds = [];
    out.faceSlots = [];
    out.uvs = [];
    out.rawIndices = [];
    var weld = Object.create(null);
    var count = 0;
    for (var i = 0; i < polys.length; i++) {
      var poly = polys[i];
      var verts = [], uniq = Object.create(null), degen = false;
      for (var k = 0; k < poly.verts.length; k++) {
        var v = poly.verts[k];
        var key = Math.round(v[0] * 1e5) + ',' + Math.round(v[1] * 1e5) + ',' + Math.round(v[2] * 1e5);
        var dense = weld[key];
        if (dense == null) {
          dense = out.positions.length / 3;
          weld[key] = dense;
          out.positions.push(v[0], v[1], v[2]);
          out.vertexIds.push(dense + 1);
        }
        if (uniq[dense]) { degen = true; break; }
        uniq[dense] = 1;
        verts.push(dense);
      }
      if (degen || verts.length < 3) continue;
      pushFaceRaw(out, out, -1, verts, out.nextFaceId++, null, poly.slot);
      count++;
    }
    if (!count) return null;
    out.nextVertexId = out.positions.length / 3 + 1;
    M.bump(out);
    return out;
  }

  /* ---------------- 环切（loop cut，专业四边环） ----------------
   * 只在「全四边」的边环上工作：遇到三角 / n 边面、网格边界或非流形就拒绝，
   * 避免在 n 边面上留下 T 形接点（Blender 的 loop cut 也以四边环为前提）。
   * 环 = 从起点边出发，在每张四边面里走到「对面边」，再跨到相邻面，两个方向各走一趟。
   * 每条环边按 t 插点，每张四边面切成 count+1 个四边面。
   * UV 按面角逐面插值（face-varying），UV 缝两侧各自的坐标都保持正确。 */
  function idsPairKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }

  function quadView(mesh, f, aId, bId) {
    var s = mesh.faceOffsets[f];
    var n = mesh.faceOffsets[f + 1] - s;
    if (n !== 4) return null;
    var ids = [], corners = [], k;
    for (k = 0; k < 4; k++) {
      corners.push(s + k);
      ids.push(mesh.vertexIds[mesh.faceIndices[s + k]]);
    }
    for (var i = 0; i < 4; i++) {
      var u = ids[i], v = ids[(i + 1) % 4];
      if ((u === aId && v === bId) || (u === bId && v === aId)) {
        var oi = [], ov = [];
        for (k = 0; k < 4; k++) {
          var at = (i + k) % 4;
          oi.push(corners[at]);
          ov.push(ids[at]);
        }
        return { face: f, ids: ov, corners: oi };
      }
    }
    return null;
  }

  /* 从一张面出发沿「对面边」走半个环；closed=绕回走过的面，nextFace<0=到达网格边界 */
  function walkRingHalf(mesh, byKey, startFace, aId, bId) {
    var cur = quadView(mesh, startFace, aId, bId);
    if (!cur) return null;
    var faces = [], seen = Object.create(null);
    while (cur) {
      if (seen[cur.face]) return { faces: faces, closed: true };
      seen[cur.face] = 1;
      faces.push(cur);
      var w = cur.ids[2], x = cur.ids[3];
      var rec = byKey[idsPairKey(w, x)];
      if (!rec) return null;
      var nextFace = -1, i;
      for (i = 0; i < rec.faces.length; i++) if (rec.faces[i] !== cur.face) nextFace = rec.faces[i];
      if (nextFace < 0) return { faces: faces, closed: false };
      if (rec.faces.length > 2) return null;                       /* 非流形 */
      if (mesh.faceOffsets[nextFace + 1] - mesh.faceOffsets[nextFace] !== 4) return null;  /* 三角 / n 边 */
      if (seen[nextFace]) return { faces: faces, closed: true };
      var next = quadView(mesh, nextFace, x, w);                   /* 共享边方向必须是 x→w */
      if (!next || next.ids[0] !== x || next.ids[1] !== w) return null;
      cur = next;
    }
    return { faces: faces, closed: true };
  }

  /* 返回 { faces:[面下标], edges:[{aId,bId}]（环方向）, closed }；无法环切返回 null */
  function edgeRing(mesh, aId, bId) {
    var M = meshCore();
    if (!M || !mesh || aId == null || bId == null) return null;
    var tbl = M.ensureEdges(mesh);
    var byKey = Object.create(null), i, rec;
    for (i = 0; i < tbl.edges.length; i++) {
      rec = tbl.edges[i];
      byKey[idsPairKey(rec.aId, rec.bId)] = rec;
    }
    var rec0 = byKey[idsPairKey(aId, bId)];
    if (!rec0 || rec0.faces.length < 1 || rec0.faces.length > 2) return null;
    var halfA = walkRingHalf(mesh, byKey, rec0.faces[0], aId, bId);
    if (!halfA) return null;
    var halfB = null;
    if (rec0.faces.length === 2) {
      halfB = walkRingHalf(mesh, byKey, rec0.faces[1], aId, bId);
      if (!halfB) return null;
    }
    var faces = [], seenF = Object.create(null);
    /* tdir=+1：环方向与全局一致；-1：这半边是反向走的，参数要镜像成 1-t，
     * 否则滑移时两边的切点会在同一条边上错开，切出来的线是折的。 */
    function add(list, dir) {
      for (var j = 0; j < list.length; j++) {
        if (seenF[list[j].face]) continue;
        seenF[list[j].face] = 1;
        list[j].tdir = dir;
        faces.push(list[j]);
      }
    }
    add(halfA.faces, 1);
    if (halfB) add(halfB.faces.slice().reverse(), -1);
    var edges = [], seenE = Object.create(null);
    for (i = 0; i < faces.length; i++) {
      var fr = faces[i];
      var pa = { aId: fr.ids[0], bId: fr.ids[1] };   /* (u,v) */
      var pb = { aId: fr.ids[3], bId: fr.ids[2] };   /* (w,x) 的环方向是 x→w */
      var ka = idsPairKey(pa.aId, pa.bId), kb = idsPairKey(pb.aId, pb.bId);
      if (!seenE[ka]) { seenE[ka] = 1; edges.push(pa); }
      if (!seenE[kb]) { seenE[kb] = 1; edges.push(pb); }
    }
    return { faces: faces, edges: edges, closed: !!(halfA.closed || (halfB && halfB.closed)) };
  }

  function loopCut(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh) return null;
    opts = opts || {};
    var count = Math.round(Number(opts.count) || 1);
    count = Math.max(1, Math.min(8, count));
    var slide = Number(opts.slide);
    if (!isFinite(slide)) slide = 0;
    slide = Math.max(-1, Math.min(1, slide));

    var aId = Number(opts.aId), bId = Number(opts.bId);
    if (!isFinite(aId) || !isFinite(bId)) return null;
    var ring = edgeRing(mesh, aId, bId);
    if (!ring || !ring.faces.length) return null;

    /* 切点参数：均匀分布后整体滑移；滑移按两端剩余空间限幅，保证切点顺序不交叉 */
    var base = [], ts = [], i;
    for (i = 0; i < count; i++) base.push((i + 1) / (count + 1));
    var shift = slide > 0 ? slide * (0.99 - base[count - 1]) : slide * (base[0] - 0.01);
    for (i = 0; i < count; i++) ts.push(Math.max(0.01, Math.min(0.99, base[i] + shift)));

    var out = M.create();
    out.nextVertexId = mesh.nextVertexId;
    out.nextFaceId = mesh.nextFaceId;
    out.positions = mesh.positions.slice();
    out.vertexIds = mesh.vertexIds.slice();
    out.faceOffsets = [0];
    out.uvs = [];
    out.rawIndices = [];
    out.faceIndices = [];
    out.faceIds = [];
    out.faceSlots = [];
    if (mesh.uvSeams) Object.keys(mesh.uvSeams).forEach(function (k) { out.uvSeams[k] = 1; });

    var idxById = Object.create(null);
    for (i = 0; i < mesh.vertexIds.length; i++) idxById[mesh.vertexIds[i]] = i;

    /* 环边 → 每个切点一个共享新顶点：位置只算一次，UV 各面自己插值 */
    var splits = Object.create(null);
    function splitAt(e, k, t) {
      var key = idsPairKey(e.aId, e.bId);
      var arr = splits[key] || (splits[key] = []);
      if (arr[k] != null) return arr[k];
      var ai = idxById[e.aId], bi = idxById[e.bId];
      var vi = out.vertexIds.length;
      out.vertexIds.push(out.nextVertexId++);
      out.positions.push(
        mesh.positions[ai * 3] + (mesh.positions[bi * 3] - mesh.positions[ai * 3]) * t,
        mesh.positions[ai * 3 + 1] + (mesh.positions[bi * 3 + 1] - mesh.positions[ai * 3 + 1]) * t,
        mesh.positions[ai * 3 + 2] + (mesh.positions[bi * 3 + 2] - mesh.positions[ai * 3 + 2]) * t
      );
      arr[k] = vi;
      return vi;
    }
    function uvOf(c) {
      if (!mesh.uvs || mesh.uvs.length !== mesh.faceIndices.length * 2) return [0, 0];
      return [mesh.uvs[c * 2] || 0, mesh.uvs[c * 2 + 1] || 0];
    }
    function lerpUV(c0, c1, t) {
      var a = uvOf(c0), b = uvOf(c1);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    function pushFace(indices, uvs, fid, slot) {
      var q, w2;
      for (q = 0; q < indices.length; q++) out.faceIndices.push(indices[q]);
      out.faceOffsets.push(out.faceIndices.length);
      out.faceIds.push(fid);
      out.faceSlots.push(slot != null ? slot : 0);
      var base = out.faceIndices.length - indices.length;
      for (w2 = 0; w2 < uvs.length; w2++) {
        /* 角号指向本网格自己的 uvs，后续算子抄 UV 才不会抄到 0 */
        out.rawIndices.push(base + w2);
        out.uvs.push(uvs[w2][0], uvs[w2][1]);
      }
    }

    var ringFace = Object.create(null);
    for (i = 0; i < ring.faces.length; i++) ringFace[ring.faces[i].face] = ring.faces[i];

    for (var f = 0; f < mesh.faceIds.length; f++) {
      var fr = ringFace[f];
      if (!fr) {
        var s0 = mesh.faceOffsets[f], e0 = mesh.faceOffsets[f + 1];
        var verts = [], uvs2 = [];
        for (i = s0; i < e0; i++) { verts.push(mesh.faceIndices[i]); uvs2.push(uvOf(i)); }
        pushFace(verts, uvs2, mesh.faceIds[f], mesh.faceSlots[f]);
        continue;
      }
      var c0 = fr.corners[0], c1 = fr.corners[1], c2 = fr.corners[2], c3 = fr.corners[3];
      var uIdx = mesh.faceIndices[c0], vIdx = mesh.faceIndices[c1];
      var wIdx = mesh.faceIndices[c2], xIdx = mesh.faceIndices[c3];
      var eUV = { aId: fr.ids[0], bId: fr.ids[1] };
      var eWX = { aId: fr.ids[3], bId: fr.ids[2] };
      var P = [], Q = [], uvP = [], uvQ = [];
      var uvC0 = uvOf(c0), uvC1 = uvOf(c1), uvC2 = uvOf(c2), uvC3 = uvOf(c3);
      for (i = 0; i < count; i++) {
        var tt = fr.tdir < 0 ? 1 - ts[i] : ts[i];
        P.push(splitAt(eUV, i, tt));
        Q.push(splitAt(eWX, i, tt));
        uvP.push(lerpUV(c0, c1, tt));
        uvQ.push(lerpUV(c3, c2, tt));
      }
      var slot = mesh.faceSlots[f];
      /* 首段沿用原面 ID，其余段领新 ID（选择 / 历史都能对上原来的面） */
      pushFace([uIdx, P[0], Q[0], xIdx], [uvC0, uvP[0], uvQ[0], uvC3], mesh.faceIds[f], slot);
      for (i = 1; i < count; i++) {
        pushFace([P[i - 1], P[i], Q[i], Q[i - 1]],
          [uvP[i - 1], uvP[i], uvQ[i], uvQ[i - 1]], out.nextFaceId++, slot);
      }
      pushFace([P[count - 1], vIdx, wIdx, Q[count - 1]],
        [uvP[count - 1], uvC1, uvC2, uvQ[count - 1]], out.nextFaceId++, slot);
    }

    M.bump(out);
    return out;
  }

  /* 三角转四边（Tris to Quads）
   * 判据复用导入时的 Mesh.mergeQuads：共享边两侧都是三角面、同一材质槽、
   * 合并后是凸四边形、共享顶点 UV 一致，并且「共面 ≤ tolDeg」或「UV 成 2×2 矩形」。
   * 默认 40° 对齐 Blender 的 tris_to_quads：曲面上相邻三角也能并，
   * 但 UV 接缝（两端 UV 不一致）会被拒绝，不会把贴图压成畸变四边形。
   * 一对都并不上时返回 null —— 外壳据此提示「没有可合并的三角面」，而不是静默成功。 */
  function trisToQuads(mesh, opts) {
    var M = meshCore();
    if (!M || !mesh || !mesh.faceIds.length) return null;
    opts = opts || {};
    var out = M.clone(mesh);
    var before = out.faceIds.length;
    M.mergeQuads(out, {
      tolDeg: opts.tolDeg != null ? Number(opts.tolDeg) : 40,
      uv: opts.uv !== false
    });
    if (out.faceIds.length >= before) return null;
    M.bump(out);
    return out;
  }

  /* op: union / intersect / subtract */
  function booleanMeshes(meshA, meshB, op) {
    var M = meshCore();
    if (!M || !meshA || !meshB) return null;
    var pa = meshToPolys(meshA), pb = meshToPolys(meshB);
    if (!pa.length || !pb.length) return null;
    var A = new CsgNode(pa), B = new CsgNode(pb);
    if (op === 'union') {
      A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert();
      A.build(B.allPolygons());
    } else if (op === 'intersect') {
      A.invert(); B.clipTo(A); B.invert(); A.clipTo(B); B.clipTo(A);
      A.build(B.allPolygons()); A.invert();
    } else {
      A.invert(); A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert();
      A.build(B.allPolygons()); A.invert();
    }
    var polys = A.allPolygons();
    if (!polys.length || polys.length > 40000) return null;
    return polysToMesh(polys);
  }

  global.SeedOps = {
    edgeRing: edgeRing,
    loopCut: loopCut,
    trisToQuads: trisToQuads,
    extrudeFaces: extrudeFaces,
    insetFaces: insetFaces,
    deleteFaces: deleteFaces,
    mergeVertices: mergeVertices,
    smoothVertices: smoothVertices,
    bevelFaces: bevelFaces,
    bridgeFaces: bridgeFaces,
    subdivideFaces: subdivideFaces,
    connectVertices: connectVertices,
    targetWeld: targetWeld,
    createQuadFace: createQuadFace,
    splitLooseParts: splitLooseParts,
    knifePlaneCut: knifePlaneCut,
    booleanMeshes: booleanMeshes
  };
})(typeof window !== 'undefined' ? window : this);
