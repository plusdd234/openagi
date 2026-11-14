#!/usr/bin/env node
/* 图像算子（浏览器 canvas 版）：裁切 / 缩放 / 掩膜 / 合成 / 度量。
 *
 * 为什么不用 sharp：仓库只装了 playwright-core，装原生依赖会破坏「开箱能跑」。
 * 浏览器本来就在，canvas 的采样口径（双线性 / drawImage）跟 App 内一致，
 * 度量结果和肉眼看到的图是同一套像素。
 *
 * 一次 open() 加载一批图进页面（BUF），后续所有操作按名字引用，避免几十 MB
 * 的 base64 来回传。
 */
'use strict';

const { chromium } = require('playwright-core');

const PAGE_SCRIPT = String.raw`
window.BUF = {};
window.CV = {};
function cv(name, w, h) {
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  window.CV[name] = c;
  return c;
}
function ctx2(c) { var g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; return g; }
IMG = {
  async load(items) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      window.BUF[it.name] = await new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () { res(im); };
        im.onerror = function () { rej(new Error('读不出图：' + it.name)); };
        im.src = it.url;
      });
    }
    return Object.keys(window.BUF);
  },
  /* 从整图裁一格 → 缩放到 dw×dh → 可选铺底色（AI 输入要白底不透明） */
  crop(name, src, sx, sy, sw, sh, dw, dh, bg) {
    var im = window.BUF[src];
    var c = cv(name, dw, dh), g = ctx2(c);
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, dw, dh); }
    g.drawImage(im, sx, sy, sw, sh, 0, 0, dw, dh);
    window.BUF[name] = c;
    return c.toDataURL('image/png');
  },
  /* 按 alpha 裁剪：传入源名与可选掩膜名（黑白图，白色保留） */
  cut(name, src, maskName, sx, sy, sw, sh, dw, dh) {
    var im = window.BUF[src];
    var c = cv(name, dw, dh), g = ctx2(c);
    g.drawImage(im, sx, sy, sw, sh, 0, 0, dw, dh);
    if (maskName) {
      var m = window.BUF[maskName];
      var mc = document.createElement('canvas');
      mc.width = dw; mc.height = dh;
      var mg = mc.getContext('2d');
      mg.drawImage(m, sx, sy, sw, sh, 0, 0, dw, dh);
      var md = mg.getImageData(0, 0, dw, dh).data;
      var id = g.getImageData(0, 0, dw, dh);
      for (var i = 0; i < md.length; i += 4) id.data[i + 3] = md[i];
      g.putImageData(id, 0, 0);
    }
    window.BUF[name] = c;
    return c.toDataURL('image/png');
  },
  /* 合成：dest 上盖 over（over 是 dw×dh 的整张 crop），掩膜羽化由浏览器 blur 完成。
   * rect 用整图坐标。feather 是掩膜模糊半径（px，相对整图）。 */
  compose(name, dest, over, rect, maskPatch, feather) {
    var d = window.BUF[dest], o = window.BUF[over];
    var c = cv(name, d.naturalWidth || d.width, d.naturalHeight || d.height), g = ctx2(c);
    g.drawImage(d, 0, 0);
    /* 羽化掩膜：先把 patch 掩膜放大到 rect 尺寸，再模糊，再贴 */
    var w = rect.w, h = rect.h;
    var mc = document.createElement('canvas');
    mc.width = w; mc.height = h;
    var mg = mc.getContext('2d');
    if (maskPatch) mg.drawImage(window.BUF[maskPatch], 0, 0, w, h);
    else { mg.fillStyle = '#fff'; mg.fillRect(0, 0, w, h); }
    var tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    var tg = tmp.getContext('2d');
    if (feather > 0) tg.filter = 'blur(' + feather + 'px)';
    tg.drawImage(mc, 0, 0);
    var id = tg.getImageData(0, 0, w, h);
    var dd = id.data;
    /* 掩膜红通道 → alpha */
    for (var i = 0; i < dd.length; i += 4) { dd[i + 3] = dd[i]; dd[i] = dd[i + 1] = dd[i + 2] = 0; }
    tg.putImageData(id, 0, 0);
    /* 把 over 画到临时层，再用掩膜 alpha 抠出来 */
    var lay = document.createElement('canvas');
    lay.width = w; lay.height = h;
    var lg = lay.getContext('2d');
    lg.drawImage(o, 0, 0, w, h);
    lg.globalCompositeOperation = 'destination-in';
    lg.drawImage(tmp, 0, 0);
    g.drawImage(lay, rect.x, rect.y);
    window.BUF[name] = c;
    return c.toDataURL('image/png');
  },
  /* 掩膜统计：fg 覆盖率、包围盒、逐行宽度（用于语义树） */
  maskStats(src, sx, sy, sw, sh) {
    var im = window.BUF[src];
    var c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    var g = c.getContext('2d');
    g.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
    var d = g.getImageData(0, 0, sw, sh).data;
    var x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
    var rows = new Int32Array(sh);
    for (var y = 0; y < sh; y++) {
      var cnt = 0;
      for (var x = 0; x < sw; x++) {
        if (d[(y * sw + x) * 4] <= 127) continue;
        cnt++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      rows[y] = cnt;
      n += cnt;
    }
    return { w: sw, h: sh, fg: n, bbox: { x0: x0, x1: x1, y0: y0, y1: y1 }, rows: Array.from(rows) };
  },
  /* 原画语义调色板：按树的比例切区域，统计每区主色（跳过近白 / 低饱和） */
  palette(src, tree, bbox) {
    var im = window.BUF[src];
    var W = im.naturalWidth, H = im.naturalHeight;
    var BW = (bbox.x1 - bbox.x0 + 1), BH = (bbox.y1 - bbox.y0 + 1);
    function region(fa, fb, xa, xb) {
      var sx = Math.round(bbox.x0 + BW * (xa == null ? 0 : xa));
      var ex = Math.round(bbox.x0 + BW * (xb == null ? 1 : xb));
      var sy = Math.round(bbox.y0 + BH * fa);
      var ey = Math.round(bbox.y0 + BH * fb);
      var w = Math.max(1, ex - sx), h = Math.max(1, ey - sy);
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var g = c.getContext('2d');
      g.drawImage(im, sx, sy, w, h, 0, 0, w, h);
      var d = g.getImageData(0, 0, w, h).data;
      var map = {}, list = [];
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], gg = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 200) continue;
        var mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        if (mn > 236) continue;              // 近白背景
        if (mx - mn < 8 && mx > 200) continue; // 浅灰高光
        var k = (r >> 4) + ',' + (gg >> 4) + ',' + (b >> 4);
        var e = map[k] || (map[k] = { n: 0, r: 0, g: 0, b: 0 });
        e.n++; e.r += r; e.g += gg; e.b += b;
      }
      for (var kk in map) list.push(map[kk]);
      list.sort(function (a, b) { return b.n - a.n; });
      var tot = 0;
      for (var j = 0; j < list.length; j++) tot += list[j].n;
      return list.slice(0, 4).map(function (e) {
        function hex(v) { v = Math.round(v / e.n); return ('0' + v.toString(16)).slice(-2); }
        return {
          hex: '#' + hex(e.r) + hex(e.g) + hex(e.b),
          weight: +(e.n / Math.max(1, tot)).toFixed(3)
        };
      });
    }
    var y = tree.y, x = tree.x;
    return {
      head: region(y.head[0], y.head[1], x.head.x0, x.head.x1),
      shoulder: region(y.shoulder[0], y.shoulder[1]),
      torso: region(y.torso[0], y.torso[1], 0.25, 0.75),
      legs: region(y.legs[0], y.legs[1], x.legs.x0, x.legs.x1),
      feet: region(y.feet[0], y.feet[1])
    };
  },
  /* 度量：生成图 vs 结构遮罩 / 生成图 vs 原画区域色 */
  measure(genName, maskName, rect, tree) {
    var im = window.BUF[genName];
    var W = im.naturalWidth || im.width, H = im.naturalHeight || im.height;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    var gen = g.getImageData(0, 0, W, H).data;

    var mc = document.createElement('canvas');
    mc.width = W; mc.height = H;
    var mg = mc.getContext('2d');
    mg.drawImage(window.BUF[maskName], 0, 0, W, H);
    var mk = mg.getImageData(0, 0, W, H).data;

    /* 生成图前景：从四边泛洪，把与边界连通的近白像素判为背景。
     * 不能直接「非白 = 前景」：白裙子、白高光都会被算成背景。 */
    var bg = new Uint8Array(W * H);
    var stack = [];
    function push(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      var i = y * W + x;
      if (bg[i]) return;
      var p = i * 4;
      if (gen[p + 3] < 128) { bg[i] = 1; stack.push(i); return; }
      var mn = Math.min(gen[p], gen[p + 1], gen[p + 2]);
      if (mn < 232) return;
      bg[i] = 1; stack.push(i);
    }
    for (var x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (var y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    while (stack.length) {
      var i = stack.pop(), xx = i % W, yy = (i - xx) / W;
      push(xx - 1, yy); push(xx + 1, yy); push(xx, yy - 1); push(xx, yy + 1);
    }

    var inter = 0, uni = 0, genFg = 0, maskFg = 0;
    var edgeG = 0, edgeM = 0;
    for (var yy = 0; yy < H; yy++) {
      for (var xx = 0; xx < W; xx++) {
        var idx = yy * W + xx, p4 = idx * 4;
        var gm = mk[p4] > 127 ? 1 : 0;
        var gf = bg[idx] ? 0 : 1;
        if (gf) genFg++;
        if (gm) maskFg++;
        if (gf && gm) inter++;
        if (gf || gm) uni++;
      }
    }
    /* 边缘：4 邻域里前景/背景翻转的像素数（用掩膜与生成图各自的轮廓） */
    function edgeCount(isFgAt) {
      var n = 0;
      for (var yy = 1; yy < H - 1; yy++) {
        for (var xx = 1; xx < W - 1; xx++) {
          var v = isFgAt(yy * W + xx);
          if (v !== isFgAt(yy * W + xx + 1) || v !== isFgAt((yy + 1) * W + xx)) n++;
        }
      }
      return n;
    }
    edgeG = edgeCount(function (i) { return bg[i] ? 0 : 1; });
    edgeM = edgeCount(function (i) { return mk[i * 4] > 127 ? 1 : 0; });

    /* 区域统计：只统计掩膜内像素 */
    var BH = tree ? (tree.bboxPx.y1 - tree.bboxPx.y0 + 1) : H;
    var BY = tree ? tree.bboxPx.y0 : 0;
    var BX = tree ? tree.bboxPx.x0 : 0;
    var BWid = tree ? (tree.bboxPx.x1 - tree.bboxPx.x0 + 1) : W;
    function regionStat(fa, fb, xa, xb) {
      var y0 = Math.round(BY + BH * fa), y1 = Math.round(BY + BH * fb);
      var x0 = Math.round(BX + BWid * (xa == null ? 0 : xa));
      var x1 = Math.round(BX + BWid * (xb == null ? 1 : xb));
      var n = 0, rr = 0, gg2 = 0, bb = 0, lap = 0, ln = 0;
      var satSum = 0;
      for (var yy = y0; yy <= y1; yy++) {
        for (var xx = x0; xx <= x1; xx++) {
          if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) continue;
          var i5 = (yy * W + xx) * 4;
          if (mk[i5] <= 127) continue;
          n++;
          rr += gen[i5]; gg2 += gen[i5 + 1]; bb += gen[i5 + 2];
          var mx2 = Math.max(gen[i5], gen[i5 + 1], gen[i5 + 2]);
          var mn2 = Math.min(gen[i5], gen[i5 + 1], gen[i5 + 2]);
          satSum += mx2 ? (mx2 - mn2) / mx2 : 0;
          /* Laplacian 方差（细节能量）：只用亮度，取 4 邻域 */
          var l = function (i6) { return (gen[i6] * 299 + gen[i6 + 1] * 587 + gen[i6 + 2] * 114) / 1000; };
          var lapv = 4 * l(i5) - l(i5 - 4) - l(i5 + 4) - l(i5 - W * 4) - l(i5 + W * 4);
          lap += lapv * lapv; ln++;
        }
      }
      return n ? {
        px: n,
        mean: [Math.round(rr / n), Math.round(gg2 / n), Math.round(bb / n)],
        sat: +(satSum / n).toFixed(3),
        detail: +(lap / Math.max(1, ln)).toFixed(1)
      } : null;
    }
    var reg = {};
    if (tree) {
      for (var k in tree.y) reg[k] = regionStat(tree.y[k][0], tree.y[k][1],
        tree.x && tree.x[k] ? tree.x[k].x0 : null, tree.x && tree.x[k] ? tree.x[k].x1 : null);
    }
    return {
      w: W, h: H,
      genFg: genFg, maskFg: maskFg,
      iou: +(inter / Math.max(1, uni)).toFixed(4),
      recall: +(inter / Math.max(1, maskFg)).toFixed(4),
      precision: +(inter / Math.max(1, genFg)).toFixed(4),
      edgeGen: edgeG, edgeMask: edgeM,
      edgeRatio: +(edgeG / Math.max(1, edgeM)).toFixed(3),
      regions: reg
    };
  }
};
`;

async function open(items) {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.goto('about:blank');
  await page.addScriptTag({ content: PAGE_SCRIPT });
  if (items && items.length) await page.evaluate(list => IMG.load(list), items);
  return {
    page,
    errors,
    load: list => page.evaluate(l => IMG.load(l), list),
    crop: (...a) => page.evaluate(args => IMG.crop(...args), a),
    cut: (...a) => page.evaluate(args => IMG.cut(...args), a),
    compose: (...a) => page.evaluate(args => IMG.compose(...args), a),
    maskStats: (...a) => page.evaluate(args => IMG.maskStats(...args), a),
    palette: (...a) => page.evaluate(args => IMG.palette(...args), a),
    measure: (...a) => page.evaluate(args => IMG.measure(...args), a),
    close: () => browser.close()
  };
}

function b64(dataUrl) {
  return Buffer.from(String(dataUrl).split(',')[1], 'base64');
}

module.exports = { open, b64 };
