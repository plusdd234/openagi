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

    /* 屏幕点 → 网格局部射线 → 最近三角形，返回面的材质槽 + 重心插值出来的 UV。
     * 网格取自视口可见性：面级隔离时只剩替身网格里的面，画不到被藏起来的部分。 */
    function paintRayHit(px, py) {
      if (!st.mesh || !st.pivot || !st.camera) return null;
      var m = visibleMesh(st.node ? st.node.id : '');
      if (!m) return null;
      var r = st.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      var ndc = new THREE.Vector2((px / r.width) * 2 - 1, -((py / r.height) * 2 - 1));
      var rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, st.camera);
      var inv = new THREE.Matrix4().copy(st.pivot.matrixWorld).invert();
      var o = rc.ray.origin.clone().applyMatrix4(inv);
      var d = rc.ray.direction.clone().transformDirection(inv);
      var pos = m.positions, off = m.faceOffsets, idx = m.faceIndices;
      var bestT = Infinity, bestF = -1, bestK = -1, bu = 0, bv = 0;
      for (var f = 0; f < m.faceIds.length; f++) {
        var s = off[f], e = off[f + 1];
        if (e - s < 3) continue;
        var i0 = idx[s] * 3;
        var ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
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
          if (t > 1e-6 && t < bestT) { bestT = t; bestF = f; bestK = k; bu = u; bv = v; }
        }
      }
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
    function paintIslandPolys(faceIndex, w, h) {
      var m = st.mesh, off = m.faceOffsets, uvs = m.uvs;
      var faces = null;
      try {
        var info = SeedModel.Mesh.uvIslands(m);
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
      return polys;
    }

    /* 笔画期间给绘制上下文加岛剪裁。必须成对 restore：否则剪裁会一直留着，
     * 换岛后整片贴图都画不上颜色。
     * 参数是 faceId（不是下标）：落笔用的是可见替身网格，岛却要在整份网格上查。 */
    function paintClipBegin(faceId) {
      paintClipRelease();
      var p = st.paint;
      if (!p.mask || !p.canvas || !p.ctx || !st.mesh || !st.mesh.uvs) return 0;
      var faceIndex = st.mesh.faceIds ? st.mesh.faceIds.indexOf(faceId) : -1;
      if (faceIndex < 0) return 0;
      var polys = paintIslandPolys(faceIndex, p.canvas.width, p.canvas.height);
      if (!polys.length) return 0;
      var ctx2 = p.ctx;
      ctx2.save();
      ctx2.beginPath();
      polys.forEach(function (poly) {
        poly.forEach(function (pt, i) {
          if (i) ctx2.lineTo(pt[0], pt[1]);
          else ctx2.moveTo(pt[0], pt[1]);
        });
        ctx2.closePath();
      });
      ctx2.clip();
      p.clipCtx = ctx2;
      p.clipped = true;
      p.clipPolys = polys.length;
      return polys.length;
    }

    function paintClipRelease() {
      var p = st.paint;
      if (p.clipped && p.clipCtx) {
        try { p.clipCtx.restore(); } catch (e) {}
      }
      p.clipCtx = null; p.clipped = false; p.clipPolys = 0;
    }

    /* 取（或建）某材质槽的绘制工作区。
     * 两张画布成对存在，尺寸必须完全一致（层回放时按 1:1 贴回去）：
     *   p.canvas 预览用：底座 ⊕ 已有层 —— 边画边看
     *   p.ink   增量用：透明底，只收这一笔 —— 抬笔时作为 stroke 层入栈 */
    function paintEnsureTarget(slot) {
      var p = st.paint;
      paintClipRelease();
      if (p.tex && p.doc === st.doc && p.slot === slot) return p.tex;
      paintCommit();
      var mats = (st.doc && st.doc.materials) || {};
      var url = (mats.slotMaps || [])[slot] || '';
      /* 底图统一问 TexSource（baked → slotMaps → 混合模块的解码缓存 → live）。
       * 以前这里是「ctx.baseImageFor → sharedTexture → liveSlotImage」三段手写顺序，
       * 与投射烘焙、UV 编辑器三处各不相同 —— 同一个槽能读出三张不同的图。
       * 注意：无论取到哪张，它都是**未合成**的底座，笔迹写回 slotMaps 后
       * 混合层照旧叠在上面，不会双份。 */
      var img = null;
      /* 先看有没有编辑层（投射）：有的话底图必须是「已投射的样子」，
       * 否则用户画的时候看不到之前投上去的那几块，一落笔还会把它盖掉。 */
      if (global.TexStack && global.TexStack.has(st.doc, slot)) {
        if (global.TexSource) {
          var r0 = global.TexSource.resolveBase(slot);
          img = global.TexStack.edited(st.doc, slot, { base: r0.img, baseKey: r0.from + '|' + r0.url }) || null;
        }
      }
      if (!img && global.TexSource) {
        img = global.TexSource.resolveBase(slot).img;
      } else if (!global.TexSource) {
        if (ctx.baseImageFor) img = ctx.baseImageFor(slot) || null;
        if (!img && url) {
          var t0 = sharedTexture(url);
          if (t0 && t0.image && t0.image.width) img = t0.image;
        }
        if (!img && ctx.liveSlotImage) {
          var lv = ctx.liveSlotImage(slot);
          if (lv && (lv.width || lv.naturalWidth)) img = lv;
        }
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
      /* 标成共享：材质释放时不能顺手把它 dispose 掉（它归绘画工具箱所有） */
      tex.userData.mdShared = true;
      /* 增量层画布：透明底，尺寸与预览画布一致 */
      var ink = document.createElement('canvas');
      ink.width = w; ink.height = h;
      p.doc = st.doc; p.slot = slot; p.tex = tex; p.canvas = cv; p.ctx = c2;
      p.ink = ink; p.inkCtx = ink.getContext('2d'); p.inkDirty = false; p.inkErase = false;
      /* 交给纹理混合模块决定材质上挂哪张图：
       * 有混合层就挂「基础画布 + 图层」的合成图，没有才直接挂这张画布。 */
      if (ctx.onPaintBase) ctx.onPaintBase(slot);
      else if (ctx.applySlotTexture) ctx.applySlotTexture(slot, tex);
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
      return cv;
    }

    /* 丢掉工作区（含增量图）：下次落笔重新从「底座 ⊕ 已有层」解码出来。
     * 撤销一笔 / 丢笔都要走这里 —— 不丢的话画布上还留着已经不在栈里的像素，
     * 下一次合成会把它当成底座（真实症状：撤销后笔迹还在，再画一笔变成双份）。 */
    function paintDropTarget() {
      var p = st.paint;
      p.tex = null; p.canvas = null; p.ctx = null;
      p.ink = null; p.inkCtx = null; p.inkDirty = false; p.inkErase = false;
      p.slot = -1; p.doc = null;
    }

    /* 抬笔：把这一笔作为**一个 stroke 层**推进栈，不再写 slotMaps。
     *
     * 三个直接好处（都是原来「写整图」的病灶）：
     *   ① 底座不动 → 混合层不会被烙进基础图（不会被叠两次）
     *   ② 底座为空也能画 → 不会把贴图洗成「槽位灰 + 几个岛」
     *   ③ 历史里存的是一张增量图，不是前后两张 2048² PNG
     * 只有没有 TexStack（老页面 / 脚本单测）时才退回老的写回路径。 */
    function paintCommit() {
      var p = st.paint;
      if (!p.canvas || p.slot < 0 || !st.doc) return false;
      if (!p.inkDirty || !p.ink || !p.ink.width) return false;
      var doc = st.doc, slot = p.slot;
      var TStack = global.TexStack;
      if (!TStack) return paintCommitLegacy(doc, slot);
      var before = TStack.ops(doc, slot).slice();
      var inkW = p.ink.width, inkH = p.ink.height;
      TStack.push(doc, slot, {
        type: 'stroke', label: '画笔',
        canvas: p.ink, w: inkW, h: inkH,
        op: 1, mode: p.inkErase ? 'erase' : 'normal'
      });
      var after = TStack.ops(doc, slot).slice();
      /* 这一笔的增量图已经归栈所有：立刻松手，下一笔重新分一张（见 paintEnsureInk） */
      p.ink = null; p.inkCtx = null;
      p.inkDirty = false;
      SeedModel.Scene.revision(doc, 'current');
      var ok = paintPushHistory(slot, before, after, inkW, inkH);
      /* 提交换一次合成：视口不变（工作区里已经有这一笔），但落盘（v4 的 ops）要靠它触发，
       * 同时混合层也要按新的层栈重算一次。 */
      if (ctx.onPaintInk) ctx.onPaintInk(slot);
      return ok;
    }

    /* 没有 TexStack 时的退路：老行为（整张写回 slotMaps）。
     * 保留它是为了让「只加载了 md-paint 的探针」不至于整个失效。 */
    function paintCommitLegacy(doc, slot) {
      var p = st.paint;
      var mats = doc.materials || (doc.materials = {});
      var arr = mats.slotMaps || (mats.slotMaps = []);
      while (arr.length <= slot) arr.push('');
      var beforeUrl = arr[slot] || '';
      var afterUrl = '';
      try { afterUrl = p.canvas.toDataURL('image/png'); } catch (e) { return false; }
      arr[slot] = afterUrl;
      p.inkDirty = false;
      /* 退路也要一笔一张：这张增量图已经用过，不能留给下一笔 */
      p.ink = null; p.inkCtx = null;
      SeedModel.Scene.revision(doc, 'current');
      if (beforeUrl === afterUrl) return false;
      st.history.undo.push({
        patch: { slot: slot, before: beforeUrl, after: afterUrl },
        label: '画笔', bytes: (beforeUrl.length + afterUrl.length) * 2
      });
      st.history.redo = [];
      while (st.history.undo.length > 1 && totalBytes() > HISTORY_BUDGET) st.history.undo.shift();
      syncBytes();
      updateChrome();
      return true;
    }

    /* 一笔 = 一条历史。存的是「栈 diff」（两个 ops 数组引用），不是两张贴图：
     * 撤销 = 把栈换回去，底座（slotMaps）一个字都没动过 ——
     * 所以撤一次是「没有这一笔」，而不是「没有贴图」。
     *
     * bytes 用增量图的面积估：层是稀疏的（大部分像素 alpha=0），PNG 压得很狠，
     * 取 raw 的 1/16 作为保守估计。别在这儿 toDataURL 量真实大小 —— 那正是
     * 我们要省掉的那次重编码（2048² 约 120ms）。 */
    function paintPushHistory(slot, before, after, w, h) {
      var est = Math.round((w || 0) * (h || 0) * 4 / 16);
      var entry = {
        tex: { slot: slot, before: before, after: after },
        label: '画笔', bytes: est
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

    function paintRgba(hex, a) {
      var s = String(hex || '#d94f4f').replace('#', '');
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      var n = parseInt(s, 16);
      if (!isFinite(n)) n = 0xd94f4f;
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    /* 一笔 = 一串圆点：软笔用径向渐变，硬笔把渐变起点推到 88%，橡皮用 destination-out
     * 同一个点要落**两处**：
     *   p.ctx（预览画布）—— 立刻看得见，橡皮真的擦掉底座
     *   p.inkCtx（增量层）—— 透明底，橡皮画成黑印记、标记 mode:'erase'，
     *                        回放时用 destination-out 按 alpha 擦（透明底上直接擦是空操作）
     */
    function paintStampAt(x, y) {
      var p = st.paint, c2 = p.ctx;
      if (!c2 || !p.canvas) return;
      var sc = Math.min(p.canvas.width, p.canvas.height) / PAINT_MAX;
      var rad = Math.max(1.5, p.size * 0.5 * sc);
      var erase = p.brush === 'erase';
      var hard = p.brush === 'hard';
      var a = Math.max(0, Math.min(1, p.opacity / 100));
      var g = c2.createRadialGradient(x, y, hard ? rad * 0.88 : 0, x, y, rad);
      if (erase) {
        g.addColorStop(0, 'rgba(0,0,0,' + a + ')');
        g.addColorStop(1, 'rgba(0,0,0,0)');
      } else {
        g.addColorStop(0, paintRgba(p.color, a));
        g.addColorStop(1, paintRgba(p.color, 0));
      }
      c2.save();
      c2.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      c2.fillStyle = g;
      c2.beginPath();
      c2.arc(x, y, rad, 0, Math.PI * 2);
      c2.fill();
      c2.restore();
      /* 增量层：永远是 source-over（黑/本色都行，回放时只看 alpha） */
      var ic = p.inkCtx;
      if (ic && p.inkDirty !== undefined) {
        var g2 = ic.createRadialGradient(x, y, hard ? rad * 0.88 : 0, x, y, rad);
        var col = erase ? '0,0,0' : paintRgbaTriple(p.color);
        g2.addColorStop(0, 'rgba(' + col + ',' + a + ')');
        g2.addColorStop(1, 'rgba(' + col + ',0)');
        ic.save();
        ic.globalCompositeOperation = 'source-over';
        ic.fillStyle = g2;
        ic.beginPath();
        ic.arc(x, y, rad, 0, Math.PI * 2);
        ic.fill();
        ic.restore();
        p.inkDirty = true;
        if (erase) p.inkErase = true;
      }
      p.tex.needsUpdate = true;
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
      /* v 轴向上：UV v=0 对应画布底边（CanvasTexture 的 flipY 与文档贴图一致） */
      paintStampAt(u * p.canvas.width, (1 - v) * p.canvas.height);
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
      var hit = paintRayHit(e.clientX - r.left, e.clientY - r.top);
      if (!hit) { setStatus('绘画：这里没点到模型', true); return false; }
      var tex = paintEnsureTarget(hit.slot);
      if (!tex) return false;
      /* 每一笔的增量图都是全新的：上一笔那张已经进栈了，不能复用 */
      var p = st.paint;
      paintEnsureInk(p.canvas.width, p.canvas.height);
      /* 工具箱的「纹理混合」跟着落笔的槽切换：用户画哪一槽就想调哪一槽 */
      if (ctx.onPaintSlot) ctx.onPaintSlot(hit.slot);
      /* 岛遮罩：clip 在整笔期间有效，落笔的岛就是这一笔的可画范围 */
      paintClipBegin(hit.faceId);
      st.paint.stroke = {
        slot: hit.slot, last: [hit.u, hit.v]
      };
      paintStampUV(hit.u, hit.v);
      st.pickDown = { x: e.clientX, y: e.clientY, paint: true };
      return true;
    }

    function move(e) {
      var p = st.paint, stroke = p.stroke;
      if (!stroke || !st.mesh) return;
      var r = st.canvas.getBoundingClientRect();
      var hit = paintRayHit(e.clientX - r.left, e.clientY - r.top);
      if (!hit || hit.slot !== stroke.slot) return;
      var w = p.canvas.width, h = p.canvas.height;
      var x0 = stroke.last[0] * w, y0 = (1 - stroke.last[1]) * h;
      var x1 = hit.u * w, y1 = (1 - hit.v) * h;
      var dist = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
      var step = Math.max(1.5, p.size * 0.22 * (Math.min(w, h) / PAINT_MAX));
      var n = Math.max(1, Math.min(400, Math.ceil(dist / step)));
      for (var i = 1; i <= n; i++) {
        paintStampAt(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
      }
      stroke.last = [hit.u, hit.v];
    }

    function end() {
      if (!st.paint.stroke) { paintClipRelease(); return; }
      var stroke = st.paint.stroke;
      st.paint.stroke = null;
      paintClipRelease();
      /* paintCommit 内部记历史：一笔 = 一个 stroke 层 + 一条栈 diff */
      var recorded = paintCommit();
      setStatus('绘画：笔画已写入贴图（保存后随 GLB 一起存' +
        (recorded ? '，Ctrl+Z 可撤销这一笔' : '') + '）' +
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

    return { begin: begin, move: move, end: end, cancel: cancel, applyPatch: applyPaintPatch, rayHit: paintRayHit };
  }

  global.MDPaint = { create: create };
})(window);
