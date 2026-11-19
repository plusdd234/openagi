/* 图像工坊 · 文档内核（PS 命名空间）
 *
 * 对标 Photoshop 的文档模型：**多图层 + 瓦片存储 + 选区 + 历史**。
 * 这一层不碰 DOM，只负责像素与状态，方便 ps-view / ps-filters / ps-tools 复用。
 *
 * 三个性能决定（参考网页版 PS 的做法）：
 *   ① 图层切成 256×256 瓦片，按需分配。打开 3000×2000 的图只有视口附近的
 *      瓦片会被画上屏，不在视口里的瓦片不参与合成，也不占绘制时间。
 *   ② 缩小视图时用 1/2^k 的 mip 层，而不是把几百个瓦片逐个缩放——
 *      缩到 30% 时一次 drawImage 就顶替几十次，这是滚动流畅的关键。
 *   ③ 历史只存**脏瓦片的 ImageData 前后快照**，不存整张图；超出预算丢最老的。
 *
 * 注意：这里用 OffscreenCanvas（不可用时退回 <canvas>），全程主线程、分片执行，
 * 不引 Worker —— 这个工作台是 file:// 直接开的，blob worker 在部分环境会失败。
 */
const PS = (function () {
  'use strict';

  var TILE = 256;
  var MAX_IMPORT_PIXELS = 48e6;     // 4800 万像素，超过就自动降采样
  var MAX_IMPORT_DIM = 16384;       // 单边上限，超过显卡/画布会直接失败
  var MAX_MIP_DIM = 2048;           // 最底层 mip 不小于这个尺寸就停止生成
  var MIP_MAX_LEVELS = 4;
  var HISTORY_BUDGET = 192 * 1024 * 1024;
  var FLOOD_LIMIT = 16e6;           // 油漆桶按整层像素处理的安全上限

  var seq = 0;

  /* ---------------- 基础画布 ---------------- */
  function makeCanvas(w, h) {
    w = Math.max(1, Math.round(w || 1));
    h = Math.max(1, Math.round(h || 1));
    var canvas = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      try { canvas = new OffscreenCanvas(w, h); } catch (e) { canvas = null; }
    }
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    }
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    return { canvas: canvas, ctx: ctx, w: w, h: h };
  }

  function canvasW(canvas) { return canvas ? (canvas.width || 0) : 0; }
  function canvasH(canvas) { return canvas ? (canvas.height || 0) : 0; }

  function frame() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { resolve(); });
      else setTimeout(resolve, 16);
    });
  }

  function blendOp(name) {
    var map = {
      normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
      darken: 'darken', lighten: 'lighten', 'color-dodge': 'color-dodge',
      'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light',
      difference: 'difference', exclusion: 'exclusion', hue: 'hue',
      saturation: 'saturation', color: 'color', luminosity: 'luminosity'
    };
    return map[name] || 'source-over';
  }

  /* ---------------- 调整层定义（合成与 UI 共用一份） ---------------- */
  var ADJUST_DEFS = {
    brightness: { name: '亮度', def: 1.25, min: 0, max: 2, step: 0.01, unit: '×',
      css: function (v) { return 'brightness(' + Math.round(v * 100) + '%)'; } },
    contrast: { name: '对比度', def: 1.3, min: 0, max: 2, step: 0.01, unit: '×',
      css: function (v) { return 'contrast(' + Math.round(v * 100) + '%)'; } },
    saturate: { name: '饱和度', def: 1.35, min: 0, max: 2, step: 0.01, unit: '×',
      css: function (v) { return 'saturate(' + Math.round(v * 100) + '%)'; } },
    hue: { name: '色相', def: 40, min: -180, max: 180, step: 1, unit: '°',
      css: function (v) { return 'hue-rotate(' + Math.round(v) + 'deg)'; } },
    blur: { name: '高斯模糊', def: 6, min: 0, max: 60, step: 0.5, unit: 'px',
      css: function (v) { return 'blur(' + v + 'px)'; } },
    grayscale: { name: '去除饱和', def: 0.75, min: 0, max: 1, step: 0.01, unit: '',
      css: function (v) { return 'grayscale(' + Math.round(v * 100) + '%)'; } },
    invert: { name: '反相', def: 1, min: 0, max: 1, step: 0.01, unit: '',
      css: function (v) { return 'invert(' + Math.round(v * 100) + '%)'; } }
  };

  function adjustString(layer) {
    if (!layer || layer.type !== 'adjust' || !layer.adjust) return 'none';
    var def = ADJUST_DEFS[layer.adjust.kind];
    if (!def) return 'none';
    var v = layer.adjust.params && typeof layer.adjust.params.value === 'number'
      ? layer.adjust.params.value : def.def;
    return def.css(v);
  }

  function adjustColor(kind) {
    var c = {
      brightness: '#8a6b2f', contrast: '#6b5a8a', saturate: '#2f7a65',
      hue: '#8a3f6b', blur: '#3d5c7a', grayscale: '#55575c', invert: '#6a4a2f'
    };
    return c[kind] || '#55575c';
  }

  /* ---------------- 文档 / 图层 ---------------- */
  function createDoc(w, h, name, opts) {
    opts = opts || {};
    var doc = {
      id: 'D' + (++seq),
      width: Math.max(1, Math.round(w || 1)),
      height: Math.max(1, Math.round(h || 1)),
      name: name || '未命名作品',
      layers: [],
      activeId: null,
      selection: { active: false, invert: false, shape: null, feather: 0, version: 0 },
      history: { entries: [], index: -1, bytes: 0 },
      version: 0
    };
    if (opts.fill !== false) {
      var l = createLayer(doc, { name: opts.layerName || '背景' });
      fillLayer(l, opts.fill || '#ffffff');
      doc.activeId = l.id;
    }
    return doc;
  }

  function normalizeLocks(raw, legacyLocked) {
    var src = raw && typeof raw === 'object' ? raw : {};
    var out = {
      transparent: src.transparent === true,
      image: src.image === true,
      position: src.position === true,
      all: src.all === true
    };
    if (legacyLocked) out.position = true;
    return out;
  }

  function hasLock(layer, kind) {
    if (!layer || !layer.locks) return false;
    if (layer.locks.all) return true;
    return layer.locks[kind] === true;
  }

  function createLayer(doc, opts) {
    opts = opts || {};
    var l = {
      id: 'L' + (++seq),
      name: opts.name || ('图层 ' + (doc.layers.length + 1)),
      type: opts.type || 'pixel',
      /* 组：type==='group' 的条目只做容器，不参与合成；
       * 子图层用 group 记组 id，可见性 / 不透明度沿组链累乘 */
      group: opts.group || null,
      collapsed: opts.collapsed === true,
      visible: opts.visible !== false,
      opacity: typeof opts.opacity === 'number' ? opts.opacity : 1,
      blend: opts.blend || 'normal',
      /* 四种锁定和 PS 一致：透明像素 / 图像像素 / 位置 / 全部 */
      locks: normalizeLocks(opts.locks, opts.locked === true),
      x: opts.x || 0,
      y: opts.y || 0,
      width: Math.max(1, Math.round(opts.width || doc.width)),
      height: Math.max(1, Math.round(opts.height || doc.height)),
      tiles: new Map(),
      mask: null,
      adjust: opts.adjust || null,
      shapes: opts.shapes ? opts.shapes.map(cloneShape) : null,
      version: 0,
      mips: [],
      mipReady: false,
      mipPending: false,
      thumbDirty: true,
      _maskCache: null
    };
    doc.layers.push(l);
    doc.version++;
    return l;
  }

  function layerById(doc, id) { return doc.layers.find(function (l) { return l.id === id; }) || null; }
  function activeLayer(doc) { return layerById(doc, doc.activeId); }

  /* 组链：子图层 → 组 → 组的上级组。防止脏数据成环 */
  function groupVisible(doc, layer) {
    var gid = layer && layer.group, guard = 0;
    while (gid && guard++ < 32) {
      var g = layerById(doc, gid);
      if (!g) break;
      if (!g.visible) return false;
      gid = g.group;
    }
    return true;
  }
  function groupOpacity(doc, layer) {
    var k = 1, gid = layer && layer.group, guard = 0;
    while (gid && guard++ < 32) {
      var g = layerById(doc, gid);
      if (!g) break;
      k *= typeof g.opacity === 'number' ? g.opacity : 1;
      gid = g.group;
    }
    return k;
  }

  function touch(layer) {
    if (!layer) return;
    layer.version++;
    layer.mips = [];
    layer.mipReady = false;
    layer.thumbDirty = true;
  }

  function touchDoc(doc) { doc.version++; }

  function tileKey(tx, ty) { return tx + ',' + ty; }
  function tileCols(layer) { return Math.ceil(layer.width / TILE); }
  function tileRows(layer) { return Math.ceil(layer.height / TILE); }

  function ensureTile(layer, tx, ty, create) {
    if (create === undefined) create = true;
    var key = tileKey(tx, ty);
    var t = layer.tiles.get(key);
    if (t) return t;
    if (!create) return null;
    var x = tx * TILE;
    var y = ty * TILE;
    var w = Math.min(TILE, layer.width - x);
    var h = Math.min(TILE, layer.height - y);
    if (w <= 0 || h <= 0) return null;
    var cv = makeCanvas(w, h);
    t = { key: key, tx: tx, ty: ty, x: x, y: y, w: w, h: h, canvas: cv.canvas, ctx: cv.ctx };
    layer.tiles.set(key, t);
    return t;
  }

  function ensureAllTiles(layer) {
    var cols = tileCols(layer);
    var rows = tileRows(layer);
    var out = [];
    for (var ty = 0; ty < rows; ty++) {
      for (var tx = 0; tx < cols; tx++) out.push(ensureTile(layer, tx, ty, true));
    }
    return out;
  }

  function existingTiles(layer) {
    var arr = [];
    layer.tiles.forEach(function (t) { arr.push(t); });
    return arr;
  }

  /* ---------------- 图层蒙版 ----------------
   * 蒙版和图层共用瓦片网格；瓦片 alpha 表示「隐藏量」，缺省瓦片 = 完全可见。
   * 这样只有真正画过的区域才占内存，合成时用 destination-in 把内容裁掉。
   */
  function createMask(layer) {
    return {
      enabled: true,
      width: layer.width,
      height: layer.height,
      tiles: new Map(),
      version: 0
    };
  }

  function ensureMaskTile(mask, tx, ty, create) {
    if (!mask) return null;
    if (create === undefined) create = true;
    var key = tileKey(tx, ty);
    var t = mask.tiles.get(key);
    if (t) return t;
    if (!create) return null;
    var x = tx * TILE;
    var y = ty * TILE;
    var w = Math.min(TILE, mask.width - x);
    var h = Math.min(TILE, mask.height - y);
    if (w <= 0 || h <= 0) return null;
    var cv = makeCanvas(w, h);
    t = { key: key, tx: tx, ty: ty, x: x, y: y, w: w, h: h, canvas: cv.canvas, ctx: cv.ctx };
    mask.tiles.set(key, t);
    return t;
  }

  function maskTileOfLocal(mask, lx, ly) {
    if (!mask || lx < 0 || ly < 0 || lx >= mask.width || ly >= mask.height) return null;
    return mask.tiles.get(tileKey(Math.floor(lx / TILE), Math.floor(ly / TILE))) || null;
  }

  function maskEmpty(mask) {
    return !mask || !mask.tiles.size;
  }

  /* 整层灰度画布：白=可见，黑=隐藏。用于存档与缩略图。 */
  function maskCanvas(mask) {
    var cv = makeCanvas(Math.max(1, mask.width), Math.max(1, mask.height));
    cv.ctx.fillStyle = '#ffffff';
    cv.ctx.fillRect(0, 0, cv.canvas.width, cv.canvas.height);
    mask.tiles.forEach(function (t) {
      cv.ctx.drawImage(t.canvas, t.x, t.y);
    });
    return cv.canvas;
  }

  function maskPreview(mask, size) {
    size = size || 34;
    var s = Math.min(size / Math.max(1, mask.width), size / Math.max(1, mask.height), 1);
    var cv = makeCanvas(Math.max(1, Math.round(mask.width * s)), Math.max(1, Math.round(mask.height * s)));
    cv.ctx.fillStyle = '#ffffff';
    cv.ctx.fillRect(0, 0, cv.canvas.width, cv.canvas.height);
    mask.tiles.forEach(function (t) {
      cv.ctx.drawImage(t.canvas, t.x * s, t.y * s, t.w * s, t.h * s);
    });
    return cv.canvas;
  }

  /* 把蒙版烘焙进图层像素（应用蒙版 / 合并前），返回是否有像素变化 */
  function bakeMaskToLayerTiles(layer) {
    var mask = layer.mask;
    if (!mask) return false;
    if (!mask.enabled || !mask.tiles.size) return false;
    layer.tiles.forEach(function (t) {
      var mt = mask.tiles.get(t.key);
      if (!mt) return;
      var img = t.ctx.getImageData(0, 0, t.w, t.h);
      var mi = mt.ctx.getImageData(0, 0, mt.w, mt.h);
      var d = img.data, m = mi.data;
      for (var i = 3; i < d.length; i += 4) {
        var hide = m[i] / 255;
        d[i] = Math.round(d[i] * (1 - hide));
      }
      t.ctx.putImageData(img, 0, 0);
    });
    return true;
  }

  function addLayerMask(doc, layer) {
    if (!doc || !layer || layer.type !== 'pixel') return null;
    if (layer.mask) return layer.mask;
    var mask = createMask(layer);
    layer.mask = mask;
    layer.version++;
    doc.version++;
    pushEntry(doc, {
      label: '添加图层蒙版',
      touched: [layer],
      undo: function () { layer.mask = null; layer.version++; doc.version++; },
      redo: function () { layer.mask = mask; layer.version++; doc.version++; }
    });
    return mask;
  }

  function removeLayerMask(doc, layer) {
    if (!doc || !layer || !layer.mask) return false;
    var mask = layer.mask;
    layer.mask = null;
    layer.version++;
    doc.version++;
    pushEntry(doc, {
      label: '删除图层蒙版',
      touched: [layer],
      undo: function () { layer.mask = mask; layer.version++; doc.version++; },
      redo: function () { layer.mask = null; layer.version++; doc.version++; }
    });
    return true;
  }

  function setLayerMaskEnabled(doc, layer, enabled) {
    if (!doc || !layer || !layer.mask) return false;
    if (layer.mask.enabled === enabled) return false;
    layer.mask.enabled = enabled;
    layer.version++;
    doc.version++;
    pushEntry(doc, {
      label: enabled ? '启用图层蒙版' : '停用图层蒙版',
      touched: [layer],
      undo: function () { layer.mask.enabled = !enabled; layer.version++; doc.version++; },
      redo: function () { layer.mask.enabled = enabled; layer.version++; doc.version++; }
    });
    return true;
  }

  function applyLayerMask(doc, layer) {
    if (!doc || !layer || !layer.mask) return false;
    var mask = layer.mask;
    var tx = beginTx(doc, '应用图层蒙版');
    layer.tiles.forEach(function (t) { snapTile(tx, layer, t); });
    bakeMaskToLayerTiles(layer);
    layer.mask = null;
    layer.version++;
    tx.undoOps.push(function () { layer.mask = mask; layer.version++; });
    tx.redoOps.push(function () { layer.mask = null; layer.version++; });
    endTx(tx);
    doc.version++;
    requestMips(doc);
    return true;
  }

  function alphaLocked(layer) {
    return hasLock(layer, 'transparent');
  }

  /* 透明像素锁：把事务里每个瓦片的 alpha 还原为落笔前 */
  function restoreTileAlpha(tx) {
    if (!tx) return;
    tx.tiles.forEach(function (rec) {
      var now = rec.tile.ctx.getImageData(0, 0, rec.tile.w, rec.tile.h);
      var before = rec.before.data;
      var d = now.data;
      for (var i = 3; i < d.length; i += 4) d[i] = before[i];
      rec.tile.ctx.putImageData(now, 0, 0);
    });
  }

  function tileOfLocal(layer, lx, ly) {
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) return null;
    return layer.tiles.get(tileKey(Math.floor(lx / TILE), Math.floor(ly / TILE))) || null;
  }

  function layerDocRect(layer) { return { x: layer.x, y: layer.y, w: layer.width, h: layer.height }; }

  /* ---------------- 矢量形状 ----------------
   * 形状图层不做栅格化：每个形状保留在 layer.shapes 里，合成时按当前缩放
   * 用 Path2D 重画，因此放大到 800% 也保持锐利。坐标是图层本地坐标，
   * 移动工具改 layer.x / layer.y 即可整体平移，导出时由 composite 统一拼平。
   */
  function cloneShape(s) {
    if (!s) return s;
    var out = { kind: s.kind, fill: s.fill || null, stroke: s.stroke || null,
      strokeWidth: s.strokeWidth || 0, opacity: s.opacity == null ? 1 : s.opacity,
      op: s.op || 'add' };
    if (s.kind === 'path') {
      out.closed = !!s.closed;
      out.pts = (s.pts || []).map(function (p) {
        return {
          x: p.x, y: p.y,
          hix: p.hix == null ? null : p.hix, hiy: p.hiy == null ? null : p.hiy,
          hox: p.hox == null ? null : p.hox, hoy: p.hoy == null ? null : p.hoy
        };
      });
      if (s.subpaths && s.subpaths.length) {
        out.subpaths = s.subpaths.map(function (sp) {
          return {
            closed: sp.closed !== false,
            pts: (sp.pts || []).map(function (p) { return { x: p.x, y: p.y }; })
          };
        });
      }
    } else if (s.kind === 'line') {
      out.x1 = s.x1; out.y1 = s.y1; out.x2 = s.x2; out.y2 = s.y2;
    } else {
      out.x = s.x; out.y = s.y; out.w = s.w; out.h = s.h;
    }
    return out;
  }

  function shapeBounds(s) {
    if (!s) return null;
    var x0, y0, x1, y1;
    if (s.kind === 'line') {
      x0 = Math.min(s.x1, s.x2); y0 = Math.min(s.y1, s.y2);
      x1 = Math.max(s.x1, s.x2); y1 = Math.max(s.y1, s.y2);
    } else if (s.kind === 'path') {
      var pts = [];
      if (s.subpaths && s.subpaths.length) {
        s.subpaths.forEach(function (sp) {
          (sp.pts || []).forEach(function (p) { pts.push(p); });
        });
      } else {
        pts = s.pts || [];
      }
      if (!pts.length) return null;
      x0 = x1 = pts[0].x; y0 = y1 = pts[0].y;
      pts.forEach(function (p) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      });
    } else {
      x0 = Math.min(s.x, s.x + s.w); y0 = Math.min(s.y, s.y + s.h);
      x1 = Math.max(s.x, s.x + s.w); y1 = Math.max(s.y, s.y + s.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* 图层内容的文档坐标包围盒（移动对齐 / 参考线用）。
   * 像素层按实际 alpha 判断，空瓦片与全透明区域不计入；
   * 结果按 layer.version 缓存，连续拖动不会每帧重扫像素。 */
  function layerContentBounds(layer) {
    if (!layer) return null;
    if (layer.type === 'shape') {
      var sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
      (layer.shapes || []).forEach(function (s) {
        var b = shapeBounds(s);
        if (!b) return;
        sx0 = Math.min(sx0, b.x); sy0 = Math.min(sy0, b.y);
        sx1 = Math.max(sx1, b.x + b.w); sy1 = Math.max(sy1, b.y + b.h);
      });
      if (!isFinite(sx0)) return null;
      return {
        x: layer.x + sx0, y: layer.y + sy0,
        w: sx1 - sx0, h: sy1 - sy0
      };
    }
    if (layer.type !== 'pixel' || !layer.tiles) return null;
    var cache = layer._boundsCache;
    if (cache && cache.version === layer.version) {
      return {
        x: layer.x + cache.rel.x, y: layer.y + cache.rel.y,
        w: cache.rel.w, h: cache.rel.h
      };
    }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    layer.tiles.forEach(function (t) {
      var data;
      try {
        data = t.ctx.getImageData(0, 0, t.w, t.h).data;
      } catch (err) {
        return;
      }
      var minX = t.w, minY = t.h, maxX = -1, maxY = -1;
      for (var y = 0; y < t.h; y++) {
        for (var x = 0; x < t.w; x++) {
          if (data[(y * t.w + x) * 4 + 3]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return;
      x0 = Math.min(x0, t.x + minX); y0 = Math.min(y0, t.y + minY);
      x1 = Math.max(x1, t.x + maxX + 1); y1 = Math.max(y1, t.y + maxY + 1);
    });
    if (!isFinite(x0)) {
      // 全透明层：退回图层框，仍可参与位置对齐
      layer._boundsCache = { version: layer.version, rel: { x: 0, y: 0, w: layer.width, h: layer.height } };
      return { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
    }
    var rel = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    layer._boundsCache = { version: layer.version, rel: rel };
    return { x: layer.x + x0, y: layer.y + y0, w: rel.w, h: rel.h };
  }

  /* 把形状写进当前路径（调用方负责 beginPath / fill / stroke）。 */
  function shapePath(ctx, s) {
    if (!s) return;
    if (s.kind === 'rect') {
      ctx.rect(s.x, s.y, s.w, s.h);
    } else if (s.kind === 'ellipse') {
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2,
        Math.max(0.5, Math.abs(s.w) / 2), Math.max(0.5, Math.abs(s.h) / 2),
        0, 0, Math.PI * 2);
    } else if (s.kind === 'line') {
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
    } else if (s.kind === 'path') {
      if (s.subpaths && s.subpaths.length) {
        s.subpaths.forEach(function (sp) {
          var spPts = sp.pts || [];
          if (!spPts.length) return;
          ctx.moveTo(spPts[0].x, spPts[0].y);
          for (var j = 1; j < spPts.length; j++) ctx.lineTo(spPts[j].x, spPts[j].y);
          if (sp.closed !== false) ctx.closePath();
        });
        return;
      }
      var pts = s.pts || [];
      if (!pts.length) return;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i - 1];
        var b = pts[i];
        var c1x = a.hox == null ? a.x : a.hox;
        var c1y = a.hoy == null ? a.y : a.hoy;
        var c2x = b.hix == null ? b.x : b.hix;
        var c2y = b.hiy == null ? b.y : b.hiy;
        if (a.hox == null && b.hix == null) ctx.lineTo(b.x, b.y);
        else ctx.bezierCurveTo(c1x, c1y, c2x, c2y, b.x, b.y);
      }
      if (s.closed) {
        var last = pts[pts.length - 1];
        var first = pts[0];
        var c1x2 = last.hox == null ? last.x : last.hox;
        var c1y2 = last.hoy == null ? last.y : last.hoy;
        var c2x2 = first.hix == null ? first.x : first.hix;
        var c2y2 = first.hiy == null ? first.y : first.hiy;
        if (last.hox == null && first.hix == null) ctx.lineTo(first.x, first.y);
        else ctx.bezierCurveTo(c1x2, c1y2, c2x2, c2y2, first.x, first.y);
        ctx.closePath();
      }
    }
  }

  function paintShape(ctx, s) {
    if (!s) return;
    var alpha = s.opacity == null ? 1 : s.opacity;
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.beginPath();
    shapePath(ctx, s);
    if (s.fill && s.kind !== 'line') {
      ctx.fillStyle = s.fill;
      if (s.subpaths && s.subpaths.length) ctx.fill('evenodd');
      else ctx.fill();
    }
    if (s.stroke && s.strokeWidth > 0) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 矢量布尔运算 ----------------
   * 形状按数组顺序组合，op 决定它如何作用到前面已合成的结果：
   *   add      合并（source-over）
   *   subtract 减去（destination-out）
   *   intersect 相交（destination-in）
   *   exclude  排除重叠（xor）
   * 纯 Canvas 没有路径布尔，所以用离屏缓冲逐条复合；只有出现非 add 时才走缓冲，
   * 普通形状仍走原来的直接绘制路径，性能不受影响。
   */
  var SHAPE_OPS = { add: 1, subtract: 1, intersect: 1, exclude: 1 };
  var SHAPE_OP_NAMES = { add: '合并', subtract: '减去', intersect: '相交', exclude: '排除' };
  var _shapeBuf = null;

  function shapeOp(s) {
    return s && SHAPE_OPS[s.op] ? s.op : 'add';
  }

  function shapeComposite(op) {
    return op === 'subtract' ? 'destination-out'
      : op === 'intersect' ? 'destination-in'
        : op === 'exclude' ? 'xor' : 'source-over';
  }

  function shapeBuffer(w, h) {
    w = Math.max(1, Math.ceil(w));
    h = Math.max(1, Math.ceil(h));
    if (!_shapeBuf || _shapeBuf.w < w || _shapeBuf.h < h) {
      _shapeBuf = makeCanvas(Math.max(w, _shapeBuf ? _shapeBuf.w : 0), Math.max(h, _shapeBuf ? _shapeBuf.h : 0));
    }
    var b = _shapeBuf;
    b.ctx.setTransform(1, 0, 0, 1, 0, 0);
    b.ctx.globalAlpha = 1;
    b.ctx.globalCompositeOperation = 'source-over';
    b.ctx.clearRect(0, 0, b.w, b.h);
    return b;
  }

  /* 视觉包围盒：把贝塞尔控制柄和描边宽度算进去，避免缓冲裁掉曲线外弧。 */
  function shapeVisualBounds(s) {
    var b = shapeBounds(s);
    if (!b) return null;
    var x0 = b.x;
    var y0 = b.y;
    var x1 = b.x + b.w;
    var y1 = b.y + b.h;
    if (s.kind === 'path') {
      (s.pts || []).forEach(function (p) {
        if (p.hix != null) { x0 = Math.min(x0, p.hix); x1 = Math.max(x1, p.hix); }
        if (p.hiy != null) { y0 = Math.min(y0, p.hiy); y1 = Math.max(y1, p.hiy); }
        if (p.hox != null) { x0 = Math.min(x0, p.hox); x1 = Math.max(x1, p.hox); }
        if (p.hoy != null) { y0 = Math.min(y0, p.hoy); y1 = Math.max(y1, p.hoy); }
      });
    }
    var pad = Math.max(2, (s.strokeWidth || 0) * 0.75 + 1);
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  function paintShapeWithOp(ctx, s, op) {
    if (!s) return;
    var alpha = s.opacity == null ? 1 : s.opacity;
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.globalCompositeOperation = shapeComposite(op);
    ctx.beginPath();
    shapePath(ctx, s);
    if (s.fill && s.kind !== 'line') {
      ctx.fillStyle = s.fill;
      if (s.subpaths && s.subpaths.length) ctx.fill('evenodd');
      else ctx.fill();
    }
    if (s.stroke && s.strokeWidth > 0) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  function hasShapeBoolean(shapes) {
    for (var i = 0; i < shapes.length; i++) if (shapeOp(shapes[i]) !== 'add') return true;
    return false;
  }

  /* 在任意已定位的上下文里画一组带布尔关系的形状（缩略图 / 合并 / 栅格化用）。 */
  function paintShapesBuffered(ctx, shapes) {
    if (!shapes || !shapes.length) return;
    if (!hasShapeBoolean(shapes)) {
      shapes.forEach(function (s) { paintShape(ctx, s); });
      return;
    }
    var x0 = Infinity;
    var y0 = Infinity;
    var x1 = -Infinity;
    var y1 = -Infinity;
    shapes.forEach(function (s) {
      var b = shapeVisualBounds(s);
      if (!b) return;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    });
    if (!isFinite(x0)) return;
    var bw = Math.max(1, x1 - x0);
    var bh = Math.max(1, y1 - y0);
    var buf = shapeBuffer(bw, bh);
    buf.ctx.translate(-x0, -y0);
    for (var i = 0; i < shapes.length; i++) {
      paintShapeWithOp(buf.ctx, shapes[i], i === 0 ? 'add' : shapeOp(shapes[i]));
    }
    ctx.drawImage(buf.canvas, 0, 0, bw, bh, x0, y0, bw, bh);
  }

  /* ---------------- 布尔轮廓化：把视觉结果写回真实锚点 ----------------
   * Canvas 没有路径布尔，复合结果只是一次性绘制。这里用「超采样 + Marching Squares
   * 提取等值线 + RDP 简化」把复合结果转成一条带 subpaths 的闭合路径：
   * 外形与孔洞都变成真实锚点，缩放仍然清晰，后续可以继续用路径选择工具编辑。
   * 这是折线近似（不做曲线拟合），但不再依赖离屏缓冲反复合成。
   */
  var MS_CASES = {
    1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]],
    6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[2, 0]],
    11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]]
  };

  function msKey(p) {
    return Math.round(p.x * 1000) + ',' + Math.round(p.y * 1000);
  }

  function msSegment(caseIdx, x, y, a, b, c, d) {
    function cut(edge) {
      var v0, v1;
      if (edge === 0) { v0 = a; v1 = b; }
      else if (edge === 1) { v0 = b; v1 = c; }
      else if (edge === 2) { v0 = d; v1 = c; }
      else { v0 = a; v1 = d; }
      var t = (v1 === v0) ? 0.5 : (128 - v0) / (v1 - v0);
      t = Math.max(0, Math.min(1, t));
      if (edge === 0) return { x: x + t, y: y };
      if (edge === 1) return { x: x + 1, y: y + t };
      if (edge === 2) return { x: x + t, y: y + 1 };
      return { x: x, y: y + t };
    }
    var defs = MS_CASES[caseIdx];
    if (!defs) {
      if (caseIdx === 5) defs = (a + b + c + d) / 4 >= 128 ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
      else if (caseIdx === 10) defs = (a + b + c + d) / 4 >= 128 ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
      else return null;
    }
    return { a: cut(defs[0][0]), b: cut(defs[0][1]), a2: defs[1] ? cut(defs[1][0]) : null, b2: defs[1] ? cut(defs[1][1]) : null };
  }

  /* 从 alpha 栅格里提取闭合等值线（网格坐标）。 */
  function marchContours(data, W, H) {
    var at = function (x, y) { return data[(y * W + x) * 4 + 3]; };
    var segs = [];
    function push(p1, p2) { if (p1 && p2) segs.push([p1, p2]); }
    for (var y = 0; y < H - 1; y++) {
      for (var x = 0; x < W - 1; x++) {
        var a = at(x, y);
        var b = at(x + 1, y);
        var c = at(x + 1, y + 1);
        var d = at(x, y + 1);
        var idx = (a >= 128 ? 1 : 0) | (b >= 128 ? 2 : 0) | (c >= 128 ? 4 : 0) | (d >= 128 ? 8 : 0);
        if (!idx || idx === 15) continue;
        var s = msSegment(idx, x, y, a, b, c, d);
        if (!s) continue;
        push(s.a, s.b);
        push(s.a2, s.b2);
      }
    }
    if (!segs.length) return [];
    // 端点量化后建邻接，串成闭合环
    var adj = new Map();
    segs.forEach(function (seg, i) {
      [seg[0], seg[1]].forEach(function (p) {
        var k = msKey(p);
        if (!adj.has(k)) adj.set(k, []);
        adj.get(k).push(i);
      });
    });
    var used = new Array(segs.length);
    var loops = [];
    for (var i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      var seg = segs[i];
      used[i] = true;
      var loop = [seg[0], seg[1]];
      var startKey = msKey(seg[0]);
      var curKey = msKey(seg[1]);
      var guard = 0;
      while (curKey !== startKey && guard++ < segs.length + 8) {
        var cands = adj.get(curKey) || [];
        var next = -1;
        for (var ci = 0; ci < cands.length; ci++) if (!used[cands[ci]]) { next = cands[ci]; break; }
        if (next < 0) break;
        used[next] = true;
        var ns = segs[next];
        var np = msKey(ns[0]) === curKey ? ns[1] : ns[0];
        loop.push(np);
        curKey = msKey(np);
      }
      if (loop.length >= 4 && curKey === startKey) loops.push(loop);
    }
    return loops;
  }

  function pointSegDist(p, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len = dx * dx + dy * dy;
    var t = len ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    var ex = p.x - (a.x + dx * t);
    var ey = p.y - (a.y + dy * t);
    return Math.sqrt(ex * ex + ey * ey);
  }

  /* 迭代式 Ramer–Douglas–Peucker，避免长直线上递归过深。 */
  function simplifyLoop(pts, eps) {
    if (pts.length < 4) return pts;
    var closedPts = pts.concat([pts[0]]);
    var keep = new Array(closedPts.length);
    keep[0] = keep[closedPts.length - 1] = true;
    var stack = [[0, closedPts.length - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var a = seg[0];
      var b = seg[1];
      var maxD = -1;
      var idx = -1;
      for (var i = a + 1; i < b; i++) {
        var dist = pointSegDist(closedPts[i], closedPts[a], closedPts[b]);
        if (dist > maxD) { maxD = dist; idx = i; }
      }
      if (maxD > eps && idx > a) {
        keep[idx] = true;
        stack.push([a, idx], [idx, b]);
      }
    }
    var out = [];
    for (var j = 0; j < closedPts.length - 1; j++) if (keep[j]) out.push(closedPts[j]);
    return out;
  }

  function loopArea(pts) {
    var area = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var q = pts[(i + 1) % pts.length];
      area += p.x * q.y - q.x * p.y;
    }
    return area / 2;
  }

  /* 把形状层的布尔复合结果轮廓化，替换为一条带 subpaths 的路径（可撤销）。 */
  function outlineShapeLayer(doc, layer) {
    if (!doc || !layer || layer.type !== 'shape' || !layer.shapes || layer.shapes.length < 2) return null;
    if (!hasShapeBoolean(layer.shapes)) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    layer.shapes.forEach(function (s) {
      var b = shapeVisualBounds(s);
      if (!b) return;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    });
    if (!isFinite(x0)) return null;
    var pad = 4;
    var bx = Math.floor(x0 - pad);
    var by = Math.floor(y0 - pad);
    var bw = Math.max(8, Math.ceil(x1 - x0 + pad * 2));
    var bh = Math.max(8, Math.ceil(y1 - y0 + pad * 2));
    var S = bw * bh > 3e6 ? 1 : 2;
    var cv = makeCanvas(bw * S, bh * S);
    var ctx = cv.ctx;
    ctx.setTransform(S, 0, 0, S, -bx * S, -by * S);
    for (var i = 0; i < layer.shapes.length; i++) {
      paintShapeWithOp(ctx, layer.shapes[i], i === 0 ? 'add' : shapeOp(layer.shapes[i]));
    }
    var img = ctx.getImageData(0, 0, cv.canvas.width, cv.canvas.height);
    var loops = marchContours(img.data, cv.canvas.width, cv.canvas.height);
    var subpaths = [];
    loops.forEach(function (loop) {
      var docPts = loop.map(function (p) {
        return { x: bx + p.x / S, y: by + p.y / S };
      });
      var simple = simplifyLoop(docPts, 0.45);
      if (simple.length < 3 || Math.abs(loopArea(simple)) < 0.5) return;
      subpaths.push({ pts: simple, closed: true });
    });
    if (!subpaths.length) return null;
    subpaths.sort(function (a, b) { return Math.abs(loopArea(b.pts)) - Math.abs(loopArea(a.pts)); });
    var top = layer.shapes[layer.shapes.length - 1];
    var shape = {
      kind: 'path',
      closed: true,
      pts: [],
      subpaths: subpaths,
      fill: top.fill || '#8a94a6',
      stroke: top.stroke || null,
      strokeWidth: top.strokeWidth || 0,
      opacity: 1,
      op: 'add'
    };
    var prev = layer.shapes;
    var prevVersion = layer.version;
    layer.shapes = [shape];
    layer.version++;
    pushEntry(doc, {
      label: '轮廓化布尔结果',
      touched: [layer],
      undo: function () { layer.shapes = prev; layer.version = prevVersion; doc.version++; },
      redo: function () { layer.shapes = [shape]; layer.version++; doc.version++; }
    });
    doc.version++;
    return shape;
  }

  /* 在任意 2D 上下文里按 scale 画一个形状图层的全部形状（缩略图 / 合并用）。 */
  function drawShapesInto(ctx, layer, scale) {
    if (!layer || !layer.shapes || !layer.shapes.length) return;
    ctx.save();
    ctx.scale(scale || 1, scale || 1);
    ctx.translate(layer.x || 0, layer.y || 0);
    paintShapesBuffered(ctx, layer.shapes);
    ctx.restore();
  }

  function createShapeLayer(doc, shapes, opts) {
    opts = opts || {};
    var l = createLayer(doc, {
      name: opts.name || '矢量形状',
      type: 'shape',
      width: doc.width,
      height: doc.height,
      x: 0,
      y: 0
    });
    l.shapes = (shapes || []).map(cloneShape);
    touch(l);
    return l;
  }

  /* 新建矢量图层并写入历史：撤销时整层移除，重做时整层放回。 */
  function addShapeLayer(doc, shapes, opts) {
    opts = opts || {};
    var l = createShapeLayer(doc, shapes, opts);
    var index = doc.layers.length - 1;
    var prevActive = doc.activeId;
    doc.activeId = l.id;
    pushEntry(doc, {
      label: opts.label || '新建矢量形状',
      touched: [l],
      undo: function () {
        var i = doc.layers.indexOf(l);
        if (i >= 0) doc.layers.splice(i, 1);
        doc.activeId = prevActive;
        doc.version++;
      },
      redo: function () {
        if (doc.layers.indexOf(l) < 0) doc.layers.splice(Math.min(index, doc.layers.length), 0, l);
        doc.activeId = l.id;
        doc.version++;
      }
    });
    doc.version++;
    return l;
  }

  /* 把新形状追加到已有形状层（布尔组合需要同一层里的多条路径）。 */
  function appendShape(doc, layer, shape, opts) {
    opts = opts || {};
    if (!layer || layer.type !== 'shape') return null;
    if (!layer.shapes) layer.shapes = [];
    var item = cloneShape(shape);
    layer.shapes.push(item);
    layer.version++;
    var index = layer.shapes.length - 1;
    var prevActive = doc.activeId;
    doc.activeId = layer.id;
    pushEntry(doc, {
      label: opts.label || '添加矢量形状',
      touched: [layer],
      undo: function () {
        var i = layer.shapes.indexOf(item);
        if (i >= 0) layer.shapes.splice(i, 1);
        layer.version++;
        doc.activeId = prevActive;
        doc.version++;
      },
      redo: function () {
        if (layer.shapes.indexOf(item) < 0) layer.shapes.splice(Math.min(index, layer.shapes.length), 0, item);
        layer.version++;
        doc.activeId = layer.id;
        doc.version++;
      }
    });
    doc.version++;
    return layer;
  }

  /* 修改单个形状的布尔运算，可撤销。 */
  function setShapeOp(doc, layer, shape, op) {
    if (!layer || !shape || !SHAPE_OPS[op]) return false;
    var before = shapeOp(shape);
    if (before === op) return true;
    shape.op = op;
    layer.version++;
    pushEntry(doc, {
      label: '布尔运算 · ' + SHAPE_OP_NAMES[op],
      touched: [layer],
      undo: function () { shape.op = before; layer.version++; doc.version++; },
      redo: function () { shape.op = op; layer.version++; doc.version++; }
    });
    doc.version++;
    return true;
  }

  /* 矢量图层栅格化：把形状烘焙进瓦片，之后可以继续画笔 / 滤镜 / 涂抹。
   * 图层不透明度与混合模式保留在图层层，不重复烘进像素。 */
  function rasterizeShapeLayer(doc, layer) {
    if (!layer || layer.type !== 'shape' || !layer.shapes) return false;
    var prevShapes = layer.shapes;
    var grid = ensureAllTiles(layer);
    grid.forEach(function (t) {
      if (!t) return;
      t.ctx.save();
      t.ctx.clearRect(0, 0, t.w, t.h);
      t.ctx.translate(-t.x, -t.y);
      paintShapesBuffered(t.ctx, prevShapes);
      t.ctx.restore();
    });
    layer.type = 'pixel';
    layer.shapes = null;
    touch(layer);
    pushEntry(doc, {
      label: '栅格化矢量',
      touched: [layer],
      undo: function () {
        layer.type = 'shape';
        layer.shapes = prevShapes;
        touch(layer);
        doc.version++;
      },
      redo: function () {
        layer.type = 'pixel';
        layer.shapes = null;
        touch(layer);
        doc.version++;
      }
    });
    doc.version++;
    return true;
  }

  /* 路径选择工具的命中测试：先找锚点，再找控制柄端点，再找边，最后找填充内部。
   * 返回 { layer, shape, anchor, handle }（anchor 为 -1 表示命中形状本体；handle 为 'in'/'out'/null）。 */
  function hitShapeLayer(doc, x, y, tol) {
    tol = tol || 6;
    for (var i = doc.layers.length - 1; i >= 0; i--) {
      var layer = doc.layers[i];
      if (!layer.visible || layer.type !== 'shape' || !layer.shapes) continue;
      var lx = x - layer.x;
      var ly = y - layer.y;
      for (var k = layer.shapes.length - 1; k >= 0; k--) {
        var s = layer.shapes[k];
        var b = shapeBounds(s);
        if (!b) continue;
        // 控制柄可能伸到路径包围盒之外，命中测试时把包围盒扩到控制柄端点
        if (s.kind === 'path') {
          (s.pts || []).forEach(function (hp) {
            if (hp.hix != null) {
              var x1 = b.x + b.w;
              b.x = Math.min(b.x, hp.hix);
              b.w = Math.max(x1, hp.hix) - b.x;
              var y1 = b.y + b.h;
              b.y = Math.min(b.y, hp.hiy);
              b.h = Math.max(y1, hp.hiy) - b.y;
            }
            if (hp.hox != null) {
              var x1b = b.x + b.w;
              b.x = Math.min(b.x, hp.hox);
              b.w = Math.max(x1b, hp.hox) - b.x;
              var y1b = b.y + b.h;
              b.y = Math.min(b.y, hp.hoy);
              b.h = Math.max(y1b, hp.hoy) - b.y;
            }
          });
        }
        var pad = tol + (s.strokeWidth || 0) / 2;
        if (lx < b.x - pad || ly < b.y - pad || lx > b.x + b.w + pad || ly > b.y + b.h + pad) continue;
        if (s.kind === 'path') {
          var pts = s.pts || [];
          for (var a = 0; a < pts.length; a++) {
            if (Math.hypot(lx - pts[a].x, ly - pts[a].y) <= pad) {
              return { layer: layer, shape: s, shapeIndex: k, anchor: a, handle: null };
            }
          }
          // 锚点优先于控制柄：先遍历完所有锚点，再判断是否点中控制柄端点
          for (var h = 0; h < pts.length; h++) {
            var hp = pts[h];
            if (hp.hix != null && Math.hypot(lx - hp.hix, ly - hp.hiy) <= pad) {
              return { layer: layer, shape: s, shapeIndex: k, anchor: h, handle: 'in' };
            }
            if (hp.hox != null && Math.hypot(lx - hp.hox, ly - hp.hoy) <= pad) {
              return { layer: layer, shape: s, shapeIndex: k, anchor: h, handle: 'out' };
            }
          }
          for (var e = 0; e < pts.length - (s.closed ? 0 : 1); e++) {
            var p0 = pts[e];
            var p1 = pts[(e + 1) % pts.length];
            if (distToSegment(lx, ly, p0.x, p0.y, p1.x, p1.y) <= pad) {
              return { layer: layer, shape: s, shapeIndex: k, anchor: -1 };
            }
          }
          if (s.closed && pointInPolygon(lx, ly, pts)) {
            return { layer: layer, shape: s, shapeIndex: k, anchor: -1 };
          }
        } else if (s.kind === 'line') {
          if (distToSegment(lx, ly, s.x1, s.y1, s.x2, s.y2) <= pad) {
            return { layer: layer, shape: s, shapeIndex: k, anchor: -1 };
          }
        } else if (s.kind === 'rect') {
          var inside = lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h;
          var nearEdge = Math.min(Math.abs(lx - b.x), Math.abs(lx - b.x - b.w),
            Math.abs(ly - b.y), Math.abs(ly - b.y - b.h)) <= pad;
          if (inside || nearEdge) return { layer: layer, shape: s, shapeIndex: k, anchor: -1 };
        } else if (s.kind === 'ellipse') {
          var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
          var nx = (lx - cx) / Math.max(0.5, b.w / 2);
          var ny = (ly - cy) / Math.max(0.5, b.h / 2);
          var d = Math.sqrt(nx * nx + ny * ny);
          if (d <= 1 + pad / Math.max(1, Math.min(b.w, b.h) / 2)) {
            return { layer: layer, shape: s, shapeIndex: k, anchor: -1 };
          }
        }
      }
    }
    return null;
  }

  function distToSegment(px, py, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
  }

  function pointInPolygon(x, y, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[i], b = pts[j];
      if (((a.y > y) !== (b.y > y)) &&
        (x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || 1e-9) + a.x)) inside = !inside;
    }
    return inside;
  }

  /* ---------------- 填充工具 ---------------- */
  function fillLayer(layer, color) {
    var tiles = ensureAllTiles(layer);
    tiles.forEach(function (t) { if (t) { t.ctx.fillStyle = color; t.ctx.fillRect(0, 0, t.w, t.h); } });
    touch(layer);
  }

  function fillLayerGradient(layer, stops, x0, y0, x1, y1) {
    var tiles = ensureAllTiles(layer);
    tiles.forEach(function (t) {
      if (!t) return;
      // 渐变坐标是文档坐标，瓦片画布是本地坐标系：把两端各减去瓦片原点，
      // 否则每个瓦片都会画出文档左上角那一小段（之前只填满了第一块瓦片）。
      var g = t.ctx.createLinearGradient(x0 - t.x, y0 - t.y, x1 - t.x, y1 - t.y);
      (stops || []).forEach(function (s) { g.addColorStop(s.at, s.color); });
      t.ctx.fillStyle = g;
      t.ctx.fillRect(0, 0, t.w, t.h);
    });
    touch(layer);
  }

  function clearLayer(layer) {
    layer.tiles.forEach(function (t) { t.ctx.clearRect(0, 0, t.w, t.h); });
    touch(layer);
  }

  /* ---------------- 区域读写（滤镜/文字共用） ---------------- */
  /* 以图层本地坐标读一块矩形（含跨瓦片拼接），返回 ImageData。 */
  function readRegionLocal(layer, rect) {
    var w = Math.max(1, Math.round(rect.w));
    var h = Math.max(1, Math.round(rect.h));
    var cv = makeCanvas(w, h);
    var cols = tileCols(layer);
    var rows = tileRows(layer);
    var tx0 = Math.max(0, Math.floor(rect.x / TILE));
    var ty0 = Math.max(0, Math.floor(rect.y / TILE));
    var tx1 = Math.min(cols - 1, Math.floor((rect.x + rect.w - 1) / TILE));
    var ty1 = Math.min(rows - 1, Math.floor((rect.y + rect.h - 1) / TILE));
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        var t = layer.tiles.get(tileKey(tx, ty));
        if (!t) continue;
        cv.ctx.drawImage(t.canvas, t.x - rect.x, t.y - rect.y);
      }
    }
    return cv.ctx.getImageData(0, 0, w, h);
  }

  /* 把整层画成一张画布（油漆桶/缩略图用，超大图层慎用）。 */
  function readLayerCanvas(layer) {
    var cv = makeCanvas(layer.width, layer.height);
    layer.tiles.forEach(function (t) {
      if (t) cv.ctx.drawImage(t.canvas, t.x, t.y);
    });
    return cv;
  }

  /* ---------------- 选区 ---------------- */
  var selSeq = 0;
  function boundsOfShape(shape) {
    if (!shape) return null;
    if (shape.bounds) return shape.bounds;
    var pts = shape.points || [];
    if (!pts.length) return null;
    var x0 = pts[0].x, y0 = pts[0].y, x1 = x0, y1 = y0;
    pts.forEach(function (p) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function setSelectionShape(doc, shape, invert, opts) {
    opts = opts || {};
    doc.selection = {
      active: true,
      invert: !!invert,
      shape: shape,
      feather: Math.max(0, Number(opts.feather) || 0),
      version: ++selSeq
    };
    doc.version++;
    return doc.selection;
  }

  function clearSelection(doc) {
    doc.selection = { active: false, invert: false, shape: null, feather: 0, version: ++selSeq };
    doc.version++;
  }

  function selectAll(doc) {
    return setSelectionShape(doc, { type: 'rect', bounds: { x: 0, y: 0, w: doc.width, h: doc.height } }, false);
  }

  function invertSelection(doc) {
    if (!doc.selection.active) {
      selectAll(doc);
      doc.selection.invert = true;
      return true;
    }
    doc.selection.invert = !doc.selection.invert;
    doc.selection.version = ++selSeq;
    doc.version++;
    return true;
  }

  function selectionContains(doc, x, y) {
    var sel = doc.selection;
    if (!sel.active || !sel.shape) return false;
    var shape = sel.shape;
    var inside = false;
    if (shape.type === 'rect') {
      var b = shape.bounds;
      inside = x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
    } else if (shape.type === 'ellipse') {
      var e = shape.bounds;
      var cx = e.x + e.w / 2;
      var cy = e.y + e.h / 2;
      var rx = Math.max(1, Math.abs(e.w) / 2);
      var ry = Math.max(1, Math.abs(e.h) / 2);
      var nx = (x - cx) / rx;
      var ny = (y - cy) / ry;
      inside = nx * nx + ny * ny <= 1;
    } else if (shape.type === 'lasso') {
      var pts = shape.points || [];
      for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        var a = pts[i], b2 = pts[j];
        if (((a.y > y) !== (b2.y > y)) && (x < (b2.x - a.x) * (y - a.y) / ((b2.y - a.y) || 1e-9) + a.x)) inside = !inside;
      }
    } else if (shape.type === 'polygons') {
      // 魔棒选区：多个轮廓（外轮廓 + 洞）按奇偶规则判断
      var polys = shape.polygons || [];
      var hits = 0;
      for (var pi = 0; pi < polys.length; pi++) {
        if (pointInPolygon(x, y, polys[pi])) hits++;
      }
      inside = (hits % 2) === 1;
    }
    return sel.invert ? !inside : inside;
  }

  /* 把选区形状加到 ctx 的当前路径上（ox/oy = 目标画布左上角对应的文档坐标）。 */
  function addSelectionPath(ctx, shape, ox, oy) {
    if (!shape) return false;
    var b = boundsOfShape(shape);
    if (!b) return false;
    ctx.save();
    ctx.translate(-ox, -oy);
    ctx.beginPath();
    if (shape.type === 'rect') {
      ctx.rect(b.x, b.y, b.w, b.h);
    } else if (shape.type === 'ellipse') {
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(0.5, Math.abs(b.w) / 2), Math.max(0.5, Math.abs(b.h) / 2), 0, 0, Math.PI * 2);
    } else if (shape.type === 'polygons') {
      var polys = shape.polygons || [];
      var added = false;
      for (var p = 0; p < polys.length; p++) {
        var poly = polys[p];
        if (!poly || poly.length < 3) continue;
        ctx.moveTo(poly[0].x, poly[0].y);
        for (var j = 1; j < poly.length; j++) ctx.lineTo(poly[j].x, poly[j].y);
        ctx.closePath();
        added = true;
      }
      if (!added) { ctx.restore(); return false; }
    } else {
      var pts = shape.points || [];
      if (pts.length < 3) { ctx.restore(); return false; }
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    }
    ctx.restore();
    return true;
  }

  /* 把选区画成白/黑遮罩（alpha 通道就是选区强度）。
   * 羽化直接交给 canvas 的 blur 滤镜：遮罩在文档坐标里绘制，半径即文档像素。 */
  function drawSelectionMask(ctx, doc, ox, oy, w, h) {
    var sel = doc.selection;
    if (!sel.active) return false;
    ctx.save();
    if (sel.feather > 0 && typeof ctx.filter === 'string') {
      ctx.filter = 'blur(' + sel.feather + 'px)';
    }
    ctx.fillStyle = '#ffffff';
    var rule = selectionRule(sel);
    if (sel.invert) {
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-out';
      if (addSelectionPath(ctx, sel.shape, ox, oy)) ctx.fill(rule);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      if (addSelectionPath(ctx, sel.shape, ox, oy)) ctx.fill(rule);
    }
    ctx.restore();
    return true;
  }

  /* 单块瓦片的选区遮罩（带缓存：同一选区 + 同一位置不重复画）。 */
  function maskForTile(doc, layer, tile) {
    if (!doc.selection.active) return null;
    var key = tile.key + '|' + layer.x + ',' + layer.y;
    var cache = layer._maskCache;
    if (!cache || cache.version !== doc.selection.version) {
      cache = layer._maskCache = { version: doc.selection.version, map: new Map() };
    }
    var hit = cache.map.get(key);
    if (hit) return hit;
    // 羽化要模糊边缘，遮罩必须比瓦片多画一圈，否则 256px 边界会出现接缝
    var pad = Math.min(64, Math.ceil((doc.selection.feather || 0) * 2));
    var cv = makeCanvas(tile.w + pad * 2, tile.h + pad * 2);
    cv.ctx.translate(pad, pad);
    drawSelectionMask(cv.ctx, doc, layer.x + tile.x - pad, layer.y + tile.y - pad,
      tile.w + pad * 2, tile.h + pad * 2);
    var out = cv;
    if (pad) {
      out = makeCanvas(tile.w, tile.h);
      out.ctx.drawImage(cv.canvas, pad, pad, tile.w, tile.h, 0, 0, tile.w, tile.h);
    }
    var data = out.ctx.getImageData(0, 0, tile.w, tile.h).data;
    var mask = { w: tile.w, h: tile.h, data: data };
    cache.map.set(key, mask);
    return mask;
  }

  /* 把「改动后的瓦片」按选区遮罩与「改动前」混合：选区外恢复原样。 */
  function applyMaskBlendTile(tile, before, mask) {
    if (!before || !mask) return;
    var cur = tile.ctx.getImageData(0, 0, tile.w, tile.h);
    var d = cur.data, b = before.data, m = mask.data;
    var n = d.length;
    for (var i = 0; i < n; i += 4) {
      var a = m[i + 3] / 255;
      if (a >= 1) continue;
      var inv = 1 - a;
      d[i] = d[i] * a + b[i] * inv;
      d[i + 1] = d[i + 1] * a + b[i + 1] * inv;
      d[i + 2] = d[i + 2] * a + b[i + 2] * inv;
      d[i + 3] = d[i + 3] * a + b[i + 3] * inv;
    }
    tile.ctx.putImageData(cur, 0, 0);
  }

  /* 给 ctx 加选区 clip（当前工具坐标是「图层本地坐标」）。
   * 反选时无法用单一路径表达，交给落笔结束后的遮罩混合兜底。 */
  function clipToSelection(ctx, doc, layer, tile) {
    if (!doc.selection.active || doc.selection.invert) return false;
    var ok = addSelectionPath(ctx, doc.selection.shape, layer.x + tile.x, layer.y + tile.y);
    if (ok) ctx.clip(selectionRule(doc.selection));
    return ok;
  }

  function selectionRule(sel) {
    return sel && sel.shape && sel.shape.type === 'polygons' ? 'evenodd' : 'nonzero';
  }

  /* ---------------- 历史 ---------------- */
  function beginTx(doc, label) {
    return { doc: doc, label: label || '编辑', tiles: new Map(), undoOps: [], redoOps: [], bytes: 0 };
  }

  function snapTile(tx, layer, tile, isMask) {
    if (!tile) return null;
    var k = (isMask ? 'M|' : 'P|') + layer.id + '|' + tile.key;
    var hit = tx.tiles.get(k);
    if (hit) return hit;
    var before = tile.ctx.getImageData(0, 0, tile.w, tile.h);
    var rec = { layer: layer, tile: tile, before: before, after: null };
    tx.tiles.set(k, rec);
    tx.bytes += before.data.length * 2;
    return rec;
  }

  function endTx(tx) {
    var recs = [];
    tx.tiles.forEach(function (r) { recs.push(r); });
    if (!recs.length && !tx.undoOps.length) return null;
    recs.forEach(function (r) {
      if (!r.after) r.after = r.tile.ctx.getImageData(0, 0, r.tile.w, r.tile.h);
    });
    var entry = {
      label: tx.label,
      bytes: tx.bytes,
      touched: recs.map(function (r) { return r.layer; }),
      undo: function () {
        recs.forEach(function (r) { r.tile.ctx.putImageData(r.before, 0, 0); });
        tx.undoOps.forEach(function (fn) { fn(); });
      },
      redo: function () {
        recs.forEach(function (r) { r.tile.ctx.putImageData(r.after, 0, 0); });
        tx.redoOps.forEach(function (fn) { fn(); });
      }
    };
    pushEntry(tx.doc, entry);
    return entry;
  }

  function pushEntry(doc, entry) {
    var h = doc.history;
    if (h.index < h.entries.length - 1) {
      var dropped = h.entries.splice(h.index + 1);
      dropped.forEach(function (e) { h.bytes -= e.bytes || 0; });
    }
    entry.bytes = entry.bytes || 0;
    h.entries.push(entry);
    h.bytes += entry.bytes;
    h.index = h.entries.length - 1;
    while (h.bytes > HISTORY_BUDGET && h.entries.length > 1) {
      var old = h.entries.shift();
      h.bytes -= old.bytes || 0;
      h.index--;
      if (h.index < -1) h.index = -1;
    }
    doc.version++;
  }

  function undo(doc) {
    var h = doc.history;
    if (h.index < 0) return false;
    var entry = h.entries[h.index];
    entry.undo();
    (entry.touched || []).forEach(function (l) { touch(l); });
    h.index--;
    doc.version++;
    return true;
  }

  function redo(doc) {
    var h = doc.history;
    if (h.index >= h.entries.length - 1) return false;
    var entry = h.entries[h.index + 1];
    entry.redo();
    (entry.touched || []).forEach(function (l) { touch(l); });
    h.index++;
    doc.version++;
    return true;
  }

  function historyJump(doc, index) {
    var h = doc.history;
    index = Math.max(-1, Math.min(index, h.entries.length - 1));
    while (h.index > index) undo(doc);
    while (h.index < index) redo(doc);
    return h.index;
  }

  /* ---------------- 结构操作 ---------------- */
  function addLayer(doc, opts) {
    var l = createLayer(doc, opts);
    var index = doc.layers.length - 1;
    var prevActive = doc.activeId;
    doc.activeId = l.id;
    pushEntry(doc, {
      label: '新建图层',
      touched: [l],
      undo: function () {
        var i = doc.layers.indexOf(l);
        if (i >= 0) doc.layers.splice(i, 1);
        doc.activeId = prevActive;
        doc.version++;
      },
      redo: function () {
        if (doc.layers.indexOf(l) < 0) doc.layers.splice(Math.min(index, doc.layers.length), 0, l);
        doc.activeId = l.id;
        doc.version++;
      }
    });
    return l;
  }

  function removeLayer(doc, layer) {
    var i = doc.layers.indexOf(layer);
    if (i < 0) return false;
    /* 组按整体删除：组条目本身不参与合成，留下的子图层会变成孤儿，
     * 既看不见也删不掉，所以一次删掉组 + 全部子图层，撤销时整块还原。 */
    if (layer.type === 'group') {
      var prev = doc.layers.slice();
      var prevActive = doc.activeId;
      var next = prev.filter(function (l) { return l !== layer && l.group !== layer.id; });
      doc.layers = next;
      doc.activeId = next.length ? next[Math.min(i, next.length - 1)].id : null;
      var nextActive = doc.activeId;
      doc.version++;
      pushEntry(doc, {
        label: '删除图层组',
        touched: prev.filter(function (l) { return l === layer || l.group === layer.id; }),
        undo: function () { doc.layers = prev.slice(); doc.activeId = prevActive; doc.version++; },
        redo: function () { doc.layers = next.slice(); doc.activeId = nextActive; doc.version++; }
      });
      return true;
    }
    var prevActive = doc.activeId;
    doc.layers.splice(i, 1);
    doc.activeId = doc.layers.length ? doc.layers[Math.min(i, doc.layers.length - 1)].id : null;
    pushEntry(doc, {
      label: '删除图层',
      touched: [layer],
      undo: function () {
        doc.layers.splice(Math.min(i, doc.layers.length), 0, layer);
        doc.activeId = prevActive;
        doc.version++;
      },
      redo: function () {
        var j = doc.layers.indexOf(layer);
        if (j >= 0) doc.layers.splice(j, 1);
        doc.activeId = doc.layers.length ? doc.layers[Math.min(i, doc.layers.length - 1)].id : null;
        doc.version++;
      }
    });
    doc.version++;
    return true;
  }

  function duplicateLayer(doc, layer) {
    if (!layer) return null;
    var copy = createLayer(doc, {
      name: layer.name + ' 副本',
      type: layer.type,
      width: layer.width,
      height: layer.height,
      x: layer.x,
      y: layer.y,
      visible: layer.visible,
      opacity: layer.opacity,
      blend: layer.blend,
      locks: {
        transparent: layer.locks.transparent, image: layer.locks.image,
        position: layer.locks.position, all: layer.locks.all
      },
      adjust: layer.adjust ? { kind: layer.adjust.kind, params: { value: layer.adjust.params.value } } : null,
      shapes: layer.shapes ? layer.shapes.map(cloneShape) : null
    });
    if (layer.type === 'pixel') {
      layer.tiles.forEach(function (t) {
        var nt = ensureTile(copy, t.tx, t.ty, true);
        if (nt) nt.ctx.drawImage(t.canvas, 0, 0);
      });
      if (layer.mask) {
        var nm = createMask(copy);
        layer.mask.tiles.forEach(function (mt) {
          var nt2 = ensureMaskTile(nm, mt.tx, mt.ty, true);
          if (nt2) nt2.ctx.drawImage(mt.canvas, 0, 0);
        });
        nm.enabled = layer.mask.enabled;
        copy.mask = nm;
      }
    }
    var index = doc.layers.indexOf(copy);
    var prevActive = doc.activeId;
    doc.activeId = copy.id;
    pushEntry(doc, {
      label: '复制图层',
      touched: [copy],
      undo: function () {
        var i = doc.layers.indexOf(copy);
        if (i >= 0) doc.layers.splice(i, 1);
        doc.activeId = prevActive;
        doc.version++;
      },
      redo: function () {
        if (doc.layers.indexOf(copy) < 0) doc.layers.splice(Math.min(index, doc.layers.length), 0, copy);
        doc.activeId = copy.id;
        doc.version++;
      }
    });
    doc.version++;
    return copy;
  }

  /* 把上层像素按自身透明度/混合模式画进下层瓦片 */
  function mergeLayerInto(doc, src, dst) {
    var grid = ensureAllTiles(dst);
    grid.forEach(function (t) {
      if (!t) return;
      var docX = dst.x + t.x;
      var docY = dst.y + t.y;
      t.ctx.save();
      t.ctx.globalAlpha = src.opacity;
      t.ctx.globalCompositeOperation = blendOp(src.blend);
      if (src.type === 'shape') {
        t.ctx.translate(src.x - docX, src.y - docY);
        paintShapesBuffered(t.ctx, src.shapes || []);
      } else {
        src.tiles.forEach(function (st) {
          var sx = src.x + st.x - docX;
          var sy = src.y + st.y - docY;
          t.ctx.drawImage(st.canvas, sx, sy);
        });
      }
      t.ctx.restore();
    });
  }

  function mergeDown(doc, layer) {
    var i = doc.layers.indexOf(layer);
    if (i <= 0) return false;
    var dst = doc.layers[i - 1];
    if (dst.type !== 'pixel') return false;
    var tx = beginTx(doc, '向下合并');
    ensureAllTiles(dst).forEach(function (t) { snapTile(tx, dst, t); });
    /* 蒙版不跟随合并：先把可见结果烘焙进上层像素，撤销时再连蒙版一起还原 */
    if (layer.mask) {
      var savedMask = layer.mask;
      layer.tiles.forEach(function (t) { snapTile(tx, layer, t); });
      bakeMaskToLayerTiles(layer);
      layer.mask = null;
      tx.undoOps.push(function () { layer.mask = savedMask; layer.version++; });
      tx.redoOps.push(function () { layer.mask = null; layer.version++; });
    }
    mergeLayerInto(doc, layer, dst);
    touch(dst);
    // 合并后把上层从文档里拿掉，但对象留给撤销
    doc.layers.splice(i, 1);
    doc.activeId = dst.id;
    tx.undoOps.push(function () {
      doc.layers.splice(Math.min(i, doc.layers.length), 0, layer);
      doc.activeId = layer.id;
      doc.version++;
    });
    tx.redoOps.push(function () {
      var j = doc.layers.indexOf(layer);
      if (j >= 0) doc.layers.splice(j, 1);
      doc.activeId = dst.id;
      doc.version++;
    });
    endTx(tx);
    return true;
  }

  function flatten(doc) {
    var flat = renderFlatten(doc);
    var prevLayers = doc.layers.slice();
    var prevActive = doc.activeId;
    var merged = createLayer(doc, { name: '拼合图层', width: doc.width, height: doc.height, x: 0, y: 0 });
    ensureAllTiles(merged).forEach(function (t) {
      if (t) t.ctx.drawImage(flat.canvas, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
    });
    doc.layers = [merged];
    doc.activeId = merged.id;
    touch(merged);
    pushEntry(doc, {
      label: '拼合图像',
      touched: [merged],
      undo: function () { doc.layers = prevLayers; doc.activeId = prevActive; doc.version++; },
      redo: function () { doc.layers = [merged]; doc.activeId = merged.id; doc.version++; }
    });
    return merged;
  }

  /* ---------------- 图层属性 ---------------- */
  function setLayerProp(doc, layer, key, value) {
    if (!layer) return;
    var before = layer[key];
    if (before === value) return;
    layer[key] = value;
    layer.version++;
    if (key === 'visible') { layer.mipReady = layer.mipReady; }
    doc.version++;
    pushEntry(doc, {
      label: key === 'opacity' ? '图层不透明度' : key === 'blend' ? '混合模式' : '图层属性',
      touched: [layer],
      undo: function () { layer[key] = before; layer.version++; doc.version++; },
      redo: function () { layer[key] = value; layer.version++; doc.version++; }
    });
  }

  /* ---------------- 裁剪 ---------------- */
  function cropDoc(doc, rect) {
    var x = Math.max(0, Math.floor(rect.x));
    var y = Math.max(0, Math.floor(rect.y));
    var w = Math.max(1, Math.min(doc.width - x, Math.floor(rect.w)));
    var h = Math.max(1, Math.min(doc.height - y, Math.floor(rect.h)));
    if (w === doc.width && h === doc.height && x === 0 && y === 0) return false;
    var before = {
      width: doc.width, height: doc.height,
      pos: doc.layers.map(function (l) { return { id: l.id, x: l.x, y: l.y }; })
    };
    doc.width = w;
    doc.height = h;
    doc.layers.forEach(function (l) {
      l.x -= x;
      l.y -= y;
      touch(l);
    });
    if (doc.selection.active) clearSelection(doc);
    doc.version++;
    pushEntry(doc, {
      label: '裁剪',
      touched: doc.layers,
      undo: function () {
        doc.width = before.width;
        doc.height = before.height;
        before.pos.forEach(function (p) {
          var l = layerById(doc, p.id);
          if (l) { l.x = p.x; l.y = p.y; touch(l); }
        });
        doc.version++;
      },
      redo: function () {
        doc.width = w;
        doc.height = h;
        doc.layers.forEach(function (l) { l.x -= x; l.y -= y; touch(l); });
        doc.version++;
      }
    });
    return true;
  }

  /* ---------------- 调整层 ---------------- */
  function addAdjustLayer(doc, kind) {
    var def = ADJUST_DEFS[kind];
    if (!def) return null;
    return addLayer(doc, {
      name: def.name,
      type: 'adjust',
      adjust: { kind: kind, params: { value: def.def } },
      width: doc.width,
      height: doc.height
    });
  }

  /* ---------------- mip ---------------- */
  function mipLevelFor(zoom) {
    if (!(zoom > 0) || zoom >= 0.5) return -1;
    return Math.max(0, Math.floor(Math.log2(1 / zoom)) - 1);
  }

  function ensureMips(layer) {
    if (layer.type !== 'pixel' || layer.mipReady) return layer.mips;
    var tiles = existingTiles(layer);
    if (!tiles.length) { layer.mipReady = true; return layer.mips; }
    var mips = [];
    var w = Math.max(1, Math.round(layer.width / 2));
    var h = Math.max(1, Math.round(layer.height / 2));
    for (var level = 0; level < MIP_MAX_LEVELS; level++) {
      var cv = makeCanvas(w, h);
      if (level === 0) {
        tiles.forEach(function (t) {
          cv.ctx.drawImage(t.canvas, t.x / 2, t.y / 2, t.w / 2, t.h / 2);
        });
      } else {
        var prev = mips[level - 1];
        cv.ctx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, w, h);
      }
      mips.push(cv.canvas);
      if (Math.max(w, h) <= MAX_MIP_DIM / 4) break;
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      if (w < 96 || h < 96) break;
    }
    layer.mips = mips;
    layer.mipReady = true;
    return mips;
  }

  var mipTimer = 0;
  function requestMips(doc, done) {
    if (!doc || mipTimer) return;
    var i = 0;
    function step() {
      mipTimer = 0;
      var layers = doc.layers;
      while (i < layers.length) {
        var l = layers[i++];
        if (l.type === 'pixel' && !l.mipReady && l.tiles.size) {
          try { ensureMips(l); } catch (e) {}
          mipTimer = setTimeout(step, 24);
          if (done) done();
          return;
        }
      }
      if (done) done();
    }
    mipTimer = setTimeout(step, 32);
  }

  /* ---------------- 合成 ---------------- */
  function visibleLocalRect(layer, view) {
    var z = view.zoom;
    var panX = view.panX;
    var panY = view.panY;
    var vw = view.width || 800;
    var vh = view.height || 600;
    var x0 = (0 - panX) / z - layer.x;
    var y0 = (0 - panY) / z - layer.y;
    var x1 = (vw - panX) / z - layer.x;
    var y1 = (vh - panY) / z - layer.y;
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(layer.width, Math.ceil(x1));
    y1 = Math.min(layer.height, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function drawPixelLayer(ctx, doc, layer, view, stats) {
    var z = view.zoom;
    var dpr = view.dpr || 1;
    var panX = view.panX;
    var panY = view.panY;
    var D = function (v) { return Math.round(v * dpr); };
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = blendOp(layer.blend);

    // 缩得很小时优先用 mip：一次 drawImage 顶替几十个瓦片
    if (view.useMips !== false && z < 0.5 && !(layer.mask && layer.mask.enabled && layer.mask.tiles.size) && layer.mipReady && layer.mips.length) {
      var level = Math.min(mipLevelFor(z), layer.mips.length - 1);
      if (level >= 0) {
        var mip = layer.mips[level];
        var mx0 = D(panX + layer.x * z);
        var my0 = D(panY + layer.y * z);
        var mx1 = D(panX + (layer.x + layer.width) * z);
        var my1 = D(panY + (layer.y + layer.height) * z);
        if (mx1 > mx0 && my1 > my0) {
          ctx.drawImage(mip, 0, 0, mip.width, mip.height, mx0, my0, mx1 - mx0, my1 - my0);
          stats.mips++;
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
    }

    var vis = visibleLocalRect(layer, view);
    if (!vis) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    var tx0 = Math.floor(vis.x / TILE);
    var ty0 = Math.floor(vis.y / TILE);
    var tx1 = Math.floor((vis.x + vis.w - 1) / TILE);
    var ty1 = Math.floor((vis.y + vis.h - 1) / TILE);
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        var t = layer.tiles.get(tileKey(tx, ty));
        if (!t) continue;
        var x0 = D(panX + (layer.x + t.x) * z);
        var y0 = D(panY + (layer.y + t.y) * z);
        var x1 = D(panX + (layer.x + t.x + t.w) * z);
        var y1 = D(panY + (layer.y + t.y + t.h) * z);
        // 相邻瓦片的边界用同一个取整表达式 → 缩放后不会出现接缝
        if (x1 <= x0 || y1 <= y0) continue;
        ctx.drawImage(t.canvas, 0, 0, t.w, t.h, x0, y0, x1 - x0, y1 - y0);
        stats.tiles++;
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawAdjustLayer(ctx, doc, layer, view, scratch) {
    if (!scratch) return;
    var filter = adjustString(layer);
    if (filter === 'none') return;
    scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
    scratch.ctx.clearRect(0, 0, scratch.w, scratch.h);
    scratch.ctx.drawImage(ctx.canvas, 0, 0);
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = blendOp(layer.blend);
    ctx.filter = filter;
    ctx.drawImage(scratch.canvas, 0, 0);
    ctx.filter = 'none';
    ctx.restore();
  }

  /* 有蒙版时的合成：先把图层画进离屏缓冲，再按蒙版 destination-in 裁剪，
   * 最后按不透明度/混合模式落到主画布。缓冲随画布尺寸复用，不每帧分配。 */
  function ensureViewBuffer(view, key, w, h) {
    var b = view[key];
    if (!b || b.w !== w || b.h !== h) {
      b = makeCanvas(w, h);
      view[key] = b;
    }
    return b;
  }

  function applyMaskToBuffer(view, layer, target, w, h) {
    var mask = layer.mask;
    var mb = ensureViewBuffer(view, '_maskBuf', w, h);
    var mctx = mb.ctx;
    var z = view.zoom;
    var dpr = view.dpr || 1;
    var D = function (v) { return Math.round(v * dpr); };
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = '#ffffff';
    mctx.fillRect(0, 0, w, h);
    mctx.globalCompositeOperation = 'destination-out';
    mask.tiles.forEach(function (t) {
      var x0 = D(view.panX + (layer.x + t.x) * z);
      var y0 = D(view.panY + (layer.y + t.y) * z);
      var x1 = D(view.panX + (layer.x + t.x + t.w) * z);
      var y1 = D(view.panY + (layer.y + t.y + t.h) * z);
      if (x1 <= x0 || y1 <= y0) return;
      mctx.drawImage(t.canvas, 0, 0, t.w, t.h, x0, y0, x1 - x0, y1 - y0);
    });
    mctx.globalCompositeOperation = 'source-over';
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalCompositeOperation = 'destination-in';
    target.drawImage(mb.canvas, 0, 0);
    target.restore();
  }

  function drawMaskedLayer(ctx, doc, layer, view, stats, scratch) {
    var w = ctx.canvas.width;
    var h = ctx.canvas.height;
    var buf = ensureViewBuffer(view, '_layerBuf', w, h);
    var bctx = buf.ctx;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalAlpha = 1;
    bctx.globalCompositeOperation = 'source-over';
    bctx.clearRect(0, 0, w, h);

    var opacity = layer.opacity;
    var blend = layer.blend;
    layer.opacity = 1;
    layer.blend = 'normal';
    if (layer.type === 'pixel') drawPixelLayer(bctx, doc, layer, view, stats);
    else if (layer.type === 'shape') drawShapeLayer(bctx, doc, layer, view, stats);
    else if (scratch) {
      // 调整层：先复制下方已合成的画面，再整幅滤镜，最后交给蒙版裁剪
      scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
      scratch.ctx.clearRect(0, 0, scratch.w, scratch.h);
      scratch.ctx.drawImage(ctx.canvas, 0, 0);
      bctx.save();
      bctx.filter = adjustString(layer);
      bctx.drawImage(scratch.canvas, 0, 0);
      bctx.filter = 'none';
      bctx.restore();
    }
    layer.opacity = opacity;
    layer.blend = blend;

    applyMaskToBuffer(view, layer, bctx, w, h);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = blendOp(layer.blend);
    ctx.drawImage(buf.canvas, 0, 0);
    ctx.restore();
  }

  function composite(ctx, doc, view) {
    var stats = { tiles: 0, mips: 0, shapes: 0 };
    if (!doc) return stats;
    var z = view.zoom;
    var dpr = view.dpr || 1;
    var D = function (v) { return Math.round(v * dpr); };
    var x0 = D(view.panX);
    var y0 = D(view.panY);
    var x1 = D(view.panX + doc.width * z);
    var y1 = D(view.panY + doc.height * z);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    ctx.clip();
    var scratch = view.scratch || null;
    for (var i = 0; i < doc.layers.length; i++) {
      var layer = doc.layers[i];
      if (layer.type === 'group') continue;
      if (!layer.visible || layer.opacity <= 0) continue;
      if (!groupVisible(doc, layer)) continue;
      var gop = groupOpacity(doc, layer);
      if (gop <= 0) continue;
      var baseOp = layer.opacity;
      layer.opacity = baseOp * gop;
      if (layer.mask && layer.mask.enabled && layer.mask.tiles.size) {
        drawMaskedLayer(ctx, doc, layer, view, stats, scratch);
      } else if (layer.type === 'pixel') {
        drawPixelLayer(ctx, doc, layer, view, stats);
      } else if (layer.type === 'shape') {
        drawShapeLayer(ctx, doc, layer, view, stats);
      } else {
        drawAdjustLayer(ctx, doc, layer, view, scratch);
      }
      layer.opacity = baseOp;
    }
    ctx.restore();
    return stats;
  }

  function drawShapeLayer(ctx, doc, layer, view, stats) {
    if (!layer.shapes || !layer.shapes.length) return;
    var z = view.zoom;
    var dpr = view.dpr || 1;
    var D = function (v) { return Math.round(v * dpr); };
    var bool = hasShapeBoolean(layer.shapes);
    if (!bool) {
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = blendOp(layer.blend);
      ctx.setTransform(z * dpr, 0, 0, z * dpr, D(view.panX), D(view.panY));
      ctx.translate(layer.x, layer.y);
      // 矢量在设备像素空间重画，任意缩放倍率下边缘都保持锐利
      for (var i = 0; i < layer.shapes.length; i++) {
        paintShape(ctx, layer.shapes[i]);
        stats.shapes++;
      }
      ctx.restore();
      return;
    }
    // 布尔形状：先按当前视口分辨率在离屏缓冲里逐条复合，再整块贴回。
    // 缓冲与画布同尺寸（设备像素），因此缩放时边缘仍然锐利。
    var w = ctx.canvas.width;
    var h = ctx.canvas.height;
    var buf = ensureViewBuffer(view, '_shapeBuf', w, h);
    var bctx = buf.ctx;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalAlpha = 1;
    bctx.globalCompositeOperation = 'source-over';
    bctx.clearRect(0, 0, w, h);
    bctx.setTransform(z * dpr, 0, 0, z * dpr, D(view.panX), D(view.panY));
    bctx.translate(layer.x, layer.y);
    for (var j = 0; j < layer.shapes.length; j++) {
      paintShapeWithOp(bctx, layer.shapes[j], j === 0 ? 'add' : shapeOp(layer.shapes[j]));
      stats.shapes++;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = blendOp(layer.blend);
    ctx.drawImage(buf.canvas, 0, 0);
    ctx.restore();
  }

  /* 拼合到一张文档尺寸的画布（导出 / 缩略图 / 存图库用）。 */
  function renderFlatten(doc) {
    var cv = makeCanvas(doc.width, doc.height);
    var scratch = makeCanvas(doc.width, doc.height);
    composite(cv.ctx, doc, {
      zoom: 1, panX: 0, panY: 0, dpr: 1,
      width: doc.width, height: doc.height,
      scratch: scratch, useMips: false
    });
    return cv;
  }

  /* 把单个图层画成一张独立画布（导出当前图层用）。混合模式需要背景板，
   * 这里只带图层自身的不透明度，不做跨层混合。 */
  function renderLayer(layer) {
    var cv = makeCanvas(layer.width, layer.height);
    cv.ctx.globalAlpha = Math.max(0, Math.min(1, typeof layer.opacity === 'number' ? layer.opacity : 1));
    if (layer.type === 'shape') {
      paintShapesBuffered(cv.ctx, layer.shapes || []);
    } else if (layer.type !== 'adjust') {
      layer.tiles.forEach(function (t) { cv.ctx.drawImage(t.canvas, t.x, t.y); });
    }
    cv.ctx.globalAlpha = 1;
    return cv;
  }

  /* ---------------- 像素采样 ----------------
   * opts.layer：只取这一层；否则按图层堆叠合成（与画布所见一致）。
   * opts.size：取样块边长（1/3/5…），块内按 alpha 加权平均，避免吸到单像素噪点。
   */
  function sampleAt(layers, x, y) {
    var r = 0, g = 0, b = 0, a = 0;
    layers.forEach(function (layer) {
      if (layer.type === 'group') return;
      if (!layer.visible || layer.opacity <= 0 || layer.type !== 'pixel') return;
      var lx = x - layer.x;
      var ly = y - layer.y;
      var t = tileOfLocal(layer, lx, ly);
      if (!t) return;
      var px = t.ctx.getImageData(lx - t.x, ly - t.y, 1, 1).data;
      var sa = (px[3] / 255) * layer.opacity;
      if (sa <= 0) return;
      var outA = sa + a * (1 - sa);
      if (outA <= 0) return;
      r = (px[0] * sa + r * a * (1 - sa)) / outA;
      g = (px[1] * sa + g * a * (1 - sa)) / outA;
      b = (px[2] * sa + b * a * (1 - sa)) / outA;
      a = outA;
    });
    return { r: r, g: g, b: b, a: a };
  }

  function colorOut(c) {
    function hex(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); }
    return { r: c.r, g: c.g, b: c.b, a: c.a, hex: '#' + hex(c.r) + hex(c.g) + hex(c.b) };
  }

  function samplePixel(doc, x, y, opts) {
    opts = opts || {};
    var size = Math.max(1, Math.min(15, Math.round(opts.size || 1)));
    var layers = opts.layer ? [opts.layer] : doc.layers;
    var px0 = Math.floor(x);
    var py0 = Math.floor(y);
    if (size === 1) return colorOut(sampleAt(layers, px0, py0));
    var half = (size - 1) / 2;
    var R = 0, G = 0, B = 0, A = 0, cnt = 0;
    for (var oy = -half; oy <= half; oy++) {
      for (var ox = -half; ox <= half; ox++) {
        var s = sampleAt(layers, px0 + ox, py0 + oy);
        if (s.a <= 0) continue;
        R += s.r * s.a;
        G += s.g * s.a;
        B += s.b * s.a;
        A += s.a;
        cnt++;
      }
    }
    if (!A || !cnt) return colorOut({ r: 0, g: 0, b: 0, a: 0 });
    return colorOut({ r: R / A, g: G / A, b: B / A, a: A / cnt });
  }

  /* 点中最靠上的可见图层：像素层看 alpha，矢量层看形状包围盒。 */
  function topLayerAt(doc, x, y) {
    for (var i = doc.layers.length - 1; i >= 0; i--) {
      var l = doc.layers[i];
      if (l.type === 'group') continue;
      if (!l.visible || l.opacity <= 0) continue;
      if (!groupVisible(doc, l)) continue;
      if (l.type === 'shape') {
        var shapes = l.shapes || [];
        for (var s = 0; s < shapes.length; s++) {
          var b = shapeBounds(shapes[s]);
          if (b && x >= b.x + l.x - 2 && y >= b.y + l.y - 2 &&
            x <= b.x + b.w + l.x + 2 && y <= b.y + b.h + l.y + 2) return l;
        }
        continue;
      }
      if (l.type !== 'pixel') continue;
      var lx = x - l.x;
      var ly = y - l.y;
      var t = tileOfLocal(l, lx, ly);
      if (!t) continue;
      if (t.ctx.getImageData(lx - t.x, ly - t.y, 1, 1).data[3] > 8) return l;
    }
    return null;
  }

  /* ---------------- 二进制导入 / 导出 ---------------- */
  function planImport(w, h) {
    w = Math.max(1, w || 1);
    h = Math.max(1, h || 1);
    var scale = 1;
    if (w * h > MAX_IMPORT_PIXELS) scale = Math.min(scale, Math.sqrt(MAX_IMPORT_PIXELS / (w * h)));
    if (Math.max(w, h) * scale > MAX_IMPORT_DIM) scale = Math.min(scale, MAX_IMPORT_DIM / Math.max(w, h));
    var tw = Math.max(1, Math.floor(w * scale));
    var th = Math.max(1, Math.floor(h * scale));
    while (tw * th > MAX_IMPORT_PIXELS) {
      scale *= 0.98;
      tw = Math.max(1, Math.floor(w * scale));
      th = Math.max(1, Math.floor(h * scale));
    }
    return {
      scale: scale, width: tw, height: th,
      limited: scale < 0.999, sourceW: w, sourceH: h,
      pixels: tw * th
    };
  }

  async function loadBitmap(src) {
    if (typeof createImageBitmap === 'function') {
      /* 手机照片常带 EXIF 方向：from-image 让解码结果就是「正着看」的方向，
       * 老浏览器不认这个参数会直接 reject，退回不带参数的调用。 */
      var bmp = null;
      try {
        bmp = await createImageBitmap(src, { imageOrientation: 'from-image' });
      } catch (e) {
        try { bmp = await createImageBitmap(src); } catch (e2) { bmp = null; }
      }
      if (bmp) {
        return {
          bitmap: bmp, width: bmp.width, height: bmp.height,
          release: function () { try { bmp.close && bmp.close(); } catch (e) {} }
        };
      }
    }
    var url = typeof src === 'string' ? src : URL.createObjectURL(src);
    var img = await new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('图片解码失败')); };
      im.src = url;
    });
    return {
      bitmap: img, width: img.naturalWidth, height: img.naturalHeight,
      release: function () { if (typeof src !== 'string') URL.revokeObjectURL(url); }
    };
  }

  /* 把位图按瓦片铺进图层；缩小时用 drawImage 的源矩形，不整张放大再切。 */
  function placeImage(doc, bitmap, opts) {
    opts = opts || {};
    var sw = opts.sourceW || bitmap.width || bitmap.naturalWidth || 1;
    var sh = opts.sourceH || bitmap.height || bitmap.naturalHeight || 1;
    var plan = planImport(sw, sh);
    var tw = opts.width || plan.width;
    var th = opts.height || plan.height;
    var layer = createLayer(doc, {
      name: opts.name || '导入图片',
      width: tw,
      height: th,
      x: typeof opts.x === 'number' ? opts.x : Math.round((doc.width - tw) / 2),
      y: typeof opts.y === 'number' ? opts.y : Math.round((doc.height - th) / 2)
    });
    var cols = tileCols(layer);
    var rows = tileRows(layer);
    for (var ty = 0; ty < rows; ty++) {
      for (var tx = 0; tx < cols; tx++) {
        var t = ensureTile(layer, tx, ty, true);
        if (!t) continue;
        var sx = (t.x / tw) * sw;
        var sy = (t.y / th) * sh;
        var sW = (t.w / tw) * sw;
        var sH = (t.h / th) * sh;
        t.ctx.drawImage(bitmap, sx, sy, Math.max(0.01, sW), Math.max(0.01, sH), 0, 0, t.w, t.h);
      }
    }
    layer.thumbDirty = true;
    doc.version++;
    return { layer: layer, plan: plan };
  }

  /* 调整图层顺序（数组下标 0 为最底层）。返回是否真的移动。 */
  function reorderLayer(doc, layer, toIndex) {
    var from = doc.layers.indexOf(layer);
    if (from < 0) return false;
    toIndex = Math.max(0, Math.min(doc.layers.length - 1, toIndex));
    if (toIndex === from) return false;
    doc.layers.splice(from, 1);
    doc.layers.splice(toIndex, 0, layer);
    doc.version++;
    return true;
  }

  function moveLayer(doc, layer, toIndex) {
    var from = doc.layers.indexOf(layer);
    if (from < 0) return false;
    if (!reorderLayer(doc, layer, toIndex)) return false;
    var to = doc.layers.indexOf(layer);
    pushEntry(doc, {
      label: '调整图层顺序',
      touched: [],
      undo: function () { reorderLayer(doc, layer, from); },
      redo: function () { reorderLayer(doc, layer, to); }
    });
    doc.version++;
    return true;
  }

  /* 把位图置入现有文档：同 placeImage，但补一条历史记录，撤销能整层移除。 */
  function placeImageLayer(doc, bitmap, opts) {
    opts = opts || {};
    var res = placeImage(doc, bitmap, opts);
    var layer = res.layer;
    var index = doc.layers.indexOf(layer);
    var prevActive = doc.activeId;
    doc.activeId = layer.id;
    pushEntry(doc, {
      label: opts.label || '置入图片',
      touched: [layer],
      undo: function () {
        var i = doc.layers.indexOf(layer);
        if (i >= 0) doc.layers.splice(i, 1);
        doc.activeId = prevActive;
        doc.version++;
      },
      redo: function () {
        if (doc.layers.indexOf(layer) < 0) doc.layers.splice(Math.min(index, doc.layers.length), 0, layer);
        doc.activeId = layer.id;
        doc.version++;
      }
    });
    doc.version++;
    return res;
  }

  async function canvasBlob(canvas, type, quality) {
    var mime = type || 'image/png';
    // makeCanvas 返回的是 { canvas, ctx, w, h } 包装对象；这里同时接受裸画布。
    var target = (canvas && canvas.canvas) ? canvas.canvas : canvas;
    if (target.convertToBlob) {
      return target.convertToBlob({ type: mime, quality: quality });
    }
    return new Promise(function (resolve, reject) {
      target.toBlob(function (b) { b ? resolve(b) : reject(new Error('导出失败')); }, mime, quality);
    });
  }

  function blobDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(new Error('读取失败')); };
      r.readAsDataURL(blob);
    });
  }

  async function canvasDataURL(canvas, type) {
    return blobDataURL(await canvasBlob(canvas, type || 'image/png'));
  }

  /* ---------------- 工程序列化 ----------------
   * 像素图层按整层 PNG 存进 JSON（base64），矢量 / 调整层直接存结构。
   * 历史记录不落盘：工程打开后从空历史开始，撤销不会把载入的内容撤掉。
   */
  var PROJECT_FORMAT = 'ilab-project';
  var PROJECT_VERSION = 2;

  async function serializeDoc(doc) {
    var payload = {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      app: '图像工坊',
      savedAt: new Date().toISOString(),
      doc: {
        name: doc.name,
        width: doc.width,
        height: doc.height,
        activeIndex: Math.max(0, doc.layers.findIndex(function (l) { return l.id === doc.activeId; }))
      },
      layers: [],
      selection: null
    };
    /* 工程里不存图层 id（打开时会重新生成），组关系用「组在 layers 里的下标」表示 */
    var groupIndex = {};
    doc.layers.forEach(function (l, idx) { if (l.type === 'group') groupIndex[l.id] = idx; });
    for (var i = 0; i < doc.layers.length; i++) {
      var l = doc.layers[i];
      var item = {
        name: l.name, type: l.type, x: l.x, y: l.y,
        width: l.width, height: l.height,
        opacity: l.opacity, blend: l.blend, visible: l.visible,
        group: l.group && groupIndex[l.group] != null ? groupIndex[l.group] : null,
        collapsed: l.type === 'group' ? !!l.collapsed : undefined,
        locks: {
          transparent: !!l.locks.transparent, image: !!l.locks.image,
          position: !!l.locks.position, all: !!l.locks.all
        }
      };
      if (l.type === 'pixel') {
        if (l.tiles.size) {
          item.png = await canvasDataURL(readLayerCanvas(l), 'image/png');
          /* 只记有内容的瓦片坐标，打开时不必把整张图所有瓦片都建出来 */
          item.tiles = Array.from(l.tiles.keys());
        } else {
          item.empty = true;
        }
        if (l.mask && l.mask.tiles.size) {
          item.mask = {
            enabled: l.mask.enabled !== false,
            png: await canvasDataURL(maskCanvas(l.mask), 'image/png'),
            tiles: Array.from(l.mask.tiles.keys())
          };
        }
      } else if (l.type === 'shape') {
        item.shapes = l.shapes || [];
      } else if (l.type === 'adjust') {
        item.adjust = l.adjust ? { kind: l.adjust.kind, params: { value: l.adjust.params && l.adjust.params.value } } : null;
      }
      payload.layers.push(item);
    }
    if (doc.selection && doc.selection.active && doc.selection.shape) {
      payload.selection = {
        shape: doc.selection.shape,
        invert: !!doc.selection.invert,
        feather: doc.selection.feather || 0
      };
    }
    return payload;
  }

  async function deserializeDoc(payload) {
    if (!payload || payload.format !== PROJECT_FORMAT || !payload.doc) {
      throw new Error('不是图像工坊工程文件（缺少 ilab-project 标记）');
    }
    var meta = payload.doc;
    var w = Math.max(1, Math.min(8192, Math.round(Number(meta.width) || 0)));
    var h = Math.max(1, Math.min(8192, Math.round(Number(meta.height) || 0)));
    if (!w || !h) throw new Error('工程尺寸无效');
    var doc = createDoc(w, h, String(meta.name || '未命名工程'), { fill: false });
    var list = Array.isArray(payload.layers) ? payload.layers : [];
    /* 组关系记的是 layers 下标，建完之后再回填，和加载顺序无关 */
    var created = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var lw = Math.max(1, Math.round(Number(it.width) || w));
      var lh = Math.max(1, Math.round(Number(it.height) || h));
      var common = {
        name: String(it.name || ('图层 ' + (i + 1))),
        x: Math.round(Number(it.x) || 0),
        y: Math.round(Number(it.y) || 0),
        width: lw,
        height: lh,
        opacity: typeof it.opacity === 'number' ? it.opacity : 1,
        blend: it.blend || 'normal',
        visible: it.visible !== false,
        locks: it.locks || null,
        locked: it.locked === true
      };
      if (it.type === 'group') {
        common.type = 'group';
        common.collapsed = it.collapsed === true;
        created.push(createLayer(doc, common));
        continue;
      }
      if (it.type === 'shape') {
        common.type = 'shape';
        common.shapes = Array.isArray(it.shapes) ? it.shapes : [];
        created.push(createLayer(doc, common));
        continue;
      }
      if (it.type === 'adjust') {
        var adj = it.adjust || {};
        common.type = 'adjust';
        common.adjust = {
          kind: ADJUST_DEFS[adj.kind] ? adj.kind : 'brightness',
          params: { value: Number(adj.params && adj.params.value) || 0 }
        };
        created.push(createLayer(doc, common));
        continue;
      }
      var layer = createLayer(doc, common);
      created.push(layer);
      if (!it.png && !it.empty) continue;
      var loaded = null;
      try {
        if (it.png) loaded = await loadBitmap(it.png);
      } catch (e) { loaded = null; }
      if (loaded) {
        var keys = Array.isArray(it.tiles) && it.tiles.length ? it.tiles : null;
        var targets = [];
        if (keys) {
          keys.forEach(function (key) {
            var parts = String(key).split(',');
            var t = ensureTile(layer, Math.round(Number(parts[0]) || 0), Math.round(Number(parts[1]) || 0), true);
            if (t) targets.push(t);
          });
        } else {
          var cols = tileCols(layer);
          var rows = tileRows(layer);
          for (var ty = 0; ty < rows; ty++) {
            for (var tx = 0; tx < cols; tx++) {
              var t = ensureTile(layer, tx, ty, true);
              if (t) targets.push(t);
            }
          }
        }
        targets.forEach(function (t) {
          var sx = (t.x / lw) * loaded.width;
          var sy = (t.y / lh) * loaded.height;
          var sw = Math.max(0.01, (t.w / lw) * loaded.width);
          var sh = Math.max(0.01, (t.h / lh) * loaded.height);
          t.ctx.drawImage(loaded.bitmap, sx, sy, sw, sh, 0, 0, t.w, t.h);
        });
        loaded.release();
        touch(layer);
      }
      if (it.mask && it.mask.png) {
        var mloaded = null;
        try { mloaded = await loadBitmap(it.mask.png); } catch (e2) { mloaded = null; }
        if (mloaded) {
          var mask = createMask(layer);
          mask.enabled = it.mask.enabled !== false;
          var mkeys = Array.isArray(it.mask.tiles) && it.mask.tiles.length ? it.mask.tiles : null;
          var mtargets = [];
          if (mkeys) {
            mkeys.forEach(function (key) {
              var parts = String(key).split(',');
              var mt = ensureMaskTile(mask, Math.round(Number(parts[0]) || 0), Math.round(Number(parts[1]) || 0), true);
              if (mt) mtargets.push(mt);
            });
          } else {
            var mcols = tileCols(layer);
            var mrows = tileRows(layer);
            for (var my = 0; my < mrows; my++) {
              for (var mx = 0; mx < mcols; mx++) {
                var mt2 = ensureMaskTile(mask, mx, my, true);
                if (mt2) mtargets.push(mt2);
              }
            }
          }
          mtargets.forEach(function (mt) {
            var sx = (mt.x / lw) * mloaded.width;
            var sy = (mt.y / lh) * mloaded.height;
            var sw = Math.max(0.01, (mt.w / lw) * mloaded.width);
            var sh = Math.max(0.01, (mt.h / lh) * mloaded.height);
            mt.ctx.drawImage(mloaded.bitmap, sx, sy, sw, sh, 0, 0, mt.w, mt.h);
            var mi = mt.ctx.getImageData(0, 0, mt.w, mt.h);
            var md = mi.data;
            /* 灰度 PNG → 隐藏量 alpha；RGB 清零，合成时只看 alpha */
            for (var q = 0; q < md.length; q += 4) {
              md[q + 3] = 255 - md[q];
              md[q] = 0; md[q + 1] = 0; md[q + 2] = 0;
            }
            mt.ctx.putImageData(mi, 0, 0);
          });
          mloaded.release();
          layer.mask = mask;
        }
      }
    }
    for (var gi = 0; gi < list.length; gi++) {
      var gItem = list[gi] || {};
      if (gItem.group == null) continue;
      var gLayer = created[Math.round(Number(gItem.group))];
      var owner = created[gi];
      if (gLayer && gLayer.type === 'group' && owner && owner.type !== 'group') owner.group = gLayer.id;
    }
    if (!doc.layers.length) createLayer(doc, { name: '图层 1' });
    var ai = Math.max(0, Math.min(doc.layers.length - 1, Math.round(Number(meta.activeIndex) || 0)));
    doc.activeId = doc.layers[ai].id;
    if (payload.selection && payload.selection.shape) {
      setSelectionShape(doc, payload.selection.shape, !!payload.selection.invert, {
        feather: Number(payload.selection.feather) || 0
      });
    }
    doc.history = { entries: [], index: -1, bytes: 0 };
    doc.version++;
    return doc;
  }

  /* ---------------- 缩略图 ---------------- */
  function layerPreview(layer, size) {
    size = size || 40;
    var s = Math.min(size / Math.max(1, layer.width), size / Math.max(1, layer.height), 1);
    var w = Math.max(1, Math.round(layer.width * s));
    var h = Math.max(1, Math.round(layer.height * s));
    var cv = makeCanvas(w, h);
    if (layer.type === 'adjust') {
      cv.ctx.fillStyle = adjustColor(layer.adjust && layer.adjust.kind);
      cv.ctx.fillRect(0, 0, w, h);
      cv.ctx.fillStyle = 'rgba(255,255,255,.86)';
      cv.ctx.font = '600 11px "Segoe UI", sans-serif';
      var def = ADJUST_DEFS[layer.adjust && layer.adjust.kind];
      cv.ctx.fillText((def ? def.name : 'ADJ').slice(0, 4), 4, Math.min(h - 4, 14));
    } else if (layer.type === 'shape') {
      cv.ctx.save();
      cv.ctx.scale(s, s);
      paintShapesBuffered(cv.ctx, layer.shapes || []);
      cv.ctx.restore();
    } else {
      layer.tiles.forEach(function (t) {
        cv.ctx.drawImage(t.canvas, t.x * s, t.y * s, t.w * s, t.h * s);
      });
    }
    return cv.canvas;
  }

  function memBytes(doc) {
    var bytes = 0;
    if (!doc) return 0;
    doc.layers.forEach(function (l) {
      if (l.type === 'adjust') { bytes += 8; return; }
      if (l.type === 'shape') {
        bytes += (l.shapes ? l.shapes.length : 0) * 256;
        return;
      }
      bytes += l.tiles.size * TILE * TILE * 4;
      if (l.mask) bytes += l.mask.tiles.size * TILE * TILE * 4;
      l.mips.forEach(function (m) { bytes += canvasW(m) * canvasH(m) * 4; });
    });
    var h = doc.history;
    h.entries.forEach(function (e) { bytes += e.bytes || 0; });
    return bytes;
  }

  /* 油漆桶：整层像素处理（超大图层拒绝，交给工具提示）。
   * opts.contiguous=false 时替换整层所有同色像素；opts.opacity 控制填充强度。
   * 返回 {ok, count, reason}。 */
  function floodFillLayer(layer, x, y, color, tolerance, opts) {
    opts = opts || {};
    if (layer.width * layer.height > FLOOD_LIMIT) {
      return { ok: false, count: 0, reason: '图层超过 1600 万像素，请先用选区限定范围' };
    }
    x = Math.floor(x - layer.x);
    y = Math.floor(y - layer.y);
    if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) {
      return { ok: false, count: 0, reason: '点击位置不在这张图层上' };
    }
    var cv = readLayerCanvas(layer);
    var img = cv.ctx.getImageData(0, 0, layer.width, layer.height);
    var data = img.data;
    var w = layer.width, h = layer.height;
    var target = (y * w + x) * 4;
    var tr = data[target], tg = data[target + 1], tb = data[target + 2], ta = data[target + 3];
    var rgb = hexToRgb(color);
    var tol = Math.max(0, Number(tolerance) || 0);
    var op = opts.opacity == null ? 1 : Math.max(0, Math.min(1, Number(opts.opacity) || 0));
    var stack = [y * w + x];
    var seen = new Uint8Array(w * h);
    var count = 0;
    function near(i) {
      var p = i * 4;
      return Math.abs(data[p] - tr) <= tol &&
        Math.abs(data[p + 1] - tg) <= tol &&
        Math.abs(data[p + 2] - tb) <= tol &&
        Math.abs(data[p + 3] - ta) <= tol;
    }
    function put(i) {
      var p = i * 4;
      if (op >= 1) {
        data[p] = rgb.r;
        data[p + 1] = rgb.g;
        data[p + 2] = rgb.b;
        data[p + 3] = 255;
        return;
      }
      data[p] = data[p] * (1 - op) + rgb.r * op;
      data[p + 1] = data[p + 1] * (1 - op) + rgb.g * op;
      data[p + 2] = data[p + 2] * (1 - op) + rgb.b * op;
      data[p + 3] = data[p + 3] * (1 - op) + 255 * op;
    }
    if (opts.contiguous === false) {
      // 不连续：把整层里所有与种子同色的像素一起换掉
      for (var gi = 0; gi < w * h; gi++) {
        if (near(gi)) { put(gi); count++; }
      }
    } else {
      while (stack.length) {
        var idx = stack.pop();
        if (seen[idx]) continue;
        if (!near(idx)) { seen[idx] = 1; continue; }
        var px = idx % w;
        var py = Math.floor(idx / w);
        // 向左右铺开整段，减少入栈次数。注意这里**不能先给种子打 seen**，
        // 否则下面写像素的循环会把它跳过，留下一个没被填充的原色洞。
        var lx = px, rx = px;
        while (lx > 0 && !seen[py * w + lx - 1] && near(py * w + lx - 1)) lx--;
        while (rx < w - 1 && !seen[py * w + rx + 1] && near(py * w + rx + 1)) rx++;
        for (var xx = lx; xx <= rx; xx++) {
          var id2 = py * w + xx;
          if (seen[id2]) continue;
          seen[id2] = 1;
          put(id2);
          count++;
          if (py > 0 && !seen[id2 - w] && near(id2 - w)) stack.push(id2 - w);
          if (py < h - 1 && !seen[id2 + w] && near(id2 + w)) stack.push(id2 + w);
        }
      }
    }
    cv.ctx.putImageData(img, 0, 0);
    var tiles = ensureAllTiles(layer);
    tiles.forEach(function (t) {
      if (t) t.ctx.drawImage(cv.canvas, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
    });
    touch(layer);
    return { ok: true, count: count };
  }

  function hexToRgb(hex) {
    var s = String(hex || '#000000').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /* ---------------- 魔棒 ----------------
   * 按颜色容差生成选区：先在源像素上做「连续 / 全图」匹配得到二值 mask，
   * 再沿像素边界追踪成若干闭合轮廓（外轮廓 + 洞），用奇偶规则表达。
   * 这样选区仍是矢量路径，画笔、填充、裁剪都能直接复用。
   */
  function magicWand(doc, layer, wx, wy, opts) {
    opts = opts || {};
    var tol = Math.max(0, Math.min(255, Number(opts.tolerance == null ? 24 : opts.tolerance) || 0));
    var contiguous = opts.contiguous !== false;
    var sampleMerged = !!opts.sampleMerged;
    var src, ox = 0, oy = 0;
    if (!sampleMerged && layer && layer.type === 'pixel') {
      src = readLayerCanvas(layer);
      ox = layer.x;
      oy = layer.y;
    } else {
      src = renderFlatten(doc);
    }
    var w = src.canvas.width;
    var h = src.canvas.height;
    if (w * h > 24e6) return { ok: false, count: 0, reason: '取样范围超过 2400 万像素，请先框选局部' };
    var x = Math.floor(wx - ox);
    var y = Math.floor(wy - oy);
    if (x < 0 || y < 0 || x >= w || y >= h) {
      return { ok: false, count: 0, reason: '点击位置不在取样范围内' };
    }
    var data = src.ctx.getImageData(0, 0, w, h).data;
    var seed = (y * w + x) * 4;
    var tr = data[seed], tg = data[seed + 1], tb = data[seed + 2], ta = data[seed + 3];
    var mask = new Uint8Array(w * h);
    var count = 0;
    function near(i) {
      var p = i * 4;
      return Math.abs(data[p] - tr) <= tol &&
        Math.abs(data[p + 1] - tg) <= tol &&
        Math.abs(data[p + 2] - tb) <= tol &&
        Math.abs(data[p + 3] - ta) <= tol;
    }
    if (contiguous) {
      var stack = [y * w + x];
      while (stack.length) {
        var idx = stack.pop();
        if (mask[idx]) continue;
        if (!near(idx)) { mask[idx] = 2; continue; }
        var px = idx % w;
        var py = Math.floor(idx / w);
        var lx = px, rx = px;
        while (lx > 0 && !mask[py * w + lx - 1] && near(py * w + lx - 1)) lx--;
        while (rx < w - 1 && !mask[py * w + rx + 1] && near(py * w + rx + 1)) rx++;
        for (var xx = lx; xx <= rx; xx++) {
          var id = py * w + xx;
          if (mask[id]) continue;
          mask[id] = 1;
          count++;
          if (py > 0 && !mask[id - w] && near(id - w)) stack.push(id - w);
          if (py < h - 1 && !mask[id + w] && near(id + w)) stack.push(id + w);
        }
      }
    } else {
      for (var i = 0; i < w * h; i++) {
        if (near(i)) { mask[i] = 1; count++; }
      }
    }
    if (!count) return { ok: false, count: 0, reason: '容差范围内没有可选的像素' };
    var polys = traceMaskPolygons(mask, w, h, ox, oy);
    if (!polys.length) return { ok: false, count: count, reason: '选区轮廓为空' };
    var bounds = { x: Infinity, y: Infinity, w: 0, h: 0 };
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    polys.forEach(function (poly) {
      poly.forEach(function (p) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      });
    });
    bounds = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
    return {
      ok: true, count: count,
      shape: { type: 'polygons', polygons: polys, bounds: bounds },
      reason: ''
    };
  }

  /* 二值 mask → 闭合轮廓。沿「亮/暗」像素交界生成有向边，再按端点串成环。 */
  function traceMaskPolygons(mask, w, h, ox, oy) {
    var edges = new Map();
    function on(px, py) {
      return px >= 0 && py >= 0 && px < w && py < h && mask[py * w + px] === 1;
    }
    function add(x0, y0, x1, y1) {
      var k = x0 + ',' + y0;
      var arr = edges.get(k);
      if (!arr) { arr = []; edges.set(k, arr); }
      arr.push(x1 + ',' + y1);
    }
    for (var py = 0; py < h; py++) {
      for (var px = 0; px < w; px++) {
        if (!on(px, py)) continue;
        if (!on(px, py - 1)) add(px, py, px + 1, py);
        if (!on(px + 1, py)) add(px + 1, py, px + 1, py + 1);
        if (!on(px, py + 1)) add(px + 1, py + 1, px, py + 1);
        if (!on(px - 1, py)) add(px, py + 1, px, py);
      }
    }
    var keys = [];
    edges.forEach(function (list, k) { if (list.length) keys.push(k); });
    var found = [];
    var largest = null;
    var total = 0;
    for (var ki = 0; ki < keys.length; ki++) {
      var startKey = keys[ki];
      var guard = 0;
      while (guard++ < 2000000) {
        var list0 = edges.get(startKey);
        if (!list0 || !list0.length) break;
        var cur = startKey;
        var ring = [];
        var closed = false;
        var steps = 0;
        while (steps++ < 2000000) {
          var arr = edges.get(cur);
          if (!arr || !arr.length) break;
          var next = arr.pop();
          var sep = cur.indexOf(',');
          ring.push({ x: parseInt(cur.slice(0, sep), 10) + ox, y: parseInt(cur.slice(sep + 1), 10) + oy });
          cur = next;
          if (cur === startKey) { closed = true; break; }
        }
        if (!closed || ring.length < 4) continue;
        var simple = simplifyRing(ring, 0.6);
        if (simple.length >= 3) {
          var area = Math.abs(ringArea(simple));
          if (!largest || area > largest.area) largest = { ring: simple, area: area };
          // 抗锯齿边缘会切出大量 1~3 px 的碎片岛，直接丢掉，避免选区轮廓上千条
          if (area > 4) {
            found.push({ ring: simple, area: area });
            total += simple.length;
          }
        }
        if (total > 40000) break;
      }
      if (total > 40000) break;
    }
    if (!found.length && largest) found.push(largest);
    found.sort(function (a, b) { return b.area - a.area; });
    if (found.length > 240) found = found.slice(0, 240);
    return found.map(function (f) { return f.ring; });
  }

  function ringArea(pts) {
    var a = 0;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    }
    return a / 2;
  }

  function simplifyRing(pts, tol) {
    // 去掉重复点，再删掉共线的中间点（像素阶梯会产生大量长直线）
    var clean = [];
    for (var i = 0; i < pts.length; i++) {
      var a = clean[clean.length - 1];
      if (!a || Math.abs(a.x - pts[i].x) > 1e-9 || Math.abs(a.y - pts[i].y) > 1e-9) clean.push(pts[i]);
    }
    if (clean.length > 2) {
      var last = clean[clean.length - 1], first = clean[0];
      if (Math.abs(last.x - first.x) < 1e-9 && Math.abs(last.y - first.y) < 1e-9) clean.pop();
    }
    if (clean.length < 3) return clean;
    var keep = [];
    for (var k = 0; k < clean.length; k++) {
      var p0 = clean[(k - 1 + clean.length) % clean.length];
      var p1 = clean[k];
      var p2 = clean[(k + 1) % clean.length];
      var cross = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
      if (Math.abs(cross) > 0.01) keep.push(p1);
    }
    if (keep.length < 3) keep = clean;
    var open = keep.concat([keep[0]]);
    var out = rdpSimplify(open, tol);
    if (out.length > 1) out.pop();
    // 点太多时逐步放宽容差，保证后续命中测试与遮挡绘制都不至于卡顿
    var bump = tol;
    while (out.length > 1600 && bump < 6) {
      bump *= 2;
      out = rdpSimplify(keep.concat([keep[0]]), bump);
      if (out.length > 1) out.pop();
    }
    return out.length >= 3 ? out : keep;
  }

  function rdpSimplify(points, eps) {
    var n = points.length;
    if (n <= 2) return points.slice();
    var keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var i0 = seg[0], i1 = seg[1];
      var maxD = -1, idx = -1;
      var a = points[i0], b = points[i1];
      for (var i = i0 + 1; i < i1; i++) {
        var d = distToSegment(points[i].x, points[i].y, a.x, a.y, b.x, b.y);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) {
        keep[idx] = 1;
        stack.push([i0, idx], [idx, i1]);
      }
    }
    var out = [];
    for (var k = 0; k < n; k++) if (keep[k]) out.push(points[k]);
    return out;
  }

  return {
    TILE: TILE,
    MAX_IMPORT_PIXELS: MAX_IMPORT_PIXELS,
    MAX_IMPORT_DIM: MAX_IMPORT_DIM,
    MAX_MIP_DIM: MAX_MIP_DIM,
    HISTORY_BUDGET: HISTORY_BUDGET,
    ADJUST_DEFS: ADJUST_DEFS,
    makeCanvas: makeCanvas,
    canvasW: canvasW,
    canvasH: canvasH,
    frame: frame,
    blendOp: blendOp,
    adjustString: adjustString,
    createDoc: createDoc,
    createLayer: createLayer,
    layerById: layerById,
    activeLayer: activeLayer,
    touch: touch,
    touchDoc: touchDoc,
    tileKey: tileKey,
    tileCols: tileCols,
    tileRows: tileRows,
    ensureTile: ensureTile,
    ensureAllTiles: ensureAllTiles,
    existingTiles: existingTiles,
    normalizeLocks: normalizeLocks,
    hasLock: hasLock,
    createMask: createMask,
    ensureMaskTile: ensureMaskTile,
    maskTileOfLocal: maskTileOfLocal,
    maskEmpty: maskEmpty,
    maskCanvas: maskCanvas,
    maskPreview: maskPreview,
    bakeMaskToLayerTiles: bakeMaskToLayerTiles,
    addLayerMask: addLayerMask,
    removeLayerMask: removeLayerMask,
    setLayerMaskEnabled: setLayerMaskEnabled,
    applyLayerMask: applyLayerMask,
    alphaLocked: alphaLocked,
    restoreTileAlpha: restoreTileAlpha,
    tileOfLocal: tileOfLocal,
    layerDocRect: layerDocRect,
    fillLayer: fillLayer,
    fillLayerGradient: fillLayerGradient,
    clearLayer: clearLayer,
    readRegionLocal: readRegionLocal,
    readLayerCanvas: readLayerCanvas,
    boundsOfShape: boundsOfShape,
    setSelectionShape: setSelectionShape,
    clearSelection: clearSelection,
    selectAll: selectAll,
    invertSelection: invertSelection,
    selectionContains: selectionContains,
    addSelectionPath: addSelectionPath,
    drawSelectionMask: drawSelectionMask,
    maskForTile: maskForTile,
    applyMaskBlendTile: applyMaskBlendTile,
    clipToSelection: clipToSelection,
    beginTx: beginTx,
    snapTile: snapTile,
    endTx: endTx,
    pushEntry: pushEntry,
    undo: undo,
    redo: redo,
    historyJump: historyJump,
    addLayer: addLayer,
    removeLayer: removeLayer,
    duplicateLayer: duplicateLayer,
    mergeDown: mergeDown,
    flatten: flatten,
    setLayerProp: setLayerProp,
    cropDoc: cropDoc,
    addAdjustLayer: addAdjustLayer,
    mipLevelFor: mipLevelFor,
    ensureMips: ensureMips,
    requestMips: requestMips,
    composite: composite,
    renderFlatten: renderFlatten,
    samplePixel: samplePixel,
    topLayerAt: topLayerAt,
    planImport: planImport,
    loadBitmap: loadBitmap,
    placeImage: placeImage,
    placeImageLayer: placeImageLayer,
    moveLayer: moveLayer,
    reorderLayer: reorderLayer,
    renderLayer: renderLayer,
    serializeDoc: serializeDoc,
    deserializeDoc: deserializeDoc,
    canvasBlob: canvasBlob,
    canvasDataURL: canvasDataURL,
    layerPreview: layerPreview,
    memBytes: memBytes,
    floodFillLayer: floodFillLayer,
    magicWand: magicWand,
    addShapeLayer: addShapeLayer,
    appendShape: appendShape,
    setShapeOp: setShapeOp,
    shapeOp: shapeOp,
    hasShapeBoolean: hasShapeBoolean,
    outlineShapeLayer: outlineShapeLayer,
    SHAPE_OPS: SHAPE_OPS,
    SHAPE_OP_NAMES: SHAPE_OP_NAMES,
    rasterizeShapeLayer: rasterizeShapeLayer,
    hitShapeLayer: hitShapeLayer,
    shapeBounds: shapeBounds,
    layerContentBounds: layerContentBounds,
    shapePath: shapePath,
    drawShapesInto: drawShapesInto,
    cloneShape: cloneShape,
    selectionRule: selectionRule,
    pointInPolygon: pointInPolygon,
    hexToRgb: hexToRgb
  };
})();
