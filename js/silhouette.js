/* 剪影对图：把「像不像」变成可比的数字
 *
 * 为什么不用截图给模型看：
 *   模型看图只能给出「头身比失调」这种模糊评语，改哪、改多少全靠猜；
 *   同一个模型换个灯光/换个角度，评语还会变。对图要比的是**轮廓**——
 *   参考图和渲染图都转成黑白剪影，按身高归一化后逐高度带量宽度，
 *   出来的是一张「哪一段比参考窄/宽多少百分比」的表，改规格时照着改就行。
 *
 * 两个容易踩的点：
 *   ① 参考图是**线稿**（白底灰线），直接按亮度取剪影会只剩线条、内部镂空 →
 *      必须从边框泛洪填充背景，剩下的内部才是真正的剪影。
 *   ② 两张图的绝对像素尺寸不同 → 先按「剪影高度」等比缩放、底边对齐、水平中心对齐，
 *      再比 IoU 和分带宽度，否则比的是分辨率不是形体。
 */
(function (global) {
  'use strict';

  var BG_LUM = 238;        // 高于它算背景（白纸 / 高光）
  var BANDS = 12;          // 身高切成多少带做宽度对比

  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  /* 线稿 / 白底图 → 实心剪影。
   * 做法：把「和边框连通的亮像素」标成背景，剩下的非背景像素就是剪影内部。
   * 然后按连通块过滤：参考图上经常有「FRONT VIEW」这类文字标注，
   * 它们高度只有主体的百分之几，留着会把 IoU 和宽度统计一起带偏。 */
  function maskFromImage(imgData) {
    var w = imgData.width, h = imgData.height, d = imgData.data;
    var bg = new Uint8Array(w * h);
    var stack = [];
    var push = function (x, y) {
      var i = y * w + x;
      if (bg[i]) return;
      var p = i * 4;
      var a = d[p + 3];
      var light = a < 16 || lum(d[p], d[p + 1], d[p + 2]) > BG_LUM;
      if (!light) return;
      bg[i] = 1; stack.push(i);
    };
    for (var x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (var y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      var i = stack.pop();
      var cx = i % w, cy = (i - cx) / w;
      if (cx > 0) push(cx - 1, cy);
      if (cx < w - 1) push(cx + 1, cy);
      if (cy > 0) push(cx, cy - 1);
      if (cy < h - 1) push(cx, cy + 1);
    }
    var raw = new Uint8Array(w * h);
    for (var i2 = 0; i2 < w * h; i2++) raw[i2] = bg[i2] ? 0 : 1;

    /* 连通块：只保留「够高」的几块（主体 + 与主体分离的长发），丢掉文字标注 */
    var seen = new Uint8Array(w * h);
    var comps = [];
    for (var s = 0; s < w * h; s++) {
      if (!raw[s] || seen[s]) continue;
      var q = [s]; seen[s] = 1;
      var area = 0, minX = w, minY = h, maxX = -1, maxY = -1, cells = [];
      while (q.length) {
        var t = q.pop(); area++; cells.push(t);
        var tx = t % w, ty = (t - tx) / w;
        if (tx < minX) minX = tx; if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty; if (ty > maxY) maxY = ty;
        var nb = [tx > 0 ? t - 1 : -1, tx < w - 1 ? t + 1 : -1, ty > 0 ? t - w : -1, ty < h - 1 ? t + w : -1];
        for (var k = 0; k < 4; k++) {
          var n = nb[k];
          if (n < 0 || seen[n] || !raw[n]) continue;
          seen[n] = 1; q.push(n);
        }
      }
      comps.push({ area: area, h: maxY - minY + 1, w: maxX - minX + 1, cells: cells });
    }
    var maxH = comps.reduce(function (m, c) { return Math.max(m, c.h); }, 0);
    var maxA = comps.reduce(function (m, c) { return Math.max(m, c.area); }, 0);
    var mask = new Uint8Array(w * h), count = 0;
    var minX2 = w, minY2 = h, maxX2 = -1, maxY2 = -1;
    comps.forEach(function (c) {
      /* 身高不到主体 45% 的块基本是文字 / 水印；面积太小的碎点也不算 */
      if (c.h < maxH * 0.45 && c.area < maxA * 0.15) return;
      for (var j = 0; j < c.cells.length; j++) {
        var idx = c.cells[j];
        mask[idx] = 1; count++;
        var x2 = idx % w, y2 = (idx - x2) / w;
        if (x2 < minX2) minX2 = x2; if (x2 > maxX2) maxX2 = x2;
        if (y2 < minY2) minY2 = y2; if (y2 > maxY2) maxY2 = y2;
      }
    });
    return { w: w, h: h, mask: mask, count: count, bbox: count ? [minX2, minY2, maxX2, maxY2] : null, dropped: comps.length };
  }

  function bboxOf(m) {
    if (m.bbox) return m.bbox;
    var minX = m.w, minY = m.h, maxX = -1, maxY = -1;
    for (var i = 0; i < m.w * m.h; i++) {
      if (!m.mask[i]) continue;
      var x = i % m.w, y = (i - x) / m.w;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return [minX, minY, maxX, maxY];
  }

  /* 把剪影重采样成「高 = H」的规范画布：只做等比缩放 + 以 bbox 为界裁剪。
   * ⚠ 之前这里从源图 x=0 开始采样（没锚到 bbox 左边），然后靠一次「中心平移」去补，
   *   结果两个人并排或旁边有文字时整体偏移 —— 对图里看到的就是「模型整体偏左」。
   *   现在直接从 bbox 左上角采样，水平居中交给调用方的 pad() 统一处理。 */
  function normalize(m, H) {
    var bb = bboxOf(m);
    var bw = bb[2] - bb[0] + 1, bh = bb[3] - bb[1] + 1;
    var scale = H / bh;
    var nw = Math.max(1, Math.round(bw * scale));
    var out = new Uint8Array(nw * H);
    for (var y = 0; y < H; y++) {
      var sy = bb[1] + Math.min(bh - 1, Math.floor(y / scale));
      for (var x = 0; x < nw; x++) {
        var sx = bb[0] + Math.min(bw - 1, Math.floor(x / scale));
        out[y * nw + x] = m.mask[sy * m.w + sx] ? 1 : 0;
      }
    }
    return { w: nw, h: H, mask: out, scale: scale, bbox: [0, 0, nw - 1, H - 1] };
  }

  function widths(m) {
    var rows = new Array(m.h).fill(0);
    for (var y = 0; y < m.h; y++) {
      var c = 0;
      for (var x = 0; x < m.w; x++) if (m.mask[y * m.w + x]) c++;
      rows[y] = c;
    }
    return rows;
  }

  /* 核心对比：参考剪影 vs 模型剪影。
   * H 是归一化高度（像素），越大越精细；默认 480 足够看出 2% 的差异。 */
  function compare(refMask, modelMask, opts) {
    var H = (opts && opts.height) || 480;
    var a = normalize(refMask, H);
    var b = normalize(modelMask, H);
    var W = Math.max(a.w, b.w);
    var pad = function (m) {
      var out = new Uint8Array(W * H);
      var off = Math.round((W - m.w) / 2);
      for (var y = 0; y < H; y++) for (var x = 0; x < m.w; x++) {
        if (m.mask[y * m.w + x]) out[y * W + x + off] = 1;
      }
      return { w: W, h: H, mask: out };
    };
    var A = pad(a), B = pad(b);
    var inter = 0, union = 0, onlyRef = 0, onlyModel = 0;
    for (var i = 0; i < W * H; i++) {
      var ra = A.mask[i], rb = B.mask[i];
      if (ra && rb) inter++;
      if (ra || rb) union++;
      if (ra && !rb) onlyRef++;
      if (rb && !ra) onlyModel++;
    }
    var rowsA = widths(A), rowsB = widths(B);

    /* 分带：y=0 是头顶，y=H 是脚底。每带取「平均每行宽度 / H」作归一化宽度，
     * 这样两边的数字都是「占身高的比例」，和分辨率无关。 */
    var bands = [];
    for (var k = 0; k < BANDS; k++) {
      var y0 = Math.round(H * k / BANDS), y1 = Math.round(H * (k + 1) / BANDS);
      var sumA = 0, sumB = 0;
      for (var y = y0; y < y1; y++) { sumA += rowsA[y]; sumB += rowsB[y]; }
      var n = Math.max(1, y1 - y0);
      var wa = sumA / n / H, wb = sumB / n / H;
      bands.push({
        band: k,
        yFrom: +(k / BANDS).toFixed(3), yTo: +((k + 1) / BANDS).toFixed(3),
        refW: +wa.toFixed(4), modelW: +wb.toFixed(4),
        ratio: wa > 1e-6 ? +(wb / wa).toFixed(3) : null,
        deltaPct: wa > 1e-6 ? +(((wb - wa) / wa) * 100).toFixed(1) : null
      });
    }

    var widestA = 0, widestAY = 0, widestB = 0, widestBY = 0;
    for (var y3 = 0; y3 < H; y3++) {
      if (rowsA[y3] > widestA) { widestA = rowsA[y3]; widestAY = y3; }
      if (rowsB[y3] > widestB) { widestB = rowsB[y3]; widestBY = y3; }
    }

    /* 判定用「体量」和「形状」分开看：
     *   fillRatio 差 = 整体胖瘦；iou 低但 fillRatio 接近 = 形体位置/分段不对（比如腿并成一根）。 */
    var fillA = A.mask.reduce(function (s, v) { return s + v; }, 0) / (W * H);
    var fillB = B.mask.reduce(function (s, v) { return s + v; }, 0) / (W * H);

    return {
      iou: +(inter / Math.max(1, union)).toFixed(4),
      coverOfRef: +(inter / Math.max(1, inter + onlyRef)).toFixed(3),
      spillOver: +(onlyModel / Math.max(1, inter + onlyModel)).toFixed(3),
      fillRef: +fillA.toFixed(4),
      fillModel: +fillB.toFixed(4),
      refAspect: +(a.w / H).toFixed(3),
      modelAspect: +(b.w / H).toFixed(3),
      widest: {
        ref: { w: +(widestA / H).toFixed(3), y: +(widestAY / H).toFixed(3) },
        model: { w: +(widestB / H).toFixed(3), y: +(widestBY / H).toFixed(3) }
      },
      bands: bands,
      worst: bands.slice().filter(function (x) { return x.ratio != null; })
        .sort(function (p, q) { return Math.abs(q.deltaPct) - Math.abs(p.deltaPct); }).slice(0, 4)
    };
  }

  /* 叠加图：参考 = 绿，模型 = 红，重合 = 琥珀。看叠图比看数字更容易定位「哪一段不对」。 */
  function overlay(refMask, modelMask, H) {
    H = H || 480;
    var a = normalize(refMask, H), b = normalize(modelMask, H);
    var W = Math.max(a.w, b.w);
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, W, H);
    var put = function (m, rgb, alpha) {
      var off = Math.round((W - m.w) / 2);
      ctx.fillStyle = 'rgba(' + rgb + ',' + alpha + ')';
      for (var y = 0; y < H; y++) for (var x = 0; x < m.w; x++) {
        if (m.mask[y * m.w + x]) ctx.fillRect(x + off, y, 1, 1);
      }
    };
    put(a, '52,211,153', 0.55);
    put(b, '248,113,113', 0.55);
    return cv;
  }

  global.Silhouette = {
    BANDS: BANDS,
    maskFromImage: maskFromImage,
    normalize: normalize,
    compare: compare,
    overlay: overlay,
    /* 从 dataURL 取剪影（浏览器里解码图片） */
    fromDataURL: function (url) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () {
          var cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          res(maskFromImage(ctx.getImageData(0, 0, cv.width, cv.height)));
        };
        img.onerror = function () { rej(new Error('图片解码失败')); };
        img.src = url;
      });
    }
  };
})(window);
