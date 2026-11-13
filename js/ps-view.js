/* 图像工坊 · 视口（PSView）
 *
 * 只做三件事：把文档合成到屏幕、把屏幕坐标换算成文档坐标、处理缩放/平移。
 * 图层数据全在 PS（ps-core.js）里，这里不持有任何像素历史。
 *
 * 渲染顺序：
 *   深色底 → 文档阴影 → 棋盘格（透明区）→ 合成画布 → 选区/网格/瓦片/笔刷环。
 *
 * 几个细节：
 *   - dpr 上限 2：4K/5K 屏上把 dpr 提到 3 会让每帧多画一倍像素，肉眼收益很小。
 *   - 合成画布按「设备像素」尺寸建一次，窗口变化才重建；
 *   - 缩放/平移只是改 zoom/pan，不重新分配图层。
 */
function PSView(host, opts) {
  opts = opts || {};
  this.host = host;
  this.doc = null;
  this.zoom = 1;
  this.panX = 0;
  this.panY = 0;
  this.cssW = 0;
  this.cssH = 0;
  this.dpr = 1;
  this.comp = null;
  this.scratch = null;
  this.wrap = null;
  this.canvas = null;
  this.ctx = null;
  this.hint = null;
  this.toolHandlers = null;
  this.previewShape = null;
  this.previewRect = null;
  this.previewLine = null;
  this.previewPath = null;
  this.previewVector = null;
  this.cursorDoc = null;
  this.cursorRadius = 0;
  this.cursorOn = false;
  this.pointerInside = false;
  this.spaceDown = false;
  this.dragging = false;
  this.panning = null;
  this.showGrid = false;
  this.showTiles = false;
  this.useMips = true;
  this.stats = { tiles: 0, mips: 0, ms: 0, fps: 0, zoom: 1 };
  this.onStats = opts.onStats || null;
  this._raf = 0;
  this._lastNow = 0;
  this._resizeObs = null;
  this._bound = false;
  this._init();
}

PSView.prototype._init = function () {
  var self = this;
  this.host.innerHTML = '';
  this.host.classList.add('ps-stage-host-inner');
  this.wrap = document.createElement('div');
  this.wrap.className = 'ps-stage';
  this.canvas = document.createElement('canvas');
  this.canvas.className = 'ps-canvas';
  this.canvas.setAttribute('aria-label', '图像画布');
  this.hint = document.createElement('div');
  this.hint.className = 'ps-empty-hint';
  this.hint.textContent = '拖入图片，或「文件 → 打开」';
  this.wrap.appendChild(this.canvas);
  this.wrap.appendChild(this.hint);
  this.host.appendChild(this.wrap);
  this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  this._bindEvents();
  if (typeof ResizeObserver !== 'undefined') {
    this._resizeObs = new ResizeObserver(function () { self.resize(); });
    this._resizeObs.observe(this.wrap);
  }
  this.resize();
};

