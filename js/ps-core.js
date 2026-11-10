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
      selection: { active: false, invert: false, shape: null, version: 0 },
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

  function createLayer(doc, opts) {
    opts = opts || {};
    var l = {
      id: 'L' + (++seq),
      name: opts.name || ('图层 ' + (doc.layers.length + 1)),
      type: opts.type || 'pixel',
      visible: opts.visible !== false,
      opacity: typeof opts.opacity === 'number' ? opts.opacity : 1,
      blend: opts.blend || 'normal',
      x: opts.x || 0,
      y: opts.y || 0,
      width: Math.max(1, Math.round(opts.width || doc.width)),
      height: Math.max(1, Math.round(opts.height || doc.height)),
      tiles: new Map(),
      adjust: opts.adjust || null,
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

  function tileOfLocal(layer, lx, ly) {
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) return null;
    return layer.tiles.get(tileKey(Math.floor(lx / TILE), Math.floor(ly / TILE))) || null;
  }

  function layerDocRect(layer) { return { x: layer.x, y: layer.y, w: layer.width, h: layer.height }; }

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

  function setSelectionShape(doc, shape, invert) {
    doc.selection = {
      active: true,
      invert: !!invert,
      shape: shape,
      version: ++selSeq
    };
    doc.version++;
    return doc.selection;
  }

  function clearSelection(doc) {
    doc.selection = { active: false, invert: false, shape: null, version: ++selSeq };
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

  /* 把选区画成白/黑遮罩（alpha 通道就是选区强度）。 */
  function drawSelectionMask(ctx, doc, ox, oy, w, h) {
    var sel = doc.selection;
    if (!sel.active) return false;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    if (sel.invert) {
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-out';
      if (addSelectionPath(ctx, sel.shape, ox, oy)) ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else {
      if (addSelectionPath(ctx, sel.shape, ox, oy)) ctx.fill();
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
    var cv = makeCanvas(tile.w, tile.h);
    drawSelectionMask(cv.ctx, doc, layer.x + tile.x, layer.y + tile.y, tile.w, tile.h);
    var data = cv.ctx.getImageData(0, 0, tile.w, tile.h).data;
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
    if (ok) ctx.clip();
    return ok;
  }

  /* ---------------- 历史 ---------------- */
  function beginTx(doc, label) {
    return { doc: doc, label: label || '编辑', tiles: new Map(), undoOps: [], redoOps: [], bytes: 0 };
  }

  function snapTile(tx, layer, tile) {
    if (!tile) return null;
    var k = layer.id + '|' + tile.key;
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
      adjust: layer.adjust ? { kind: layer.adjust.kind, params: { value: layer.adjust.params.value } } : null
    });
    if (layer.type === 'pixel') {
      layer.tiles.forEach(function (t) {
        var nt = ensureTile(copy, t.tx, t.ty, true);
        if (nt) nt.ctx.drawImage(t.canvas, 0, 0);
      });
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
      src.tiles.forEach(function (st) {
        var sx = src.x + st.x - docX;
        var sy = src.y + st.y - docY;
        t.ctx.drawImage(st.canvas, sx, sy);
      });
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
    if (view.useMips !== false && z < 0.5 && layer.mipReady && layer.mips.length) {
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

  function composite(ctx, doc, view) {
    var stats = { tiles: 0, mips: 0 };
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
      if (!layer.visible || layer.opacity <= 0) continue;
      if (layer.type === 'pixel') drawPixelLayer(ctx, doc, layer, view, stats);
      else drawAdjustLayer(ctx, doc, layer, view, scratch);
    }
    ctx.restore();
    return stats;
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

  /* ---------------- 像素采样 ---------------- */
  function samplePixel(doc, x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    var r = 0, g = 0, b = 0, a = 0;
    doc.layers.forEach(function (layer) {
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
    function hex(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); }
    return { r: r, g: g, b: b, a: a, hex: '#' + hex(r) + hex(g) + hex(b) };
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
      try {
        var bmp = await createImageBitmap(src);
        return {
          bitmap: bmp, width: bmp.width, height: bmp.height,
          release: function () { try { bmp.close && bmp.close(); } catch (e) {} }
        };
      } catch (e) { /* 退回 <img> */ }
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
      bytes += l.tiles.size * TILE * TILE * 4;
      l.mips.forEach(function (m) { bytes += canvasW(m) * canvasH(m) * 4; });
    });
    var h = doc.history;
    h.entries.forEach(function (e) { bytes += e.bytes || 0; });
    return bytes;
  }

  /* 油漆桶：整层像素处理（超大图层拒绝，交给工具提示）。
   * 返回 {ok, count, reason}。 */
  function floodFillLayer(layer, x, y, color, tolerance) {
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
        var p2 = id2 * 4;
        data[p2] = rgb.r;
        data[p2 + 1] = rgb.g;
        data[p2 + 2] = rgb.b;
        data[p2 + 3] = 255;
        count++;
        if (py > 0 && !seen[id2 - w] && near(id2 - w)) stack.push(id2 - w);
        if (py < h - 1 && !seen[id2 + w] && near(id2 + w)) stack.push(id2 + w);
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
    planImport: planImport,
    loadBitmap: loadBitmap,
    placeImage: placeImage,
    canvasBlob: canvasBlob,
    canvasDataURL: canvasDataURL,
    layerPreview: layerPreview,
    memBytes: memBytes,
    floodFillLayer: floodFillLayer,
    hexToRgb: hexToRgb
  };
})();
