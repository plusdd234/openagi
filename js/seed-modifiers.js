/* 修改器（数据层，M7）
 *
 * 一批纯函数：拿 mesh + 参数 → 返回**新 mesh**（绝不原地改 base）。
 * 求值顺序由 evaluator 负责，这里只管单个修改器怎么算。
 *
 * ID 为什么这么派生：
 *   每次求值都会重建整份网格，如果用随机数 / 全局自增，同样的输入两次求值会得到
 *   不同 ID，选择集、撤销、外部引用全部失效。所以：
 *     - subdivision：原顶点沿用旧 vertexId；边点 / 面点按「排序后的顶点 ID、面 ID」
 *       顺序分配，与面遍历顺序无关；
 *     - mirror：原顶点沿用旧 ID，镜像顶点从 nextVertexId 起递增；
 *     - solidify：外壳沿用旧 ID，内壳按原顶点下标顺序追加。
 *   面 ID 同样派生自父面 ID（subdivision 用 parent*4+k，其余用 nextFaceId 追加）。
 *
 * 不支持的东西（宁可明确拒绝，也不静默产出坏网格）：
 *   - 不做布尔运算 / 自交修复；solidify 只沿顶点法线偏移，凹角可能自穿；
 *   - mirror 不做裁剪（几何已经跨过镜面时会重叠）；缝上只焊接平面附近的点；
 *   - subdivision 不重算 UV 缝（uvSeams 清空，UV 按父面角插值保留）。
 *
 * 对外（window.SeedModifiers）：
 *   subdivision(mesh, opts) / mirror(mesh, opts) / solidify(mesh, opts)
 *   apply(mesh, stack) / isActive(item)
 */
