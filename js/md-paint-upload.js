/* 预览纹理的局部上传（TileStore 的落点）
 *
 * 问题：绘画工作副本是一张 2048² canvas，每落一个图章都置 `texture.needsUpdate`，
 * three 会把**整张**（≈16MB）重新上传。集显 / 共享显存下这一下就把帧时吃满，
 * 于是「笔刷一小块，画面一大卡」。
 *
 * 做法：第一次让 three 整张上传建好纹理对象；之后每帧只对笔刷包围盒调用
 * `gl.texSubImage2D`，并用 `renderer.resetState()` 把 three 的纹理绑定缓存清掉
 * （我们绕过了它的 state 封装，不清会让它以为别的纹理还绑着）。
 *
 * 关键细节：`texSubImage2D` 的「画布源 + 源矩形」重载只在 ArrayBufferView 上存在，
 * 直接给 canvas 多传 srcX/srcY 会抛 TypeError（浏览器只认 9 个参数）。
 * 所以脏块先 drawImage 拷进一张按脏块尺寸复用的小画布，再整张小画布上传。
 *
 * 能力边界（不是第二套业务逻辑，只是驱动能力探测）：
 *   - 纹理还没被渲染过（拿不到 __webglTexture）→ 本帧整张上传，脏块保留到下一帧；
 *   - 驱动拒绝子矩形上传 → 本次起退化成整张上传。
 * 两种情况都只是「上传多少像素」的差别，像素结果完全一致。
 *
 * 对外（window.MDPaintUpload）：create({ renderer }) →
 *   { track, untrack, markDirty, flush, stats }
 */
