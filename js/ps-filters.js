/* 图像工坊 · 滤镜与调整
 *
 * 所有滤镜都按「瓦片 + 邻域」处理：
 *   对每块瓦片，先按需要的半径扩一圈邻域读到临时画布，处理完只把瓦片本身写回。
 *   这样模糊/锐化不会在瓦片交界处出现方格接缝，也不会把整张大图读进内存。
 *
 * 时间分片：每处理 6 块瓦片让出一帧，主线程不会因为一张 4800 万像素的图卡死。
 */
const PSFilters = (function () {
  'use strict';

  function field(key, label, min, max, step, value) {
    return { key: key, label: label, type: 'range', min: min, max: max, step: step, value: value };
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    if (s === 0) {
      var v = l * 255;
      return [v, v, v];
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
  }

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  /* 三遍盒式模糊 ≈ 高斯：每遍 O(n)，比逐像素卷积快一个数量级。 */
  function boxBlur(data, w, h, radius) {
    var r = Math.max(1, Math.round(radius));
    var n = w * h;
    var src = new Float32Array(n * 4);
    var tmp = new Float32Array(n * 4);
    var i, a;
    for (i = 0; i < n; i++) {
      a = data[i * 4 + 3] / 255;
      src[i * 4] = data[i * 4] * a;
      src[i * 4 + 1] = data[i * 4 + 1] * a;
      src[i * 4 + 2] = data[i * 4 + 2] * a;
      src[i * 4 + 3] = a;
    }
    function blurH(from, to) {
      for (var y = 0; y < h; y++) {
        var sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
        for (var k = -r; k <= r; k++) {
          var xx = clamp(k, 0, w - 1);
          var p = (y * w + xx) * 4;
          sum0 += from[p]; sum1 += from[p + 1]; sum2 += from[p + 2]; sum3 += from[p + 3];
        }
        var denom = r * 2 + 1;
        for (var x = 0; x < w; x++) {
          var o = (y * w + x) * 4;
          to[o] = sum0 / denom;
          to[o + 1] = sum1 / denom;
          to[o + 2] = sum2 / denom;
          to[o + 3] = sum3 / denom;
          var addX = clamp(x + r + 1, 0, w - 1);
          var subX = clamp(x - r, 0, w - 1);
          var pa = (y * w + addX) * 4;
          var ps = (y * w + subX) * 4;
          sum0 += from[pa] - from[ps];
          sum1 += from[pa + 1] - from[ps + 1];
          sum2 += from[pa + 2] - from[ps + 2];
          sum3 += from[pa + 3] - from[ps + 3];
        }
      }
    }
    function blurV(from, to) {
      for (var x = 0; x < w; x++) {
        var sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
        for (var k = -r; k <= r; k++) {
          var yy = clamp(k, 0, h - 1);
          var p = (yy * w + x) * 4;
          sum0 += from[p]; sum1 += from[p + 1]; sum2 += from[p + 2]; sum3 += from[p + 3];
        }
        var denom = r * 2 + 1;
        for (var y = 0; y < h; y++) {
          var o = (y * w + x) * 4;
          to[o] = sum0 / denom;
          to[o + 1] = sum1 / denom;
          to[o + 2] = sum2 / denom;
          to[o + 3] = sum3 / denom;
          var addY = clamp(y + r + 1, 0, h - 1);
          var subY = clamp(y - r, 0, h - 1);
          var pa = (addY * w + x) * 4;
          var ps = (subY * w + x) * 4;
          sum0 += from[pa] - from[ps];
          sum1 += from[pa + 1] - from[ps + 1];
          sum2 += from[pa + 2] - from[ps + 2];
          sum3 += from[pa + 3] - from[ps + 3];
        }
      }
    }
    for (var pass = 0; pass < 3; pass++) {
      blurH(src, tmp);
      blurV(tmp, src);
    }
    for (i = 0; i < n; i++) {
      a = src[i * 4 + 3];
      if (a <= 0.0001) {
        data[i * 4] = 0; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; data[i * 4 + 3] = 0;
      } else {
        data[i * 4] = clamp255(src[i * 4] / a);
        data[i * 4 + 1] = clamp255(src[i * 4 + 1] / a);
        data[i * 4 + 2] = clamp255(src[i * 4 + 2] / a);
        data[i * 4 + 3] = clamp255(a * 255);
      }
    }
  }

  function sharpen(data, w, h, amount) {
    var a = Math.max(0, amount) / 100;
    if (a <= 0) return;
    var out = new Uint8ClampedArray(data.length);
    out.set(data);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = (y * w + x) * 4;
        for (var c = 0; c < 3; c++) {
          var center = data[i + c];
          var sum = data[i - w * 4 + c] + data[i + w * 4 + c] + data[i - 4 + c] + data[i + 4 + c];
          var val = center + a * (4 * center - sum);
          out[i + c] = clamp255(val);
        }
      }
    }
    data.set(out);
  }

  function pixelate(data, w, h, size, rect, layer) {
    var bs = Math.max(2, Math.round(size));
    var blocks = new Map();
    var startX = Math.floor((rect.x + layer.x) / bs) * bs - layer.x - rect.x;
    var startY = Math.floor((rect.y + layer.y) / bs) * bs - layer.y - rect.y;
    for (var y = 0; y < h; y++) {
      var by = Math.floor((y - startY) / bs);
      for (var x = 0; x < w; x++) {
        var bx = Math.floor((x - startX) / bs);
        var key = bx + ',' + by;
        var acc = blocks.get(key);
        if (!acc) { acc = { r: 0, g: 0, b: 0, a: 0, n: 0 }; blocks.set(key, acc); }
        var i = (y * w + x) * 4;
        acc.r += data[i]; acc.g += data[i + 1]; acc.b += data[i + 2]; acc.a += data[i + 3];
        acc.n++;
      }
    }
    for (var yy = 0; yy < h; yy++) {
      var byy = Math.floor((yy - startY) / bs);
      for (var xx = 0; xx < w; xx++) {
        var bxx = Math.floor((xx - startX) / bs);
        var acc2 = blocks.get(bxx + ',' + byy);
        var o = (yy * w + xx) * 4;
        if (!acc2 || !acc2.n) continue;
        data[o] = acc2.r / acc2.n;
        data[o + 1] = acc2.g / acc2.n;
        data[o + 2] = acc2.b / acc2.n;
        data[o + 3] = acc2.a / acc2.n;
      }
    }
  }

  var FILTERS = {
    brightness: {
      name: '亮度', fields: [field('value', '亮度', -100, 100, 1, 25)],
      process: function (data, w, h, p) {
        var add = (p.value || 0) * 2.55;
        for (var i = 0; i < data.length; i += 4) {
          data[i] = clamp255(data[i] + add);
          data[i + 1] = clamp255(data[i + 1] + add);
          data[i + 2] = clamp255(data[i + 2] + add);
        }
      }
    },
    contrast: {
      name: '对比度', fields: [field('value', '强度', -100, 100, 1, 30)],
      process: function (data, w, h, p) {
        var v = (p.value || 0) * 2.55;
        var factor = (259 * (v + 255)) / (255 * (259 - v));
        for (var i = 0; i < data.length; i += 4) {
          data[i] = clamp255(factor * (data[i] - 128) + 128);
          data[i + 1] = clamp255(factor * (data[i + 1] - 128) + 128);
          data[i + 2] = clamp255(factor * (data[i + 2] - 128) + 128);
        }
      }
    },
    saturate: {
      name: '饱和度', fields: [field('value', '饱和度', -100, 100, 1, 30)],
      process: function (data, w, h, p) {
        var add = (p.value || 0) / 100;
        for (var i = 0; i < data.length; i += 4) {
          var hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          var s = clamp(hsl[1] + add * (add > 0 ? 1 - hsl[1] : hsl[1]), 0, 1);
          var rgb = hslToRgb(hsl[0], s, hsl[2]);
          data[i] = clamp255(rgb[0]);
          data[i + 1] = clamp255(rgb[1]);
          data[i + 2] = clamp255(rgb[2]);
        }
      }
    },
    hue: {
      name: '色相', fields: [field('value', '旋转', -180, 180, 1, 30)],
      process: function (data, w, h, p) {
        var shift = (p.value || 0) / 360;
        for (var i = 0; i < data.length; i += 4) {
          var hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          var rgb = hslToRgb((hsl[0] + shift + 1) % 1, hsl[1], hsl[2]);
          data[i] = clamp255(rgb[0]);
          data[i + 1] = clamp255(rgb[1]);
          data[i + 2] = clamp255(rgb[2]);
        }
      }
    },
    grayscale: {
      name: '去色', fields: [],
      process: function (data) {
        for (var i = 0; i < data.length; i += 4) {
          var v = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          data[i] = v; data[i + 1] = v; data[i + 2] = v;
        }
      }
    },
    invert: {
      name: '反相', fields: [],
      process: function (data) {
        for (var i = 0; i < data.length; i += 4) {
          data[i] = 255 - data[i];
          data[i + 1] = 255 - data[i + 1];
          data[i + 2] = 255 - data[i + 2];
        }
      }
    },
    blur: {
      name: '高斯模糊', fields: [field('value', '半径', 1, 40, 1, 6)],
      halo: function (p) { return Math.ceil((p.value || 6) * 3); },
      process: function (data, w, h, p) { boxBlur(data, w, h, p.value || 6); }
    },
    sharpen: {
      name: '锐化', fields: [field('value', '强度', 0, 200, 1, 60)],
      halo: function () { return 1; },
      process: function (data, w, h, p) { sharpen(data, w, h, p.value || 60); }
    },
    pixelate: {
      name: '像素化', fields: [field('value', '块大小', 2, 64, 1, 10)],
      halo: function (p) { return Math.ceil((p.value || 10) * 1.5); },
      process: function (data, w, h, p, env) { pixelate(data, w, h, p.value || 10, env.rect, env.layer); }
    },
    noise: {
      name: '噪点', fields: [field('value', '强度', 0, 100, 1, 22)],
      process: function (data, w, h, p) {
        var amount = (p.value || 0) * 1.6;
        for (var i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          var n = (Math.random() - 0.5) * amount;
          data[i] = clamp255(data[i] + n);
          data[i + 1] = clamp255(data[i + 1] + n);
          data[i + 2] = clamp255(data[i + 2] + n);
        }
      }
    }
  };

  var ORDER = ['brightness', 'contrast', 'saturate', 'hue', 'grayscale', 'invert', 'blur', 'sharpen', 'pixelate', 'noise'];

  function specOf(id) { return FILTERS[id] || null; }

  function expandRect(rect, halo, layer) {
    var x = Math.max(0, rect.x - halo);
    var y = Math.max(0, rect.y - halo);
    var x2 = Math.min(layer.width, rect.x + rect.w + halo);
    var y2 = Math.min(layer.height, rect.y + rect.h + halo);
    return { x: x, y: y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
  }

  async function apply(doc, layer, id, params, opts) {
    opts = opts || {};
    var spec = FILTERS[id];
    if (!spec) return { ok: false, reason: '未知滤镜：' + id };
    if (!layer || layer.type !== 'pixel') return { ok: false, reason: '请先选中一个像素图层' };
    var tiles = PS.existingTiles(layer);
    if (!tiles.length) return { ok: false, reason: '图层是空的，没有可处理的像素' };
    var halo = spec.halo ? Math.max(0, spec.halo(params || {})) : 0;
    var tx = PS.beginTx(doc, spec.name);
    var count = 0;
    for (var i = 0; i < tiles.length; i++) {
      if (opts.signal && opts.signal.aborted) break;
      var t = tiles[i];
      var rec = PS.snapTile(tx, layer, t);
      var rect = expandRect({ x: t.x, y: t.y, w: t.w, h: t.h }, halo, layer);
      var region = PS.readRegionLocal(layer, rect);
      spec.process(region.data, region.w, region.h, params || {}, { rect: rect, layer: layer, doc: doc });
      var sub = new ImageData(t.w, t.h);
      var ox = t.x - rect.x;
      var oy = t.y - rect.y;
      for (var row = 0; row < t.h; row++) {
        var from = ((oy + row) * region.w + ox) * 4;
        sub.data.set(region.data.subarray(from, from + t.w * 4), row * t.w * 4);
      }
      var mask = PS.maskForTile(doc, layer, t);
      if (mask && rec) {
        var b = rec.before.data;
        var m = mask.data;
        for (var p = 0; p < sub.data.length; p += 4) {
          var a = m[p + 3] / 255;
          if (a >= 1) continue;
          var inv = 1 - a;
          sub.data[p] = sub.data[p] * a + b[p] * inv;
          sub.data[p + 1] = sub.data[p + 1] * a + b[p + 1] * inv;
          sub.data[p + 2] = sub.data[p + 2] * a + b[p + 2] * inv;
          sub.data[p + 3] = sub.data[p + 3] * a + b[p + 3] * inv;
        }
      }
      t.ctx.putImageData(sub, 0, 0);
      count++;
      if (opts.onProgress) opts.onProgress(i + 1, tiles.length, spec.name);
      if ((i + 1) % 6 === 0) await PS.frame();
    }
    PS.touch(layer);
    PS.endTx(tx);
    doc.version++;
    if (opts.onProgress) opts.onProgress(tiles.length, tiles.length, spec.name);
    PS.requestMips(doc);
    return { ok: true, tiles: count, name: spec.name };
  }

  return {
    FILTERS: FILTERS,
    ORDER: ORDER,
    specOf: specOf,
    apply: apply
  };
})();