(function (global) {
  'use strict';

  function meshApi() { return (global.SeedModel && global.SeedModel.Mesh) || null; }

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* 参数可能平铺，也可能放在 params 里；两种都认，顶层优先 */
  function paramsOf(item) {
    var o = isObj(item) ? item : {};
    var p = isObj(o.params) ? o.params : null;
    if (!p) return o;
    var merged = Object.create(null);
    var k;
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) merged[k] = p[k];
    for (k in o) if (k !== 'params' && Object.prototype.hasOwnProperty.call(o, k)) merged[k] = o[k];
    return merged;
  }

  function pick(o, keys, d) {
    for (var i = 0; i < keys.length; i++) {
      if (o[keys[i]] != null) return o[keys[i]];
    }
    return d;
  }

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function levelOf(item) {
    var n = Math.round(num(pick(paramsOf(item), ['level', 'levels', 'subdivisionLevel', 'value'], 1), 1));
    /* 规格只支持 1–3；越界直接夹住，避免上层传 0 得到一个「看起来没生效」的复印件 */
    return Math.max(1, Math.min(3, n));
  }

  function axisOf(item) {
    var v = pick(paramsOf(item), ['axis', 'mirrorAxis', 'direction'], 'x');
    if (typeof v === 'number') return Math.max(0, Math.min(2, Math.round(v)));
    var s = String(v || 'x').toLowerCase();
    if (s === 'y' || s === '1') return 1;
    if (s === 'z' || s === '2') return 2;
    return 0;
  }

  function mergeOf(item) {
    var v = num(pick(paramsOf(item), ['merge', 'threshold', 'weld', 'mergeThreshold'], 0.001), 0.001);
    return v > 0 ? v : 0;
  }

  function thicknessOf(item) {
    return num(pick(paramsOf(item), ['thickness', 'amount', 'dist'], 0.02), 0.02);
  }

  function offsetOf(item) {
    var n = num(pick(paramsOf(item), ['offset', 'offsetFactor'], -1), -1);
    return Math.max(-1, Math.min(1, n));
  }

  function maxIdOf(mesh) {
    var m = -1;
    for (var i = 0; i < mesh.vertexIds.length; i++) if (mesh.vertexIds[i] > m) m = mesh.vertexIds[i];
    return m;
  }

  function faceMaxIdOf(mesh) {
    var m = -1;
    for (var i = 0; i < mesh.faceIds.length; i++) if (mesh.faceIds[i] > m) m = mesh.faceIds[i];
    return m;
  }

  function addVertex(out, x, y, z, id) {
    out.positions.push(x, y, z);
    out.vertexIds.push(id);
    return out.vertexIds.length - 1;
  }

  function addFace(out, verts, uvs, id, slot) {
    for (var i = 0; i < verts.length; i++) out.faceIndices.push(verts[i]);
    if (uvs) for (var k = 0; k < uvs.length; k++) out.uvs.push(uvs[k]);
    out.faceOffsets.push(out.faceIndices.length);
    out.faceIds.push(id);
    out.faceSlots.push(slot || 0);
    return out.faceIds.length - 1;
  }

  /* ---------------- 细分 ----------------
   * Catmull-Clark：每个 n 边形 → n 个四边形，面数 = Σn，顶点数 = V + E + F。
   * 用线性细分也能得到同样的拓扑，但曲面会保持折角；那只是「插点」，不是细分。
   * 边界点走 CC 的边界规则（0.75P + 0.125(P_prev + P_next)），否则开放平面会向内塌。 */
  function subdivision(mesh, opts) {
    var M = meshApi();
    if (!M || !mesh) return null;
    var level = levelOf(opts);
    var cur = mesh;
    for (var i = 0; i < level; i++) cur = subdivideOnce(cur);
    return cur || mesh;
  }

  function subdivideOnce(mesh) {
    var M = meshApi();
    var pos = mesh.positions, idx = mesh.faceIndices, off = mesh.faceOffsets, ids = mesh.vertexIds;
    var vCount = ids.length, fCount = mesh.faceIds.length;
    var hasUV = M.hasUV(mesh);

    /* 先算总面数：超过上限就明确失败，别让一次 level=3 把页面卡死 */
    var outFaceCount = 0;
    for (var q = 0; q < fCount; q++) outFaceCount += off[q + 1] - off[q];
    if (outFaceCount > M.MAX_FACES) {
      throw new Error('subdivision 会得到 ' + outFaceCount + ' 面，超过上限 ' + M.MAX_FACES);
    }

    var facePts = new Array(fCount * 3);
    var faceUVs = hasUV ? new Array(fCount * 2) : null;
    var vf = new Array(vCount);
    for (var i = 0; i < vCount; i++) vf[i] = null;

    var f, s, e, n, k, ci, vi;
    for (f = 0; f < fCount; f++) {
      s = off[f]; e = off[f + 1]; n = e - s;
      var cx = 0, cy = 0, cz = 0, cu = 0, cv = 0;
      for (k = 0; k < n; k++) {
        ci = s + k;
        vi = idx[ci] * 3;
        cx += pos[vi]; cy += pos[vi + 1]; cz += pos[vi + 2];
        if (hasUV) { cu += mesh.uvs[ci * 2] || 0; cv += mesh.uvs[ci * 2 + 1] || 0; }
        var vInFace = idx[ci];
        if (!vf[vInFace]) vf[vInFace] = [];
        vf[vInFace].push(f);
      }
      var d = n || 1;
      facePts[f * 3] = cx / d;
      facePts[f * 3 + 1] = cy / d;
      facePts[f * 3 + 2] = cz / d;
      if (hasUV) { faceUVs[f * 2] = cu / d; faceUVs[f * 2 + 1] = cv / d; }
    }

    /* 边表：用顶点 ID 的规范组合做 key（下标会随拓扑变，ID 不会） */
    var edgeMap = Object.create(null), edgeList = [];
    var ve = new Array(vCount);
    for (i = 0; i < vCount; i++) ve[i] = null;

    for (f = 0; f < fCount; f++) {
      s = off[f]; e = off[f + 1]; n = e - s;
      for (k = 0; k < n; k++) {
        var a = idx[s + k], b = idx[s + ((k + 1) % n)];
        var ida = ids[a], idb = ids[b];
        var key = ida < idb ? ida + '_' + idb : idb + '_' + ida;
        var rec = edgeMap[key];
        if (!rec) {
          rec = { a: a, b: b, lo: Math.min(ida, idb), hi: Math.max(ida, idb), faces: [], newIndex: -1, newId: -1 };
          edgeMap[key] = rec;
          edgeList.push(rec);
        }
        rec.faces.push(f);
        if (!ve[a]) ve[a] = [];
        ve[a].push(rec);
        if (!ve[b]) ve[b] = [];
        ve[b].push(rec);
      }
    }

    /* 边点按 (lo, hi) 排序后分配 ID：与面的遍历顺序无关，重复求值结果一致 */
    edgeList.sort(function (x, y) { return (x.lo - y.lo) || (x.hi - y.hi); });
    var idStart = Math.max(mesh.nextVertexId || 0, maxIdOf(mesh) + 1);
    for (i = 0; i < edgeList.length; i++) {
      edgeList[i].newIndex = vCount + i;
      edgeList[i].newId = idStart + i;
    }

    /* 面点按面 ID 排序分配：面被重新排序不会把 ID 洗牌 */
    var faceOrder = [];
    for (f = 0; f < fCount; f++) faceOrder.push(f);
    faceOrder.sort(function (x, y) { return mesh.faceIds[x] - mesh.faceIds[y]; });
    var faceOrd = new Array(fCount);
    for (i = 0; i < faceOrder.length; i++) faceOrd[faceOrder[i]] = i;
    var facePointIndex = new Array(fCount);
    for (f = 0; f < fCount; f++) facePointIndex[f] = vCount + edgeList.length + faceOrd[f];

    var out = M.create();

    /* 1. 原顶点：新位置按 CC 规则算，但 ID 一个都不换 */
    for (var v = 0; v < vCount; v++) {
      var px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
      var incE = ve[v] || [];
      var incF = vf[v] || [];
      var onBoundary = false;
      var b0 = -1, b1 = -1, bc = 0;
      for (i = 0; i < incE.length; i++) {
        if (incE[i].faces.length === 1) {
          onBoundary = true;
          var other = incE[i].a === v ? incE[i].b : incE[i].a;
          if (bc === 0) b0 = other; else if (bc === 1) b1 = other;
          bc += 1;
        }
      }
      if (onBoundary) {
        if (bc === 2) {
          px = 0.75 * px + 0.125 * (pos[b0 * 3] + pos[b1 * 3]);
          py = 0.75 * py + 0.125 * (pos[b0 * 3 + 1] + pos[b1 * 3 + 1]);
          pz = 0.75 * pz + 0.125 * (pos[b0 * 3 + 2] + pos[b1 * 3 + 2]);
        }
      } else if (incF.length && incE.length) {
        var nv = incE.length;
        var fx = 0, fy = 0, fz = 0;
        for (i = 0; i < incF.length; i++) {
          fx += facePts[incF[i] * 3]; fy += facePts[incF[i] * 3 + 1]; fz += facePts[incF[i] * 3 + 2];
        }
        fx /= incF.length; fy /= incF.length; fz /= incF.length;
        var rx = 0, ry = 0, rz = 0;
        for (i = 0; i < incE.length; i++) {
          var oth = incE[i].a === v ? incE[i].b : incE[i].a;
          rx += (px + pos[oth * 3]) * 0.5;
          ry += (py + pos[oth * 3 + 1]) * 0.5;
          rz += (pz + pos[oth * 3 + 2]) * 0.5;
        }
        rx /= incE.length; ry /= incE.length; rz /= incE.length;
        px = (fx + 2 * rx + (nv - 3) * px) / nv;
        py = (fy + 2 * ry + (nv - 3) * py) / nv;
        pz = (fz + 2 * rz + (nv - 3) * pz) / nv;
      }
      addVertex(out, px, py, pz, ids[v]);
    }

    /* 2. 边点：内部边 = 两端点 + 两侧面点求平均；边界边取中点 */
    for (i = 0; i < edgeList.length; i++) {
      var er = edgeList[i];
      var ax = pos[er.a * 3], ay = pos[er.a * 3 + 1], az = pos[er.a * 3 + 2];
      var bx = pos[er.b * 3], by = pos[er.b * 3 + 1], bz = pos[er.b * 3 + 2];
      var ex, ey, ez;
      if (er.faces.length < 2) {
        ex = (ax + bx) * 0.5; ey = (ay + by) * 0.5; ez = (az + bz) * 0.5;
      } else {
        var sumX = ax + bx, sumY = ay + by, sumZ = az + bz;
        for (k = 0; k < er.faces.length; k++) {
          sumX += facePts[er.faces[k] * 3];
          sumY += facePts[er.faces[k] * 3 + 1];
          sumZ += facePts[er.faces[k] * 3 + 2];
        }
        var dd = 2 + er.faces.length;
        ex = sumX / dd; ey = sumY / dd; ez = sumZ / dd;
      }
      addVertex(out, ex, ey, ez, er.newId);
    }

    /* 3. 面点 */
    for (i = 0; i < faceOrder.length; i++) {
      f = faceOrder[i];
      addVertex(out, facePts[f * 3], facePts[f * 3 + 1], facePts[f * 3 + 2],
        idStart + edgeList.length + i);
    }

    /* 4. 面：每个角长一个四边形，绕序与父面一致（法线不会被翻） */
    var maxFid = -1;
    for (f = 0; f < fCount; f++) {
      s = off[f]; e = off[f + 1]; n = e - s;
      var pid = mesh.faceIds[f];
      var slot = mesh.faceSlots[f];
      for (k = 0; k < n; k++) {
        var v0 = idx[s + k];
        var vNext = idx[s + ((k + 1) % n)];
        var vPrev = idx[s + ((k + n - 1) % n)];
        var ida0 = ids[v0], idb0 = ids[vNext], idp0 = ids[vPrev];
        var kNext = ida0 < idb0 ? ida0 + '_' + idb0 : idb0 + '_' + ida0;
        var kPrev = idp0 < ida0 ? idp0 + '_' + ida0 : ida0 + '_' + idp0;
        var eNext = edgeMap[kNext], ePrev = edgeMap[kPrev];
        var quad = [v0, eNext.newIndex, facePointIndex[f], ePrev.newIndex];
        var quv = null;
        if (hasUV) {
          ci = s + k;
          var u0 = mesh.uvs[ci * 2] || 0, w0 = mesh.uvs[ci * 2 + 1] || 0;
          var cNext = s + ((k + 1) % n), cPrev = s + ((k + n - 1) % n);
          quv = [
            u0, w0,
            (u0 + (mesh.uvs[cNext * 2] || 0)) * 0.5, (w0 + (mesh.uvs[cNext * 2 + 1] || 0)) * 0.5,
            faceUVs[f * 2], faceUVs[f * 2 + 1],
            (u0 + (mesh.uvs[cPrev * 2] || 0)) * 0.5, (w0 + (mesh.uvs[cPrev * 2 + 1] || 0)) * 0.5
          ];
        }
        var fid = pid * 4 + k;
        if (fid > maxFid) maxFid = fid;
        addFace(out, quad, quv, fid, slot);
      }
    }

    out.nextVertexId = idStart + edgeList.length + fCount;
    out.nextFaceId = maxFid + 1;
    M.bump(out);
    return out;
  }

  /* ---------------- 镜像 ----------------
   * 复制一份几何、按轴翻转坐标，并把绕序反向 —— 否则镜像半边整块朝里，渲染出来发黑。
   * 镜面附近的点先吸到平面上再复用同一个坐标，这样两半在缝上是一个点而不是两个。 */
  function mirror(mesh, opts) {
    var M = meshApi();
    if (!M || !mesh) return null;
    var axis = axisOf(opts);
    var merge = mergeOf(opts);
    var vCount = mesh.vertexIds.length;
    var fCount = mesh.faceIds.length;
    if (fCount * 2 > M.MAX_FACES) {
      throw new Error('mirror 会得到 ' + (fCount * 2) + ' 面，超过上限 ' + M.MAX_FACES);
    }
    var hasUV = M.hasUV(mesh);
    var out = M.create();

    var idStart = Math.max(mesh.nextVertexId || 0, maxIdOf(mesh) + 1);
    var map = new Array(vCount);
    var seam = Object.create(null);
    var i, k;

    /* 1. 原件顶点：镜面附近的坐标归零；同一位置只留一个点（这是「焊接」的实现） */
    for (i = 0; i < vCount; i++) {
      var x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
      var c = axis === 0 ? x : axis === 1 ? y : z;
      var onSeam = Math.abs(c) <= merge;
      if (onSeam) {
        if (axis === 0) x = 0; else if (axis === 1) y = 0; else z = 0;
        var sk = Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5);
        if (seam[sk] != null) {
          map[i] = seam[sk];
          continue;
        }
        map[i] = addVertex(out, x, y, z, mesh.vertexIds[i]);
        seam[sk] = map[i];
        continue;
      }
      map[i] = addVertex(out, x, y, z, mesh.vertexIds[i]);
    }

    /* 2. 镜像顶点：缝上的点直接复用，其余新建并分配 nextVertexId 起始的 ID */
    var mirrorMap = new Array(vCount);
    var nextVid = idStart;
    for (i = 0; i < vCount; i++) {
      var mx = mesh.positions[i * 3], my = mesh.positions[i * 3 + 1], mz = mesh.positions[i * 3 + 2];
      var mc = axis === 0 ? mx : axis === 1 ? my : mz;
      if (Math.abs(mc) <= merge) {
        mirrorMap[i] = map[i];
        continue;
      }
      if (axis === 0) mx = -mx; else if (axis === 1) my = -my; else mz = -mz;
      mirrorMap[i] = addVertex(out, mx, my, mz, nextVid++);
    }

    /* 3. 原件面：顶点下标要过 map（缝上可能有多个旧点并成一个） */
    for (var f = 0; f < fCount; f++) {
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      var loop = [], uvs = [];
      for (k = s; k < e; k++) {
        loop.push(map[mesh.faceIndices[k]]);
        if (hasUV) uvs.push(mesh.uvs[k * 2] || 0, mesh.uvs[k * 2 + 1] || 0);
      }
      addFace(out, loop, hasUV ? uvs : null, mesh.faceIds[f], mesh.faceSlots[f]);
    }

    /* 4. 镜像面：绕序反向；UV 跟着角一起反，否则贴图在镜像半边会左右颠倒 */
    var mirrorFaceBase = Math.max(mesh.nextFaceId || 0, faceMaxIdOf(mesh) + 1);
    for (f = 0; f < fCount; f++) {
      var s2 = mesh.faceOffsets[f], e2 = mesh.faceOffsets[f + 1];
      var loop2 = [], uvs2 = [];
      for (k = e2 - 1; k >= s2; k--) {
        loop2.push(mirrorMap[mesh.faceIndices[k]]);
        if (hasUV) uvs2.push(mesh.uvs[k * 2] || 0, mesh.uvs[k * 2 + 1] || 0);
      }
      addFace(out, loop2, hasUV ? uvs2 : null, mirrorFaceBase + f, mesh.faceSlots[f]);
    }

    out.nextVertexId = nextVid;
    out.nextFaceId = mirrorFaceBase + fCount;
    M.bump(out);
    return out;
  }

  /* 面法线（Newell）：多边形可能不共面，用前三点算叉积会漏掉后半段的扭转 */
  function faceNormal(mesh, f, out) {
    var P = mesh.positions, s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1], n = e - s;
    var nx = 0, ny = 0, nz = 0;
    for (var k = 0; k < n; k++) {
      var a = mesh.faceIndices[s + k] * 3;
      var b = mesh.faceIndices[s + ((k + 1) % n)] * 3;
      var ax = P[a], ay = P[a + 1], az = P[a + 2];
      var bx = P[b], by = P[b + 1], bz = P[b + 2];
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    out[0] = nx; out[1] = ny; out[2] = nz;
    return out;
  }

  /* 顶点法线：把相邻面的 Newell 法线（带面积权重）加起来再归一化 */
  function vertexNormals(mesh) {
    var P = mesh.positions, vCount = mesh.vertexIds.length;
    var acc = new Array(vCount * 3);
    for (var i = 0; i < acc.length; i++) acc[i] = 0;
    var nrm = [0, 0, 0];
    for (var f = 0; f < mesh.faceIds.length; f++) {
      if (!faceNormal(mesh, f, nrm)) continue;
      var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
      for (var k = s; k < e; k++) {
        var v = mesh.faceIndices[k];
        acc[v * 3] += nrm[0];
        acc[v * 3 + 1] += nrm[1];
        acc[v * 3 + 2] += nrm[2];
      }
    }
    var out = new Array(vCount * 3);
    for (var j = 0; j < vCount; j++) {
      var x = acc[j * 3], y = acc[j * 3 + 1], z = acc[j * 3 + 2];
      var len = Math.sqrt(x * x + y * y + z * z);
      if (len < 1e-12) { out[j * 3] = 0; out[j * 3 + 1] = 0; out[j * 3 + 2] = 0; }
      else { out[j * 3] = x / len; out[j * 3 + 1] = y / len; out[j * 3 + 2] = z / len; }
    }
    return out;
  }

  /* ---------------- 加厚 ----------------
   * 外壳沿用原件（ID / 面 ID 都不变），内壳复制一份并反向绕序（法线朝里）。
   * offset 用 Blender 的语义：-1 = 只向内加厚（外壳原地），+1 = 只向外，0 = 两侧各一半。
   * 只有开放边界才长侧壁；封闭网格加厚后仍是封闭的，面数正好翻倍。 */
  function solidify(mesh, opts) {
    var M = meshApi();
    if (!M || !mesh) return null;
    var thickness = thicknessOf(opts);
    var offset = offsetOf(opts);
    var vCount = mesh.vertexIds.length;
    var fCount = mesh.faceIds.length;
    var hasUV = M.hasUV(mesh);

    /* 外壳位移与内壳位移都沿顶点法线：offset=-1 时外壳位移为 0 */
    var outerShift = thickness * (offset + 1) * 0.5;
    var innerShift = outerShift - thickness;
    var normals = vertexNormals(mesh);

    /* 先数边界边，超上限时不必白算 */
    var edgeMap = Object.create(null), edgeList = [];
    var f, s, e, n, k, i;
    for (f = 0; f < fCount; f++) {
      s = mesh.faceOffsets[f]; e = mesh.faceOffsets[f + 1]; n = e - s;
      for (k = 0; k < n; k++) {
        var a = mesh.faceIndices[s + k];
        var b = mesh.faceIndices[s + ((k + 1) % n)];
        var ida = mesh.vertexIds[a], idb = mesh.vertexIds[b];
        var key = ida < idb ? ida + '_' + idb : idb + '_' + ida;
        var rec = edgeMap[key];
        if (!rec) {
          rec = { a: a, b: b, f: f, count: 0 };
          edgeMap[key] = rec;
          edgeList.push(rec);
        }
        rec.count += 1;
      }
    }
    var wallRecs = [];
    for (i = 0; i < edgeList.length; i++) if (edgeList[i].count === 1) wallRecs.push(edgeList[i]);
    if (fCount * 2 + wallRecs.length > M.MAX_FACES) {
      throw new Error('solidify 会得到 ' + (fCount * 2 + wallRecs.length) + ' 面，超过上限 ' + M.MAX_FACES);
    }

    var out = M.create();
    /* 1. 外壳顶点：ID 沿用，位置沿法线移动 */
    for (i = 0; i < vCount; i++) {
      var nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
      addVertex(out,
        mesh.positions[i * 3] + nx * outerShift,
        mesh.positions[i * 3 + 1] + ny * outerShift,
        mesh.positions[i * 3 + 2] + nz * outerShift,
        mesh.vertexIds[i]);
    }
    /* 2. 内壳顶点：从 nextVertexId 起排队，内壳下标 = 外壳下标 + vCount */
    var idStart = Math.max(mesh.nextVertexId || 0, maxIdOf(mesh) + 1);
    for (i = 0; i < vCount; i++) {
      var nx2 = normals[i * 3], ny2 = normals[i * 3 + 1], nz2 = normals[i * 3 + 2];
      addVertex(out,
        mesh.positions[i * 3] + nx2 * innerShift,
        mesh.positions[i * 3 + 1] + ny2 * innerShift,
        mesh.positions[i * 3 + 2] + nz2 * innerShift,
        idStart + i);
    }

    /* 3. 外壳面 */
    for (f = 0; f < fCount; f++) {
      s = mesh.faceOffsets[f]; e = mesh.faceOffsets[f + 1];
      var loop = [], uvs = [];
      for (k = s; k < e; k++) {
        loop.push(mesh.faceIndices[k]);
        if (hasUV) uvs.push(mesh.uvs[k * 2] || 0, mesh.uvs[k * 2 + 1] || 0);
      }
      addFace(out, loop, hasUV ? uvs : null, mesh.faceIds[f], mesh.faceSlots[f]);
    }

    /* 4. 内壳面：绕序反向，法线朝里 */
    var innerBase = Math.max(mesh.nextFaceId || 0, faceMaxIdOf(mesh) + 1);
    for (f = 0; f < fCount; f++) {
      s = mesh.faceOffsets[f]; e = mesh.faceOffsets[f + 1];
      var loopI = [], uvsI = [];
      for (k = e - 1; k >= s; k--) {
        loopI.push(mesh.faceIndices[k] + vCount);
        if (hasUV) uvsI.push(mesh.uvs[k * 2] || 0, mesh.uvs[k * 2 + 1] || 0);
      }
      addFace(out, loopI, hasUV ? uvsI : null, innerBase + f, mesh.faceSlots[f]);
    }

    /* 5. 侧壁：沿边界边把外壳与内壳缝起来。绕序取「边界边反向」，法线才朝外 */
    var wallBase = innerBase + fCount;
    for (i = 0; i < wallRecs.length; i++) {
      var w = wallRecs[i];
      /* 绕序取边界边的反向：外壳 a→b 是面内方向，侧壁要朝外就得从 b 出发 */
      var quadW = [w.b, w.a, w.a + vCount, w.b + vCount];
      var uvW = hasUV ? [0, 0, 0, 0, 0, 0, 0, 0] : null;
      addFace(out, quadW, uvW, wallBase + i, mesh.faceSlots[w.f]);
    }

    out.nextVertexId = idStart + vCount;
    out.nextFaceId = wallBase + wallRecs.length;
    M.bump(out);
    return out;
  }

  /* ---------------- 栈 ---------------- */
  function typeOf(item) {
    return String((item && (item.type || item.kind)) || '').toLowerCase();
  }

  function isActive(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.enabled === false || item.enabled === 0) return false;
    var t = typeOf(item);
    return t === 'subdivision' || t === 'subdivide' || t === 'mirror' ||
      t === 'solidify' || t === 'solid';
  }

  function apply(mesh, stack) {
    var out = mesh;
    for (var i = 0; i < (stack || []).length; i++) {
      var item = stack[i];
      if (!isActive(item)) continue;
      var t = typeOf(item);
      if (t === 'subdivision' || t === 'subdivide') out = subdivision(out, item);
      else if (t === 'mirror') out = mirror(out, item);
      else if (t === 'solidify' || t === 'solid') out = solidify(out, item);
    }
    return out;
  }

  global.SeedModifiers = {
    subdivision: subdivision,
    mirror: mirror,
    solidify: solidify,
    apply: apply,
    isActive: isActive
  };
})(typeof window !== 'undefined' ? window : globalThis);