PSView.prototype._bindEvents = function () {
  var self = this;
  this._onWheel = function (e) {
    if (!self.doc) return;
    e.preventDefault();
    var r = self.canvas.getBoundingClientRect();
    var cx = e.clientX - r.left;
    var cy = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey) {
      var f = Math.pow(1.0016, -e.deltaY);
      self.zoomAt(cx, cy, f);
    } else if (e.shiftKey) {
      self.panX -= e.deltaY;
      self.schedule();
    } else {
      self.panX -= e.deltaX;
      self.panY -= e.deltaY;
      self.schedule();
    }
  };
  this._onDown = function (e) {
    if (!self.doc) return;
    var p = self.pointOf(e);
    if (e.button === 1 || (self.spaceDown && e.button === 0)) {
      self._startPan(e);
      return;
    }
    if (e.button !== 0) return;
    self.dragging = true;
    try { self.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    if (self.toolHandlers && typeof self.toolHandlers.down === 'function') self.toolHandlers.down(p, e);
    self.schedule();
  };
  this._onMove = function (e) {
    if (!self.doc) return;
    var p = self.pointOf(e);
    self.cursorDoc = p;
    if (self.panning) {
      self.panX = self.panning.px + (e.clientX - self.panning.cx);
      self.panY = self.panning.py + (e.clientY - self.panning.cy);
      self.schedule();
      return;
    }
    if (self.dragging && self.toolHandlers && typeof self.toolHandlers.move === 'function') {
      self.toolHandlers.move(p, e);
      self.schedule();
      return;
    }
    // 悬停时也交给工具层：画笔 / 橡皮擦靠它画笔刷环，钢笔靠它更新橡皮筋
    if (self.toolHandlers && typeof self.toolHandlers.move === 'function') {
      self.toolHandlers.move(p, e);
    }
    if (self.cursorOn) self.schedule();
  };
  this._onUp = function (e) {
    if (self.panning) {
      self.panning = null;
      self.schedule();
      return;
    }
    if (!self.dragging) return;
    self.dragging = false;
    var p = self.pointOf(e);
    if (self.toolHandlers && typeof self.toolHandlers.up === 'function') self.toolHandlers.up(p, e);
    self.schedule();
  };
  this._onKeyDown = function (e) {
    if (!self._isActive()) return;
    if (e.code === 'Space') {
      self.spaceDown = true;
      self.canvas.classList.add('ps-space');
      e.preventDefault();
    }
  };
  this._onKeyUp = function (e) {
    if (e.code === 'Space') {
      self.spaceDown = false;
      self.canvas.classList.remove('ps-space');
    }
  };
  this._onEnter = function () {
    self.pointerInside = true;
  };
  this._onLeave = function () {
    self.pointerInside = false;
    // 指针离开画布时收掉笔刷环，否则会留一个「幽灵圆」停在边缘
    if (self.cursorOn) self.clearCursor();
  };
  this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
  this.canvas.addEventListener('pointerdown', this._onDown);
  this.canvas.addEventListener('pointermove', this._onMove);
  this.canvas.addEventListener('pointerenter', this._onEnter);
  this.canvas.addEventListener('pointerleave', this._onLeave);
  this.canvas.addEventListener('pointerup', this._onUp);
  this.canvas.addEventListener('pointercancel', this._onUp);
  this.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  window.addEventListener('keydown', this._onKeyDown);
  window.addEventListener('keyup', this._onKeyUp);
};

PSView.prototype._isActive = function () {
  var win = this.host && this.host.closest ? this.host.closest('.os-win') : null;
  return !!win && !win.classList.contains('hidden');
};

