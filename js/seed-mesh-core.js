/* 可编辑网格内核（架构层 ② mesh-core）
 *
 * 数据结构：face-vertex（顶点数组 + 面偏移 + 面索引），不用 half-edge。
 *   - 顶点：positions（三个一组）、vertexIds（文档级稳定整数 ID，永不复用）
 *   - 面：  faceOffsets（长度 = 面数 + 1，faceOffsets[i] ~ faceOffsets[i+1] 是第 i 面的索引区间）、
 *           faceIndices（每个元素是**顶点数组下标**，不是顶点 ID）、
 *           faceIds（面的稳定整数 ID）、faceSlots（每个面所属材质槽下标）
 *   - 边：  不持久化，按需由 faceIndices 重建（ensureEdges）；边 ID 由两端顶点 ID 规范化组合
 *   - 边 ID：minId * 2^26 + maxId（顶点 ID 上限 2^26，够 1000 万，远超 1 万面场景）
 *
 * 为什么 ID 和下标分开：
 *   拓扑算子会删点删面，数组下标会被压缩、会变；ID 不变。选择集、撤销、外部引用一律存 ID。
 *   mesh 内部用 ID → 下标的映射（ensureEdges 里顺带建 vertexFaces）。
 *
 * 序列化：D1 冻结方案 —— JSON + base64 类型数组，写进 asset.extras.seedModel，
 *   仍然只替换 GLB 的 JSON chunk，不动 BIN。面数硬上限 1 万；P3 再迁 BIN（schema 3）。
 *   base64 里的字节序按平台 TypedArray（所有目标环境都是小端），字段名 storage:'json' 标明来源。
 *
 * 对外（window.SeedModel.Mesh）：
 *   create() / fromBufferGeometry(geo, opts) / append(target, src, opts) / merge(list)
 *   faceVertices(mesh, i) / stats(mesh) / ensureEdges(mesh)
 *   buildGeometry(mesh, opts) / translate(mesh, x, y, z) / bump(mesh)
 *   toJSON(mesh) / fromJSON(obj) / validate(mesh) / byteSize(mesh) / hash(mesh) / clone(mesh)
 */
