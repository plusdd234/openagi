/* 绘画工具箱：把笔刷颜色画进材质槽的基础色贴图
 *
 * 贴图真源是 doc.materials.slotMaps（data URL）。笔刷落在 UV 坐标上：
 * 工作副本是一张 canvas（打开时把已有贴图解码进来），笔画结束再编码回文档。
 * 这样不用改材质系统，也天然跟着 seedModel 存进 GLB。
 *
 * 为什么拆出来：这段是「射线求交 + UV 岛剪裁 + canvas 工作区 + 贴图历史」
 * 一条完整链路，只依赖外壳的材质/重建动作，不该继续长在 model-desk.js 里。
 *
 * 分工：
 *   - 本模块：落笔判定、笔画、提交、撤销补丁
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

    var PAINT_MAX = 1024;

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

    /* 取（或建）某材质槽的绘制工作区：已有贴图解码进 canvas，没有就铺底色 */
    function paintEnsureTarget(slot) {
      var p = st.paint;
      paintClipRelease();
      if (p.tex && p.doc === st.doc && p.slot === slot) return p.tex;
      paintCommit();
      var mats = (st.doc && st.doc.materials) || {};
      var url = (mats.slotMaps || [])[slot] || '';
      var img = null;
      if (url) {
        var t0 = sharedTexture(url);
        if (t0 && t0.image && t0.image.width) img = t0.image;
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
      p.doc = st.doc; p.slot = slot; p.tex = tex; p.canvas = cv; p.ctx = c2;
      applyPaintTexture(tex, slot);
      return tex;
    }

    /* 把绘制贴图挂到当前对象所有使用该槽的材质上（含平涂缓存材质） */
    function applyPaintTexture(tex, slot) {
      if (!st.pivot) return;
      st.pivot.traverse(function (o) {
        if (!o.userData || o.userData.mdPart !== 'solid') return;
        if (o.material) {
          var arr = Array.isArray(o.material) ? o.material : [o.material];
          var m = arr[slot];
          if (m) {
            if (!m.userData.mdPaintOrig) m.userData.mdPaintOrig = m.map || null;
            m.map = tex;
            m.userData.mdBaseMap = tex;
            m.needsUpdate = true;
          }
        }
        if (o.userData.mdFlatMats) {
          var fm = o.userData.mdFlatMats[slot];
          if (fm) { fm.map = tex; fm.userData.mdBaseMap = tex; fm.needsUpdate = true; }
        }
      });
    }

    /* 把画布编码回文档：slotMaps 是贴图真源，保存 GLB 时随 seedModel 一起走 */
    function paintCommit() {
      var p = st.paint;
      if (!p.canvas || p.slot < 0 || !st.doc) return;
      var mats = st.doc.materials || (st.doc.materials = {});
      var arr = mats.slotMaps || (mats.slotMaps = []);
      while (arr.length <= p.slot) arr.push('');
      try { arr[p.slot] = p.canvas.toDataURL('image/png'); } catch (e) {}
      SeedModel.Scene.revision(st.doc, 'current');
    }

    /* 一笔 = 一条历史。只存前后两张贴图 URL，不掺网格快照：
     * 每笔都复制整份网格既慢又会把历史预算吃光。 */
    function paintPushHistory(slot, before, after) {
      if (before === after) return false;
      var entry = {
        patch: { slot: slot, before: before, after: after },
        label: '画笔',
        bytes: (before.length + after.length) * 2
      };
      st.history.undo.push(entry);
      st.history.redo = [];
      while (st.history.undo.length > 1 && totalBytes() > HISTORY_BUDGET) st.history.undo.shift();
      syncBytes();
      updateChrome();
      return true;
    }

    /* 撤销 / 重做一笔：把材质槽的基础色贴图换回旧 URL，并重建视口材质 */
    function applyPaintPatch(patch, side) {
      if (!st.doc || !patch) return;
      var mats = st.doc.materials || (st.doc.materials = {});
      var arr = mats.slotMaps || (mats.slotMaps = []);
      while (arr.length <= patch.slot) arr.push('');
      arr[patch.slot] = patch[side] || '';
      SeedModel.Scene.revision(st.doc, 'current');
      /* 工作副本按 URL 建，旧的会过期：丢掉，下次落笔重新解码 */
      st.paint.tex = null; st.paint.canvas = null; st.paint.ctx = null;
      st.paint.slot = -1; st.paint.doc = null;
      rebuildModel(true);
      paintAll();
    }

    function paintRgba(hex, a) {
      var s = String(hex || '#d94f4f').replace('#', '');
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      var n = parseInt(s, 16);
      if (!isFinite(n)) n = 0xd94f4f;
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    /* 一笔 = 一串圆点：软笔用径向渐变，硬笔把渐变起点推到 88%，橡皮用 destination-out */
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
      p.tex.needsUpdate = true;
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
      /* 岛遮罩：clip 在整笔期间有效，落笔的岛就是这一笔的可画范围 */
      paintClipBegin(hit.faceId);
      st.paint.stroke = {
        slot: hit.slot, last: [hit.u, hit.v],
        /* 抬笔时要和这一笔之前的贴图比对，所以起笔先记下旧的 data URL */
        before: (st.doc.materials && st.doc.materials.slotMaps || [])[hit.slot] || ''
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
      paintCommit();
      var after = (st.doc.materials && st.doc.materials.slotMaps || [])[stroke.slot] || '';
      var recorded = paintPushHistory(stroke.slot, stroke.before || '', after);
      setStatus('绘画：笔画已写入贴图（保存后随 GLB 一起存' +
        (recorded ? '，Ctrl+Z 可撤销这一笔' : '') + '）' +
        (st.paint.mask ? '（UV 岛遮罩开）' : ''));
    }

    /* 切页签 / 切换文档 / 失焦时丢笔：不提交、不记历史 */
    function cancel() {
      st.paint.stroke = null;
      paintClipRelease();
    }

    return { begin: begin, move: move, end: end, cancel: cancel, applyPatch: applyPaintPatch };
  }

  global.MDPaint = { create: create };
})(window);