(function (global) {
  'use strict';

  function create(opt) {
    opt = opt || {};
    var getRenderer = opt.renderer || function () { return null; };
    var items = [];      /* [{ tex, dirty, fullPending }] */
    var st = { bytes: 0, fullBytes: 0, partialBytes: 0, uploads: 0, fullUploads: 0 };
    var disabled = false;
    /* 脏块中转画布：一次只处理一个脏块，整张复用；尺寸只增不减 */
    var scratch = null;

    function entryOf(tex) {
      for (var i = 0; i < items.length; i++) if (items[i].tex === tex) return items[i];
      return null;
    }

    /* 开始跟踪一张预览纹理。dpr 不用：画布像素就是纹理像素 */
    function track(tex) {
      if (!tex) return null;
      var it = entryOf(tex);
      if (it) { it.dirty = null; it.fullPending = true; return it; }
      it = { tex: tex, dirty: null, fullPending: true };
      items.push(it);
      return it;
    }

    function untrack(tex) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].tex === tex) { items.splice(i, 1); return; }
      }
    }

    /* 标记一块脏像素（画布坐标）。box 已经由 PaintStroke.clampBox 夹过。 */
    function markDirty(tex, box) {
      var it = entryOf(tex);
      if (!it) it = track(tex);
      if (!box) return;
      it.dirty = global.PaintStroke
        ? global.PaintStroke.unionBox(it.dirty, box)
        : (it.dirty || box);
    }

    /* 是否还有未上传的像素：按需渲染用它决定「这一帧要不要画」 */
    function hasDirty() {
      for (var i = 0; i < items.length; i++) {
        if (items[i].dirty || items[i].fullPending) return true;
      }
      return false;
    }

    function fullUpload(it) {
      var tex = it.tex;
      var img = tex.image;
      var w = (img && (img.width || img.naturalWidth)) || 0;
      var h = (img && (img.height || img.naturalHeight)) || 0;
      tex.needsUpdate = true;
      it.dirty = null;
      st.fullUploads++;
      st.uploads++;
      st.bytes += w * h * 4;
      st.fullBytes += w * h * 4;
    }

    /* 把画布上的脏块拷进中转画布：texSubImage2D 的 canvas 源重载不接受源矩形 */
    function scratchFor(w, h) {
      if (!scratch) scratch = document.createElement('canvas');
      if (scratch.width < w) scratch.width = w;
      if (scratch.height < h) scratch.height = h;
      return scratch;
    }

    /* 把累计脏块真正写进纹理。必须在 renderer.render 之前调用。 */
    function flush() {
      if (!items.length) return;
      var renderer = getRenderer();
      if (!renderer) return;
      var gl = renderer.getContext ? renderer.getContext() : null;
      if (!gl) { disabled = true; return; }
      /* resetState() 会把 three 记的「当前渲染目标」清成 null（其内部实现如此），
       * 调用方若正往 RenderTarget 里画，之后的 render 会按画布尺寸设视口，
       * 回读出来是一块放大的局部。这里先记下来，清完缓存再恢复。 */
      var prevRT = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
      var bound = false;
      for (var i = 0; i < items.length; i++) {
        var it = items[i], tex = it.tex;
        /* 第一次（或整张上传被判定更划算）：交给 three，本帧全量 */
        if (it.fullPending) { it.fullPending = false; fullUpload(it); continue; }
        if (!it.dirty) continue;
        if (disabled) { fullUpload(it); continue; }
        var props = renderer.properties ? renderer.properties.get(tex) : null;
        var glTex = props && props.__webglTexture;
        if (!glTex) {
          /* 纹理还没被渲染过：让 three 建一次，脏块留到下一帧按块补。
           * 不清 dirty 是有意的——整张上传已经把当前像素带上去了，
           * 下一帧再补一次同一块只是多传一次，不会错。 */
          tex.needsUpdate = true;
          continue;
        }
        var img = tex.image;
        var W = (img && (img.width || img.naturalWidth)) || 0;
        var H = (img && (img.height || img.naturalHeight)) || 0;
        var box = global.PaintStroke
          ? global.PaintStroke.clampBox(it.dirty, W, H)
          : it.dirty;
        it.dirty = null;
        if (!box) continue;
        var flip = tex.flipY !== false;
        var sc = scratchFor(box.w, box.h);
        var sg = sc.getContext('2d');
        sg.setTransform(1, 0, 0, 1, 0, 0);
        sg.globalAlpha = 1;
        sg.globalCompositeOperation = 'source-over';
        sg.clearRect(0, 0, box.w, box.h);
        /* 翻转在 2D 画布里做，而不是交给 UNPACK_FLIP_Y_WEBGL：
         * 那只翻转「整张源图」。中转画布只增不减，比脏块大时，翻转后的
         * 取样区域会落到画布下半部分（上一次的大脏块），上传进去就是黑块 + 乱线。 */
        if (flip) {
          sg.save();
          sg.translate(0, box.h);
          sg.scale(1, -1);
          sg.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
          sg.restore();
        } else {
          sg.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
        }
        gl.bindTexture(gl.TEXTURE_2D, glTex);
        bound = true;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!tex.premultiplyAlpha);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        var dy = flip ? (H - (box.y + box.h)) : box.y;
        try {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, box.x, dy, box.w, box.h,
            gl.RGBA, gl.UNSIGNED_BYTE, sc);
          st.bytes += box.w * box.h * 4;
          st.partialBytes += box.w * box.h * 4;
          st.uploads++;
        } catch (e) {
          /* 某些驱动不接受 canvas 源子矩形：退回整张，一次即知 */
          disabled = true;
          fullUpload(it);
        }
      }
      /* 我们直接调了 gl.bindTexture，绕过了 three 的 WebGLState 缓存：
       * 不清掉的话，下一次它 bind 同一张会以为已经绑好而跳过，采样到刚绑上去的那张。 */
      if (bound && renderer.resetState) {
        renderer.resetState();
        if (prevRT && renderer.setRenderTarget) renderer.setRenderTarget(prevRT);
      }
    }

    function stats() {
      return {
        bytes: st.bytes, fullBytes: st.fullBytes, partialBytes: st.partialBytes,
        uploads: st.uploads, fullUploads: st.fullUploads,
        enabled: !disabled, tracked: items.length
      };
    }
    function resetStats() {
      st.bytes = 0; st.fullBytes = 0; st.partialBytes = 0; st.uploads = 0; st.fullUploads = 0;
    }

    return { track: track, untrack: untrack, markDirty: markDirty, flush: flush,
      hasDirty: hasDirty, stats: stats, resetStats: resetStats };
  }

  global.MDPaintUpload = { create: create };
})(window);