(function (global) {
  'use strict';

  var M = global.SeedModel = global.SeedModel || {};
  /* 面数上限是「存储 / 撤销」策略的保护线，不是实测性能线：
   * 实测 1.1 万面转换 ~50ms / JSON 1MB；3.5 万面转换 ~170ms / 重建 ~15ms / JSON 3.4MB。
   * 50k 四边形 ≈ 10 万三角；再大的模型要走 P3 的二进制网格存储，而不是继续抬这个数。 */
  var MAX_FACES = 50000;
  var EDGE_STRIDE = 67108864;      // 2^26：边 ID 编码的进位
  var WELD_SCALE = 1e5;            // 焊接量化：1e-5 米

  function create() {
    return {
      /* 顶点 */
      positions: [],               // 平铺 xyz
      vertexIds: [],
      nextVertexId: 0,
      /* 面 */
      faceOffsets: [0],
      faceIndices: [],
      faceIds: [],
      faceSlots: [],
      nextFaceId: 0,
      /* UV：face-varying（每个面角一份），长度 = faceIndices.length * 2。
       * 为什么不用「每顶点一份」：球体经线、UV 接缝处同一个顶点两侧的 UV 不同，
       * 每顶点一份就表达不了接缝，UV 岛无从判定。显示几何暂时不读它（那需要按 UV 拆顶点），
       * 它现在只服务两件事：UV 岛选取、以及将来的贴图 / UV 视图。 */
      uvs: [],
      /* 缓存：不参与序列化 */
      version: 0,
      _geometry: null,
      _geometryVersion: -1,
      _edges: null,
      _edgesVersion: -1
    };
  }

  function vertexCount(mesh) { return mesh.vertexIds.length; }
  function faceCount(mesh) { return mesh.faceIds.length; }

  function faceVertices(mesh, i) {
    if (i < 0 || i >= mesh.faceIds.length) return [];
    var a = mesh.faceOffsets[i], b = mesh.faceOffsets[i + 1];
    return mesh.faceIndices.slice(a, b);
  }

  function faceVertexCount(mesh, i) {
    return mesh.faceOffsets[i + 1] - mesh.faceOffsets[i];
  }

  function triangleCount(mesh) {
    var t = 0;
    for (var i = 0; i < mesh.faceIds.length; i++) {
      var n = faceVertexCount(mesh, i);
      if (n >= 3) t += n - 2;
    }
    return t;
  }

  /* ---------------- UV 与 UV 岛 ----------------
   * UV 是 face-varying 的（每个面角一份），所以「接缝」天然被表达出来：
   * 同一个顶点两侧的 UV 不同 = 那条边是接缝。岛 = 沿共享边 UV 连续的连通面集合，
   * 不需要额外的 seam 标记，也不需要先展开 —— 有 UV 就按 UV 判，没 UV 就盒式投影补一份。 */

  function hasUV(mesh) {
    return !!(mesh && mesh.uvs && mesh.uvs.length === mesh.faceIndices.length * 2 && mesh.uvs.length > 0);
  }

  function uvAt(mesh, corner, out) {
    var o = out || [0, 0];
    o[0] = mesh.uvs[corner * 2] || 0;
    o[1] = mesh.uvs[corner * 2 + 1] || 0;
    return o;
  }

  /* 盒式投影：按面法线取主轴，投影到另外两个轴，再按包围盒归一化到 0~1。
   * 相邻同轴且共面的面会得到连续 UV —— 所以立方体是 6 个岛，而不是 12 个。 */
  function ensureUV(mesh) {
    if (!mesh || hasUV(mesh)) return mesh;
    var pos = mesh.positions, off = mesh.faceOffsets, idx = mesh.faceIndices;
    var n = idx.length * 2;
    var uv = new Array(n);
    var minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    var i;
    for (i = 0; i < pos.length; i += 3) {
      if (pos[i] < minX) minX = pos[i];
      if (pos[i] > maxX) maxX = pos[i];
      if (pos[i + 1] < minY) minY = pos[i + 1];
      if (pos[i + 1] > maxY) maxY = pos[i + 1];
      if (pos[i + 2] < minZ) minZ = pos[i + 2];
      if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
    }
    var spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1, spanZ = (maxZ - minZ) || 1;
    for (var f = 0; f < mesh.faceIds.length; f++) {
      var s0 = off[f], e0 = off[f + 1];
      if (e0 - s0 < 3) {
        for (i = s0; i < e0; i++) { uv[i * 2] = 0; uv[i * 2 + 1] = 0; }
        continue;
      }
      var p0 = idx[s0] * 3, p1 = idx[s0 + 1] * 3, p2 = idx[s0 + 2] * 3;
      var ax = pos[p1] - pos[p0], ay = pos[p1 + 1] - pos[p0 + 1], az = pos[p1 + 2] - pos[p0 + 2];
      var bx = pos[p2] - pos[p0], by = pos[p2 + 1] - pos[p0 + 1], bz = pos[p2 + 2] - pos[p0 + 2];
      /* 主轴 + 朝向 → 6 个 tile（3 列 × 2 行）各占一块。
       * ⚠ 只按轴分、不管朝向会出事：立方体 +X 面和 +Z 面在公共棱上算出来的 UV 恰好都是 (1, v)，
       * 于是 4 个侧面被连成一个岛（实测 6 → 2）。分成 6 块才是「盒式贴图」该有的结果。 */
      var nx0 = ay * bz - az * by, ny0 = az * bx - ax * bz, nz0 = ax * by - ay * bx;
      var axis, sign;
      if (Math.abs(nx0) >= Math.abs(ny0) && Math.abs(nx0) >= Math.abs(nz0)) { axis = 0; sign = nx0 >= 0 ? 1 : -1; }
      else if (Math.abs(ny0) >= Math.abs(nz0)) { axis = 1; sign = ny0 >= 0 ? 1 : -1; }
      else { axis = 2; sign = nz0 >= 0 ? 1 : -1; }
      var tile = axis * 2 + (sign > 0 ? 0 : 1);
      var col = tile % 3, row = Math.floor(tile / 3);
      var TW = 1 / 3, TH = 1 / 2, PAD = 0.02;
      for (i = s0; i < e0; i++) {
        var vi = idx[i] * 3, x = pos[vi], y = pos[vi + 1], z = pos[vi + 2];
        var u0, v0;
        if (axis === 0) { u0 = (z - minZ) / spanZ; v0 = (y - minY) / spanY; }
        else if (axis === 1) { u0 = (x - minX) / spanX; v0 = (z - minZ) / spanZ; }
        else { u0 = (x - minX) / spanX; v0 = (y - minY) / spanY; }
        uv[i * 2] = (col + PAD + u0 * (1 - 2 * PAD)) * TW;
        uv[i * 2 + 1] = (row + PAD + v0 * (1 - 2 * PAD)) * TH;
      }
    }
    mesh.uvs = uv;
    bump(mesh);
    return mesh;
  }

  /* UV 岛：共享边的两个面，如果两个端点的 UV 都一致（容差 1e-5）就是同一个岛。
   * 返回 { islands: [{ id, faces: [面下标] }], faceIsland: Int32Array }，按版本缓存。 */
  function uvIslands(mesh) {
    if (!mesh) return { islands: [], faceIsland: new Int32Array(0) };
    if (mesh._islands && mesh._islandsVersion === mesh.version) return mesh._islands;
    var fCount = mesh.faceIds.length;
    var faceIsland = new Int32Array(fCount);
    var parent = new Int32Array(fCount);
    var i;
    for (i = 0; i < fCount; i++) { parent[i] = i; faceIsland[i] = -1; }
    var empty = { islands: [], faceIsland: faceIsland };
    if (!hasUV(mesh) || !fCount) { mesh._islands = empty; mesh._islandsVersion = mesh.version; return empty; }

    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    /* 边 → 该边在哪些面里出现（最多两次），带上两端 UV，按顶点较小的那端对齐方向 */
    var byEdge = Object.create(null);
    var EPS = 1e-5;
    for (var f = 0; f < fCount; f++) {
      var s0 = mesh.faceOffsets[f], e0 = mesh.faceOffsets[f + 1], nv = e0 - s0;
      if (nv < 3) continue;
      for (var k = 0; k < nv; k++) {
        var c0 = s0 + k, c1 = s0 + ((k + 1) % nv);
        var va = mesh.faceIndices[c0], vb = mesh.faceIndices[c1];
        var key = (va < vb ? va + '_' + vb : vb + '_' + va);
        var rec = {
          f: f,
          uA: va < vb ? mesh.uvs[c0 * 2] : mesh.uvs[c1 * 2],
          vA: va < vb ? mesh.uvs[c0 * 2 + 1] : mesh.uvs[c1 * 2 + 1],
          uB: va < vb ? mesh.uvs[c1 * 2] : mesh.uvs[c0 * 2],
          vB: va < vb ? mesh.uvs[c1 * 2 + 1] : mesh.uvs[c0 * 2 + 1]
        };
        (byEdge[key] || (byEdge[key] = [])).push(rec);
      }
    }
    Object.keys(byEdge).forEach(function (key) {
      var list = byEdge[key];
      if (list.length < 2) return;
      for (var a = 1; a < list.length; a++) {
        var A = list[0], B = list[a];
        if (Math.abs(A.uA - B.uA) <= EPS && Math.abs(A.vA - B.vA) <= EPS &&
            Math.abs(A.uB - B.uB) <= EPS && Math.abs(A.vB - B.vB) <= EPS) {
          union(A.f, B.f);
        }
      }
    });

    var byRoot = Object.create(null), islands = [];
    for (var fi = 0; fi < fCount; fi++) {
      var root = find(fi);
      if (!byRoot[root]) { byRoot[root] = { id: islands.length, faces: [] }; islands.push(byRoot[root]); }
      byRoot[root].faces.push(fi);
      faceIsland[fi] = byRoot[root].id;
    }
    var out = { islands: islands, faceIsland: faceIsland };
    mesh._islands = out;
    mesh._islandsVersion = mesh.version;
    return out;
  }

  /* 版本号：任何写操作后手动 bump；显示缓存、边表都靠它失效 */
  function bump(mesh) {
    mesh.version = (mesh.version || 0) + 1;
    return mesh;
  }

  /* ---------------- 拓扑算子公共底座（M6b） ----------------
   * 所有改拓扑的算子（挤出 / 内插 / 删除面 / 合并顶点 …）都遵守同一条铁律：
   *   **绝不原地改旧 mesh** —— 先 clone 一份再动，动完 bump。
   *   原地改会让「内容指纹」指向被改过的同一份数据，撤销 / 历史去重直接失真。
   *
   * rawIndices：faceIndices 的**原始副本**（三角形下标）。fromBufferGeometry 里
   *   mergeQuads 合并四边形时会改写 faceIndices，但 uvs 仍按原始三角面角存放
   *   （见 ensureUV/uvIslands：角号 = faceOffsets 下标，对应原始三角面角序列）。
   *   算子要改拓扑（挤出 / 内插 / 删面）时，必须同时改 rawIndices 和 uvs，
   *   否则两者长度脱节、UV 岛判定直接崩。 */
  function ensureRawIndices(mesh) {
    if (!mesh) return null;
    if (!mesh.rawIndices || mesh.rawIndices.length !== mesh.faceIndices.length) {
      mesh.rawIndices = mesh.faceIndices.slice();
    }
    return mesh.rawIndices;
  }

  /* 把一份「要替换的面角」写回 rawIndices / uvs：
   * faceCorners[i] = 新面第 i 个角对应的原始面角号（可与旧角号不同）。
   * 新角没有对应旧角时传 -1，UV 补 0，rawIndices 补 -1。 */
  function setFaceCorners(mesh, faceIndex, faceCorners) {
    var raw = ensureRawIndices(mesh);
    var s = mesh.faceOffsets[faceIndex];
    if (!mesh.uvs || mesh.uvs.length !== mesh.faceIndices.length * 2) {
      /* 老网格没 UV：补一份全 0，别让后续角号错位 */
      mesh.uvs = new Array(mesh.faceIndices.length * 2);
      for (var z = 0; z < mesh.uvs.length; z++) mesh.uvs[z] = 0;
    }
    for (var i = 0; i < faceCorners.length; i++) {
      var c = s + i;
      var src = faceCorners[i];
      if (src == null || src < 0) {
        raw[c] = -1;
        mesh.uvs[c * 2] = 0;
        mesh.uvs[c * 2 + 1] = 0;
      } else {
        raw[c] = src;
        mesh.uvs[c * 2] = mesh.uvs[src * 2] || 0;
        mesh.uvs[c * 2 + 1] = mesh.uvs[src * 2 + 1] || 0;
      }
    }
    return mesh;
  }

  /* 从源 mesh 把一串面角的 UV 抄到目标 mesh 的指定面角区间（新面没有旧角号时用） */
  function copyCornerUVs(src, srcCorners, dst, dstStart) {
    if (!dst) return dst;
    if (!dst.uvs || dst.uvs.length !== dst.faceIndices.length * 2) {
      dst.uvs = new Array(dst.faceIndices.length * 2);
      for (var z = 0; z < dst.uvs.length; z++) dst.uvs[z] = 0;
    }
    for (var i = 0; i < srcCorners.length; i++) {
      var sc = srcCorners[i];
      var dc = dstStart + i;
      if (sc == null || sc < 0) {
        dst.uvs[dc * 2] = 0;
        dst.uvs[dc * 2 + 1] = 0;
      } else {
        dst.uvs[dc * 2] = (src && src.uvs) ? (src.uvs[sc * 2] || 0) : 0;
        dst.uvs[dc * 2 + 1] = (src && src.uvs) ? (src.uvs[sc * 2 + 1] || 0) : 0;
      }
    }
    return dst;
  }

  /* ---------------- base64 编解码（不依赖 seed-glb-meta，保持一致的小端视图） ---------------- */
  function bytesToBase64(u8) {
    var s = '', CH = 8192;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    if (typeof global.btoa === 'function') return global.btoa(s);
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    throw new Error('当前环境没有 base64 编码能力');
  }

  function base64ToBytes(b64) {
    var text = String(b64 || '');
    if (!text) return new Uint8Array(0);
    var bin;
    if (typeof global.atob === 'function') {
      bin = global.atob(text);
    } else if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(text, 'base64'));
    } else {
      throw new Error('当前环境没有 base64 解码能力');
    }
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function packF32(arr) {
    if (!arr || !arr.length) return '';
    var f = new Float32Array(arr);
    return bytesToBase64(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
  }

  function packI32(arr) {
    if (!arr || !arr.length) return '';
    var a = new Int32Array(arr);
    return bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }

  function unpackTyped(b64, ctor, name, expected) {
    var u8 = base64ToBytes(b64);
    if (!u8.length) return [];
    if (u8.length % 4 !== 0) throw new Error(name + ' 的 base64 长度不是 4 的倍数');
    var typed = new ctor(u8.buffer, u8.byteOffset, u8.byteLength / 4);
    if (expected != null && typed.length !== expected) {
      throw new Error(name + ' 元素数 ' + typed.length + '，期望 ' + expected);
    }
    var out = new Array(typed.length);
    for (var i = 0; i < typed.length; i++) out[i] = typed[i];
    return out;
  }

  /* ---------------- 从 BufferGeometry 烘焙（基础体工厂的出口） ----------------
   * 默认焊接：按位置量化合并重复顶点。基础体（Box 每个面一套顶点、球体经线接缝）
   * 不焊接就不是一张连通的网格，后续挤出 / 倒角会得到一堆断开的碎片。
   * UV / 法线不参与焊接判断（MVP-1 还没有 UV；法线由 buildGeometry 重算）。
   * 负缩放（镜像件）会翻转三角形绕序，用 opts.flip 修正，否则面朝里、渲染发黑。 */
  function fromBufferGeometry(geo, opts) {
    opts = opts || {};
    if (!geo || !geo.getAttribute) throw new Error('fromBufferGeometry 需要 BufferGeometry');
    var pos = geo.getAttribute('position') || (geo.attributes && geo.attributes.position);
    if (!pos) throw new Error('几何缺少 position 属性');
    var index = geo.getIndex ? geo.getIndex() : null;
    var triTotal = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    if (triTotal > MAX_FACES) {
      throw new Error('面数 ' + triTotal + ' 超过 MVP-1 上限 ' + MAX_FACES + '（P3 切 BIN 后再放开）');
    }

    var mesh = create();
    var uvAttr = geo.getAttribute ? (geo.getAttribute('uv') || (geo.attributes && geo.attributes.uv)) : null;
    var weld = opts.weld !== false;
    var map = Object.create(null);
    var remap = new Array(pos.count);
    var nextVid = 0;

    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      var key = null;
      if (weld) {
        key = Math.round(x * WELD_SCALE) + ',' + Math.round(y * WELD_SCALE) + ',' + Math.round(z * WELD_SCALE);
        if (map[key] != null) { remap[i] = map[key]; continue; }
      }
      var dense = mesh.positions.length / 3;
      mesh.positions.push(x, y, z);
      mesh.vertexIds.push(nextVid);
      nextVid += 1;
      remap[i] = dense;
      if (key) map[key] = dense;
    }
    mesh.nextVertexId = nextVid;

    var slot = opts.slot != null ? Math.max(0, Math.round(opts.slot)) : 0;
    for (var t = 0; t < triTotal; t++) {
      var i0 = index ? index.getX(t * 3) : t * 3;
      var i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      var i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      var a = remap[i0], b = remap[i1], c = remap[i2];
      if (a === b || b === c || c === a) continue;       // 退化三角形直接丢
      var tri = opts.flip ? [a, c, b] : [a, b, c];
      /* 角序决定 UV 归属：翻转过的三角形，UV 也要跟着交换后两个角 */
      var corners = opts.flip ? [i0, i1, i2] : [i0, i1, i2];
      if (opts.flip) { var tmp = corners[1]; corners[1] = corners[2]; corners[2] = tmp; }
      mesh.faceIndices.push(tri[0], tri[1], tri[2]);
      mesh.faceOffsets.push(mesh.faceIndices.length);
      mesh.faceIds.push(mesh.nextFaceId);
      mesh.faceSlots.push(slot);
      mesh.nextFaceId += 1;
      if (uvAttr) {
        for (var ci = 0; ci < 3; ci++) {
          mesh.uvs.push(uvAttr.getX(corners[ci]), uvAttr.getY(corners[ci]));
        }
      }
    }
    /* 三角化是一切几何的通用格式，但建模软件里「面」是多边形：
     * 导入后立刻把三角对合并回四边形（盒子 12 面 → 6 面），否则点选永远只选到半个面。
     * 判据见 mergeQuads：共面 或 UV 成矩形，且合并后是凸四边形。 */
    if (opts.quads !== false) mergeQuads(mesh, opts.quadOpts);
    bump(mesh);
    return mesh;
  }

  /* ---------------- 三角化 → 多边形（合并四边形） ----------------
   * 为什么需要两道判据：
   *   ① 平面体（盒 / 平面 / 圆柱端盖）三角对**严格共面**，法线点积 ≈ 1；
   *   ② 曲面体（球 / 圆柱侧面）三角对**不共面**，但它们的四个角在 UV 里正好是一个矩形
   *      （lat-long 网格天然如此）。所以「共面」不够时再看 UV 是否为矩形。
   * 另外必须要求合并后是**凸四边形**，否则会把凹形或扭转的两片硬拼在一起。 */
  function triLoop(mesh, f) {
    var s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
    if (e - s !== 3) return null;
    return [{ v: mesh.faceIndices[s], c: s }, { v: mesh.faceIndices[s + 1], c: s + 1 }, { v: mesh.faceIndices[s + 2], c: s + 2 }];
  }

  /* 面的法线（三角形用前三点；out 是 [x,y,z] 数组，省得为一次判断建 Vector3） */
  function triNormal(mesh, f, out) {
    var s = mesh.faceOffsets[f], n = mesh.faceOffsets[f + 1] - s;
    if (n < 3) return false;
    var P = mesh.positions;
    var i0 = mesh.faceIndices[s] * 3, i1 = mesh.faceIndices[s + 1] * 3, i2 = mesh.faceIndices[s + 2] * 3;
    var ax = P[i1] - P[i0], ay = P[i1 + 1] - P[i0 + 1], az = P[i1 + 2] - P[i0 + 2];
    var bx = P[i2] - P[i0], by = P[i2 + 1] - P[i0 + 1], bz = P[i2 + 2] - P[i0 + 2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    var len = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
    if (len < 1e-12) return false;
    out[0] /= len; out[1] /= len; out[2] /= len;
    return true;
  }

  /* 两三角形能否并成一个凸四边形；能的话返回 4 个角（带各自的面角下标，UV 要跟着走） */
  function quadOf(mesh, f1, f2, cosTol, useUV) {
    var A = triLoop(mesh, f1), B = triLoop(mesh, f2);
    if (!A || !B) return null;
    /* 找共享边：A 里连续的一对 (p,q)，在 B 里必然以 (q,p) 出现 */
    for (var ka = 0; ka < 3; ka++) {
      var p = A[ka], q = A[(ka + 1) % 3], x = A[(ka + 2) % 3];
      for (var kb = 0; kb < 3; kb++) {
        if (B[kb].v === q.v && B[(kb + 1) % 3].v === p.v) {
          var y = B[(kb + 2) % 3];
          /* B 的循环是 q→p，所以 B[kb] 是 q 的角、B[kb+1] 是 p 的角（别写反） */
          var qB = B[kb], pB = B[(kb + 1) % 3];
          /* ⚠ 共享边上两侧的 UV 必须一致：不一致说明这条边是**UV 接缝**，
           * 合并后一个顶点只能有一份 UV，会把两个贴图位置压成一个（实测把立方体压成 4 个畸变四边面）。 */
          if (hasUV(mesh) && (!uvSame(mesh, p.c, pB.c) || !uvSame(mesh, q.c, qB.c))) return null;
          var loop = [p, y, q, x];          /* 去掉共享边后的外轮廓 */
          if (isConvexQuad(mesh, loop) && (isCoplanar(mesh, f1, f2, cosTol) || (useUV && isUVRect(mesh, loop)))) {
            return loop;
          }
          return null;
        }
      }
    }
    return null;
  }

  function uvSame(mesh, c1, c2) {
    return Math.abs(mesh.uvs[c1 * 2] - mesh.uvs[c2 * 2]) <= 1e-5 &&
      Math.abs(mesh.uvs[c1 * 2 + 1] - mesh.uvs[c2 * 2 + 1]) <= 1e-5;
  }

  function isConvexQuad(mesh, loop) {
    var P = mesh.positions;
    var pts = loop.map(function (o) { return [P[o.v * 3], P[o.v * 3 + 1], P[o.v * 3 + 2]]; });
    /* Newell 法向 */
    var nx = 0, ny = 0, nz = 0;
    for (var i = 0; i < 4; i++) {
      var a = pts[i], b = pts[(i + 1) % 4];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-9) return false;
    nx /= len; ny /= len; nz /= len;
    var sign = 0;
    for (i = 0; i < 4; i++) {
      var e1x = pts[(i + 1) % 4][0] - pts[i][0], e1y = pts[(i + 1) % 4][1] - pts[i][1], e1z = pts[(i + 1) % 4][2] - pts[i][2];
      var e2x = pts[(i + 2) % 4][0] - pts[(i + 1) % 4][0], e2y = pts[(i + 2) % 4][1] - pts[(i + 1) % 4][1], e2z = pts[(i + 2) % 4][2] - pts[(i + 1) % 4][2];
      var cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
      var d = (cx * nx + cy * ny + cz * nz);
      if (Math.abs(d) < 1e-12) return false;       /* 三个点共线 */
      var sg = d > 0 ? 1 : -1;
      if (sign === 0) sign = sg; else if (sg !== sign) return false;
    }
    return true;
  }

  function isCoplanar(mesh, f1, f2, cosTol) {
    var n1 = [0, 0, 0], n2 = [0, 0, 0];
    if (!triNormal(mesh, f1, n1) || !triNormal(mesh, f2, n2)) return false;
    return (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) >= cosTol;
  }

  /* UV 是否构成矩形：两个不同 u × 两个不同 v */
  function isUVRect(mesh, loop) {
    if (!hasUV(mesh)) return false;
    var us = [], vs = [], pts = [], EPS = 1e-5;
    loop.forEach(function (o) {
      var u = mesh.uvs[o.c * 2], v = mesh.uvs[o.c * 2 + 1];
      if (!us.some(function (x) { return Math.abs(x - u) <= EPS; })) us.push(u);
      if (!vs.some(function (x) { return Math.abs(x - v) <= EPS; })) vs.push(v);
      pts.push(u.toFixed(5) + ',' + v.toFixed(5));
    });
    /* 必须是 2×2 的**四个不同角**：只数“2 个 u、2 个 v”会把两个角重合成同一点的情况也放过 */
    var uniq = Object.create(null);
    pts.forEach(function (k) { uniq[k] = 1; });
    return us.length === 2 && vs.length === 2 && Object.keys(uniq).length === 4;
  }

  function mergeQuads(mesh, opts) {
    opts = opts || {};
    if (!mesh || !mesh.faceIds.length) return mesh;
    var cosTol = Math.cos((opts.tolDeg != null ? opts.tolDeg : 1.2) * Math.PI / 180);
    var useUV = opts.uv !== false;
    var guard = 0;
    while (guard++ < 6) {
      var mergedCount = mergeQuadPass(mesh, cosTol, useUV);
      if (!mergedCount) break;
      bump(mesh);
    }
    return mesh;
  }

  function mergeQuadPass(mesh, cosTol, useUV) {
    var fCount = mesh.faceIds.length;
    var edgeMap = Object.create(null);
    var f, s, k;
    for (f = 0; f < fCount; f++) {
      s = mesh.faceOffsets[f];
      if (mesh.faceOffsets[f + 1] - s !== 3) continue;
      for (k = 0; k < 3; k++) {
        var a = mesh.faceIndices[s + k], b = mesh.faceIndices[s + (k + 1) % 3];
        var key = a < b ? a + '_' + b : b + '_' + a;
        (edgeMap[key] || (edgeMap[key] = [])).push(f);
      }
    }
    var taken = Object.create(null), pairs = [];
    Object.keys(edgeMap).forEach(function (key) {
      var list = edgeMap[key];
      if (list.length !== 2) return;
      var f1 = list[0], f2 = list[1];
      if (taken[f1] || taken[f2]) return;
      if (mesh.faceSlots[f1] !== mesh.faceSlots[f2]) return;
      var loop = quadOf(mesh, f1, f2, cosTol, useUV);
      if (!loop) return;
      taken[f1] = loop; taken[f2] = true;
      pairs.push(f1);
    });
    if (!pairs.length) return 0;

    /* 重建面表：被合并的那一对里，第一个面写四边形（沿用它的 faceId），第二个面丢弃 */
    var newIdx = [], newOff = [0], newIds = [], newSlots = [], newUvs = [];
    var did = 0;
    for (f = 0; f < fCount; f++) {
      var start = mesh.faceOffsets[f], end = mesh.faceOffsets[f + 1];
      var loop2 = taken[f];
      if (loop2 === true) continue;                    /* 被并入前一个面 */
      if (loop2 && loop2.length === 4) {
        for (k = 0; k < 4; k++) {
          var o = loop2[k];
          newIdx.push(o.v);
          if (mesh.uvs && mesh.uvs.length) newUvs.push(mesh.uvs[o.c * 2], mesh.uvs[o.c * 2 + 1]);
        }
        newOff.push(newIdx.length);
        newIds.push(mesh.faceIds[f]);
        newSlots.push(mesh.faceSlots[f]);
        did++;
        continue;
      }
      for (k = start; k < end; k++) {
        newIdx.push(mesh.faceIndices[k]);
        if (mesh.uvs && mesh.uvs.length) newUvs.push(mesh.uvs[k * 2], mesh.uvs[k * 2 + 1]);
      }
      newOff.push(newIdx.length);
      newIds.push(mesh.faceIds[f]);
      newSlots.push(mesh.faceSlots[f]);
    }
    mesh.faceIndices = newIdx;
    mesh.faceOffsets = newOff;
    mesh.faceIds = newIds;
    mesh.faceSlots = newSlots;
    if (newUvs.length) mesh.uvs = newUvs;
    mesh._geometry = null;
    mesh._edges = null;
    mesh._islands = null;
    return did;
  }

  /* 把一个网格并进另一个：顶点 ID / 面 ID 整体平移，保证文档级 ID 不撞车。
   * opts.slot 给了就整块改写材质槽；opts.flip 用于镜像件。 */
  function append(target, source, opts) {
    opts = opts || {};
    if (!target || !source) throw new Error('append 缺少网格');
    var vBase = target.positions.length / 3;
    var vIdBase = target.nextVertexId;
    var fIdBase = target.nextFaceId;
    var i, k;

    for (i = 0; i < source.positions.length; i++) target.positions.push(source.positions[i]);
    for (i = 0; i < source.vertexIds.length; i++) target.vertexIds.push(source.vertexIds[i] + vIdBase);

    for (i = 0; i < source.faceIds.length; i++) {
      var start = source.faceOffsets[i], end = source.faceOffsets[i + 1];
      var verts = [], uvs = [];
      for (k = start; k < end; k++) {
        verts.push(source.faceIndices[k]);
        uvs.push(source.uvs ? source.uvs[k * 2] : 0, source.uvs ? source.uvs[k * 2 + 1] : 0);
      }
      if (opts.flip) verts.reverse();
      for (k = 0; k < verts.length; k++) target.faceIndices.push(verts[k] + vBase);
      /* UV 跟着面角一起搬；源网格没有 UV 就补 0，别让两个数组长度对不上 */
      for (k = 0; k < verts.length; k++) {
        var srcK = opts.flip ? (verts.length - 1 - k) : k;
        target.uvs.push(uvs[srcK * 2], uvs[srcK * 2 + 1]);
      }
      target.faceOffsets.push(target.faceIndices.length);
      target.faceIds.push(source.faceIds[i] + fIdBase);
      target.faceSlots.push(opts.slot != null ? Math.max(0, Math.round(opts.slot)) : (source.faceSlots[i] || 0));
    }
    target.nextVertexId = Math.max(vIdBase, vIdBase + source.nextVertexId);
    target.nextFaceId = Math.max(fIdBase, fIdBase + source.nextFaceId);
    bump(target);
    return target;
  }

  function merge(list) {
    var out = create();
    (list || []).forEach(function (m) { if (m) append(out, m, {}); });
    return out;
  }

  /* 整体平移顶点：v1 烘焙后把模型中心挪到原点（手柄 / 相机都落在模型中心） */
  function translate(mesh, dx, dy, dz) {
    var n = mesh.positions.length / 3;
    for (var i = 0; i < n; i++) {
      mesh.positions[i * 3] += dx;
      mesh.positions[i * 3 + 1] += dy;
      mesh.positions[i * 3 + 2] += dz;
    }
    bump(mesh);
    return mesh;
  }

  /* ---------------- 边表（按需重建，不持久化） ---------------- */
  function ensureEdges(mesh) {
    if (mesh._edges && mesh._edgesVersion === mesh.version) return mesh._edges;
    var edges = [], byId = Object.create(null);
    var vertexFaces = new Array(mesh.vertexIds.length);
    for (var i = 0; i < vertexFaces.length; i++) vertexFaces[i] = null;

    for (var f = 0; f < mesh.faceIds.length; f++) {
      var start = mesh.faceOffsets[f], end = mesh.faceOffsets[f + 1], n = end - start;
      for (var k = 0; k < n; k++) {
        var va = mesh.faceIndices[start + k];
        var vb = mesh.faceIndices[start + (k + 1) % n];
        var ida = mesh.vertexIds[va], idb = mesh.vertexIds[vb];
        var lo = Math.min(ida, idb), hi = Math.max(ida, idb);
        var eid = lo * EDGE_STRIDE + hi;
        var rec = byId[eid];
        if (!rec) {
          rec = {
            id: eid,
            a: ida <= idb ? va : vb,
            b: ida <= idb ? vb : va,
            aId: lo,
            bId: hi,
            faces: []
          };
          byId[eid] = rec;
          edges.push(rec);
        }
        rec.faces.push(f);
        if (!vertexFaces[va]) vertexFaces[va] = [];
        if (!vertexFaces[vb]) vertexFaces[vb] = [];
        if (vertexFaces[va].indexOf(f) < 0) vertexFaces[va].push(f);
        if (vertexFaces[vb].indexOf(f) < 0) vertexFaces[vb].push(f);
      }
    }
    mesh._edges = { edges: edges, edgeById: byId, vertexFaces: vertexFaces };
    mesh._edgesVersion = mesh.version;
    return mesh._edges;
  }

  function stats(mesh) {
    if (!mesh) return { vertices: 0, faces: 0, edges: 0, triangles: 0 };
    var e = ensureEdges(mesh);
    return {
      vertices: mesh.vertexIds.length,
      faces: mesh.faceIds.length,
      edges: e.edges.length,
      triangles: triangleCount(mesh)
    };
  }

  /* ---------------- 显示几何 ----------------
   * 面（可能是多边形）按扇形三角化；材质槽按连续段切成 groups，
   * 上层只要按 slotNames 顺序准备材质数组即可。
   * 默认带缓存：拓扑不变时重复取用不会重新构建。导出等一次性用途传 { cache:false }。 */
  function buildGeometry(mesh, opts) {
    opts = opts || {};
    var THREE = global.THREE;
    if (!THREE) throw new Error('three.js 未就绪');
    if (opts.cache !== false && mesh._geometry && mesh._geometryVersion === mesh.version) {
      return mesh._geometry;
    }

    var posArr = new Float32Array(mesh.positions.length);
    for (var i = 0; i < mesh.positions.length; i++) posArr[i] = mesh.positions[i];
    var idx = [];
    var groups = [];
    var runSlot = -1, runStart = 0, runCount = 0;

    for (var f = 0; f < mesh.faceIds.length; f++) {
      var start = mesh.faceOffsets[f], end = mesh.faceOffsets[f + 1];
      var slot = mesh.faceSlots[f] || 0;
      if (slot !== runSlot) {
        if (runCount) groups.push({ start: runStart, count: runCount, slot: runSlot });
        runSlot = slot;
        runStart = idx.length;
        runCount = 0;
      }
      var v0 = mesh.faceIndices[start];
      for (var k = 1; k < end - start - 1; k++) {
        idx.push(v0, mesh.faceIndices[start + k], mesh.faceIndices[start + k + 1]);
        runCount += 3;
      }
    }
    if (runCount) groups.push({ start: runStart, count: runCount, slot: runSlot });

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    if (idx.length) geo.setIndex(idx);
    geo.computeVertexNormals();
    groups.forEach(function (g) { geo.addGroup(g.start, g.count, g.slot); });
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    if (opts.cache !== false) {
      mesh._geometry = geo;
      mesh._geometryVersion = mesh.version;
    }
    return geo;
  }

  /* ---------------- 序列化 ---------------- */
  function toJSON(mesh) {
    return {
      storage: 'json',
      vertexCount: mesh.vertexIds.length,
      faceCount: mesh.faceIds.length,
      nextVertexId: mesh.nextVertexId,
      nextFaceId: mesh.nextFaceId,
      positions: packF32(mesh.positions),
      vertexIds: packI32(mesh.vertexIds),
      faceOffsets: packI32(mesh.faceOffsets),
      faceIndices: packI32(mesh.faceIndices),
      faceIds: packI32(mesh.faceIds),
      faceSlots: packI32(mesh.faceSlots),
      uvs: packF32(mesh.uvs),
      stats: stats(mesh)
    };
  }

  function fromJSON(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('mesh 不是对象');
    if (obj.storage && obj.storage !== 'json') throw new Error('不支持的 mesh.storage：' + obj.storage);
    var mesh = create();
    mesh.positions = unpackTyped(obj.positions, Float32Array, 'positions');
    mesh.vertexIds = unpackTyped(obj.vertexIds, Int32Array, 'vertexIds');
    mesh.faceIndices = unpackTyped(obj.faceIndices, Int32Array, 'faceIndices');
    mesh.faceIds = unpackTyped(obj.faceIds, Int32Array, 'faceIds');
    mesh.faceOffsets = unpackTyped(obj.faceOffsets, Int32Array, 'faceOffsets');
    mesh.faceSlots = unpackTyped(obj.faceSlots, Int32Array, 'faceSlots');
    /* UV 是后加的字段：老文件没有它，读成空数组即可（ensureUV 会补一份盒式投影） */
    mesh.uvs = obj.uvs ? unpackTyped(obj.uvs, Float32Array, 'uvs') : [];

    var errs = validate(mesh);
    if (errs.length) throw new Error('mesh 数据损坏：' + errs.join('；'));

    var vMax = -1, fMax = -1;
    for (var i = 0; i < mesh.vertexIds.length; i++) vMax = Math.max(vMax, mesh.vertexIds[i]);
    for (var j = 0; j < mesh.faceIds.length; j++) fMax = Math.max(fMax, mesh.faceIds[j]);
    mesh.nextVertexId = Math.max(Number(obj.nextVertexId) || 0, vMax + 1);
    mesh.nextFaceId = Math.max(Number(obj.nextFaceId) || 0, fMax + 1);
    if (!mesh.faceSlots.length && mesh.faceIds.length) {
      for (var k = 0; k < mesh.faceIds.length; k++) mesh.faceSlots.push(0);
    }
    bump(mesh);
    return mesh;
  }

  /* 结构校验：返回错误字符串数组（空 = 通过）。读回来的东西不可信，先过这一关。 */
  function validate(mesh) {
    var errs0 = [];
    if (mesh && mesh.uvs && mesh.uvs.length && mesh.uvs.length !== mesh.faceIndices.length * 2) {
      errs0.push('uvs 长度 ' + mesh.uvs.length + ' 与面角数 ' + (mesh.faceIndices.length * 2) + ' 不一致');
      return errs0;
    }
    var errs = [];
    if (!mesh) return ['网格为空'];
    if (mesh.positions.length % 3 !== 0) errs.push('positions 长度不是 3 的倍数');
    var vCount = mesh.positions.length / 3;
    if (mesh.vertexIds.length !== vCount) errs.push('顶点 ID 数与顶点数不一致');
    if (mesh.faceOffsets.length !== mesh.faceIds.length + 1) errs.push('faceOffsets 长度 ≠ 面数 + 1');
    if (mesh.faceOffsets[0] !== 0) errs.push('faceOffsets[0] 不是 0');
    if (mesh.faceOffsets[mesh.faceOffsets.length - 1] !== mesh.faceIndices.length) {
      errs.push('faceOffsets 末尾与 faceIndices 长度不一致');
    }
    if (mesh.faceSlots.length && mesh.faceSlots.length !== mesh.faceIds.length) {
      errs.push('faceSlots 与面数不一致');
    }
    if (mesh.faceIds.length > MAX_FACES) errs.push('面数超过上限 ' + MAX_FACES);
    for (var f = 0; f < mesh.faceIds.length && errs.length < 8; f++) {
      var start = mesh.faceOffsets[f], end = mesh.faceOffsets[f + 1];
      if (end - start < 3) { errs.push('第 ' + f + ' 面少于 3 个顶点'); break; }
      if (end < start) { errs.push('faceOffsets 非单调（第 ' + f + ' 面）'); break; }
      for (var k = start; k < end; k++) {
        var v = mesh.faceIndices[k];
        if (v < 0 || v >= vCount) { errs.push('第 ' + f + ' 面引用了越界顶点 ' + v); f = mesh.faceIds.length; break; }
      }
    }
    return errs;
  }

  /* 体积估算：保存前提示用（JSON chunk 还没写，这里算解码前的原始字节 + base64 膨胀） */
  function byteSize(mesh) {
    var raw = mesh.positions.length * 4 + mesh.vertexIds.length * 4 +
      mesh.faceIndices.length * 4 + mesh.faceOffsets.length * 4 +
      mesh.faceIds.length * 4 + mesh.faceSlots.length * 4 +
      (mesh.uvs ? mesh.uvs.length * 4 : 0);
    return Math.round(raw * 1.37);   // base64 约 4/3，加 JSON 字段名损耗
  }

  /* ---------------- 指纹与深拷贝（V3：历史要认网格） ----------------
   * 为什么不是「快照时把整份网格复制进撤销栈」：
   *   实测 9800 面的一份网格序列化后约 412 KB，64 MB 预算只够 40 步，
   *   而其中 38 步往往只是挪了个位置（网格一个字节没变）。
   * 所以这里给网格算一个内容指纹，撤销栈只存指纹；真正改过的那几版网格
   * 按指纹去重（intern）后单独存一份，引用计数归零才释放。
   *
   * 指纹 = 位置（按 float32 位模式）+ 五个整型数组的 FNV-1a + 两个长度。
   * 加长度是为了让「删掉最后一个点」这种等长哈希碰撞不可能发生。
   * 用 32 位 float 位模式而不是数值本身：positions 有时是 Array、有时是
   * Float32Array，直接比数值会把 0.1 和 0.100000001 当成不同版本。 */
  var _f32 = new Float32Array(1);
  var _u32 = new Uint32Array(_f32.buffer);
  function fnvByte(h, b) { return Math.imul(h ^ (b & 0xff), 16777619) >>> 0; }
  function hashF32(arr, seed) {
    var h = seed >>> 0, i, k;
    for (i = 0; i < arr.length; i++) {
      _f32[0] = +arr[i];
      k = _u32[0];
      h = fnvByte(h, k); h = fnvByte(h, k >>> 8);
      h = fnvByte(h, k >>> 16); h = fnvByte(h, k >>> 24);
    }
    return h;
  }
  function hashI32(arr, seed) {
    var h = seed >>> 0, i, v;
    for (i = 0; i < arr.length; i++) {
      v = arr[i] | 0;
      h = fnvByte(h, v); h = fnvByte(h, v >>> 8);
      h = fnvByte(h, v >>> 16); h = fnvByte(h, v >>> 24);
    }
    return h;
  }
  function hash(mesh) {
    if (!mesh) return '';
    var a = hashF32(mesh.positions, 2166136261);
    var b = hashI32(mesh.vertexIds, 2166136261);
    b = hashI32(mesh.faceOffsets, b);
    b = hashI32(mesh.faceIndices, b);
    b = hashI32(mesh.faceIds, b);
    b = hashI32(mesh.faceSlots, b);
    /* UV 也进指纹：改 UV 必须算一次编辑，否则撤销栈看不见它 */
    if (mesh.uvs && mesh.uvs.length) a = hashF32(mesh.uvs, a);
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36) +
      '-' + mesh.positions.length + '-' + mesh.faceIds.length;
  }

  /* 深拷贝：只带数据，不带 _geometry / _edges 缓存（缓存必须跟着新对象重新建）。
   * 撤销恢复时一定要用 clone —— 直接塞 intern 里的那份，后续编辑会改到共享副本。 */
  function cloneArray(a) {
    return (a && typeof a.slice === 'function') ? a.slice() : Array.prototype.slice.call(a || []);
  }
  function clone(mesh) {
    if (!mesh) return null;
    var m = create();
    m.positions = cloneArray(mesh.positions);
    m.vertexIds = cloneArray(mesh.vertexIds);
    m.faceOffsets = cloneArray(mesh.faceOffsets);
    m.faceIndices = cloneArray(mesh.faceIndices);
    m.faceIds = cloneArray(mesh.faceIds);
    m.faceSlots = cloneArray(mesh.faceSlots);
    m.uvs = cloneArray(mesh.uvs);
    m.nextVertexId = mesh.nextVertexId || 0;
    m.nextFaceId = mesh.nextFaceId || 0;
    m.version = mesh.version || 0;
    return m;
  }

  M.Mesh = {
    MAX_FACES: MAX_FACES,
    EDGE_STRIDE: EDGE_STRIDE,
    create: create,
    fromBufferGeometry: fromBufferGeometry,
    append: append,
    merge: merge,
    translate: translate,
    bump: bump,
    vertexCount: vertexCount,
    faceCount: faceCount,
    faceVertices: faceVertices,
    faceVertexCount: faceVertexCount,
    triangleCount: triangleCount,
    ensureEdges: ensureEdges,
    stats: stats,
    buildGeometry: buildGeometry,
    toJSON: toJSON,
    fromJSON: fromJSON,
    validate: validate,
    byteSize: byteSize,
    hash: hash,
    clone: clone,
    hasUV: hasUV,
    uvAt: uvAt,
    ensureUV: ensureUV,
    uvIslands: uvIslands,
    mergeQuads: mergeQuads,
    triNormal: triNormal,
    ensureRawIndices: ensureRawIndices,
    setFaceCorners: setFaceCorners,
    copyCornerUVs: copyCornerUVs
  };
})(typeof window !== 'undefined' ? window : globalThis);