PSView.prototype._startPan = function (e) {
  this.panning = { cx: e.clientX, cy: e.clientY, px: this.panX, py: this.panY };
  try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
  this.canvas.classList.add('ps-panning');
  var self = this;
  var up = function () {
    self.panning = null;
    self.canvas.classList.remove('ps-panning');
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointerup', up);
};

PSView.prototype.pointOf = function (e) {
  var r = this.canvas.getBoundingClientRect();
  var cx = e.clientX - r.left;
  var cy = e.clientY - r.top;
  return {
    x: cx,
    y: cy,
    docX: (cx - this.panX) / this.zoom,
    docY: (cy - this.panY) / this.zoom
  };
};

PSView.prototype.resize = function () {
  var w = this.wrap ? this.wrap.clientWidth : 0;
  var h = this.wrap ? this.wrap.clientHeight : 0;
  if (w <= 0 || h <= 0) return;
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  if (w === this.cssW && h === this.cssH && dpr === this.dpr && this.canvas.width) return;
  /* 视口尺寸变化（拖窗口、收纳面板）时保持画布中心不漂移 */
  var centerDoc = this.cssW > 0 && this.doc
    ? { x: (this.cssW / 2 - this.panX) / this.zoom, y: (this.cssH / 2 - this.panY) / this.zoom }
    : null;
  this.cssW = w;
  this.cssH = h;
  this.dpr = dpr;
  if (centerDoc) {
    this.panX = w / 2 - centerDoc.x * this.zoom;
    this.panY = h / 2 - centerDoc.y * this.zoom;
  }
  this.canvas.width = Math.max(1, Math.round(w * dpr));
  this.canvas.height = Math.max(1, Math.round(h * dpr));
  this.canvas.style.width = w + 'px';
  this.canvas.style.height = h + 'px';
  this.comp = null;
  this.scratch = null;
  this.schedule();
};

PSView.prototype.setDoc = function (doc) {
  this.doc = doc || null;
  if (this.hint) this.hint.hidden = !!doc;
  if (doc) this.fit();
  this.schedule();
};

PSView.prototype.fit = function () {
  if (!this.doc || !this.cssW || !this.cssH) return;
  var pad = 40;
  var z = Math.min(
    (this.cssW - pad * 2) / this.doc.width,
    (this.cssH - pad * 2) / this.doc.height
  );
  z = Math.max(0.01, Math.min(z, 4));
  this.zoom = z;
  this.panX = (this.cssW - this.doc.width * z) / 2;
  this.panY = (this.cssH - this.doc.height * z) / 2;
  this.schedule();
};

PSView.prototype.actual = function () {
  if (!this.doc) return;
  this.setZoom(1);
};

PSView.prototype.setZoom = function (z, cx, cy) {
  if (!this.doc) return;
  if (typeof cx !== 'number') cx = this.cssW / 2;
  if (typeof cy !== 'number') cy = this.cssH / 2;
  this.zoomAt(cx, cy, z / this.zoom);
};

PSView.prototype.zoomAt = function (cx, cy, factor) {
  if (!this.doc) return;
  var old = this.zoom;
  var z = Math.max(0.01, Math.min(32, old * factor));
  if (Math.abs(z - old) < 1e-6) return;
  var docX = (cx - this.panX) / old;
  var docY = (cy - this.panY) / old;
  this.zoom = z;
  this.panX = cx - docX * z;
  this.panY = cy - docY * z;
  this.schedule();
};

PSView.prototype.setCursor = function (x, y, radius) {
  this.cursorDoc = { docX: x, docY: y };
  this.cursorRadius = radius || 0;
  this.cursorOn = true;
  this.schedule();
};

PSView.prototype.clearCursor = function () {
  this.cursorOn = false;
  this.schedule();
};

PSView.prototype.schedule = function () {
  if (this._raf) return;
  var self = this;
  this._raf = requestAnimationFrame(function () {
    self._raf = 0;
    self.render();
  });
};

PSView.prototype._checkBuffers = function () {
  var cw = this.canvas.width;
  var ch = this.canvas.height;
  if (!this.comp || this.comp.w !== cw || this.comp.h !== ch) this.comp = PS.makeCanvas(cw, ch);
  if (!this.scratch || this.scratch.w !== cw || this.scratch.h !== ch) this.scratch = PS.makeCanvas(cw, ch);
};

PSView.prototype.render = function () {
  if (!this.ctx || !this.cssW) return;
  this.resize();
  var t0 = performance.now();
  var ctx = this.ctx;
  var dpr = this.dpr;
  var cw = this.canvas.width;
  var ch = this.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  // 工作台底色：和主界面的浅灰画布一致，白色文档浮在灰底上
  var stageBg = ctx.createLinearGradient(0, 0, 0, ch);
  stageBg.addColorStop(0, '#eef1f6');
  stageBg.addColorStop(1, '#e6eaf0');
  ctx.fillStyle = stageBg;
  ctx.fillRect(0, 0, cw, ch);

  var doc = this.doc;
  if (!doc) {
    this._emitStats(t0, 0, 0);
    return;
  }
  this._checkBuffers();

  var z = this.zoom;
  var px = this.panX;
  var py = this.panY;
  var dx = Math.round(px * dpr);
  var dy = Math.round(py * dpr);
  var dw = Math.round(doc.width * z * dpr);
  var dh = Math.round(doc.height * z * dpr);

  // 文档投影 + 底板
  ctx.save();
  ctx.shadowColor = 'rgba(28,38,60,.22)';
  ctx.shadowBlur = 20 * dpr;
  ctx.shadowOffsetY = 5 * dpr;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(dx, dy, dw, dh);
  ctx.restore();

  // 透明棋盘格
  this._drawChecker(dx, dy, dw, dh);
  // 用棋盘格的静态图案做剪裁，合成结果直接盖上去
  var comp = this.comp;
  comp.ctx.setTransform(1, 0, 0, 1, 0, 0);
  comp.ctx.clearRect(0, 0, comp.w, comp.h);
  var res = PS.composite(comp.ctx, doc, {
    zoom: z, panX: px, panY: py, dpr: dpr,
    width: this.cssW, height: this.cssH,
    scratch: this.scratch, useMips: this.useMips
  });
  ctx.drawImage(comp.canvas, 0, 0, comp.w, comp.h, 0, 0, comp.w, comp.h);

  this._drawOverlays(ctx, doc, dx, dy, dw, dh, z, dpr);

  this._emitStats(t0, res.tiles, res.mips);
};

PSView.prototype._emitStats = function (t0, tiles, mips) {
  var now = performance.now();
  var ms = now - t0;
  var inst = this._lastNow ? 1000 / Math.max(1, now - this._lastNow) : 60;
  this._lastNow = now;
  this.stats.fps = this.stats.fps ? Math.round(this.stats.fps * 0.82 + inst * 0.18) : Math.round(inst);
  this.stats.ms = Math.round(ms * 10) / 10;
  this.stats.tiles = tiles;
  this.stats.mips = mips;
  this.stats.zoom = this.zoom;
  if (this.onStats) this.onStats(this.stats, this);
};

PSView.prototype._drawChecker = function (dx, dy, dw, dh) {
  var ctx = this.ctx;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.fillStyle = '#f6f7f9';
  ctx.fillRect(dx, dy, dw, dh);
  var cell = 12;
  var cols = Math.ceil(dw / cell);
  var rows = Math.ceil(dh / cell);
  ctx.fillStyle = '#e9ecf1';
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      if ((r + c) % 2) ctx.fillRect(dx + c * cell, dy + r * cell, cell, cell);
    }
  }
  ctx.restore();
};

