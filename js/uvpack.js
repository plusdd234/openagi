/* UV 排布：调节岛大小 + 自动装箱（模型库 UV 视图的「UV 排布」工具）
 *
 * 为什么需要它：
 *   模型（Tripo / 手搓的 GLB）自带的 UV 是自动展的，岛的大小和模型面积不成比例，
 *   岛之间空隙经常过半（利用率 40–60%）。上色 / 贴图之前真正要的是「尺寸一致 + 排布紧凑」，
 *   以前只能导出到 Blender 手动 Average Island Scale + Pack Islands，现在在模型库里一步做完。
 *
 * 分工（和 ModelTex 一样按「读 / 写」切）：
 *   - ModelTex.analyze 负责「模型 → 岛」，只读
 *   - 这里负责「岛 → 新 UV」，会写几何、写贴图
 *   - UI 在 model3d.js 的 UV 视图里，只调这里的纯函数
 *
 * API：
 *   UvPack.snapshot(a)                      留一份基线（原 UV + 原贴图），还原 / 幂等排布都靠它
 *   UvPack.restore(a, snap)                 回到基线（含贴图）
 *   UvPack.pack(a, opt)                     → { ok, ops, fill, scale, notes }
 *   UvPack.apply(a, ops)                    → { rebuilt:[partIdx] }   写回几何（必要时拆顶点）
 *   UvPack.refresh(a)                       重算岛的 UV 包围盒 / 面积（写完必调）
 *   UvPack.remapTextures(a, snap)           → { ok, count }   把旧贴图按新 UV 重采样
 *   UvPack.exportGLB(a)                     → ArrayBuffer
 *
 * 四个坑（都踩过，别回头改）：
 *   ① 岛的变换必须按「顶点 → 唯一岛」写。一个顶点只有一份 UV，被两个岛共享时只能拆顶点
 *      （deindex），否则两个变换轮流覆盖同一个 UV，贴图直接撕成花屏。
 *   ② 多插槽模型（GLB 里多个 mesh）每个 mesh 各自占满 0–1，装箱必须**按插槽分别**做；
 *      混在一起装会把两个插槽的岛叠到同一块 UV 上，导出后两处互相抢颜色。
 *   ③ UV 一改，mat.map 就全错位。排布必须跟着重采样贴图，否则「排布成功」的代价是模型糊掉。
 *   ④ 排布要**从基线算**（每次先 restore 再 apply），不能拿「上一次的排布结果」当输入：
 *      那样连续点两次会越缩越小，滑块也不再有确定含义。
 */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var EPS = 1e-9;

  /* 岛边距（UV 单位）：0.004 ≈ 1024 贴图上的 4px。
   * 太小 → 相邻岛在双线性采样 / mipmap 时互相渗色；太大 → 白扔 UV 空间。 */
  var PAD = 0.004;

  /* 重采样贴图的长边上限：4K 贴图两张大 ImageData 就近 128MB，浏览器容易直接 OOM。
   * 2048 对色块贴图足够（模型库的贴图本身多是 1–2K）。 */
  var TEX_MAX = 2048;

  /* ---------------- 索引小工具 ---------------- */

  /* 三角形第 k 个角点的顶点索引（有无 index 都要能读） */
  function vOf(part, t, k) {
    return part.idx ? part.idx.getX(t * 3 + k) : t * 3 + k;
  }

  /* geometry → mesh：apply 拆完顶点要换回 mesh.geometry，靠它找 */
  function meshOfGeometry(a) {
    var m = new Map();
    if (!a || !a.root || !a.root.traverse) return m;
    a.root.traverse(function (o) {
      if (o.isMesh && o.geometry && !m.has(o.geometry)) m.set(o.geometry, o);
    });
    return m;
  }

  /* 某插槽上的岛。岛本来就是 part 内部划分的，一个岛不会跨 mesh，
   * 但 islands[].tris 是全局列表，这里筛出属于该 part 的三角形。 */
  function islandsOf(a, pi) {
    var out = [];
    for (var i = 0; i < a.islands.length; i++) {
      var o = a.islands[i], ts = [];
      for (var j = 0; j < o.tris.length; j++) {
        if (o.tris[j].part === pi) ts.push(o.tris[j].t);
      }
      if (ts.length) out.push({ id: o.id, tris: ts });
    }
    return out;
  }

  /* 岛的 UV 包围盒 + UV 面积（三角形面积和，比包围盒更真实） */
  function islandBox(part, tris) {
    var uv = part.uv;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      var ia = vOf(part, t, 0), ib = vOf(part, t, 1), ic = vOf(part, t, 2);
      var ax = uv.getX(ia), ay = uv.getY(ia);
      var bx = uv.getX(ib), by = uv.getY(ib);
      var cx = uv.getX(ic), cy = uv.getY(ic);
      if (ax < x0) x0 = ax; if (ax > x1) x1 = ax;
      if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
      if (bx < x0) x0 = bx; if (bx > x1) x1 = bx;
      if (by < y0) y0 = by; if (by > y1) y1 = by;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    }
    if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = EPS; }
    return {
      x0: x0, y0: y0, x1: x1, y1: y1,
      w: Math.max(x1 - x0, EPS), h: Math.max(y1 - y0, EPS), area: area
    };
  }

  /* 岛的 3D 表面积（世界空间）。「统一贴图密度」靠它：面积大的岛在 UV 里也该大。 */
  var _v3 = null;
  function islandArea3D(part, tris) {
    if (!_v3) _v3 = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), u: new THREE.Vector3(), w: new THREE.Vector3() };
    var A = _v3.a, B = _v3.b, C = _v3.c, u = _v3.u, w = _v3.w;
    var pos = part.pos, mw = part.mw, total = 0;
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      var ia = vOf(part, t, 0), ib = vOf(part, t, 1), ic = vOf(part, t, 2);
      A.set(pos.getX(ia), pos.getY(ia), pos.getZ(ia)).applyMatrix4(mw);
      B.set(pos.getX(ib), pos.getY(ib), pos.getZ(ib)).applyMatrix4(mw);
      C.set(pos.getX(ic), pos.getY(ic), pos.getZ(ic)).applyMatrix4(mw);
      u.subVectors(B, A); w.subVectors(C, A);
      total += u.cross(w).length() / 2;
    }
    return total;
  }

  /* ---------------- 装箱：skyline bottom-left ----------------
   * 为什么不用「按行切」（shelf）：岛尺寸差得远（一个躯干能占半张图、碎渣只有几像素），
   * 按行切会被最高的那个岛把整行撑高，碎岛全浪费掉；skyline 允许矮岛塞进高岛脚下的凹槽，
   * 同样的面积能多装 10–20%，而代码只多 40 行。
   * 也不做旋转：UV 岛转了 90° 贴图方向也跟着转，色块贴图无所谓，
   * 带文字 / 条纹的贴图就废了——收益不值这个风险。 */
  function skylinePack(sizes, W, H) {
    var sky = [{ x: 0, y: 0, w: W }];
    var out = [];
    for (var i = 0; i < sizes.length; i++) {
      var w = sizes[i].w, h = sizes[i].h;
      var best = null;
      for (var j = 0; j < sky.length; j++) {
        var nx = sky[j].x;
        if (nx + w > W + EPS) continue;
        /* 这段 [nx, nx+w) 跨越的节点里最高的那个顶，就是落点高度 */
        var y = 0, rest = w, k = j;
        while (rest > EPS && k < sky.length) {
          if (sky[k].y > y) y = sky[k].y;
          rest -= sky[k].w;
          k++;
        }
        if (rest > EPS) continue;                    // 右边宽度不够
        if (y + h > H + EPS) continue;               // 顶上放不下
        if (!best || y + h < best.top) best = { x: nx, y: y, top: y + h };
      }
      if (!best) return null;
      out.push({ x: best.x, y: best.y });
      skylinePlace(sky, best.x, best.y, w, h);
    }
    return out;
  }

  function skylinePlace(sky, x, y, w, h) {
    var top = y + h, x2 = x + w, out = [], done = false;
    for (var i = 0; i < sky.length; i++) {
      var n = sky[i], a = n.x, b = n.x + n.w;
      if (b <= x + EPS || a >= x2 - EPS) { out.push(n); continue; }
      if (a < x - EPS) out.push({ x: a, y: n.y, w: x - a });
      if (!done) { out.push({ x: x, y: top, w: w }); done = true; }
      if (b > x2 + EPS) out.push({ x: x2, y: n.y, w: b - x2 });
    }
    /* 相邻同高必须合并：不合并节点数会随岛数线性增长，装箱退化成 O(n²) */
    var merged = [];
    for (i = 0; i < out.length; i++) {
      var p = merged[merged.length - 1];
      if (p && Math.abs(p.y - out[i].y) < EPS && Math.abs(p.x + p.w - out[i].x) < EPS) p.w += out[i].w;
      else merged.push(out[i]);
    }
    sky.length = 0;
    for (i = 0; i < merged.length; i++) sky.push(merged[i]);
  }

  /* ---------------- UV 空间分组 ----------------
   * 「一个 mesh 一份 UV」是错的。真正决定装在哪份 0–1 里的是**贴图**：
   *   · 有 map：同一个 map 对象 → 同一份 UV 空间（渲染时本来就叠在一张贴图上）
   *   · 没有 map：全部算一组。模型没贴图时贴图是后面生成的（区域上色只出一张），
   *     各 mesh 分开装会让它们互相覆盖。
   * 踩过的坑（2026-11-01，身体.obj）：一个 OBJ 里三个 object（da / input / faaf），
   * 每个都摊满 0–1 共用一套布局、且都没贴图。按 mesh 分别排布 = 三套 UV 全塞进同一块 0–1，
   * 症状就是「同一个岛的位置被别的插槽占掉」——贴图一上就互相抢颜色。 */
  function packGroups(a) {
    var partOf = new Map();
    a.parts.forEach(function (p, i) { partOf.set(p.g, i); });
    var key = a.parts.map(function () { return ''; });
    if (a.root && a.root.traverse) {
      a.root.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.material) return;
        if (!partOf.has(o.geometry)) return;
        var pi = partOf.get(o.geometry);
        if (key[pi]) return;
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < ms.length; i++) {
          if (ms[i] && ms[i].map) { key[pi] = String(ms[i].map.uuid || 'map'); return; }
        }
      });
    }
    var groups = [], idxOf = new Map();
    a.parts.forEach(function (p, i) {
      var k = key[i], g = idxOf.get(k);
      if (!g) { g = []; idxOf.set(k, g); groups.push(g); }
      g.push(i);
    });
    return groups;
  }

  /* ---------------- 排布主函数 ---------------- */

  /* opt: {
   *   scale: 1,              相对原始 UV 的尺寸倍率（滑杆）
   *   equalDensity: false,   统一贴图密度（按 3D 面积分配 UV 面积）
   *   padding: 0.004,
   *   parts: [0]             只排某些插槽（不传 = 全部）
   * }
   * → { ok, ops:{islandId:{s,tx,ty}}, fill, scale, notes:[] } */
  function pack(a, opt) {
    opt = opt || {};
    var pad = opt.padding == null ? PAD : Math.max(0, Number(opt.padding) || 0);
    var baseScale = opt.scale == null ? 1 : Math.max(0.01, Number(opt.scale) || 1);
    var density = !!opt.equalDensity;
    var only = (opt.parts && opt.parts.length) ? opt.parts.slice() : null;

    var groups = packGroups(a);
    if (only) {
      groups = groups.map(function (g) {
        return g.filter(function (pi) { return only.indexOf(pi) >= 0; });
      }).filter(function (g) { return g.length; });
    }

    var ops = {}, notes = [], fills = [], effective = 1;

    for (var gi = 0; gi < groups.length; gi++) {
      var gparts = groups[gi];
      /* 一组 = 一份 0–1 空间。组内的岛放在一起装，装不下才降级 */
      var tag = gparts.length > 1 ? (gparts.length + ' 个网格共用的 UV') : ('插槽 #' + (gparts[0] + 1));
      var recs = [];
      gparts.forEach(function (pi) {
        var part = a.parts[pi];
        islandsOf(a, pi).forEach(function (it) {
          recs.push({ id: it.id, tris: it.tris, pi: pi, box: islandBox(part, it.tris), k: baseScale, a3: 0 });
        });
      });
      if (!recs.length) continue;

      /* 统一密度：让每个岛满足「UV 面积 / 3D 面积」相同，即 k_i = sqrt(U·A3_i / (ΣA3·A2_i))。
       * 目的是贴图精度均匀——不然一个大岛占掉半张图、小岛只剩几个像素，同细节在大岛上糊。
       * 目标占用 U 取 0.55：装箱本身还有空隙，取满会一律触发降级。 */
      if (density) {
        var sum3 = 0, i, r;
        for (i = 0; i < recs.length; i++) {
          recs[i].a3 = islandArea3D(a.parts[recs[i].pi], recs[i].tris);
          sum3 += recs[i].a3;
        }
        var U = 0.55;
        for (i = 0; i < recs.length; i++) {
          r = recs[i];
          if (!(r.box.area > 0) || !(r.a3 > 0) || !(sum3 > 0)) continue;
          r.k = Math.sqrt(U * r.a3 / (sum3 * r.box.area)) * baseScale;
        }
      }

      /* 试装：先按用户给的大小，放不下再二分找「真能放下的最大档」。
       * 直接报错不如自动降级——用户拖到 180% 的意图是「再大一点」，不是「必须 180%」。 */
      function tryPack(f) {
        var sizes = recs.map(function (r, idx) {
          return { idx: idx, w: r.box.w * r.k * f + pad, h: r.box.h * r.k * f + pad };
        });
        sizes.sort(function (p, q) { return q.h - p.h || q.w - p.w; });
        var pos = skylinePack(sizes, 1 - pad, 1 - pad);
        if (!pos) return null;
        var out = [];
        for (var q = 0; q < sizes.length; q++) {
          var sz = sizes[q];
          out[sz.idx] = { x: pos[q].x + pad / 2, y: pos[q].y + pad / 2, w: sz.w, h: sz.h };
        }
        return out;
      }

      var used = 1, placed = tryPack(1);
      if (!placed) {
        var lo = 0.02, hi = 1;
        var rounds = recs.length > 1200 ? 8 : 14;
        for (var it = 0; it < rounds; it++) {
          var mid = (lo + hi) / 2;
          var t2 = tryPack(mid);
          if (t2) { lo = mid; placed = t2; } else hi = mid;
        }
        used = lo;
        if (!placed) {
          notes.push(tag + ' 的岛连最小倍率也放不下，已跳过');
          continue;
        }
        /* 报「最终倍率」而不是二分出来的系数：系数是叠在滑杆上的，
         * 写 77% 会让人以为比滑杆的 60% 还大（实际是 60%×77%）。 */
        notes.push(tag + ' 装不下，实际用 ' + Math.round(baseScale * used * 100) + '%' +
          '（设定 ' + Math.round(baseScale * 100) + '%）');
      }

      var fill = 0;
      for (var q2 = 0; q2 < recs.length; q2++) {
        var rc = recs[q2], pl = placed[q2];
        if (!pl) continue;
        var s = rc.k * used;
        var cx = (rc.box.x0 + rc.box.x1) / 2, cy = (rc.box.y0 + rc.box.y1) / 2;
        /* 内容（不含边距）居中放进「带边距的格子」里 */
        ops[rc.id] = { s: s, tx: pl.x + pl.w / 2 - cx * s, ty: pl.y + pl.h / 2 - cy * s };
        fill += rc.box.area * s * s;
      }
      fills.push(fill);
      if (used < effective) effective = used;
    }

    var avg = 0;
    for (var i2 = 0; i2 < fills.length; i2++) avg += fills[i2];
    if (fills.length) avg /= fills.length;

    return {
      ok: Object.keys(ops).length > 0,
      ops: ops, fill: Math.min(avg, 1),
      /* scale = 最终相对原始尺寸的倍率（滑杆值 × 放不下的妥协），不是内部系数 */
      scale: baseScale * effective,
      pad: pad, notes: notes
    };
  }

  /* ---------------- 写回几何 ---------------- */

  /* 拆顶点：每个三角形独立 3 个顶点，所有 attribute 照抄。
   * 只在「顶点被多个岛共享」时才用——UV 岛正常的模型，接缝处顶点早就分开了，
   * 那份原始几何可以直接原地改 UV，一个字节都不用重建。 */
  function deindexGeometry(part) {
    var g = part.g, n = part.tri * 3;
    var out = new THREE.BufferGeometry();
    var names = Object.keys(g.attributes);
    for (var a = 0; a < names.length; a++) {
      var name = names[a], src = g.attributes[name];
      var isz = src.itemSize;
      var dst = new Float32Array(n * isz);
      for (var t = 0; t < part.tri; t++) {
        for (var k = 0; k < 3; k++) {
          var v = vOf(part, t, k), o = (t * 3 + k) * isz;
          dst[o] = src.getX(v);
          if (isz > 1) dst[o + 1] = src.getY(v);
          if (isz > 2) dst[o + 2] = src.getZ(v);
          if (isz > 3) dst[o + 3] = src.getW(v);
        }
      }
      out.setAttribute(name, new THREE.BufferAttribute(dst, isz, src.normalized));
    }
    /* 多材质分组要跟着走：三角形顺序没变，只是索引被展平，start/count 原样可用 */
    if (g.groups && g.groups.length) {
      for (var gi = 0; gi < g.groups.length; gi++) {
        var gr = g.groups[gi];
        out.addGroup(gr.start, gr.count, gr.materialIndex);
      }
    }
    return out;
  }

  function apply(a, ops) {
    var meshes = meshOfGeometry(a);
    var rebuilt = [];
    a.parts.forEach(function (part, pi) {
      var recs = [];
      islandsOf(a, pi).forEach(function (it) {
        var op = ops[it.id];
        if (op) recs.push({ id: it.id, tris: it.tris, op: op });
      });
      if (!recs.length) return;

      /* 顶点 → 岛。一个顶点只能有一个 UV，出现两种归属就只能拆 */
      var owner = new Int32Array(part.pos.count);
      owner.fill(-1);
      var conflict = false;
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        for (var j = 0; j < r.tris.length; j++) {
          for (var k = 0; k < 3; k++) {
            var v = vOf(part, r.tris[j], k);
            if (owner[v] >= 0 && owner[v] !== r.id) conflict = true;
            else owner[v] = r.id;
          }
        }
      }

      if (conflict) {
        var newGeo = deindexGeometry(part);
        var mesh = meshes.get(part.g);
        if (mesh) mesh.geometry = newGeo;
        part.g = newGeo;
        part.pos = newGeo.attributes.position;
        part.uv = newGeo.attributes.uv;
        part.idx = null;
        rebuilt.push(pi);
      }

      /* 先把原 UV 抄一份：同一个顶点会被多条三角形引用，
       * 边读边写会把已经变换过的值再乘一次，岛直接缩成一点。 */
      var uv = part.uv, cnt = part.pos.count;
      var U0 = new Float32Array(cnt), V0 = new Float32Array(cnt), done = new Uint8Array(cnt);
      for (var v2 = 0; v2 < cnt; v2++) { U0[v2] = uv.getX(v2); V0[v2] = uv.getY(v2); }
      for (var i2 = 0; i2 < recs.length; i2++) {
        var r2 = recs[i2], s = r2.op.s, tx = r2.op.tx, ty = r2.op.ty;
        for (var j2 = 0; j2 < r2.tris.length; j2++) {
          for (var k2 = 0; k2 < 3; k2++) {
            var v3 = vOf(part, r2.tris[j2], k2);
            if (done[v3]) continue;
            done[v3] = 1;
            uv.setXY(v3, U0[v3] * s + tx, V0[v3] * s + ty);
          }
        }
      }
      uv.needsUpdate = true;
    });
    return { rebuilt: rebuilt };
  }

  /* 重算岛的 UV 包围盒 / 面积。岛图上编号的位置、面积筛选都读这两个字段 */
  function refresh(a) {
    if (!a || !a.islands) return;
    for (var i = 0; i < a.islands.length; i++) {
      var o = a.islands[i];
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
      for (var j = 0; j < o.tris.length; j++) {
        var ref = o.tris[j], part = a.parts[ref.part], uv = part.uv;
        var ia = vOf(part, ref.t, 0), ib = vOf(part, ref.t, 1), ic = vOf(part, ref.t, 2);
        var ax = uv.getX(ia), ay = uv.getY(ia);
        var bx = uv.getX(ib), by = uv.getY(ib);
        var cx = uv.getX(ic), cy = uv.getY(ic);
        if (ax < x0) x0 = ax; if (ax > x1) x1 = ax;
        if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
        if (bx < x0) x0 = bx; if (bx > x1) x1 = bx;
        if (by < y0) y0 = by; if (by > y1) y1 = by;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
      }
      if (isFinite(x0)) o.uvBBox = [x0, y0, x1, y1];
      o.area = area;
    }
  }

  /* ---------------- 基线：快照 / 还原 ----------------
   * 快照存「几何引用 + UV 副本 + 原贴图」三样。为什么存几何引用：
   * 拆过顶点的那份几何要能整个换回来，只还原 UV 数组救不了（顶点已经多出来了）。 */
  function snapshot(a) {
    var parts = a.parts.map(function (p) {
      return {
        g: p.g, pos: p.pos, uv: p.uv, idx: p.idx, tri: p.tri,
        uv0: new Float32Array(p.uv.array)
      };
    });
    var mats = [];
    if (a.root && a.root.traverse) {
      a.root.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < ms.length; i++) {
          if (ms[i] && mats.indexOf(ms[i]) < 0) mats.push(ms[i]);
        }
      });
    }
    return {
      parts: parts,
      maps: mats.map(function (m) { return { mat: m, map: m.map || null }; })
    };
  }

  function restore(a, snap) {
    if (!snap || !snap.parts) return false;
    var meshes = meshOfGeometry(a);
    a.parts.forEach(function (p, i) {
      var s = snap.parts[i];
      if (!s) return;
      if (p.g !== s.g) {
        var mesh = meshes.get(p.g);
        if (mesh) mesh.geometry = s.g;
      }
      p.g = s.g; p.pos = s.pos; p.uv = s.uv; p.idx = s.idx; p.tri = s.tri;
      try { p.uv.array.set(s.uv0); p.uv.needsUpdate = true; } catch (e) {}
    });
    for (var i = 0; i < (snap.maps || []).length; i++) {
      var r = snap.maps[i];
      if (!r.mat) continue;
      r.mat.map = r.map;
      r.mat.needsUpdate = true;
    }
    refresh(a);
    return true;
  }

  /* ---------------- 贴图重采样 ----------------
   * UV 变了，mat.map 不会自己跟着动。这里按三角形把旧图「投影」到新位置：
   * 新图每个像素 → 重心坐标 → 旧图的 UV → 采样旧像素。等价于在 UV 空间里做一次重映射，
   * 形状不变、只换位置和大小，所以不需要重新渲染，色块贴图基本无损。
   *
   * flipY 必须跟着旧图：glTF 的贴图是 flipY=false（图原点在左上），OBJ / CanvasTexture
   * 是 true。搞反了整张贴图上下颠倒——这个坑在材质插槽的 GLB 导出里踩过一次了。 */
  function remapTextures(a, snap) {
    if (!snap || !snap.parts) return { ok: false, count: 0 };
    var partOf = new Map();
    a.parts.forEach(function (p, i) { partOf.set(p.g, i); });

    /* 材质 → part 列表。一个材质可能被多个 mesh 共用，必须攒齐再一次性换贴图，
     * 否则后处理的那个 part 用的是刚生成的半成品。 */
    var recs = [], byMat = new Map();
    if (!a.root || !a.root.traverse) return { ok: false, count: 0 };
    a.root.traverse(function (o) {
      if (!o.isMesh || !o.material || !o.geometry) return;
      var pi = partOf.has(o.geometry) ? partOf.get(o.geometry) : -1;
      if (pi < 0) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m, mi) {
        if (!m || !m.map || !m.map.image) return;
        var rec = byMat.get(m);
        if (!rec) { rec = { mat: m, ranges: [] }; byMat.set(m, rec); recs.push(rec); }
        /* 多材质 mesh 靠 groups 限定三角形范围，否则一张图里会被画进别人的 UV */
        var g = o.geometry, added = false;
        if (g.groups && g.groups.length > 1) {
          for (var i = 0; i < g.groups.length; i++) {
            if (g.groups[i].materialIndex !== mi) continue;
            rec.ranges.push([pi, Math.floor(g.groups[i].start / 3), Math.floor((g.groups[i].start + g.groups[i].count) / 3)]);
            added = true;
          }
        }
        if (!added) rec.ranges.push([pi, 0, a.parts[pi].tri]);
      });
    });
    if (!recs.length) return { ok: true, count: 0 };

    var count = 0;
    for (var ri = 0; ri < recs.length; ri++) {
      var rec = recs[ri], tex = rec.mat.map, img = tex.image;
      var W0 = img.width || img.videoWidth || 0, H0 = img.height || img.videoHeight || 0;
      if (!W0 || !H0) continue;
      /* 超过上限就降采样：UV 是归一化的，目标图小一点不影响贴图对位 */
      var sc = Math.min(1, TEX_MAX / Math.max(W0, H0));
      var W = Math.max(4, Math.round(W0 * sc)), H = Math.max(4, Math.round(H0 * sc));

      var srcCv = document.createElement('canvas');
      srcCv.width = W; srcCv.height = H;
      var sctx = srcCv.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(img, 0, 0, W, H);
      var sd = sctx.getImageData(0, 0, W, H).data;

      var dstCv = document.createElement('canvas');
      dstCv.width = W; dstCv.height = H;
      var dctx = dstCv.getContext('2d');
      var outImg = dctx.createImageData(W, H);
      var od = outImg.data;

      var flip = tex.flipY !== false;                       // 与旧图一致
      var pv = function (v) { return flip ? (1 - v) * H : v * H; };

      /* 双线性采样（源图像素坐标）。最近邻会让色块边缘变锯齿，代价只是多 3 次取值 */
      function sample(sx, sy, o4) {
        sx -= 0.5; sy -= 0.5;
        if (sx < 0) sx = 0; else if (sx > W - 1) sx = W - 1;
        if (sy < 0) sy = 0; else if (sy > H - 1) sy = H - 1;
        var x0 = Math.floor(sx), y0 = Math.floor(sy);
        var x1 = x0 + 1 < W ? x0 + 1 : W - 1, y1 = y0 + 1 < H ? y0 + 1 : H - 1;
        var fx = sx - x0, fy = sy - y0;
        var i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
        var i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        var w01 = (1 - fx) * fy, w11 = fx * fy;
        for (var c = 0; c < 4; c++) {
          o4[c] = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
        }
      }

      var tmp = [0, 0, 0, 0];
      for (var q = 0; q < rec.ranges.length; q++) {
        var pi = rec.ranges[q][0], t0 = rec.ranges[q][1], t1 = rec.ranges[q][2];
        var part = a.parts[pi], sp = snap.parts[pi];
        if (!part || !sp) continue;
        var cuv = part.uv, ni = part.idx, oi = sp.idx, ou = sp.uv0;
        var tri1 = Math.min(t1, part.tri);
        for (var t = t0; t < tri1; t++) {
          var oa = oi ? oi.getX(t * 3) : t * 3, ob = oi ? oi.getX(t * 3 + 1) : t * 3 + 1, oc = oi ? oi.getX(t * 3 + 2) : t * 3 + 2;
          var na = ni ? ni.getX(t * 3) : t * 3, nb = ni ? ni.getX(t * 3 + 1) : t * 3 + 1, nc = ni ? ni.getX(t * 3 + 2) : t * 3 + 2;
          /* 新三角 → 像素坐标（写目标图的坐标系） */
          var ax = cuv.getX(na) * W, ay = pv(cuv.getY(na));
          var bx = cuv.getX(nb) * W, by = pv(cuv.getY(nb));
          var cx = cuv.getX(nc) * W, cy = pv(cuv.getY(nc));
          var den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
          if (!isFinite(den) || Math.abs(den) < 1e-9) continue;
          var minx = Math.floor(Math.min(ax, bx, cx)) - 1, maxx = Math.ceil(Math.max(ax, bx, cx)) + 1;
          var miny = Math.floor(Math.min(ay, by, cy)) - 1, maxy = Math.ceil(Math.max(ay, by, cy)) + 1;
          if (minx < 0) minx = 0; if (miny < 0) miny = 0;
          if (maxx > W) maxx = W; if (maxy > H) maxy = H;
          if (minx >= maxx || miny >= maxy) continue;
          /* 旧三角的三个角在旧图里的像素坐标 */
          var oax = ou[oa * 2] * W, oay = pv(ou[oa * 2 + 1]);
          var obx = ou[ob * 2] * W, oby = pv(ou[ob * 2 + 1]);
          var ocx = ou[oc * 2] * W, ocy = pv(ou[oc * 2 + 1]);
          for (var py = miny; py < maxy; py++) {
            var fy = py + 0.5;
            for (var px = minx; px < maxx; px++) {
              var fx = px + 0.5;
              var l0 = ((by - cy) * (fx - cx) + (cx - bx) * (fy - cy)) / den;
              var l1 = ((cy - ay) * (fx - cx) + (ax - cx) * (fy - cy)) / den;
              var l2 = 1 - l0 - l1;
              /* -0.02 的容差 = 边缘外扩约 1px：不留这点余量，岛边界上会有一圈黑缝 */
              if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
              sample(l0 * oax + l1 * obx + l2 * ocx, l0 * oay + l1 * oby + l2 * ocy, tmp);
              var idx4 = (py * W + px) * 4;
              od[idx4] = tmp[0]; od[idx4 + 1] = tmp[1]; od[idx4 + 2] = tmp[2]; od[idx4 + 3] = tmp[3];
            }
          }
        }
      }

      dctx.putImageData(outImg, 0, 0);
      var nt = new THREE.CanvasTexture(dstCv);
      nt.flipY = flip;
      if ('encoding' in nt && tex.encoding != null) nt.encoding = tex.encoding;
      nt.wrapS = tex.wrapS || THREE.RepeatWrapping;
      nt.wrapT = tex.wrapT || THREE.RepeatWrapping;
      nt.anisotropy = tex.anisotropy || 4;
      nt.name = (tex.name || 'uvpack') + '_packed';
      nt.needsUpdate = true;
      rec.mat.map = nt;
      rec.mat.needsUpdate = true;
      count++;
    }
    return { ok: true, count: count };
  }

  function exportGLB(a) {
    if (!THREE.GLTFExporter) throw new Error('GLTFExporter 未加载（vendor/GLTFExporter.js）');
    var exp = new THREE.GLTFExporter();
    return new Promise(function (res, rej) {
      exp.parse(a.root, res, rej, { binary: true });
    }).then(function (r) {
      if (!(r instanceof ArrayBuffer)) throw new Error('GLB 导出结果异常');
      return r;
    });
  }

  /* ---------------- 缝合碎岛：把「脱离主岛」的碎片 UV 拉回主岛 ----------------
   * AI 生成模型自动展 UV 的典型遗留：一小片一小片的面在 UV 上被切出主岛，
   * 碎片 UV 还被丢进主岛内部（重叠）。这些面本身有用——3D 顶点与主岛完全重合、
   * 就贴在主表面上——不该删，也不能当独立岛参与逐岛处理：
   * 逐岛投射 / 上色时碎片各自归到别的视图，表面就出一堆杂色小斑。
   *
   * 修法（只写 UV、不动 3D，主岛顶点一个不碰）：
   *   · 碎片顶点位置与主岛顶点重合的（缝边），直接复制主岛侧顶点的 UV——
   *     ModelTex 按「UV 数值」分岛，数值完全一致，重算后碎片自动并入主岛；
   *   · 其余顶点在主岛表面上找最近点，按重心坐标插值 UV。
   * opt: {
   *   maxTris: 8,    面数 ≤ 它的岛算碎片（用户场景是 1–4 面的碎四边形）
   *   minShare: 2,   与主岛至少共享几个 3D 顶点位置才缝（1 个可能是巧合重合，不碰）
   * }
   * → { ok, merged, skipped, rebuilt:[partIdx], notes:[] } */
  function stitch(a, opt) {
    opt = opt || {};
    var maxTris = opt.maxTris == null ? 8 : Math.max(1, opt.maxTris | 0);
    var minShare = opt.minShare == null ? 2 : Math.max(1, opt.minShare | 0);
    var merged = 0, skipped = 0, skipShare = 0, skipFar = 0, rebuilt = [];
    var notes = [];

    /* 点到三角形最近点（Ericson 5.1.5），返回 { d2, l0, l1, l2 }（A/B/C 重心权重） */
    function closestTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
      var abx = bx - ax, aby = by - ay, abz = bz - az;
      var acx = cx - ax, acy = cy - ay, acz = cz - az;
      var apx = px - ax, apy = py - ay, apz = pz - az;
      var d1 = abx * apx + aby * apy + abz * apz;
      var d2 = acx * apx + acy * apy + acz * apz;
      if (d1 <= 0 && d2 <= 0) return { d2: apx * apx + apy * apy + apz * apz, l0: 1, l1: 0, l2: 0 };
      var bpx = px - bx, bpy = py - by, bpz = pz - bz;
      var d3 = abx * bpx + aby * bpy + abz * bpz;
      var d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) return { d2: bpx * bpx + bpy * bpy + bpz * bpz, l0: 0, l1: 1, l2: 0 };
      var vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        var t = d1 / (d1 - d3);
        var qx = ax + abx * t - px, qy = ay + aby * t - py, qz = az + abz * t - pz;
        return { d2: qx * qx + qy * qy + qz * qz, l0: 1 - t, l1: t, l2: 0 };
      }
      var cpx = px - cx, cpy = py - cy, cpz = pz - cz;
      var d5 = abx * cpx + aby * cpy + abz * cpz;
      var d6 = acx * cpx + acy * cpy + acz * cpz;
      if (d6 >= 0 && d5 <= d6) return { d2: cpx * cpx + cpy * cpy + cpz * cpz, l0: 0, l1: 0, l2: 1 };
      var vb = d5 * d2 - d1 * d6;
      if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        var w = d2 / (d2 - d6);
        var rx = ax + acx * w - px, ry = ay + acy * w - py, rz = az + acz * w - pz;
        return { d2: rx * rx + ry * ry + rz * rz, l0: 1 - w, l1: 0, l2: w };
      }
      var va = d3 * d6 - d5 * d4;
      if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        var wb = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        var sx = bx + (cx - bx) * wb - px, sy = by + (cy - by) * wb - py, sz = bz + (cz - bz) * wb - pz;
        return { d2: sx * sx + sy * sy + sz * sz, l0: 0, l1: 1 - wb, l2: wb };
      }
      var den = va + vb + vc;
      var v = vb / den, w = vc / den;
      var fx = ax + abx * v + acx * w - px, fy = ay + aby * v + acy * w - py, fz = az + abz * v + acz * w - pz;
      return { d2: fx * fx + fy * fy + fz * fz, l0: 1 - v - w, l1: v, l2: w };
    }

    a.parts.forEach(function (part, pi) {
      var isl = islandsOf(a, pi);
      if (isl.length < 2) return;
      var mains = [], smalls = [];
      isl.forEach(function (it) { (it.tris.length <= maxTris ? smalls : mains).push(it); });
      if (!smalls.length || !mains.length) return;

      /* 碎片顶点要单独改 UV：若顶点被多个岛共享就先拆顶点（与 apply 同一机制） */
      var owner = new Int32Array(part.pos.count);
      owner.fill(-1);
      var conflict = false;
      isl.forEach(function (it) {
        for (var j = 0; j < it.tris.length; j++) {
          for (var k = 0; k < 3; k++) {
            var v0 = vOf(part, it.tris[j], k);
            if (owner[v0] >= 0 && owner[v0] !== it.id) conflict = true;
            else owner[v0] = it.id;
          }
        }
      });
      if (conflict) {
        var newGeo = deindexGeometry(part);
        var mesh = meshOfGeometry(a).get(part.g);
        if (mesh) mesh.geometry = newGeo;
        part.g = newGeo;
        part.pos = newGeo.attributes.position;
        part.uv = newGeo.attributes.uv;
        part.idx = null;
        rebuilt.push(pi);
      }

      /* 主岛准备：每个主岛的包围盒（候选筛选）+ 容差空间哈希 + 三角形列表。
       * 位置指纹不能用 1e-5 量化——OBJ 文本坐标过 float32 往返后在 1e-5 网格上
       * 会跨格，缝边就对不上了（实测 1667 个碎岛只缝上 129 个）。
       * 网格哈希 cell = 主岛包围盒对角线的 1e-3，匹配距离 ≤ cell/2，
       * 远大于精度损失、又远小于真实网格顶点间距。 */
      var x0p = 1e30, y0p = 1e30, z0p = 1e30, x1p = -1e30, y1p = -1e30, z1p = -1e30;
      mains.forEach(function (it) {
        for (var j = 0; j < it.tris.length; j++) {
          for (var k = 0; k < 3; k++) {
            var v = vOf(part, it.tris[j], k);
            var x = part.pos.getX(v), y = part.pos.getY(v), z = part.pos.getZ(v);
            if (x < x0p) x0p = x; if (x > x1p) x1p = x;
            if (y < y0p) y0p = y; if (y > y1p) y1p = y;
            if (z < z0p) z0p = z; if (z > z1p) z1p = z;
          }
        }
      });
      var diag = Math.sqrt((x1p - x0p) * (x1p - x0p) + (y1p - y0p) * (y1p - y0p) + (z1p - z0p) * (z1p - z0p));
      var cell = Math.max(diag * 1e-3, 1e-9), half2 = (cell * 0.5) * (cell * 0.5);
      var buckets = new Map();
      function bKey(x, y, z) {
        return Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
      }
      /* 每个主岛：bbox（找候选）+ 顶点哈希（缝边精确复制 UV 用） */
      var mainRecs = mains.map(function (it) {
        var x0 = 1e30, y0 = 1e30, z0 = 1e30, x1 = -1e30, y1 = -1e30, z1 = -1e30;
        for (var j = 0; j < it.tris.length; j++) {
          for (var k = 0; k < 3; k++) {
            var v = vOf(part, it.tris[j], k);
            var x = part.pos.getX(v), y = part.pos.getY(v), z = part.pos.getZ(v);
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
          }
        }
        return { it: it, tris: it.tris, bbox: [x0, y0, z0, x1, y1, z1] };
      });
      mains.forEach(function (it, mi) {
        for (var j = 0; j < it.tris.length; j++) {
          for (var k = 0; k < 3; k++) {
            var v = vOf(part, it.tris[j], k);
            var key = bKey(part.pos.getX(v), part.pos.getY(v), part.pos.getZ(v));
            var arr = buckets.get(key);
            if (!arr) { arr = []; buckets.set(key, arr); }
            arr.push({ v: v, mi: mi });
          }
        }
      });
      /* 27 邻域里找所有距离 ≤ cell/2 的主岛顶点（同位置的切缝副本全都会命中） */
      function lookup(px, py, pz) {
        var out = [];
        var gx = Math.floor(px / cell), gy = Math.floor(py / cell), gz = Math.floor(pz / cell);
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            for (var dz = -1; dz <= 1; dz++) {
              var arr = buckets.get((gx + dx) + ',' + (gy + dy) + ',' + (gz + dz));
              if (!arr) continue;
              for (var i = 0; i < arr.length; i++) {
                var e = arr[i];
                var ex = part.pos.getX(e.v) - px, ey = part.pos.getY(e.v) - py, ez = part.pos.getZ(e.v) - pz;
                var d2 = ex * ex + ey * ey + ez * ez;
                if (d2 <= half2) out.push({ v: e.v, mi: e.mi, d2: d2 });
              }
            }
          }
        }
        return out;
      }

      var partMerged = 0;
      /* 从最小的碎片开始缝：碎片群是「小碎片贴小碎片再贴主岛」的链，
       * 先缝最小的，它并进主岛后，贴着它的碎片下一轮才有大邻居可缝 */
      smalls.sort(function (p, q) { return p.tris.length - q.tris.length; });
      smalls.forEach(function (sm) {
        var pos = part.pos, uvA = part.uv;
        var sVerts = [], seen = {}, matches = {}, cnt = {};
        var sx0 = 1e30, sy0 = 1e30, sz0 = 1e30, sx1 = -1e30, sy1 = -1e30, sz1 = -1e30;
        for (var j = 0; j < sm.tris.length; j++) {
          for (var k = 0; k < 3; k++) {
            var v = vOf(part, sm.tris[j], k);
            if (!seen[v]) {
              seen[v] = 1; sVerts.push(v);
              var x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
              if (x < sx0) sx0 = x; if (x > sx1) sx1 = x;
              if (y < sy0) sy0 = y; if (y > sy1) sy1 = y;
              if (z < sz0) sz0 = z; if (z > sz1) sz1 = z;
              matches[v] = lookup(x, y, z);
              var hitIslands = {};
              for (var h = 0; h < matches[v].length; h++) hitIslands[matches[v][h].mi] = 1;
              for (var mi in hitIslands) cnt[mi] = (cnt[mi] || 0) + 1;
            }
          }
        }
        /* 候选主岛：① 有 ≥minShare 个碎片顶点精确贴上主岛顶点的；
         * ② 兜底——碎片贴在主面的边/内部而不是顶点上时顶点匹配不到，
         *    用「主岛 bbox（膨胀 2%）包含碎片 bbox」再筛一轮，交给投影择优。 */
        var cands = [];
        for (var m2 in cnt) {
          if (cnt[m2] >= minShare) cands.push(+m2);
        }
        if (!cands.length) {
          /* 兜底用「bbox 相交」而不是包含：贴在主岛边缘的碎片 bbox 常常
           * 稍微越出主岛 bbox，包含判定会把大量贴面碎片误判成孤岛 */
          var pad2 = diag * 0.02;
          for (var mi2 = 0; mi2 < mainRecs.length; mi2++) {
            var b2 = mainRecs[mi2].bbox;
            if (sx0 <= b2[3] + pad2 && sx1 >= b2[0] - pad2 &&
                sy0 <= b2[4] + pad2 && sy1 >= b2[1] - pad2 &&
                sz0 <= b2[5] + pad2 && sz1 >= b2[2] - pad2) cands.push(mi2);
          }
        }
        if (!cands.length) { skipped++; skipShare++; return; }

        /* 对每个候选试算完整方案，取「顶点到主岛表面平均距离」最小者。
         * 碎片顶点往往落在主面的边/内部，平均距离就是「这片碎片贴没贴着主岛」的判据。 */
        var bestPlan = null, bestDist = Infinity, bestMi = -1;
        for (var ci = 0; ci < cands.length; ci++) {
          var cand = cands[ci];
          var mrTris = mainRecs[cand].tris;
          var plan = [], distSum = 0, failed = false;
          for (var i2 = 0; i2 < sVerts.length; i2++) {
            var v2 = sVerts[i2];
            var px = pos.getX(v2), py = pos.getY(v2), pz = pos.getZ(v2);
            var same = (matches[v2] || []).filter(function (e) { return e.mi === cand; });
            var nu = null, nv = null, d3 = 0;
            if (same.length) {
              /* 缝边顶点：直接复制主岛侧的 UV。切缝两侧副本 UV 不同时，
               * 取「与碎片原 UV 最近」的那个——碎片原来采样主岛内部，
               * 靠得近的那份副本才是语义对应的，缝过去颜色不跳。 */
              var ou = uvA.getX(v2), ov = uvA.getY(v2), bd = Infinity;
              for (var h2 = 0; h2 < same.length; h2++) {
                var du = uvA.getX(same[h2].v) - ou, dv = uvA.getY(same[h2].v) - ov;
                var dd = du * du + dv * dv;
                if (dd < bd) { bd = dd; nu = uvA.getX(same[h2].v); nv = uvA.getY(same[h2].v); }
              }
            } else {
              /* 自由顶点：在主岛表面上找最近点，按重心坐标插值 UV */
              var bd2 = Infinity, bl = null;
              for (var j2 = 0; j2 < mrTris.length; j2++) {
                var t3 = mrTris[j2];
                var ia = vOf(part, t3, 0), ib = vOf(part, t3, 1), ic = vOf(part, t3, 2);
                var r3 = closestTri(px, py, pz,
                  pos.getX(ia), pos.getY(ia), pos.getZ(ia),
                  pos.getX(ib), pos.getY(ib), pos.getZ(ib),
                  pos.getX(ic), pos.getY(ic), pos.getZ(ic));
                if (r3.d2 < bd2) {
                  bd2 = r3.d2;
                  bl = [
                    uvA.getX(ia) * r3.l0 + uvA.getX(ib) * r3.l1 + uvA.getX(ic) * r3.l2,
                    uvA.getY(ia) * r3.l0 + uvA.getY(ib) * r3.l1 + uvA.getY(ic) * r3.l2
                  ];
                }
              }
              if (!bl || !isFinite(bl[0]) || !isFinite(bl[1])) { failed = true; break; }
              d3 = Math.sqrt(bd2);
              nu = bl[0]; nv = bl[1];
            }
            distSum += d3;
            plan.push([v2, nu, nv]);
          }
          if (failed) continue;
          var avg = distSum / sVerts.length;
          if (avg < bestDist) { bestDist = avg; bestPlan = plan; bestMi = cand; }
        }
        if (!bestPlan || bestDist > diag * 0.02) { skipped++; skipFar++; return; }
        for (var i3 = 0; i3 < bestPlan.length; i3++) {
          uvA.setXY(bestPlan[i3][0], bestPlan[i3][1], bestPlan[i3][2]);
        }
        /* 级联：碎片三角形、顶点、bbox 都并进主岛记录——贴在这片碎片上的
         * 下一片碎片才有邻居可缝，碎片群才能一路收进主岛 */
        var mr2 = mainRecs[bestMi];
        for (var j3 = 0; j3 < sm.tris.length; j3++) mr2.tris.push(sm.tris[j3]);
        for (var i4 = 0; i4 < sVerts.length; i4++) {
          var v4 = sVerts[i4];
          var key4 = bKey(pos.getX(v4), pos.getY(v4), pos.getZ(v4));
          var arr4 = buckets.get(key4);
          if (!arr4) { arr4 = []; buckets.set(key4, arr4); }
          arr4.push({ v: v4, mi: bestMi });
        }
        var b3 = mr2.bbox;
        if (sx0 < b3[0]) b3[0] = sx0; if (sx1 > b3[3]) b3[3] = sx1;
        if (sy0 < b3[1]) b3[1] = sy0; if (sy1 > b3[4]) b3[4] = sy1;
        if (sz0 < b3[2]) b3[2] = sz0; if (sz1 > b3[5]) b3[5] = sz1;
        merged++; partMerged++;
      });

      if (partMerged || rebuilt.indexOf(pi) >= 0) part.uv.needsUpdate = true;
    });

    if (merged) notes.push('已缝合 ' + merged + ' 个碎岛（面数 ≤' + maxTris + '）');
    if (skipFar) notes.push(skipFar + ' 个碎岛离最近的主岛太远，保持原样');
    if (skipShare) notes.push(skipShare + ' 个碎岛周围没有主岛，保持原样');
    return { ok: merged > 0, merged: merged, skipped: skipped, rebuilt: rebuilt, notes: notes };
  }

  global.UvPack = {
    pack: pack,
    apply: apply,
    refresh: refresh,
    snapshot: snapshot,
    restore: restore,
    remapTextures: remapTextures,
    exportGLB: exportGLB,
    stitch: stitch,
    groups: packGroups,
    PAD: PAD
  };
})(window);
