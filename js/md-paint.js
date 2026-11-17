/* 绘画工具箱：把笔刷颜色画成材质槽上的一层「笔迹」
 *
 * 贴图真源是「底座 + 编辑层栈」（js/tex-stack.js）。**一笔 = 一个 stroke 层**：
 *   - 工作副本 canvas 只用于视口预览（底座 ⊕ 已有层 ⊕ 这一笔，边画边看）；
 *   - 同时有一张**透明底**的 ink canvas 只收这一笔的像素，抬笔时作为增量图入栈。
 * 以前是抬笔就把整张工作副本编码回 doc.materials.slotMaps，于是
 * 「画一笔 = 丢一笔可编辑性 + 一次 2048² PNG 重编码 + 把投射层/混合层烙进基础图」。
 *
 * 为什么拆出来：这段是「射线求交 + UV 岛剪裁 + canvas 工作区 + 贴图历史」
 * 一条完整链路，只依赖外壳的材质/重建动作，不该继续长在 model-desk.js 里。
 *
 * 分工：
 *   - 本模块：落笔判定、笔画、提交（推层）、撤销补丁
 *   - 外壳：右侧工具箱 UI、指针事件路由、材质重建
 *
 * 对外（window.MDPaint）：create(ctx) → { begin, move, end, cancel, applyPatch }
 * 外壳同名门面 paintStrokeBegin / paintStrokeMove / paintStrokeEnd / paintClipRelease /
 * applyPaintPatch 保持原调用点不变。
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var st = ctx.st, THREE = ctx.THREE, SeedModel = ctx.SeedModel;
    var sharedTexture = ctx.sharedTexture;
    var setStatus = ctx.setStatus, updateChrome = ctx.updateChrome;
    var rebuildModel = ctx.rebuildModel, paintAll = ctx.paintAll;
    var uvRefreshSolidGeometry = ctx.uvRefreshSolidGeometry;
    var totalBytes = ctx.totalBytes, syncBytes = ctx.syncBytes;
    var HISTORY_BUDGET = ctx.historyBudget;
    var visibleMesh = ctx.visibleMesh;

    var PAINT_MAX = (global.TexStack && global.TexStack.MAX_SIDE) || 2048;
    /* 笔刷采样与脏块口径都收在 js/paint-stroke.js（纯函数，Node 可测） */
    var PS = global.PaintStroke || null;
    /* 预览纹理局部上传：只把笔刷包围盒写进纹理，不再整张 2048² 重传。
     * 实例由外壳创建并同时交给混合模块 —— 一张纹理只能有一个上传者。 */
    var UP = ctx.upload || null;

    /* 射线求交的临时对象：拖动时一秒要跑几十次，反复 new 会让 GC 在笔迹中间抖一下 */
    var _rc = null, _ndc = new THREE.Vector2(), _inv = new THREE.Matrix4();
    var _org = new THREE.Vector3(), _dir = new THREE.Vector3();

    /* 单面求交的命中槽（避免每次 return 一个临时对象） */
    var _hfT = 0, _hfK = -1, _hfU = 0, _hfV = 0;
    /* 上一笔落在哪张面：拖动时先原地试，命中就省掉整份网格的线性扫描 */
    var _stickyM = null, _stickyFace = -1;

    /* 面是否朝向射线：只看首三角的法线。续笔快路径必须先过这一关，
     * 否则拖过轮廓线时光线会穿过模型、从背面命中上一张面，画到看不见的地方。 */
    function faceFacing(f, pos, off, idx, d) {
      var s = off[f], e = off[f + 1];
      if (e - s < 3) return false;
      var i0 = idx[s] * 3, i1 = idx[s + 1] * 3, i2 = idx[s + 2] * 3;
      var ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
      var vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      return (nx * d.x + ny * d.y + nz * d.z) < 0;
    }

    function hitOneFace(f, pos, off, idx, o, d) {
      var s = off[f], e = off[f + 1];
      if (e - s < 3) return false;
      var i0 = idx[s] * 3;
      var ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
      var bestT = Infinity, bestK = -1, bu = 0, bv = 0;
      for (var k = s + 1; k < e - 1; k++) {
        var i1 = idx[k] * 3, i2 = idx[k + 1] * 3;
        var e1x = pos[i1] - ax, e1y = pos[i1 + 1] - ay, e1z = pos[i1 + 2] - az;
        var e2x = pos[i2] - ax, e2y = pos[i2 + 1] - ay, e2z = pos[i2 + 2] - az;
        var px1 = d.y * e2z - d.z * e2y, py1 = d.z * e2x - d.x * e2z, pz1 = d.x * e2y - d.y * e2x;
        var det = e1x * px1 + e1y * py1 + e1z * pz1;
        if (det > -1e-9 && det < 1e-9) continue;
        var iv = 1 / det;
        var tx = o.x - ax, ty = o.y - ay, tz = o.z - az;
        var u = (tx * px1 + ty * py1 + tz * pz1) * iv;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        var v = (d.x * qx + d.y * qy + d.z * qz) * iv;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        var t = (e2x * qx + e2y * qy + e2z * qz) * iv;
        if (t > 1e-6 && t < bestT) { bestT = t; bestK = k; bu = u; bv = v; }
      }
      if (bestK < 0) return false;
      _hfT = bestT; _hfK = bestK; _hfU = bu; _hfV = bv;
      return true;
    }

    /* 屏幕点 → 网格局部射线 → 最近三角形，返回面的材质槽 + 重心插值出来的 UV。
     * 网格取自视口可见性：面级隔离时只剩替身网格里的面，画不到被藏起来的部分。 */
    function paintRayHit(px, py) {
      if (!st.mesh || !st.pivot || !st.camera) return null;
      var m = visibleMesh(st.node ? st.node.id : '');
      if (!m) return null;
      var r = st.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      var ndc = _ndc.set((px / r.width) * 2 - 1, -((py / r.height) * 2 - 1));
      var rc = _rc || (_rc = new THREE.Raycaster());
      rc.setFromCamera(ndc, st.camera);
      var inv = _inv.copy(st.pivot.matrixWorld).invert();
      var o = _org.copy(rc.ray.origin).applyMatrix4(inv);
      var d = _dir.copy(rc.ray.direction).transformDirection(inv);
      var pos = m.positions, off = m.faceOffsets, idx = m.faceIndices;
      var bestT = Infinity, bestF = -1, bestK = -1, bu = 0, bv = 0;
      /* 续笔快路径：笔画通常还压在刚才那张面上，先只测它。
       * 整份网格的线性扫描在几十万三角面的模型上每次好几毫秒，
       * 合并到 rAF 也只有 60 次/秒，仍然会把拖动拖钝。 */
      if (_stickyM === m && _stickyFace >= 0 && _stickyFace < m.faceIds.length &&
          faceFacing(_stickyFace, pos, off, idx, d) &&
          hitOneFace(_stickyFace, pos, off, idx, o, d)) {
        bestF = _stickyFace; bestT = _hfT; bestK = _hfK; bu = _hfU; bv = _hfV;
      } else {
        for (var f = 0; f < m.faceIds.length; f++) {
          /* 背面直接跳过：封闭模型里约一半的面朝后，不参与求交就省掉一半以上的计算。
           * 与粘面快路径同一口径（faceFacing），不会出现两条路径命中规则不一致。 */
          if (!faceFacing(f, pos, off, idx, d)) continue;
          if (!hitOneFace(f, pos, off, idx, o, d)) continue;
          if (_hfT < bestT) { bestT = _hfT; bestF = f; bestK = _hfK; bu = _hfU; bv = _hfV; }
        }
      }
      _stickyM = m; _stickyFace = bestF;
      if (bestF < 0) return null;
      var slot = m.faceSlots[bestF] || 0;
      var uu = 0, vv = 0;
      if (m.uvs && m.uvs.length === m.faceIndices.length * 2) {
        /* 扇形三角化：三角 (s, k, k+1)，UV 也按同一组面角取 */
        var s2 = off[bestF];
        var uv0 = [m.uvs[s2 * 2], m.uvs[s2 * 2 + 1]];
        var uv1 = [m.uvs[bestK * 2], m.uvs[bestK * 2 + 1]];
        var uv2 = [m.uvs[(bestK + 1) * 2], m.uvs[(bestK + 1) * 2 + 1]];
        var w0 = 1 - bu - bv;
        uu = uv0[0] * w0 + uv1[0] * bu + uv2[0] * bv;
        vv = uv0[1] * w0 + uv1[1] * bu + uv2[1] * bv;
      }
      /* face 是可见网格里的下标，faceId 才是能回到整份网格的稳定标识：
       * 岛遮罩（paintClipBegin）要在整份网格上查岛，必须用 faceId。 */
      return { face: bestF, faceId: m.faceIds[bestF], slot: slot, u: uu, v: vv };
    }

    /* UV 岛遮罩：把「落笔那张面所在的岛」的 UV 多边形换算到画布像素空间。
     * 岛是 UV 空间的连续区域；相邻岛即使共用一条 3D 边，UV 上也互不重叠，
     * 所以用岛的并集做 clip 就能挡住笔刷溢到别的区域。 */
    function paintIslandPolys(faceIndex, w, h, info) {
      var m = st.mesh, off = m.faceOffsets, uvs = m.uvs;
      var faces = null;
      try {
        if (!info) info = SeedModel.Mesh.uvIslands(m);
        var iid = info.faceIsland[faceIndex];
        if (iid != null && iid >= 0 && info.islands[iid]) faces = info.islands[iid].faces;
      } catch (e) { faces = null; }
      if (!faces || !faces.length) faces = [faceIndex];
      var polys = [];
      for (var i = 0; i < faces.length; i++) {
        var f = faces[i], s = off[f], e = off[f + 1];
        if (e - s < 3) continue;
        var poly = [];
        for (var k = s; k < e; k++) {
          /* v 轴向上：UV v=0 在画布底边（与 CanvasTexture 的 flipY 一致） */
          poly.push([uvs[k * 2] * w, (1 - uvs[k * 2 + 1]) * h]);
        }
        polys.push(poly);
      }
      /* UV 明显超出 0–1（平铺 / atlas）时岛多边形落在画布外，clip 会把整笔裁成空。
       * 这种模型宁可不遮罩：先保证画得上，比「静默无反应」好。
       * 容差 1%：接缝处的浮点误差仍按正常岛裁剪。 */
      for (var q = 0; q < faces.length; q++) {
        var f2 = faces[q], s2 = off[f2], e2 = off[f2 + 1];
        for (var j = s2; j < e2; j++) {
          var uu = uvs[j * 2], vv = uvs[j * 2 + 1];
          if (uu < -0.01 || uu > 1.01 || vv < -0.01 || vv > 1.01) return [];
        }
      }
      return polys;
    }

    /* 指定面的 UV 多边形（画布像素坐标）。组件隔离与对象隔离的绘制范围都从这里来。
     * UV 明显超出 0–1（平铺 / atlas）时返回空：裁剪会把整笔裁成空，
     * 这种模型宁可不裁（与岛遮罩同一条兜底规则）。 */
    function paintFacePolys(faces, w, h) {
      var m = st.mesh, off = m.faceOffsets, uvs = m.uvs;
      var polys = [], q, j;
      for (q = 0; q < faces.length; q++) {
        var f = faces[q], s = off[f], e = off[f + 1];
        if (e - s < 3) continue;
        for (j = s; j < e; j++) {
          var uu = uvs[j * 2], vv = uvs[j * 2 + 1];
          if (uu < -0.01 || uu > 1.01 || vv < -0.01 || vv > 1.01) return [];
        }
        var poly = [];
        for (j = s; j < e; j++) {
          /* v 轴向上：UV v=0 在画布底边（与 CanvasTexture 的 flipY 一致） */
          poly.push([uvs[j * 2] * w, (1 - uvs[j * 2 + 1]) * h]);
        }
        polys.push(poly);
      }
      return polys;
    }

    /* 笔画期间给绘制上下文加剪裁。必须成对 restore：否则剪裁会一直留着，
     * 换岛后整片贴图都画不上颜色。
     * faceId（不是下标）：落笔用的是可见替身网格，岛却要在整份网格上查。
     * scope = MDIsolate.paintScope()：隔离状态下只允许写到可见面，null 表示不隔离。
     * 两重剪裁（岛遮罩 ∩ 隔离范围）分别 clip，画布会按交集生效。 */
    function paintClipBegin(faceId, scope) {
      paintClipRelease();
      var p = st.paint;
      if (!p.mask && !scope) return 0;
      if (!p.canvas || !p.ctx || !st.mesh || !st.mesh.uvs) return 0;
      var parts = [], polys;
      if (p.mask) {
        /* 魔棒锁定了岛就按锁定的岛裁：选完岛之后从哪落笔都只写这一岛 */
        var useId = (p.lockIsland != null && p.lockIsland >= 0) ? p.lockIsland : faceId;
        var faceIndex = st.mesh.faceIds ? st.mesh.faceIds.indexOf(useId) : -1;
        /* 换过文档 / 重新生成网格后，旧 faceId 已经不存在：退回落笔面并清掉锁 */
        if (faceIndex < 0 && useId !== faceId) {
          p.lockIsland = -1;
          faceIndex = st.mesh.faceIds ? st.mesh.faceIds.indexOf(faceId) : -1;
        }
        if (faceIndex >= 0) {
          polys = paintIslandPolys(faceIndex, p.canvas.width, p.canvas.height);
          if (polys.length) parts.push(polys);
        }
      }
      if (scope) {
        var faces = scope;
        if (scope === 'object') {
          faces = [];
          for (var fi = 0; fi < st.mesh.faceIds.length; fi++) faces.push(fi);
        }
        polys = paintFacePolys(faces, p.canvas.width, p.canvas.height);
        if (polys.length) parts.push(polys);
      }
      if (!parts.length) return 0;
      /* 两张画布都要裁：p.ctx 是即时预览，p.inkCtx 是抬笔后进层栈的增量图。
       * 只裁预览的话，笔刷在范围外的溢色会随增量层一起进合成 ——
       * 画面预览时看着被裁住了，一抬笔就溢到隔壁（遮罩 / 隔离「失效」）。 */
      var ctxs = [p.ctx];
      if (p.inkCtx) ctxs.push(p.inkCtx);
      var total = 0;
      ctxs.forEach(function (c2) {
        c2.save();
        parts.forEach(function (list) {
          c2.beginPath();
          list.forEach(function (poly) {
            poly.forEach(function (pt, i) {
              if (i) c2.lineTo(pt[0], pt[1]);
              else c2.moveTo(pt[0], pt[1]);
            });
            c2.closePath();
          });
          c2.clip();
        });
      });
      parts.forEach(function (list) { total += list.length; });
      p.clipCtxs = ctxs;
      p.clipped = true;
      p.clipPolys = total;
      return total;
    }

    function paintClipRelease() {
      var p = st.paint;
      if (p.clipped && p.clipCtxs) {
        for (var i = 0; i < p.clipCtxs.length; i++) {
          try { p.clipCtxs[i].restore(); } catch (e) {}
        }
      }
      p.clipCtxs = null; p.clipped = false; p.clipPolys = 0;
    }

    /* 断笔（离开模型 / 换槽 / 跨 UV 接缝）：下一落点要重新起笔。
     * smudgeLast 必须一起清 —— 它存的是画布坐标，跨岛后还指着旧岛，
     * 下一个涂抹图章就会把旧岛（在贴图里可能隔着半张图集）的像素拖进新岛。 */
    function paintStrokeBreak(stroke) {
      if (!stroke) return;
      stroke.last = null;
      stroke.lastPx = null;
      stroke.smudgeLast = null;
    }

    /* 涂抹取样的岛路径。
     * 工作画布是整张图集，岛边界外就是别的岛（脸、眼睛、鞋……）。取样不裁到
     * 本岛的话，贴边的大笔刷会把隔壁岛的像素拖进来 —— 模型上就是「头发里
     * 冒出皮肤色块和眼睛碎片、裙子成竖条」这种贴图错乱。
     * 岛信息一笔只算一次，Path2D 按岛缓存；同一岛里换面不重建。 */
    function paintSmudgeIslandPath(stroke) {
      var m = st.mesh, p = st.paint;
      if (!stroke || !m || !m.faceIds || !p.canvas || typeof Path2D === 'undefined') return null;
      /* 魔棒锁了岛就跟目标剪裁用同一个岛，否则跟随落笔面 */
      var fid = (p.lockIsland != null && p.lockIsland >= 0) ? p.lockIsland : (stroke && stroke.faceId);
      if (fid == null) return null;
      if (stroke.islands === undefined) {
        try { stroke.islands = SeedModel.Mesh.uvIslands(m); } catch (e) { stroke.islands = null; }
      }
      var info = stroke.islands;
      if (!info) return null;
      if (stroke.islandFace === fid) return stroke.islandPath || null;
      var fi = m.faceIds.indexOf(fid);
      stroke.islandFace = fid;
      var iid = fi >= 0 ? info.faceIsland[fi] : -1;
      if (iid == null || iid < 0) { stroke.islandPath = null; stroke.islandIid = -1; return null; }
      if (stroke.islandPath && stroke.islandIid === iid) return stroke.islandPath;
      var polys = paintIslandPolys(fi, p.canvas.width, p.canvas.height, info);
      stroke.islandIid = iid;
      if (!polys.length) { stroke.islandPath = null; return null; }
      var path = new Path2D();
      for (var i = 0; i < polys.length; i++) {
        var poly = polys[i];
        if (!poly.length) continue;
        path.moveTo(poly[0][0], poly[0][1]);
        for (var k = 1; k < poly.length; k++) path.lineTo(poly[k][0], poly[k][1]);
        path.closePath();
      }
      stroke.islandPath = path;
      return path;
    }

    /* 取（或建）某材质槽的绘制工作区。
     * 两张画布成对存在，尺寸必须完全一致（层回放时按 1:1 贴回去）：
     *   p.canvas 预览用：底座 ⊕ 已有层 —— 边画边看
     *   p.ink   增量用：透明底，只收这一笔 —— 抬笔时作为 stroke 层入栈 */
    function paintEnsureTarget(slot) {
      var p = st.paint;
      paintClipRelease();
      if (p.tex && p.doc === st.doc && p.slot === slot) {
        /* 工作区还在，但材质上的 map 可能已经被别的路径换走（重建材质 / 混合模块
         * 退回底座）。不重新挂一次，第二笔开始就会「画在没人看的画布上」。 */
        if (ctx.applySlotTexture) p.applyMiss = !ctx.applySlotTexture(slot, p.tex);
        return p.tex;
      }
      paintCommit();
      var mats = (st.doc && st.doc.materials) || {};
      var url = (mats.slotMaps || [])[slot] || '';
      /* 底图统一问 TexSource（baked → slotMaps → 混合模块的解码缓存 → live）。
       * 以前这里是「ctx.baseImageFor → sharedTexture → liveSlotImage」三段手写顺序，
       * 与投射烘焙、UV 编辑器三处各不相同 —— 同一个槽能读出三张不同的图。
       * 注意：无论取到哪张，它都是**未合成**的底座，笔迹写回 slotMaps 后
       * 混合层照旧叠在上面，不会双份。 */
      var img = null;
      var baseImg = null, baseKey = '';
      /* 底图统一问 TexSource（baked → slotMaps → 混合模块的解码缓存 → live）。
       * baseImageFor 会带上混合模块解出来的缓存图；直接调 resolveBase 不传 cached 时，
       * 只要 slotMaps 读不到就会返回 null —— 工作副本只剩槽底色，
       * 视口先白一下、下一帧合成图再盖回来，就是用户看到的「绘制瞬间变白」。 */
      if (ctx.baseImageFor) baseImg = ctx.baseImageFor(slot) || null;
      if (baseImg) baseKey = 'cached';
      if (!baseImg && global.TexSource) {
        var r1 = global.TexSource.resolveBase(slot);
        baseImg = r1.img || null;
        if (baseImg) baseKey = r1.from + '|' + r1.url;
      }
      /* 先看有没有编辑层（投射）：有的话底图必须是「已投射的样子」，
       * 否则用户画的时候看不到之前投上去的那几块，一落笔还会把它盖掉。 */
      var hasStack = !!(global.TexStack && global.TexStack.has(st.doc, slot));
      if (hasStack) {
        img = global.TexStack.edited(st.doc, slot, { base: baseImg, baseKey: baseKey }) || null;
      }
      if (!img) img = baseImg;
      /* 仍然没有底座：退回材质上正在显示的那张图（可能已经是合成图）。
       * 它只当预览底 —— 提交的是独立的增量层，不会把合成图写回 slotMaps。
       * 少这一步，工作副本会被槽底色填满，落笔瞬间就是一片白/灰。 */
      if (!img && ctx.liveSlotImage) {
        var lv0 = ctx.liveSlotImage(slot);
        /* 跳过自己上一笔挂上去的工作副本（丢笔 / 撤销后材质上可能还挂着它），
         * 否则预览会把已经不在栈里的旧笔迹再画一遍。 */
        if (lv0 && lv0 !== p.lastCv && (lv0.width || lv0.naturalWidth)) img = lv0;
      }
      if (!img && url) {
        var t9 = sharedTexture(url);
        if (t9 && t9.image && t9.image.width) img = t9.image;
      }
      var w = PAINT_MAX, h = PAINT_MAX;
      if (img && img.width && img.height) {
        var sc = Math.min(1, PAINT_MAX / Math.max(img.width, img.height));
        w = Math.max(4, Math.round(img.width * sc));
        h = Math.max(4, Math.round(img.height * sc));
      }
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var c2 = cv.getContext('2d');
      c2.fillStyle = (mats.slotColors || [])[slot] || '#c9ccd4';
      c2.fillRect(0, 0, w, h);
      if (img) c2.drawImage(img, 0, 0, w, h);
      var tex = new THREE.CanvasTexture(cv);
      if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 4;
      /* 工作副本每落一个笔尖都要上传。2048² 上传时再生成 mipmap
       * 是纯浪费（预览只看笔刷附近），关掉后拖动明显跟手；
       * 抬笔后的合成图（ensureTex）仍按默认带 mipmap。 */
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      /* 标成共享：材质释放时不能顺手把它 dispose 掉（它归绘画工具箱所有） */
      tex.userData.mdShared = true;
      if (UP) UP.track(tex);
      /* 增量层画布：透明底，尺寸与预览画布一致 */
      var ink = document.createElement('canvas');
      ink.width = w; ink.height = h;
      p.doc = st.doc; p.slot = slot; p.tex = tex; p.canvas = cv; p.ctx = c2;
      p.lastCv = cv;
      p.stampKey = ''; p.stampCv = null;
      p.ink = ink; p.inkCtx = ink.getContext('2d'); p.inkDirty = false; p.inkErase = false;
      p.inkBlur = false; p.inkSmudge = false;
      /* 交给纹理混合模块决定材质上挂哪张图：
       * 有混合层就挂「基础画布 + 图层」的合成图，没有才直接挂这张画布。 */
      if (ctx.onPaintBase) ctx.onPaintBase(slot);
      /* 合成是下一帧（rAF）才发生；没配置时甚至可能什么都不做。
       * 这里同步把工作副本挂上去 —— 少这一下，有贴图的模型上落笔就是「画了没反应」。 */
      var applied = ctx.applySlotTexture ? (ctx.applySlotTexture(slot, tex) | 0) : 0;
      p.applyMiss = applied === 0;
      return tex;
    }

    /* 增量画布按需分配。**一笔一张**，绝不复用已被推进栈的那张 ——
     * 复用的话下一笔的 clearRect 会把上一笔已经提交的像素擦掉
     * （症状：画第二笔时第一笔凭空消失）。 */
    function paintEnsureInk(w, h) {
      var p = st.paint;
      if (p.ink && p.ink.width === w && p.ink.height === h) return p.ink;
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      p.ink = cv;
      p.inkCtx = cv.getContext('2d');
      p.inkDirty = false;
      p.inkErase = false;
      p.inkBlur = false;
      p.inkSmudge = false;
      p.inkBox = null;
      p.inkFrameBox = null;
      return cv;
    }

    /* 丢掉工作区（含增量图）：下次落笔重新从「底座 ⊕ 已有层」解码出来。
     * 撤销一笔 / 丢笔都要走这里 —— 不丢的话画布上还留着已经不在栈里的像素，
     * 下一次合成会把它当成底座（真实症状：撤销后笔迹还在，再画一笔变成双份）。 */
    function paintDropTarget() {
      var p = st.paint;
      if (UP && p.tex) UP.untrack(p.tex);
      p.tex = null; p.canvas = null; p.ctx = null;
      p.ink = null; p.inkCtx = null; p.inkDirty = false; p.inkErase = false; p.inkBlur = false;
      p.inkSmudge = false;
      p.previewBox = null; p.inkBox = null; p.inkFrameBox = null;
      p.lastCv = null; p.stampKey = ''; p.stampCv = null;
      p.slot = -1; p.doc = null;
    }

    /* 抬笔：把这一笔作为**一个 stroke 层**推进栈，不再写 slotMaps。
     *
     * 三个直接好处（都是原来「写整图」的病灶）：
     *   ① 底座不动 → 混合层不会被烙进基础图（不会被叠两次）
     *   ② 底座为空也能画 → 不会把贴图洗成「槽位灰 + 几个岛」
     *   ③ 历史里存的是一张增量图，不是前后两张 2048² PNG
     * 只有没有 TexStack（老页面 / 脚本单测）时才退回老的写回路径。 */
    function paintCommit(title) {
      var p = st.paint;
      if (!p.canvas || p.slot < 0 || !st.doc) return false;
      if (!p.inkDirty || !p.ink || !p.ink.width) return false;
      var doc = st.doc, slot = p.slot;
      var TStack = global.TexStack;
      if (!TStack) return false;
      var before = TStack.ops(doc, slot).slice();
      var inkW = p.ink.width, inkH = p.ink.height;
      /* 模糊笔（Shift）入栈成 blur 层：层里存的是「笔刷遮罩」而不是像素。
       * 合成时按遮罩对当时的结果再模糊一次 —— 存模糊后的像素就锁死了
       * 它下面那一层的内容（有混合层时会糊出一块没有混合层内容的斑）。 */
      var blur = !!p.inkBlur;
      var smudge = !!p.inkSmudge;
      /* 调用方可以给这一层起名（例如岛填充），历史面板里就能区分「画的一笔」与「填的一岛」 */
      var label = title || (blur ? '模糊' : smudge ? '涂抹' : '画笔');
      TStack.push(doc, slot, {
        type: blur ? 'blur' : 'stroke', label: label,
        canvas: p.ink, w: inkW, h: inkH,
        op: 1, mode: p.inkErase ? 'erase' : 'normal',
        radius: blur ? Math.max(1, p.blurRad || 1) : 0,
        /* 这一笔实际动过的像素范围：合成 / 落盘只需要看这里，不用扫整张画布 */
        bbox: p.inkBox ? { x: p.inkBox.x, y: p.inkBox.y, w: p.inkBox.w, h: p.inkBox.h } : null
      });
      var after = TStack.ops(doc, slot).slice();
      /* 这一笔的增量图已经归栈所有：立刻松手，下一笔重新分一张（见 paintEnsureInk） */
      p.ink = null; p.inkCtx = null;
      p.inkDirty = false; p.inkBlur = false; p.inkSmudge = false; p.inkBox = null;
      SeedModel.Scene.revision(doc, 'current');
      var ok = paintPushHistory(slot, before, after, inkW, inkH, label);
      /* 提交换一次合成：视口不变（工作区里已经有这一笔），但落盘（v4 的 ops）要靠它触发，
       * 同时混合层也要按新的层栈重算一次。 */
      if (ctx.onPaintInk) ctx.onPaintInk(slot);
      return ok;
    }

    /* 选中 UV 岛的整岛纯色填充（绘制工具栏的「岛填充」）。
     *
     * 落盘链路与一笔笔刷完全一致：每个材质槽生成一张增量图 → 作为 stroke 层推进 TexStack。
     * 所以填充天然可撤销、可持久化，也不需要重编码整张贴图。
     *
     * 三条必须守住的约束：
     *   ① 只填选中的岛：路径取自选中面的 UV 多边形并集，岛外一个像素都不碰；
     *   ② 只填视口里看得见的部分：单独显示（面 / 岛级）时按 paintScope 收窄，
     *      与笔刷的裁剪口径同源，否则会涂到被隐藏的面上；
     *   ③ 按材质槽分组：一张贴图一个层，跨槽的岛不会被写进错误的槽。
     * 相邻面共用一条边时若逐面 fill，抗锯齿会在岛内留下发丝缝；
     * 把所有面多边形放进同一个 Path2D 再一次 fill，得到的是真正的并集。
     */
    function fillIslands() {
      var p = st.paint, m = st.mesh, doc = st.doc;
      if (!doc || !m) { setStatus('岛填充：先打开一个模型', true); return 0; }
      if (st.selMode !== 'island') {
        setStatus('岛填充：先在建模模式按 F12 选中 UV 岛，再回到绘制模式填充', true);
        return 0;
      }
      var ids = (st.sel && st.sel.faceIds) ? st.sel.faceIds.slice() : [];
      if (!ids.length) { setStatus('岛填充：没有选中 UV 岛（在建模模式按 F12 点模型选岛）', true); return 0; }
      if (!m.uvs || m.uvs.length !== m.faceIndices.length * 2) {
        setStatus('岛填充：当前网格没有 UV，先展开 UV 再填充', true);
        return 0;
      }
      if (typeof Path2D === 'undefined') {
        setStatus('岛填充：当前环境不支持 Canvas 路径填充', true);
        return 0;
      }
      /* 与绘画共用同一条可见性口径：看不见的对象 / 面不接收填充 */
      if (!visibleMesh(st.node ? st.node.id : '')) {
        setStatus('岛填充：当前对象在视口里不可见，先退出单独显示', true);
        return 0;
      }
      var scope = ctx.paintScope ? ctx.paintScope(m) : null;
      if (scope && scope !== 'object' && !scope.length) {
        setStatus('岛填充：当前对象不在单独显示的范围内', true);
        return 0;
      }
      var allow = null;
      if (scope && scope !== 'object') {
        allow = Object.create(null);
        for (var a = 0; a < scope.length; a++) allow[scope[a]] = 1;
      }
      /* faceId → 面下标，同时按材质槽分组；越界槽夹回合法范围（与 begin 同一规则） */
      var slotN = Math.max(1, ((doc.materials && doc.materials.slotNames) || []).length);
      var bySlot = Object.create(null), picked = 0, q, j;
      for (var i = 0; i < ids.length; i++) {
        var fi = m.faceIds ? m.faceIds.indexOf(ids[i]) : -1;
        if (fi < 0) continue;
        if (allow && !allow[fi]) continue;
        var s0 = m.faceOffsets[fi], e0 = m.faceOffsets[fi + 1], bad = false;
        for (j = s0; j < e0; j++) {
          var uu = m.uvs[j * 2], vv = m.uvs[j * 2 + 1];
          if (uu < -0.01 || uu > 1.01 || vv < -0.01 || vv > 1.01) { bad = true; break; }
        }
        /* UV 落在 0–1 之外（平铺 / 图集偏移）时不能像笔刷那样取模：
         * 一个岛可能横跨接缝，取模会把多边形拆成两段，整片填充会填错区域。
         * 宁可明确拒绝，也不静默填到错误的地方。 */
        if (bad) {
          setStatus('岛填充：选中的岛 UV 超出 0–1（平铺 / 图集），暂不支持整岛填充', true);
          return 0;
        }
        var slot = Math.max(0, Math.min(slotN - 1, m.faceSlots[fi] | 0));
        (bySlot[slot] || (bySlot[slot] = [])).push(fi);
        picked++;
      }
      if (!picked) { setStatus('岛填充：选中的面都不在当前可见范围内', true); return 0; }
      var slots = Object.keys(bySlot), filled = 0, missed = 0;
      for (var k = 0; k < slots.length; k++) {
        var slotId = Number(slots[k]);
        var tex = paintEnsureTarget(slotId);
        if (!tex) continue;
        paintEnsureInk(p.canvas.width, p.canvas.height);
        p.previewBox = null; p.inkFrameBox = null;
        var polys = paintFacePolys(bySlot[slots[k]], p.canvas.width, p.canvas.height);
        if (!polys.length) { missed++; continue; }
        var path = new Path2D();
        var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (q = 0; q < polys.length; q++) {
          var poly = polys[q];
          if (!poly.length) continue;
          path.moveTo(poly[0][0], poly[0][1]);
          if (poly[0][0] < bx0) bx0 = poly[0][0];
          if (poly[0][0] > bx1) bx1 = poly[0][0];
          if (poly[0][1] < by0) by0 = poly[0][1];
          if (poly[0][1] > by1) by1 = poly[0][1];
          for (j = 1; j < poly.length; j++) {
            path.lineTo(poly[j][0], poly[j][1]);
            if (poly[j][0] < bx0) bx0 = poly[j][0];
            if (poly[j][0] > bx1) bx1 = poly[j][0];
            if (poly[j][1] < by0) by0 = poly[j][1];
            if (poly[j][1] > by1) by1 = poly[j][1];
          }
          path.closePath();
        }
        if (!(bx1 > bx0 && by1 > by0)) { missed++; continue; }
        /* 纯色 = 所选颜色本身，按 100% 不透明度铺满；浓度混合留给笔刷。
         * 预览与增量图必须画同一份路径，否则抬笔后入栈的像素和看到的不一致。 */
        var ctxs = [p.ctx];
        if (p.inkCtx) ctxs.push(p.inkCtx);
        for (q = 0; q < ctxs.length; q++) {
          var c2 = ctxs[q];
          c2.save();
          c2.globalCompositeOperation = 'source-over';
          c2.fillStyle = p.color;
          c2.fill(path);
          c2.restore();
        }
        p.inkDirty = true;
        p.inkErase = false; p.inkBlur = false; p.inkSmudge = false;
        paintMarkDirty(bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1);
        if (paintCommit('填充')) filled++;
      }
      if (!filled) {
        setStatus('岛填充：没有写入任何材质槽，检查对象是否挂有这些槽的贴图', true);
        return 0;
      }
      setStatus('岛填充：已用 ' + String(p.color).toUpperCase() + ' 填满' +
        (picked === ids.length ? '选中的岛' : picked + ' 个面') +
        (slots.length > 1 ? '（' + slots.length + ' 个材质槽）' : '') +
        '，Ctrl+Z 可撤销' +
        (missed ? '（' + missed + ' 个槽未写入）' : '') +
        (p.applyMiss ? '（材质里找不到对应贴图，暂时看不到）' : ''));
      return filled;
    }

    /* 一笔 = 一条历史。存的是「栈 diff」（两个 ops 数组引用），不是两张贴图：
     * 撤销 = 把栈换回去，底座（slotMaps）一个字都没动过 ——
     * 所以撤一次是「没有这一笔」，而不是「没有贴图」。
     *
     * bytes 用增量图的面积估：层是稀疏的（大部分像素 alpha=0），PNG 压得很狠，
     * 取 raw 的 1/16 作为保守估计。别在这儿 toDataURL 量真实大小 —— 那正是
     * 我们要省掉的那次重编码（2048² 约 120ms）。 */
    function paintPushHistory(slot, before, after, w, h, label) {
      var est = Math.round((w || 0) * (h || 0) * 4 / 16);
      var entry = {
        tex: { slot: slot, before: before, after: after },
        label: label || '画笔', bytes: est
      };
      st.history.undo.push(entry);
      st.history.redo = [];
      while (st.history.undo.length > 1 && totalBytes() > HISTORY_BUDGET) st.history.undo.shift();
      syncBytes();
      updateChrome();
      return true;
    }

    /* 撤销 / 重做一笔：把材质槽的基础色贴图换回旧 URL，并重建视口材质。
     * 仅用于老格式的 patch entry（新格式走外壳的 applyTexPatch → TexStack.setOps）。 */
    function applyPaintPatch(patch, side) {
      if (!st.doc || !patch) return;
      var mats = st.doc.materials || (st.doc.materials = {});
      var arr = mats.slotMaps || (mats.slotMaps = []);
      while (arr.length <= patch.slot) arr.push('');
      arr[patch.slot] = patch[side] || '';
      SeedModel.Scene.revision(st.doc, 'current');
      /* 工作副本按 URL 建，旧的会过期：丢掉，下次落笔重新解码 */
      paintDropTarget();
      rebuildModel(true);
      paintAll();
      /* 工作副本没了：让纹理混合按「解码后的基础贴图」重新合成 */
      if (ctx.onPaintReset) ctx.onPaintReset(patch.slot);
    }

    /* 笔尖形状路径：圆 / 方 / 菱形 / 星形。自定义形状直接用图片的 alpha。 */
    function paintShapePath(g, shape, cx, cy, rad) {
      if (shape === 'square') { g.rect(cx - rad, cy - rad, rad * 2, rad * 2); return; }
      if (shape === 'diamond') {
        g.moveTo(cx, cy - rad); g.lineTo(cx + rad, cy);
        g.lineTo(cx, cy + rad); g.lineTo(cx - rad, cy);
        g.closePath(); return;
      }
      if (shape === 'star') {
        var spikes = 5, inner = rad * 0.45;
        for (var i = 0; i < spikes * 2; i++) {
          var ang = -Math.PI / 2 + i * Math.PI / spikes;
          var rr = (i % 2) ? inner : rad;
          var X = cx + Math.cos(ang) * rr, Y = cy + Math.sin(ang) * rr;
          if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
        }
        g.closePath(); return;
      }
      if (shape === 'triangle') {
        g.moveTo(cx, cy - rad);
        g.lineTo(cx + rad * 0.866, cy + rad * 0.5);
        g.lineTo(cx - rad * 0.866, cy + rad * 0.5);
        g.closePath(); return;
      }
      if (shape === 'pentagon' || shape === 'cross') {
        if (shape === 'pentagon') {
          for (var p5 = 0; p5 < 5; p5++) {
            var a5 = -Math.PI / 2 + p5 * Math.PI * 2 / 5;
            var x5 = cx + Math.cos(a5) * rad, y5 = cy + Math.sin(a5) * rad;
            if (p5) g.lineTo(x5, y5); else g.moveTo(x5, y5);
          }
        } else {
          var t = rad * 0.34;
          g.moveTo(cx - t, cy - rad); g.lineTo(cx + t, cy - rad);
          g.lineTo(cx + t, cy - t); g.lineTo(cx + rad, cy - t);
          g.lineTo(cx + rad, cy + t); g.lineTo(cx + t, cy + t);
          g.lineTo(cx + t, cy + rad); g.lineTo(cx - t, cy + rad);
          g.lineTo(cx - t, cy + t); g.lineTo(cx - rad, cy + t);
          g.lineTo(cx - rad, cy - t); g.lineTo(cx - t, cy - t);
        }
        g.closePath(); return;
      }
      if (shape === 'ring') {
        /* 两圈反向绕行 = 中间真的挖空；nonzero 填充下外圈 - 内圈 */
        var ir = rad * 0.55;
        g.arc(cx, cy, rad, 0, Math.PI * 2, false);
        g.moveTo(cx + ir, cy);
        g.arc(cx, cy, ir, 0, Math.PI * 2, true);
        return;
      }
      g.arc(cx, cy, rad, 0, Math.PI * 2);
    }

    /* 一次笔画内笔尖是常量：把「形状 + 软硬 + 尺寸 + 颜色 + 不透明度」烘成一张
     * 小图章，落点只做 drawImage。比每个点重建径向渐变快，也是自定义笔刷
     * （图片 alpha）能自然接进来的地方。 */
    function paintStampFor(rad, a, erase, hard) {
      var p = st.paint;
      var isHard = hard == null ? p.brush === 'hard' : !!hard;
      var shape = p.shape || 'round';
      var custom = shape === 'custom' ? p.customBrush : null;
      var key = [p.brush, isHard ? 'h' : 's', shape, rad.toFixed(2), a.toFixed(3), erase ? 'e' : p.color,
        custom ? custom.rev : 0].join('|');
      if (p.stampKey === key && p.stampCv) return p.stampCv;
      var d = Math.ceil(rad * 2) + 2, c = d / 2;
      var cv = document.createElement('canvas');
      cv.width = d; cv.height = d;
      var g = cv.getContext('2d');
      var col = erase ? '0,0,0' : paintRgbaTriple(p.color);
      if (custom && custom.img) {
        g.globalAlpha = a;
        g.drawImage(custom.img, c - rad, c - rad, rad * 2, rad * 2);
        g.globalAlpha = 1;
        if (!erase) {
          /* source-in 把图片 alpha 染成当前笔刷色：保留轮廓与羽化，换色不换图 */
          g.globalCompositeOperation = 'source-in';
          g.fillStyle = 'rgb(' + col + ')';
          g.fillRect(0, 0, d, d);
        }
      } else {
        g.beginPath();
        paintShapePath(g, shape, c, c, rad);
        g.closePath();
        var gd = g.createRadialGradient(c, c, isHard ? rad * 0.9 : 0, c, c, rad);
        gd.addColorStop(0, 'rgba(' + col + ',' + a + ')');
        if (!isHard) gd.addColorStop(0.72, 'rgba(' + col + ',' + (a * 0.82) + ')');
        gd.addColorStop(1, 'rgba(' + col + ',0)');
        g.fillStyle = gd;
        g.fill();
      }
      p.stampKey = key; p.stampCv = cv;
      return cv;
    }

    /* 一笔 = 一串图章：软笔用径向渐变，硬笔边缘收窄，橡皮用 destination-out
     * 同一个点要落**两处**：
     *   p.ctx（预览画布）—— 立刻看得见，橡皮真的擦掉底座
     *   p.inkCtx（增量层）—— 透明底，橡皮画成黑印记、标记 mode:'erase'，
     *                        回放时用 destination-out 按 alpha 擦（透明底上直接擦是空操作）
     */
    /* Shift + 拖动 = 模糊笔：不改笔刷色，只把笔刷覆盖到的贴图纹素糊开。
     *
     * 预览：只在图章 bbox（外扩一段 padding，免得模糊在裁切边缘露出透明边）里
     * 从工作副本裁一块、做高斯模糊，再按笔尖 alpha 贴回去 —— 整张 2048² 每帧
     * 做 filter 太贵，局部做既够看也不掉帧。
     * 增量层：写同一张「纯 alpha 图章」。抬笔后这一笔入栈成 blur 层，合成时
     * 按遮罩对「底座 + 混合层 + 笔迹」的结果再模糊一次（见 md-texmix composeOnto）。
     * 不能把模糊后的像素存进 stroke 层：那存的是底座颜色，有混合层时会在视口里
     * 糊出一块没有混合层内容的斑。 */
    function paintBlurAt(x, y, rad, a) {
      var p = st.paint, c2 = p.ctx;
      if (!c2 || !p.canvas) return;
      var mask = paintStampFor(rad, a, true);   /* 纯 alpha 形状（erase 图章不带颜色） */
      var d = mask.width;
      var ox = x - d / 2, oy = y - d / 2;
      var pad = Math.max(2, Math.round(rad * 0.7));
      var sw = d + pad * 2, sh = d + pad * 2;
      var src = p.blurSrc || (p.blurSrc = document.createElement('canvas'));
      if (src.width !== sw) src.width = sw;
      if (src.height !== sh) src.height = sh;
      var sg = src.getContext('2d');
      sg.setTransform(1, 0, 0, 1, 0, 0);
      sg.clearRect(0, 0, sw, sh);
      sg.drawImage(p.canvas, ox - pad, oy - pad, sw, sh, 0, 0, sw, sh);
      var blurR = Math.max(0.6, rad * 0.45);
      var tmp = p.blurTmp || (p.blurTmp = document.createElement('canvas'));
      if (tmp.width !== sw) tmp.width = sw;
      if (tmp.height !== sh) tmp.height = sh;
      var tg = tmp.getContext('2d');
      tg.setTransform(1, 0, 0, 1, 0, 0);
      tg.clearRect(0, 0, sw, sh);
      if ('filter' in tg) tg.filter = 'blur(' + blurR.toFixed(1) + 'px)';
      tg.drawImage(src, 0, 0);
      if ('filter' in tg) tg.filter = 'none';
      /* 只留笔尖形状内的模糊结果；贴回时 p.ctx 上的岛剪裁照常生效 */
      tg.globalCompositeOperation = 'destination-in';
      tg.drawImage(mask, pad, pad);
      tg.globalCompositeOperation = 'source-over';
      c2.save();
      c2.globalAlpha = 1;
      c2.drawImage(tmp, ox - pad, oy - pad);
      c2.restore();
      /* 增量层只存遮罩（回放时当模糊范围用） */
      var ic = p.inkCtx;
      if (ic) {
        ic.save();
        ic.globalCompositeOperation = 'source-over';
        ic.drawImage(mask, ox, oy);
        ic.restore();
        p.inkDirty = true;
        p.inkBlur = true;
        p.blurRad = blurR;
      }
      paintMarkDirty(ox - pad, oy - pad, sw, sh);
      if (ctx.onPaintInk) ctx.onPaintInk(p.slot);
    }

    /* 涂抹笔：把「上一个落点」周围的一块贴图按笔尖形状搬到当前落点，
     * 再按不透明度压回去 —— 和图像编辑器的涂抹工具同一套逻辑（取样 → 位移 → 覆盖）。
     * 取样来自工作副本本身，所以一笔里会越涂越花；抬笔时把这一串补丁作为普通
     * stroke 层入栈（source-over 可结合，合成结果与预览逐帧一致）。 */
    function paintSmudgeAt(x, y, rad, a) {
      var p = st.paint, c2 = p.ctx, stroke = p.stroke;
      if (!c2 || !p.canvas) return;
      var last = stroke && stroke.smudgeLast;
      if (!last) { if (stroke) stroke.smudgeLast = [x, y]; return; }
      if (Math.abs(x - last[0]) + Math.abs(y - last[1]) < 0.75) return;
      var mask = paintStampFor(rad, 1, true);
      var d = mask.width;
      var ox = x - d / 2, oy = y - d / 2;
      var buf = p.smudgeBuf || (p.smudgeBuf = document.createElement('canvas'));
      if (buf.width !== d) buf.width = d;
      if (buf.height !== d) buf.height = d;
      var bg = buf.getContext('2d');
      var sx = last[0] - d / 2, sy = last[1] - d / 2;
      bg.save();
      bg.setTransform(1, 0, 0, 1, 0, 0);
      bg.globalCompositeOperation = 'source-over';
      bg.clearRect(0, 0, d, d);
      /* 取样裁到落笔所在的 UV 岛：岛外是图集里别的区域，拖进来就是贴图错乱 */
      var clipPath = paintSmudgeIslandPath(stroke);
      if (clipPath) {
        bg.setTransform(1, 0, 0, 1, -sx, -sy);
        bg.clip(clipPath);
        bg.setTransform(1, 0, 0, 1, 0, 0);
      }
      bg.drawImage(p.canvas, sx, sy, d, d, 0, 0, d, d);
      bg.globalCompositeOperation = 'destination-in';
      bg.drawImage(mask, 0, 0);
      bg.restore();
      /* 强度跟着浓度走；上限 0.95，避免一次拖动就把整块贴图原样搬走 */
      var stg = Math.max(0.05, Math.min(0.95, a * 0.9));
      c2.save();
      c2.globalAlpha = stg;
      c2.drawImage(buf, ox, oy);
      c2.restore();
      var ic = p.inkCtx;
      if (ic) {
        ic.save();
        ic.globalAlpha = stg;
        ic.drawImage(buf, ox, oy);
        ic.restore();
        p.inkDirty = true;
        p.inkSmudge = true;
      }
      paintMarkDirty(ox, oy, d, d);
      if (ctx.onPaintInk) ctx.onPaintInk(p.slot);
      stroke.smudgeLast = [x, y];
    }

    /* 一个图章实际改过的像素范围：预览纹理按块上传、笔迹层按块合成都用它。
     * 记录的是并集 —— 一次拖动会落几十个图章，逐块上传等于整张。 */
    function paintMarkDirty(x, y, w, h) {
      var p = st.paint;
      var box = PS.clampBox({ x: x, y: y, w: w, h: h }, p.canvas.width, p.canvas.height);
      if (!box) return;
      p.previewBox = PS.unionBox(p.previewBox, box);
      p.inkBox = PS.unionBox(p.inkBox, box);
      /* 上一次合成之后新增的像素：混合层增量合成只看这一块 */
      p.inkFrameBox = PS.unionBox(p.inkFrameBox, box);
      if (UP) UP.markDirty(p.tex, box);
      else p.tex.needsUpdate = true;
    }

    function paintStampAt(x, y) {
      var p = st.paint, c2 = p.ctx;
      if (!c2 || !p.canvas) return;
      var stroke = p.stroke || {};
      /* 落笔时已把屏幕尺寸换算成贴图尺寸；没有笔（例如直接调用）才退回设置值 */
      var rad = PS.radius(stroke.sizeTex || p.size, p.canvas.width, p.canvas.height, PAINT_MAX);
      var erase = !!stroke.erase || p.brush === 'erase';
      var hard = !!stroke.pencil || p.brush === 'hard';
      var a = Math.max(0, Math.min(1, p.opacity / 100));
      if (stroke.blur) { paintBlurAt(x, y, rad, a); return; }
      if (stroke.smudge) { paintSmudgeAt(x, y, rad, a); return; }
      var stamp = paintStampFor(rad, a, erase, hard);
      var ox = x - stamp.width / 2, oy = y - stamp.height / 2;
      c2.save();
      c2.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      c2.drawImage(stamp, ox, oy);
      c2.restore();
      /* 增量层：同一张图章（颜色 / alpha 一致），回放时按 mode 选合成方式 */
      var ic = p.inkCtx;
      if (ic && p.inkDirty !== undefined) {
        ic.save();
        ic.globalCompositeOperation = 'source-over';
        ic.drawImage(stamp, ox, oy);
        ic.restore();
        p.inkDirty = true;
        if (erase) p.inkErase = true;
      }
      paintMarkDirty(ox, oy, stamp.width, stamp.height);
      /* 有混合层时，笔迹要参与合成：让纹理混合模块在本帧重烘一次 */
      if (ctx.onPaintInk) ctx.onPaintInk(p.slot);
    }

    /* '#d94f4f' → '217,79,79'（给 rgba() 拼串用，不重复解析） */
    function paintRgbaTriple(hex) {
      var s = String(hex || '#d94f4f').replace('#', '');
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      var n = parseInt(s, 16);
      if (!isFinite(n)) n = 0xd94f4f;
      return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
    }

    function paintStampUV(u, v) {
      var p = st.paint;
      if (!p.canvas) return;
      /* 导入模型的 UV 常超出 0–1（平铺 / atlas 偏移）。不折算的话笔刷落在画布外，
       * 一个像素都写不进去，表现就是「有贴图的模型上画了没反应」。 */
      u = u - Math.floor(u);
      v = v - Math.floor(v);
      /* v 轴向上：UV v=0 对应画布底边（CanvasTexture 的 flipY 与文档贴图一致） */
      paintStampAt(u * p.canvas.width, (1 - v) * p.canvas.height);
    }

    /* 吸管：按落笔点读工作副本里的贴图颜色（v 轴与画布方向对齐，和落笔同一套换算） */
    function paintPickColorAt(u, v) {
      var p = st.paint;
      if (!p.canvas || !p.ctx) return;
      var w = p.canvas.width, h = p.canvas.height;
      var x = Math.max(0, Math.min(w - 1, Math.round((u - Math.floor(u)) * w)));
      var y = Math.max(0, Math.min(h - 1, Math.round((1 - (v - Math.floor(v))) * h)));
      var d;
      try {
        d = p.ctx.getImageData(x, y, 1, 1).data;
      } catch (err) {
        setStatus('吸管：这张贴图不允许读取像素（跨域纹理）', true);
        return;
      }
      if (d[3] < 8) { setStatus('吸管：这里是透明像素，颜色未改变', true); return; }
      var hex = '#' + [d[0], d[1], d[2]].map(function (n) {
        return ('0' + n.toString(16)).slice(-2);
      }).join('');
      if (ctx.setPaintColor) ctx.setPaintColor(hex);
      else st.paint.color = hex;
      setStatus('吸管：已取色 ' + hex.toUpperCase());
    }

    function begin(e) {
      if (!st.mesh || !st.pivot || !st.doc) return false;
      /* 视口里看不见的对象不许落笔：否则会画到被「单独显示」藏起来的部分 */
      if (!visibleMesh(st.node ? st.node.id : '')) {
        setStatus('绘画：当前对象在视口里不可见，先退出单独显示', true);
        return false;
      }
      if (!st.mesh.uvs || !st.mesh.uvs.length) {
        /* 修改器生效时 st.mesh 是求值结果：在这里补 UV 会写坏 evaluator 的缓存 */
        if (ctx.nodeModsActive && ctx.nodeModsActive(st.node)) {
          setStatus('绘画：该对象有修改器且没有 UV，先「应用修改器」或展开 UV 再画', true);
          return false;
        }
        /* 没有 UV 的网格（基础体、刚导入的部分资产）先铺一层默认展开，
         * 否则笔刷无处落点；生成的 UV 会写进文档，和 UV 编辑器里看到的一致。 */
        SeedModel.Mesh.ensureUV(st.mesh);
        SeedModel.Mesh.bump(st.mesh);
        uvRefreshSolidGeometry();
        setStatus('绘画：当前网格没有 UV，已自动生成默认展开');
      }
      var r = st.canvas.getBoundingClientRect();
      var px = e.clientX - r.left, py = e.clientY - r.top;
      var hit = paintRayHit(px, py);
      /* 导入的多材质模型通常拆成多个节点，激活对象往往不是鼠标下那个：
       * 这时射线只会打空、只提示「没点到模型」，看起来就是「有贴图模型上画了没反应」。
       * 先问视口指针下面是哪个对象，命中别的对象就切过去再落笔。 */
      if (!hit && ctx.nodeUnderPointer && ctx.activateNode) {
        var nid = ctx.nodeUnderPointer(px, py);
        if (nid && (!st.node || nid !== st.node.id) && ctx.activateNode(nid)) {
          /* 换过去的对象可能还没 UV：先铺一层默认展开，再重算落点 */
          if (st.mesh && (!st.mesh.uvs || !st.mesh.uvs.length)) {
            SeedModel.Mesh.ensureUV(st.mesh);
            SeedModel.Mesh.bump(st.mesh);
            uvRefreshSolidGeometry();
          }
          hit = paintRayHit(px, py);
        }
      }
      if (!hit) { setStatus('绘画：这里没点到模型', true); return false; }
      /* 单独显示 = 绘制域过滤：只允许写进隔离里的那部分可见面。
       * 没隔离时返回 null，完全按老规则走；返回空数组说明当前对象不在隔离里，直接拒绝。 */
      var paintScope = ctx.paintScope ? ctx.paintScope(st.mesh) : null;
      if (paintScope && paintScope !== 'object' && !paintScope.length) {
        setStatus('绘画：当前对象不在单独显示的范围内', true);
        return false;
      }
      /* 老资产里的 faceSlots 可能指向已经回收掉的槽（材质串通时代保存的文档）。
       * 这类面在视口里没有材质，按原下标画会静默失败；夹回合法槽再落笔。 */
      var slotN = Math.max(1, ((st.doc.materials && st.doc.materials.slotNames) || []).length);
      /* 显式选定的材质槽优先：只写这一槽，跨到别的槽的面也不中断（见 move） */
      var forced = ctx.forceSlot ? (ctx.forceSlot() | 0) : -1;
      var slot = forced >= 0
        ? Math.min(forced, slotN - 1)
        : Math.max(0, Math.min(slotN - 1, hit.slot | 0));
      var u0 = hit.u - Math.floor(hit.u), v0 = hit.v - Math.floor(hit.v);
      var p = st.paint;
      var tool = p.tool || 'brush';
      /* 魔棒：点一下锁定「这一面所在的 UV 岛」，之后所有笔画都只裁在这一岛里；
       * 再点同一岛解除。它不产生像素，所以不建笔画、也不进历史。 */
      if (tool === 'wand') {
        var fid = hit.faceId;
        if (p.lockIsland != null && p.lockIsland === fid) {
          p.lockIsland = -1;
          setStatus('魔棒：已解除 UV 岛锁定');
        } else {
          p.lockIsland = fid;
          p.mask = true;
          setStatus('魔棒：已锁定该 UV 岛 —— 笔画只写进这一岛；再点同一岛解除');
        }
        if (ctx.updatePaintUi) ctx.updatePaintUi();
        st.pickDown = { x: e.clientX, y: e.clientY, paint: true };
        return true;
      }
      var tex = paintEnsureTarget(slot);
      if (!tex) return false;
      /* 吸管：直接从工作副本读落笔处的贴图颜色，写完就结束，不产生笔画 */
      if (tool === 'picker') {
        paintPickColorAt(u0, v0);
        st.pickDown = { x: e.clientX, y: e.clientY, paint: true };
        return true;
      }
      /* 每一笔的增量图都是全新的：上一笔那张已经进栈了，不能复用 */
      paintEnsureInk(p.canvas.width, p.canvas.height);
      p.previewBox = null;
      p.inkFrameBox = null;
      /* 工具箱的「纹理混合」跟着落笔的槽切换：用户画哪一槽就想调哪一槽 */
      if (ctx.onPaintSlot) ctx.onPaintSlot(slot);
      /* 岛遮罩 + 隔离范围：clip 在整笔期间有效，落笔的岛 / 可见面就是这一笔的可写范围 */
      paintClipBegin(hit.faceId, paintScope);
      /* Shift = 模糊的旧习惯保留；但选了涂抹 / 吸管 / 魔棒时不能被 Shift 改语义 */
      var shiftBlur = !!e.shiftKey && tool !== 'eraser' && tool !== 'smudge' &&
        tool !== 'picker' && tool !== 'wand';
      st.paint.stroke = {
        slot: slot, last: [u0, v0], forced: forced >= 0,
        /* 屏幕像素尺寸 → 贴图等效尺寸；整笔固定，笔尖缓存不会每个点重建 */
        sizeTex: paintScreenSize(px, py),
        /* 上一落点在屏幕上的位置：用来判断「屏幕几乎没动、UV 却跳了很远」的跨接缝情况 */
        lastPx: [px, py],
        /* 当前落点所在面：涂抹按它查 UV 岛，把取样裁在本岛内 */
        faceId: hit.faceId,
        /* 工具在落笔瞬间定死，一笔里不混两种语义 */
        blur: tool === 'blur' || shiftBlur,
        smudge: tool === 'smudge',
        erase: tool === 'eraser',
        pencil: tool === 'pencil',
        smudgeLast: null
      };
      paintStampUV(u0, v0);
      st.pickDown = { x: e.clientX, y: e.clientY, paint: true };
      if (st.paint.stroke.blur) {
        setStatus(tool === 'blur'
          ? '绘画：模糊工具 —— 糊开笔刷覆盖到的贴图纹素，抬笔可撤销'
          : '绘画：模糊笔（Shift）—— 糊开笔刷覆盖到的贴图纹素，抬笔可撤销');
      } else if (st.paint.stroke.smudge) {
        setStatus('绘画：涂抹工具 —— 拖动把落笔处的贴图往笔尖方向带，抬笔可撤销');
      }
      /* 显式槽但当前对象根本没用这一槽 / 材质没挂上：先提示，
       * 否则笔迹写进了看不见的地方，用户只会看到「画了没反应」。 */
      if (forced >= 0 && ctx.slotFaceCount && !ctx.slotFaceCount(slot)) {
        setStatus('绘画：当前对象没有用到「' + (ctx.slotName ? ctx.slotName(slot) : ('槽 ' + (slot + 1))) +
          '」，笔迹不会显示在它身上', true);
      } else if (p.applyMiss) {
        setStatus('绘画：材质里找不到「' + (ctx.slotName ? ctx.slotName(slot) : ('槽 ' + (slot + 1))) +
          '」这张贴图，笔迹暂不显示', true);
      }
      return true;
    }

    function move(e) {
      var p = st.paint, stroke = p.stroke;
      if (!stroke || !st.mesh) return;
      var r = st.canvas.getBoundingClientRect();
      var px = e.clientX - r.left, py = e.clientY - r.top;
      var hit = paintRayHit(px, py);
      /* 槽下标已经夹过（老资产的越界 faceSlots），续笔也按同一规则比 */
      var slotN = Math.max(1, ((st.doc && st.doc.materials && st.doc.materials.slotNames) || []).length);
      /* 显式槽：不管指头滑到哪一槽的面，都继续写进这一槽 */
      var slot = stroke.forced
        ? stroke.slot
        : Math.max(0, Math.min(slotN - 1, hit ? (hit.slot | 0) : 0));
      /* 指针离开模型 / 换到别的一槽：这一笔先断开。
       * 只 return 不更新 last 的话，回到表面那一下会从「离开前那点」直接连过来，
       * 在贴图上拉出一条横穿整张图的长线。 */
      if (!hit || slot !== stroke.slot) {
        paintStrokeBreak(stroke);
        return;
      }
      /* 面的身份跟着落点走：涂抹按它查岛，把取样裁在本岛内 */
      stroke.faceId = hit.faceId;
      var w = p.canvas.width, h = p.canvas.height;
      /* 在 UV 空间插值再逐点取模：UV 跨 0/1 接缝时，画布空间插值会绕整张贴图一圈。
       * 采样口径见 js/paint-stroke.js（纯函数，Node 单测覆盖接缝与间距）。 */
      var u1 = hit.u - Math.floor(hit.u), v1 = hit.v - Math.floor(hit.v);
      if (!stroke.last || !stroke.lastPx) {
        /* 断笔后的第一下：只在新位置点一个图章，不做跨岛插值 */
        paintStampUV(u1, v1);
        stroke.last = [u1, v1];
        stroke.lastPx = [px, py];
        return;
      }
      var u0 = stroke.last[0], v0 = stroke.last[1];
      if (!PS) return;
      var dpx = Math.hypot(px - stroke.lastPx[0], py - stroke.lastPx[1]);
      /* 跨 UV 接缝：3D 上相邻的两张面在贴图里可能隔着半张图集。屏幕上只挪了几像素、
       * UV 却跳很远，就不是连续拖动 —— 连起来会在模型上凭空多出一条长线，
       * 还会一次补满几百个图章把主线程卡住。这里断笔，只点新位置。
       * 先清 smudgeLast 再点：否则这一下会把旧岛的像素拖进新岛。 */
      if (PS.seamJump(dpx, Math.hypot(u1 - u0, v1 - v0))) {
        stroke.smudgeLast = null;
        paintStampUV(u1, v1);
        stroke.last = [u1, v1];
        stroke.lastPx = [px, py];
        return;
      }
      var sp = PS.samples(u0, v0, u1, v1, w, h, stroke.sizeTex || p.size, PAINT_MAX);
      for (var i = 1; i <= sp.n; i++) {
        paintStampUV(u0 + sp.du * i / sp.n, v0 + sp.dv * i / sp.n);
      }
      stroke.last = [u1, v1];
      stroke.lastPx = [px, py];
    }

    function end() {
      if (!st.paint.stroke) { paintClipRelease(); return; }
      var stroke = st.paint.stroke;
      st.paint.stroke = null;
      paintClipRelease();
      /* paintCommit 内部记历史：一笔 = 一个 stroke 层 + 一条栈 diff */
      var recorded = paintCommit();
      var label = ctx.slotName ? ctx.slotName(stroke.slot) : ('槽 ' + (stroke.slot + 1));
      setStatus((stroke.blur ? '绘画：已模糊贴图「'
        : stroke.smudge ? '绘画：已涂抹贴图「'
        : '绘画：笔画已写入贴图「') + label + '」' +
        (st.paint.applyMiss ? '（当前对象没有挂这个槽的材质，暂时看不到）' : '') +
        (recorded ? '，Ctrl+Z 可撤销这一笔' : '') +
        (st.paint.mask ? '（UV 岛遮罩开）' : ''));
    }

    /* 切页签 / 切换文档 / 失焦时丢笔：不提交、不记历史。
     * 预览画布上已经落下的点必须一起丢掉 —— 那张画布是「底座 ⊕ 已有层」的
     * 快照，留着不提交的话，下一次合成会把它当成底座（笔迹幽灵留在图上）。 */
    function cancel() {
      var p = st.paint;
      st.paint.stroke = null;
      paintClipRelease();
      if (p.inkDirty) {
        var slot = p.slot;
        paintDropTarget();
        if (ctx.onPaintReset) ctx.onPaintReset(slot);
      }
    }

    /* 视口画笔环的真实半径（CSS px）。面板里的圆点只是相对大小，真正落在模型上的
     * 覆盖范围取决于落笔面的 texel 密度：同一个 80px 笔，在 256² 的底座上能盖住
     * 半张脸，在 2048² 上只有一小点。换算链：
     *   笔刷半径(UV) = size/2 / PAINT_MAX →「每 UV 的世界长度」→ 投影到屏幕。
     * 没命中返回 0，调用方退回 size*0.5。 */
    function paintCursorRadius(px, py) {
      if (!st.mesh || !st.pivot || !st.camera) return 0;
      var hit = paintRayHit(px, py);
      if (!hit) return 0;
      var m = visibleMesh(st.node ? st.node.id : '');
      if (!m) return 0;
      var s = m.faceOffsets[hit.face], e = m.faceOffsets[hit.face + 1];
      if (!(e - s >= 3)) return 0;
      var A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
      var i0 = m.faceIndices[s] * 3, i1 = m.faceIndices[s + 1] * 3, i2 = m.faceIndices[s + 2] * 3;
      A.set(m.positions[i0], m.positions[i0 + 1], m.positions[i0 + 2]);
      B.set(m.positions[i1], m.positions[i1 + 1], m.positions[i1 + 2]);
      C.set(m.positions[i2], m.positions[i2 + 1], m.positions[i2 + 2]);
      /* 这一面上「1 单位 UV = 多少世界长度」 */
      var J = 0;
      if (m.uvs && m.uvs.length === m.faceIndices.length * 2) {
        var u0 = m.uvs[s * 2], v0 = m.uvs[s * 2 + 1];
        var d1 = Math.sqrt(Math.pow(m.uvs[(s + 1) * 2] - u0, 2) + Math.pow(m.uvs[(s + 1) * 2 + 1] - v0, 2));
        var d2 = Math.sqrt(Math.pow(m.uvs[(s + 2) * 2] - u0, 2) + Math.pow(m.uvs[(s + 2) * 2 + 1] - v0, 2));
        var k1 = d1 > 1e-6 ? B.distanceTo(A) / d1 : 0;
        var k2 = d2 > 1e-6 ? C.distanceTo(A) / d2 : 0;
        J = (k1 > 0 && k2 > 0) ? (k1 + k2) / 2 : (k1 || k2);
      }
      /* 没 UV（纯色模型）：按「整张贴图铺满这张面」估算 */
      if (!(J > 0)) J = Math.max(A.distanceTo(B), A.distanceTo(C));
      if (!(J > 0)) return 0;
      var rLocal = (st.paint.size * 0.5) / PAINT_MAX * J;
      var n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A));
      if (n.lengthSq() < 1e-12) return 0;
      n.normalize();
      var camW = st.camera.getWorldPosition(new THREE.Vector3());
      var inv = new THREE.Matrix4().copy(st.pivot.matrixWorld).invert();
      var viewL = camW.applyMatrix4(inv).sub(A).normalize();
      var tL = new THREE.Vector3().crossVectors(n, viewL);
      if (tL.lengthSq() < 1e-10) return 0;
      tL.normalize();
      var P0 = st.pivot.localToWorld(A.clone());
      var P1 = st.pivot.localToWorld(A.clone().addScaledVector(tL, rLocal));
      var r0 = st.canvas.getBoundingClientRect();
      var s0 = P0.clone().project(st.camera);
      var s1 = P1.clone().project(st.camera);
      var dx = (s1.x - s0.x) * 0.5 * r0.width, dy = (s1.y - s0.y) * 0.5 * r0.height;
      var rad = Math.sqrt(dx * dx + dy * dy);
      if (!(rad > 0.3)) rad = 0.3;
      return Math.min(rad, Math.max(r0.width, r0.height));
    }

    /* 把「笔刷大小 = 屏幕像素」换算成贴图里的等效尺寸：
     * 先在落点算 size 当前能在屏幕上覆盖多大，再按比例反推。
     * 只在落笔瞬间算一次，整笔保持同一尺寸 —— 图章缓存稳定，来回换面也不会忽大忽小。 */
    function paintScreenSize(px, py) {
      var p = st.paint;
      var rad = paintCursorRadius(px, py);
      if (!(rad > 0.3)) return p.size;
      var eff = p.size * (p.size * 0.5) / rad;
      return Math.max(0.5, Math.min(1024, eff));
    }

    return {
      begin: begin, move: move, end: end, cancel: cancel, applyPatch: applyPaintPatch,
      /* 整岛纯色填充：读当前选择（F12 UV 岛模式），按材质槽分组写入 */
      fillIslands: fillIslands,
      rayHit: paintRayHit, cursorRadius: paintCursorRadius,
      /* 预览纹理的脏块上传：外壳在 renderer.render 之前调一次；
       * hasPendingUpload 给按需渲染判断「这一帧有没有新像素要上屏」。 */
      flushPreview: function () { if (UP) UP.flush(); },
      hasPendingUpload: function () { return !!(UP && UP.hasDirty()); },
      uploadStats: function () { return UP ? UP.stats() : null; },
      resetUploadStats: function () { if (UP) UP.resetStats(); }
    };
  }

  global.MDPaint = { create: create };
})(window);