PSView.prototype._docTransform = function (ctx, z, dpr, px, py) {
  ctx.setTransform(z * dpr, 0, 0, z * dpr, px * dpr, py * dpr);
};

PSView.prototype._drawOverlays = function (ctx, doc, dx, dy, dw, dh, z, dpr) {
  var self = this;
  var sel = doc.selection;

  // 文档边框
  ctx.save();
  ctx.strokeStyle = 'rgba(28,38,60,.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(dx + 0.5, dy + 0.5, Math.max(0, dw - 1), Math.max(0, dh - 1));
  ctx.restore();

  // 网格
  if (this.showGrid) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.strokeStyle = 'rgba(28,38,60,.13)';
    ctx.lineWidth = 1;
    var step = 100;
    for (var gx = step; gx < doc.width; gx += step) {
      var lx = Math.round((this.panX + gx * z) * dpr) + 0.5;
      ctx.beginPath();
      ctx.moveTo(lx, dy);
      ctx.lineTo(lx, dy + dh);
      ctx.stroke();
    }
    for (var gy = step; gy < doc.height; gy += step) {
      var ly = Math.round((this.panY + gy * z) * dpr) + 0.5;
      ctx.beginPath();
      ctx.moveTo(dx, ly);
      ctx.lineTo(dx + dw, ly);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 选区：黑底 + 白虚线，深浅背景都看得见
  if (sel.active && sel.shape) {
    this._strokeShape(ctx, doc, sel.shape, z, dpr, '#ffffff', 2);
    this._strokeShape(ctx, doc, sel.shape, z, dpr, '#111318', 1);
  }
  if (this.previewShape) {
    this._strokeShape(ctx, doc, this.previewShape, z, dpr, '#5b8fd9', 1.5);
  }
  if (this.previewRect) {
    var pr = this.previewRect;
    ctx.save();
    ctx.strokeStyle = '#5b8fd9';
    ctx.fillStyle = 'rgba(91,143,217,.12)';
    ctx.lineWidth = 1;
    var rx = Math.round((this.panX + pr.x * z) * dpr);
    var ry = Math.round((this.panY + pr.y * z) * dpr);
    var rw = Math.round(pr.w * z * dpr);
    var rh = Math.round(pr.h * z * dpr);
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    ctx.restore();
  }
  if (this.previewLine) {
    var pl = this.previewLine;
    ctx.save();
    ctx.strokeStyle = '#5b8fd9';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo((this.panX + pl.x0 * z) * dpr, (this.panY + pl.y0 * z) * dpr);
    ctx.lineTo((this.panX + pl.x1 * z) * dpr, (this.panY + pl.y1 * z) * dpr);
    ctx.stroke();
    ctx.restore();
  }

  // 钢笔路径预览：已落下的锚点 + 到光标的橡皮筋 + 控制柄
  if (this.previewPath) {
    var pp = this.previewPath;
    var px = 1 / (z * dpr);
    ctx.save();
    this._docTransform(ctx, z, dpr, this.panX, this.panY);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (pp.pts.length >= 2) {
      ctx.beginPath();
      PS.shapePath(ctx, { kind: 'path', pts: pp.pts, closed: !!pp.closed });
      ctx.strokeStyle = '#5b8fd9';
      ctx.lineWidth = 1.6 * px;
      ctx.stroke();
    }
    if (pp.cursor && pp.pts.length) {
      var lastPt = pp.pts[pp.pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(lastPt.x, lastPt.y);
      ctx.lineTo(pp.cursor.x, pp.cursor.y);
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeStyle = 'rgba(91,143,217,.82)';
      ctx.lineWidth = 1 * px;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pp.pts.forEach(function (a, idx) {
      if (a.hox != null || a.hoy != null) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.hox == null ? a.x : a.hox, a.hoy == null ? a.y : a.hoy);
        ctx.strokeStyle = 'rgba(91,143,217,.6)';
        ctx.lineWidth = 1 * px;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(a.hox == null ? a.x : a.hox, a.hoy == null ? a.y : a.hoy, 2.4 * px, 0, Math.PI * 2);
        ctx.fillStyle = '#5b8fd9';
        ctx.fill();
      }
      if (a.hix != null || a.hiy != null) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.hix == null ? a.x : a.hix, a.hiy == null ? a.y : a.hiy);
        ctx.strokeStyle = 'rgba(91,143,217,.6)';
        ctx.lineWidth = 1 * px;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(a.hix == null ? a.x : a.hix, a.hiy == null ? a.y : a.hiy, 2.4 * px, 0, Math.PI * 2);
        ctx.fillStyle = '#5b8fd9';
        ctx.fill();
      }
      var half = (idx === 0 ? 4.2 : 3.2) * px;
      ctx.fillStyle = idx === 0 ? '#ffffff' : '#5b8fd9';
      ctx.strokeStyle = '#111318';
      ctx.lineWidth = 1 * px;
      ctx.fillRect(a.x - half, a.y - half, half * 2, half * 2);
      ctx.strokeRect(a.x - half, a.y - half, half * 2, half * 2);
    });
    ctx.restore();
  }

  // 形状工具拖拽预览
  if (this.previewVector) {
    var pv = this.previewVector;
    ctx.save();
    this._docTransform(ctx, z, dpr, this.panX, this.panY);
    ctx.beginPath();
    PS.shapePath(ctx, pv.shape);
    if (pv.shape.kind !== 'line') {
      ctx.fillStyle = pv.shape.fill || 'rgba(91,143,217,.25)';
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = '#5b8fd9';
    ctx.lineWidth = 1.5 / (z * dpr);
    ctx.setLineDash([5 / (z * dpr), 4 / (z * dpr)]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 瓦片边界（调试/性能观察用）
  if (this.showTiles) {
    ctx.save();
    ctx.strokeStyle = 'rgba(91,143,217,.35)';
    ctx.lineWidth = 1;
    doc.layers.forEach(function (layer) {
      if (layer.type !== 'pixel' || !layer.visible) return;
      layer.tiles.forEach(function (t) {
        var tx = Math.round((self.panX + (layer.x + t.x) * z) * dpr) + 0.5;
        var ty = Math.round((self.panY + (layer.y + t.y) * z) * dpr) + 0.5;
        var tw = Math.max(1, Math.round(t.w * z * dpr) - 1);
        var th = Math.max(1, Math.round(t.h * z * dpr) - 1);
        ctx.strokeRect(tx, ty, tw, th);
      });
    });
    ctx.restore();
  }

  // 笔刷环
  if (this.cursorOn && this.cursorDoc && this.cursorRadius > 0) {
    var cx = (this.panX + this.cursorDoc.docX * z) * dpr;
    var cy = (this.panY + this.cursorDoc.docY * z) * dpr;
    var rr = Math.max(2, this.cursorRadius * z * dpr);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.beginPath();
    ctx.arc(cx, cy, rr + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

PSView.prototype._strokeShape = function (ctx, doc, shape, z, dpr, color, width) {
  ctx.save();
  this._docTransform(ctx, z, dpr, this.panX, this.panY);
  var ok = PS.addSelectionPath(ctx, shape, 0, 0);
  if (ok) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width / (z * dpr);
    ctx.setLineDash([5 / (z * dpr), 4 / (z * dpr)]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
};

PSView.prototype.screenToDoc = function (x, y) {
  return { x: (x - this.panX) / this.zoom, y: (y - this.panY) / this.zoom };
};
