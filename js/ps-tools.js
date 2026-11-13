/* 图像工坊 · 工具层
 *
 * 负责指针手势 → 文档像素。所有改动都走 PS 的事务（beginTx / snapTile / endTx），
 * 因此笔刷、填充、渐变、文字都能被撤销。
 *
 * 选区不是「画的时候裁掉」：笔刷和滤镜都先把结果画上去，收笔时再按选区遮罩
 * 与改动前混合。这样反选（形状外）也能正确工作，而 canvas 的单一路径 clip
 * 表达不了反选。
 */
const PSTools = (function () {
  'use strict';

  function rgba(hex, a) {
    var c = PS.hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  function normalizeRect(x0, y0, x1, y1) {
    var x = Math.min(x0, x1);
    var y = Math.min(y0, y1);
    return { x: x, y: y, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  function create(view, hooks) {
    var st = {
      tool: 'move',
      drag: null,
      brush: { size: 44, hardness: 70, opacity: 92, spacing: 18 },
      tolerance: 24,
      gradient: 'fg2transparent',
      grad: { kind: 'linear', opacity: 100 },
      select: { feather: 0 },
      fill: { tolerance: 32, contiguous: true, opacity: 100 },
      eye: { size: 1, merged: true },
      crop: { ratio: 'free' },
      move: { autoSelect: false },
      colors: { fg: '#e8a13a', bg: '#ffffff' },
      wand: { contiguous: true, sampleMerged: false },
      vector: { kind: 'rect', fillOn: true, fill: '#e8a13a', strokeOn: true, stroke: '#0f1115', width: 2 },
      penEdit: null
    };

    function activeDoc() { return hooks.doc(); }
    function activeLayer() { return hooks.layer(); }
    function colors() {
      if (hooks.colors) {
        var c = hooks.colors();
        if (c) st.colors = c;
      }
      return st.colors;
    }

    function updateCursor() {
      var map = {
        move: 'grab', 'select-rect': 'crosshair', 'select-ellipse': 'crosshair',
        'select-lasso': 'crosshair', crop: 'crosshair', eyedropper: 'crosshair',
        brush: 'none', eraser: 'none', gradient: 'crosshair', fill: 'crosshair', text: 'text',
        'magic-wand': 'crosshair', pen: 'crosshair', shape: 'crosshair', 'path-select': 'default'
      };
      view.canvas.style.cursor = map[st.tool] || 'default';
    }

    function setTool(id) {
      if (st.penEdit) {
        if (st.penEdit.pts.length >= 2) finishPen(true);
        else cancelPen();
      }
      st.tool = id;
      st.drag = null;
      view.previewShape = null;
      view.previewRect = null;
      view.previewLine = null;
      view.clearCursor();
      updateCursor();
      // 用快捷键切到画笔 / 橡皮擦时指针可能已经在画布里，立即补画刷环，
      // 否则 CSS 光标是 none、环又没有，看起来就是「光标消失」。
      if ((id === 'brush' || id === 'eraser') && view.pointerInside && view.cursorDoc) {
        view.setCursor(view.cursorDoc.docX, view.cursorDoc.docY, st.brush.size / 2);
      }
      if (hooks.status) hooks.status('');
      view.schedule();
    }

    function setOption(key, value) {
      if (key === 'size') st.brush.size = Math.max(1, value);
      else if (key === 'hardness') st.brush.hardness = Math.max(0, Math.min(100, value));
      else if (key === 'opacity') st.brush.opacity = Math.max(1, Math.min(100, value));
      else if (key === 'spacing') st.brush.spacing = Math.max(1, Math.min(200, value));
      else if (key === 'tolerance') st.tolerance = Math.max(0, Math.min(255, value));
      else if (key === 'feather') st.select.feather = Math.max(0, Math.min(200, value));
      else if (key === 'gradient') st.gradient = value;
      else if (key === 'gradKind') st.grad.kind = value === 'radial' ? 'radial' : 'linear';
      else if (key === 'gradOpacity') st.grad.opacity = Math.max(1, Math.min(100, value));
      else if (key === 'fillTolerance') st.fill.tolerance = Math.max(0, Math.min(255, value));
      else if (key === 'fillContiguous') st.fill.contiguous = !!value;
      else if (key === 'fillOpacity') st.fill.opacity = Math.max(1, Math.min(100, value));
      else if (key === 'eyeSize') st.eye.size = Math.max(1, Math.min(9, Number(value) || 1));
      else if (key === 'eyeMerged') st.eye.merged = !!value;
      else if (key === 'cropRatio') st.crop.ratio = value;
      else if (key === 'autoSelect') st.move.autoSelect = !!value;
      else if (key === 'wandContiguous') st.wand.contiguous = !!value;
      else if (key === 'wandMerged') st.wand.sampleMerged = !!value;
      else if (key === 'vectorKind') st.vector.kind = value;
      else if (key === 'fillOn') st.vector.fillOn = !!value;
      else if (key === 'fillColor') st.vector.fill = value;
      else if (key === 'strokeOn') st.vector.strokeOn = !!value;
      else if (key === 'strokeColor') st.vector.stroke = value;
      else if (key === 'strokeWidth') st.vector.width = Math.max(0, Math.min(80, Number(value) || 0));
    }

    function options() {
      return {
        tool: st.tool,
        size: st.brush.size,
        hardness: st.brush.hardness,
        opacity: st.brush.opacity,
        spacing: st.brush.spacing,
        tolerance: st.tolerance,
        feather: st.select.feather,
        gradient: st.gradient,
        gradKind: st.grad.kind,
        gradOpacity: st.grad.opacity,
        fillTolerance: st.fill.tolerance,
        fillContiguous: st.fill.contiguous,
        fillOpacity: st.fill.opacity,
        eyeSize: st.eye.size,
        eyeMerged: st.eye.merged,
        cropRatio: st.crop.ratio,
        autoSelect: st.move.autoSelect,
        wandContiguous: st.wand.contiguous,
        wandMerged: st.wand.sampleMerged,
        vectorKind: st.vector.kind,
        fillOn: st.vector.fillOn,
        fillColor: st.vector.fill,
        strokeOn: st.vector.strokeOn,
        strokeColor: st.vector.stroke,
        strokeWidth: st.vector.width,
        penActive: !!st.penEdit
      };
    }

    /* ---------------- 笔刷 ---------------- */
    function stampTile(doc, layer, t, docX, docY, drag) {
      var lx = docX - layer.x - t.x;
      var ly = docY - layer.y - t.y;
      var r = drag.r;
      if (lx + r < 0 || ly + r < 0 || lx - r > t.w || ly - r > t.h) return;
      var ctx = t.ctx;
      ctx.save();
      PS.clipToSelection(ctx, doc, layer, t);
      var hard = drag.hardness;
      var op = drag.opacity;
      var g = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(1, r));
      if (drag.erase) {
        g.addColorStop(0, 'rgba(0,0,0,' + op + ')');
        g.addColorStop(Math.max(0.02, hard), 'rgba(0,0,0,' + op + ')');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalCompositeOperation = 'destination-out';
      } else {
        g.addColorStop(0, rgba(drag.color, op));
        g.addColorStop(Math.max(0.02, hard), rgba(drag.color, op));
        g.addColorStop(1, rgba(drag.color, 0));
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(lx, ly, Math.max(1, r), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function stampAt(x, y) {
      var d = st.drag;
      if (!d || d.kind !== 'brush') return;
      var r = d.r;
      var cols = PS.tileCols(d.layer);
      var rows = PS.tileRows(d.layer);
      var tx0 = Math.max(0, Math.floor((x - d.layer.x - r) / PS.TILE));
      var ty0 = Math.max(0, Math.floor((y - d.layer.y - r) / PS.TILE));
      var tx1 = Math.min(cols - 1, Math.floor((x - d.layer.x + r) / PS.TILE));
      var ty1 = Math.min(rows - 1, Math.floor((y - d.layer.y + r) / PS.TILE));
      for (var ty = ty0; ty <= ty1; ty++) {
        for (var tx = tx0; tx <= tx1; tx++) {
          var t = PS.ensureTile(d.layer, tx, ty, false);
          if (!t) continue;
          PS.snapTile(d.tx, d.layer, t);
          stampTile(d.doc, d.layer, t, x, y, d);
        }
      }
    }

    function stampLine(x0, y0, x1, y1) {
      var d = st.drag;
      if (!d || d.kind !== 'brush') return;
      // 间距按笔刷直径的百分比算，和 PS 的 Spacing 语义一致
      var spacing = Math.max(0.8, d.r * 2 * st.brush.spacing / 100);
      var dx = x1 - x0;
      var dy = y1 - y0;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var steps = Math.max(1, Math.ceil(dist / spacing));
      for (var i = 0; i <= steps; i++) {
        stampAt(x0 + dx * i / steps, y0 + dy * i / steps);
      }
    }

    function beginStroke(p) {
      var doc = activeDoc();
      var layer = activeLayer();
      if (!layer || layer.type !== 'pixel') {
        if (hooks.status) hooks.status('请先选中一个像素图层', true);
        return;
      }
      var c = colors();
      var isErase = st.tool === 'eraser';
      st.drag = {
        kind: 'brush',
        doc: doc,
        layer: layer,
        tx: PS.beginTx(doc, isErase ? '橡皮擦' : '画笔'),
        erase: isErase,
        color: isErase ? '#000000' : c.fg,
        r: Math.max(1, st.brush.size / 2),
        hardness: st.brush.hardness / 100,
        opacity: isErase ? 1 : st.brush.opacity / 100,
        lastX: p.docX,
        lastY: p.docY
      };
      stampAt(p.docX, p.docY);
      if (hooks.status) hooks.status((isErase ? '橡皮擦' : '画笔') + ' · ' + Math.round(st.brush.size) + 'px');
      view.schedule();
    }

    function endStroke() {
      var d = st.drag;
      if (!d || d.kind !== 'brush') return;
      st.drag = null;
      var doc = d.doc;
      var layer = d.layer;
      if (doc.selection.active) {
        d.tx.tiles.forEach(function (rec) {
          var mask = PS.maskForTile(doc, layer, rec.tile);
          if (mask) PS.applyMaskBlendTile(rec.tile, rec.before, mask);
        });
      }
      PS.touch(layer);
      PS.endTx(d.tx);
      doc.version++;
      PS.requestMips(doc);
      if (hooks.change) hooks.change('brush');
    }

    /* ---------------- 选区 ---------------- */
    function selectionShape(p, start, points) {
      var x0 = Math.min(start.x, p.docX);
      var y0 = Math.min(start.y, p.docY);
      var x1 = Math.max(start.x, p.docX);
      var y1 = Math.max(start.y, p.docY);
      var type = st.tool === 'select-ellipse' ? 'ellipse' : 'rect';
      if (st.tool === 'select-lasso') {
        return { type: 'lasso', points: points.slice() };
      }
      return { type: type, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
    }

    function selectionMessage(shape) {
      var b = PS.boundsOfShape(shape);
      if (!b) return '选区已取消';
      return '选区 ' + Math.round(b.w) + ' × ' + Math.round(b.h) + ' px';
    }

    function commitSelection() {
      var d = st.drag;
      if (!d || d.kind !== 'select') return;
      var shape = st.drag.shape;
      st.drag = null;
      view.previewShape = null;
      if (!shape) return;
      var b = PS.boundsOfShape(shape);
      if (!b || b.w < 1 || b.h < 1) {
        PS.clearSelection(activeDoc());
        if (hooks.change) hooks.change('selection');
        return;
      }
      PS.setSelectionShape(activeDoc(), shape, false, { feather: st.select.feather });
      if (hooks.status) hooks.status(selectionMessage(shape));
      if (hooks.change) hooks.change('selection');
    }

    /* ---------------- 渐变 ---------------- */
    function applyGradient(doc, layer, x0, y0, x1, y1) {
      if (!layer || layer.type !== 'pixel') {
        if (hooks.status) hooks.status('请先选中一个像素图层', true);
        return false;
      }
      var big = layer.width * layer.height > 16e6;
      var tiles = big ? PS.existingTiles(layer) : PS.ensureAllTiles(layer);
      if (!tiles.length) return false;
      var tx = PS.beginTx(doc, '渐变');
      tiles.forEach(function (t) { if (t) PS.snapTile(tx, layer, t); });
      var c = colors();
      tiles.forEach(function (t) {
        if (!t) return;
        var ctx = t.ctx;
        ctx.save();
        PS.clipToSelection(ctx, doc, layer, t);
        ctx.globalAlpha = st.grad.opacity / 100;
        var g;
        if (st.grad.kind === 'radial') {
          var rad = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
          g = ctx.createRadialGradient(x0, y0, 0, x0, y0, rad);
        } else {
          g = ctx.createLinearGradient(x0, y0, x1, y1);
        }
        if (st.gradient === 'fg2bg') {
          g.addColorStop(0, rgba(c.fg, 1));
          g.addColorStop(1, rgba(c.bg, 1));
        } else {
          g.addColorStop(0, rgba(c.fg, 1));
          g.addColorStop(1, rgba(c.fg, 0));
        }
        ctx.fillStyle = g;
        ctx.fillRect(layer.x + t.x, layer.y + t.y, t.w, t.h);
        ctx.restore();
      });
      if (doc.selection.active) {
        tx.tiles.forEach(function (rec) {
          var mask = PS.maskForTile(doc, layer, rec.tile);
          if (mask) PS.applyMaskBlendTile(rec.tile, rec.before, mask);
        });
      }
      PS.touch(layer);
      PS.endTx(tx);
      doc.version++;
      PS.requestMips(doc);
      if (hooks.change) hooks.change('gradient');
      if (hooks.status) hooks.status('渐变已应用');
      return true;
    }

    /* ---------------- 填充 ---------------- */
    function fillAt(doc, layer, x, y, color) {
      if (!layer || layer.type !== 'pixel') {
        if (hooks.status) hooks.status('请先选中一个像素图层', true);
        return { ok: false };
      }
      var tiles = PS.ensureAllTiles(layer);
      var tx = PS.beginTx(doc, '油漆桶');
      tiles.forEach(function (t) { if (t) PS.snapTile(tx, layer, t); });
      var res = PS.floodFillLayer(layer, x, y, color, st.fill.tolerance, {
        contiguous: st.fill.contiguous,
        opacity: st.fill.opacity / 100
      });
      if (!res.ok) {
        if (hooks.status) hooks.status(res.reason || '填充失败', true);
        return res;
      }
      if (doc.selection.active) {
        tx.tiles.forEach(function (rec) {
          var mask = PS.maskForTile(doc, layer, rec.tile);
          if (mask) PS.applyMaskBlendTile(rec.tile, rec.before, mask);
        });
      }
      PS.touch(layer);
      PS.endTx(tx);
      doc.version++;
      PS.requestMips(doc);
      if (hooks.change) hooks.change('fill');
      if (hooks.status) hooks.status('填充 ' + (res.count || 0) + ' 像素');
      return res;
    }

    /* ---------------- 文字 ---------------- */
    function drawText(doc, layer, o) {
      o = o || {};
      var text = String(o.text == null ? '' : o.text);
      if (!text.trim()) return false;
      if (!layer || layer.type !== 'pixel') {
        if (hooks.status) hooks.status('请先选中一个像素图层', true);
        return false;
      }
      var size = Math.max(6, Math.round(o.size || 96));
      var weight = o.weight || 700;
      var color = o.color || colors().fg;
      var font = weight + ' ' + size + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
      var probe = PS.makeCanvas(1, 1);
      probe.ctx.font = font;
      var metrics = probe.ctx.measureText(text);
      var pad = Math.max(6, Math.round(size * 0.25));
      var tw = Math.max(1, Math.ceil(metrics.width) + pad * 2);
      var th = Math.max(1, Math.ceil(size * 1.4) + pad * 2);
      var tmp = PS.makeCanvas(tw, th);
      tmp.ctx.font = font;
      tmp.ctx.fillStyle = color;
      tmp.ctx.textBaseline = 'top';
      tmp.ctx.fillText(text, pad, pad);
      var x = Math.round(o.x || 0) - pad;
      var y = Math.round(o.y || 0) - pad;
      var tx = PS.beginTx(doc, '文字');
      var cols = PS.tileCols(layer);
      var rows = PS.tileRows(layer);
      var localX = x - layer.x;
      var localY = y - layer.y;
      var tx0 = Math.max(0, Math.floor(localX / PS.TILE));
      var ty0 = Math.max(0, Math.floor(localY / PS.TILE));
      var tx1 = Math.min(cols - 1, Math.floor((localX + tw - 1) / PS.TILE));
      var ty1 = Math.min(rows - 1, Math.floor((localY + th - 1) / PS.TILE));
      for (var ty = ty0; ty <= ty1; ty++) {
        for (var txx = tx0; txx <= tx1; txx++) {
          var t = PS.ensureTile(layer, txx, ty, true);
          if (!t) continue;
          var rec = PS.snapTile(tx, layer, t);
          t.ctx.drawImage(tmp.canvas, localX - t.x, localY - t.y);
          if (doc.selection.active && rec) {
            var mask = PS.maskForTile(doc, layer, t);
            if (mask) PS.applyMaskBlendTile(t, rec.before, mask);
          }
        }
      }
      PS.touch(layer);
      PS.endTx(tx);
      doc.version++;
      PS.requestMips(doc);
      if (hooks.change) hooks.change('text');
      if (hooks.status) hooks.status('文字已写入图层');
      return true;
    }

    /* ---------------- 魔棒 ---------------- */
    function wandAt(doc, layer, p) {
      if (!layer) {
        if (hooks.status) hooks.status('请先选中一个图层', true);
        return { ok: false };
      }
      var res = PS.magicWand(doc, layer, p.docX, p.docY, {
        tolerance: st.tolerance,
        contiguous: st.wand.contiguous,
        sampleMerged: st.wand.sampleMerged
      });
      if (!res.ok) {
        if (hooks.status) hooks.status(res.reason || '未能建立选区', true);
        return res;
      }
      PS.setSelectionShape(doc, res.shape, false, { feather: st.select.feather });
      if (hooks.change) hooks.change('selection');
      if (hooks.status) {
        hooks.status('魔棒选区 · ' + res.count + ' px' +
          (res.shape.polygons.length > 1 ? ' · ' + res.shape.polygons.length + ' 个轮廓' : ''));
      }
      return res;
    }

    /* ---------------- 钢笔 ---------------- */
    function syncPenPreview() {
      var d = st.penEdit;
      if (!d) { view.previewPath = null; return; }
      view.previewPath = { pts: d.pts, closed: !!d.closed, cursor: d.cursor };
      view.schedule();
    }

    function penState() {
      var doc = activeDoc();
      if (!st.penEdit || st.penEdit.doc !== doc) {
        st.penEdit = { doc: doc, pts: [], closed: false, dragging: -1, cursor: null };
      }
      return st.penEdit;
    }

    function penDown(p) {
      var d = penState();
      var first = d.pts[0];
      var tol = 9 / Math.max(0.15, view.zoom);
      if (first && Math.hypot(p.docX - first.x, p.docY - first.y) <= tol) {
        d.closed = true;
        finishPen(true);
        return;
      }
      d.pts.push({ x: p.docX, y: p.docY, hix: null, hiy: null, hox: null, hoy: null });
      d.dragging = d.pts.length - 1;
      d.cursor = { x: p.docX, y: p.docY };
      syncPenPreview();
    }

    function penDrag(p) {
      var d = st.penEdit;
      if (!d) return;
      if (d.dragging >= 0) {
        var a = d.pts[d.dragging];
        var dx = p.docX - a.x;
        var dy = p.docY - a.y;
        if (Math.hypot(dx, dy) > 1.5) {
          a.hox = p.docX;
          a.hoy = p.docY;
          a.hix = a.x - dx;
          a.hiy = a.y - dy;
        }
      }
      d.cursor = { x: p.docX, y: p.docY };
      syncPenPreview();
    }

    function penHover(p) {
      var d = st.penEdit;
      if (!d) return;
      d.cursor = { x: p.docX, y: p.docY };
      syncPenPreview();
    }

    function penUp() {
      var d = st.penEdit;
      if (d) d.dragging = -1;
    }

    function finishPen(close) {
      var d = st.penEdit;
      st.penEdit = null;
      view.previewPath = null;
      if (!d) return false;
      var doc = d.doc || activeDoc();
      if (d.pts.length < 2) {
        if (hooks.status) hooks.status('路径至少需要两个锚点', true);
        view.schedule();
        return false;
      }
      var v = st.vector;
      var shape = {
        kind: 'path',
        pts: d.pts.map(function (a) {
          return { x: a.x, y: a.y, hix: a.hix, hiy: a.hiy, hox: a.hox, hoy: a.hoy };
        }),
        closed: !!close,
        fill: v.fillOn ? v.fill : null,
        stroke: v.strokeOn && v.width > 0 ? v.stroke : null,
        strokeWidth: v.strokeOn ? v.width : 0
      };
      PS.addShapeLayer(doc, [shape], { name: '矢量路径', label: '钢笔路径' });
      PS.requestMips(doc);
      if (hooks.change) hooks.change('shape');
      if (hooks.status) hooks.status('矢量路径已创建 · ' + d.pts.length + ' 个锚点');
      view.schedule();
      return true;
    }

    function cancelPen() {
      st.penEdit = null;
      view.previewPath = null;
      view.schedule();
      if (hooks.status) hooks.status('已取消当前路径');
    }

    /* ---------------- 形状 ---------------- */
    function shapeName(kind) {
      return kind === 'ellipse' ? '椭圆' : kind === 'line' ? '直线' : '矩形';
    }

    function buildShape(start, p, shift) {
      var v = st.vector;
      var x0 = start.x, y0 = start.y;
      var x1 = p.docX, y1 = p.docY;
      if (shift && v.kind !== 'line') {
        var dx = x1 - x0, dy = y1 - y0;
        var m = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = x0 + (dx < 0 ? -m : m);
        y1 = y0 + (dy < 0 ? -m : m);
      }
      if (v.kind === 'line') {
        return {
          kind: 'line', x1: x0, y1: y0, x2: x1, y2: y1,
          fill: null,
          stroke: v.strokeOn ? v.stroke : (v.fillOn ? v.fill : null),
          strokeWidth: v.strokeOn ? v.width : Math.max(2, v.width)
        };
      }
      var r = normalizeRect(x0, y0, x1, y1);
      return {
        kind: v.kind, x: r.x, y: r.y, w: r.w, h: r.h,
        fill: v.fillOn ? v.fill : null,
        stroke: v.strokeOn && v.width > 0 ? v.stroke : null,
        strokeWidth: v.strokeOn ? v.width : 0
      };
    }

    function shapeDown(p) {
      st.drag = { kind: 'vector', doc: activeDoc(), start: { x: p.docX, y: p.docY } };
      view.previewVector = { shape: buildShape(st.drag.start, p, false) };
    }

    function shapeMove(p, shift) {
      var d = st.drag;
      if (!d || d.kind !== 'vector') return;
      view.previewVector = { shape: buildShape(d.start, p, shift) };
      view.schedule();
    }

    function shapeUp(p, shift) {
      var d = st.drag;
      if (!d || d.kind !== 'vector') return;
      var shape = buildShape(d.start, p, shift);
      st.drag = null;
      view.previewVector = null;
      var b = PS.shapeBounds(shape);
      var tiny = shape.kind === 'line'
        ? Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < 3
        : (!b || b.w < 2 || b.h < 2);
      if (tiny) {
        if (hooks.status) hooks.status('形状太小，已忽略', true);
        view.schedule();
        return;
      }
      var name = shapeName(shape.kind);
      PS.addShapeLayer(d.doc, [shape], { name: name, label: '新建' + name });
      PS.requestMips(d.doc);
      if (hooks.change) hooks.change('shape');
      if (hooks.status) hooks.status('已创建矢量' + name);
      view.schedule();
    }

    /* ---------------- 路径选择 ---------------- */
    function pathDown(p) {
      var doc = activeDoc();
      var hit = PS.hitShapeLayer(doc, p.docX, p.docY, 8 / Math.max(0.2, view.zoom));
      if (!hit) {
        if (hooks.status) hooks.status('没有命中矢量路径');
        return;
      }
      doc.activeId = hit.layer.id;
      PS.touchDoc(doc);
      if (hooks.change) hooks.change('layer');
      if (hit.anchor >= 0) {
        var a = hit.shape.pts[hit.anchor];
        st.drag = {
          kind: 'anchor', doc: doc, layer: hit.layer, shape: hit.shape,
          index: hit.anchor, sx: p.docX, sy: p.docY,
          ox: a.x, oy: a.y,
          before: PS.cloneShape(hit.shape), moved: false
        };
        if (hooks.status) hooks.status('拖动锚点 · 第 ' + (hit.anchor + 1) + ' 个');
      } else {
        st.drag = {
          kind: 'shape-move', doc: doc, layer: hit.layer,
          sx: p.docX, sy: p.docY, ox: hit.layer.x, oy: hit.layer.y, moved: false
        };
        if (hooks.status) hooks.status('拖动矢量图层');
      }
      view.schedule();
    }

    function pathMove(p) {
      var d = st.drag;
      if (!d) return;
      if (d.kind === 'anchor') {
        var dx = p.docX - d.sx;
        var dy = p.docY - d.sy;
        var a = d.shape.pts[d.index];
        var prevX = a.x, prevY = a.y;
        a.x = d.ox + dx;
        a.y = d.oy + dy;
        var mdx = a.x - prevX, mdy = a.y - prevY;
        if (a.hix != null) { a.hix += mdx; a.hiy += mdy; }
        if (a.hox != null) { a.hox += mdx; a.hoy += mdy; }
        d.moved = true;
        d.layer.version++;
        d.doc.version++;
        view.schedule();
      } else if (d.kind === 'shape-move') {
        d.layer.x = Math.round(d.ox + (p.docX - d.sx));
        d.layer.y = Math.round(d.oy + (p.docY - d.sy));
        d.moved = true;
        d.layer.version++;
        d.doc.version++;
        view.schedule();
      }
    }

    function pathUp() {
      var d = st.drag;
      if (!d) return;
      st.drag = null;
      if (!d.moved) return;
      if (d.kind === 'anchor') {
        var after = PS.cloneShape(d.shape);
        var before = d.before;
        PS.pushEntry(d.doc, {
          label: '编辑锚点',
          touched: [d.layer],
          undo: function () { d.shape.pts = PS.cloneShape(before).pts; d.layer.version++; d.doc.version++; },
          redo: function () { d.shape.pts = PS.cloneShape(after).pts; d.layer.version++; d.doc.version++; }
        });
        PS.touch(d.layer);
        if (hooks.change) hooks.change('shape');
        if (hooks.status) hooks.status('锚点已移动');
      } else if (d.kind === 'shape-move') {
        var dx = d.layer.x - d.ox;
        var dy = d.layer.y - d.oy;
        var layer = d.layer;
        PS.pushEntry(d.doc, {
          label: '移动矢量图层',
          touched: [layer],
          undo: function () { layer.x = d.ox; layer.y = d.oy; layer.version++; d.doc.version++; },
          redo: function () { layer.x = d.ox + dx; layer.y = d.oy + dy; layer.version++; d.doc.version++; }
        });
        PS.touch(layer);
        if (hooks.change) hooks.change('shape');
        if (hooks.status) hooks.status('矢量图层已移动');
      }
    }

    /* ---------------- 手势 ---------------- */
    function cropRatioValue(name) {
      if (name === '1:1') return 1;
      if (name === '4:3') return 4 / 3;
      if (name === '16:9') return 16 / 9;
      return 0;
    }

    /* 裁剪矩形：锁定比例时从起点角向外推，Shift 临时改成 1:1。 */
    function cropRect(p, start, shift) {
      var dx = p.docX - start.x;
      var dy = p.docY - start.y;
      var w = Math.abs(dx);
      var h = Math.abs(dy);
      var ratio = cropRatioValue(st.crop.ratio) || (shift ? 1 : 0);
      if (ratio > 0) {
        if (w / Math.max(1e-6, h) > ratio) h = w / ratio;
        else w = h * ratio;
      }
      return { x: dx < 0 ? start.x - w : start.x, y: dy < 0 ? start.y - h : start.y, w: w, h: h };
    }

    function down(p, e) {
      var doc = activeDoc();
      if (!doc) return;
      var layer = activeLayer();

      if (st.tool === 'move') {
        var target = layer;
        // 「自动选择」：按下时先选中最上层的不透明图层，再开始拖
        if (st.move.autoSelect) {
          var hit = PS.topLayerAt(doc, p.docX, p.docY);
          if (hit && hit !== layer) {
            doc.activeId = hit.id;
            target = hit;
            if (hooks.change) hooks.change('layer');
          }
        }
        if (!target || target.type === 'adjust') {
          if (hooks.status) hooks.status('调整层不能移动，请选中像素或矢量图层', true);
          return;
        }
        st.drag = {
          kind: 'move', doc: doc, layer: target,
          sx: p.docX, sy: p.docY, ox: target.x, oy: target.y
        };
        view.canvas.style.cursor = 'grabbing';
        return;
      }

      if (st.tool === 'magic-wand') {
        wandAt(doc, layer, p);
        return;
      }

      if (st.tool === 'pen') {
        penDown(p);
        return;
      }

      if (st.tool === 'shape') {
        shapeDown(p);
        return;
      }

      if (st.tool === 'path-select') {
        pathDown(p);
        return;
      }

      if (st.tool === 'select-rect' || st.tool === 'select-ellipse' || st.tool === 'select-lasso') {
        st.drag = {
          kind: 'select', doc: doc, start: { x: p.docX, y: p.docY },
          points: [{ x: p.docX, y: p.docY }], shape: null
        };
        view.previewShape = null;
        return;
      }

      if (st.tool === 'crop') {
        st.drag = { kind: 'crop', doc: doc, start: { x: p.docX, y: p.docY } };
        view.previewRect = null;
        return;
      }

      if (st.tool === 'eyedropper') {
        var c = PS.samplePixel(doc, p.docX, p.docY, {
          size: st.eye.size,
          layer: st.eye.merged ? null : layer
        });
        if (hooks.onColor) hooks.onColor(c.hex);
        if (hooks.status) hooks.status('取样 ' + c.hex.toUpperCase() +
          ' · ' + st.eye.size + '×' + st.eye.size + (st.eye.merged ? ' · 合并图层' : ' · 当前图层'));
        return;
      }

      if (st.tool === 'brush' || st.tool === 'eraser') {
        beginStroke(p);
        return;
      }

      if (st.tool === 'gradient') {
        st.drag = { kind: 'gradient', doc: doc, x0: p.docX, y0: p.docY };
        view.previewLine = { x0: p.docX, y0: p.docY, x1: p.docX, y1: p.docY };
        return;
      }

      if (st.tool === 'fill') {
        fillAt(doc, layer, p.docX, p.docY, colors().fg);
        return;
      }

      if (st.tool === 'text') {
        if (hooks.onText) hooks.onText({ x: p.docX, y: p.docY });
        return;
      }
    }

    function move(p, e) {
      var shift = !!(e && e.shiftKey);
      if (st.tool === 'pen') { penDrag(p); return; }
      var d = st.drag;
      if (!d) {
        if (st.tool === 'brush' || st.tool === 'eraser') {
          view.setCursor(p.docX, p.docY, st.brush.size / 2);
        }
        return;
      }
      if (d.kind === 'move') {
        d.layer.x = Math.round(d.ox + (p.docX - d.sx));
        d.layer.y = Math.round(d.oy + (p.docY - d.sy));
        d.layer.version++;
        d.doc.version++;
        return;
      }
      if (d.kind === 'vector') {
        shapeMove(p, shift);
        return;
      }
      if (d.kind === 'anchor' || d.kind === 'shape-move') {
        pathMove(p);
        return;
      }
      if (d.kind === 'select') {
        if (st.tool === 'select-lasso') d.points.push({ x: p.docX, y: p.docY });
        d.shape = selectionShape(p, d.start, d.points);
        view.previewShape = d.shape;
        return;
      }
      if (d.kind === 'crop') {
        view.previewRect = cropRect(p, d.start, shift);
        return;
      }
      if (d.kind === 'brush') {
        stampLine(d.lastX, d.lastY, p.docX, p.docY);
        d.lastX = p.docX;
        d.lastY = p.docY;
        // 每段笔迹立即失效图层缓存并请求重绘，避免松手后才看到整条轨迹
        PS.touch(d.layer);
        d.doc.version++;
        view.schedule();
        view.setCursor(p.docX, p.docY, d.r);
        return;
      }
      if (d.kind === 'gradient') {
        view.previewLine = { x0: d.x0, y0: d.y0, x1: p.docX, y1: p.docY };
      }
    }

    function up(p, e) {
      if (st.tool === 'pen') { penUp(); return; }
      var d = st.drag;
      if (!d) return;
      if (d.kind === 'vector') {
        shapeUp(p, !!(e && e.shiftKey));
        return;
      }
      if (d.kind === 'anchor' || d.kind === 'shape-move') {
        pathUp();
        return;
      }
      if (d.kind === 'move') {
        st.drag = null;
        var dx = d.layer.x - d.ox;
        var dy = d.layer.y - d.oy;
        view.canvas.style.cursor = 'grab';
        if (!dx && !dy) return;
        var layer = d.layer;
        PS.pushEntry(d.doc, {
          label: '移动图层',
          touched: [layer],
          undo: function () { layer.x = d.ox; layer.y = d.oy; layer.version++; d.doc.version++; },
          redo: function () { layer.x = d.ox + dx; layer.y = d.oy + dy; layer.version++; d.doc.version++; }
        });
        PS.touch(layer);
        if (hooks.change) hooks.change('move');
        return;
      }
      if (d.kind === 'select') {
        d.shape = selectionShape(p || { docX: d.start.x, docY: d.start.y }, d.start, d.points);
        commitSelection();
        return;
      }
      if (d.kind === 'crop') {
        var rect = cropRect(p || { docX: d.start.x, docY: d.start.y }, d.start, !!(e && e.shiftKey));
        st.drag = null;
        view.previewRect = null;
        if (rect.w < 4 || rect.h < 4) {
          if (hooks.status) hooks.status('裁剪区域太小', true);
          return;
        }
        if (PS.cropDoc(d.doc, rect)) {
          view.fit();
          if (hooks.change) hooks.change('crop');
          if (hooks.status) hooks.status('裁剪为 ' + d.doc.width + ' × ' + d.doc.height);
        }
        return;
      }
      if (d.kind === 'brush') {
        st.drag = d;
        endStroke();
        return;
      }
      if (d.kind === 'gradient') {
        st.drag = null;
        view.previewLine = null;
        applyGradient(d.doc, activeLayer(), d.x0, d.y0, p.docX, p.docY);
      }
    }

    function cancel() {
      var d = st.drag;
      if (d && d.kind === 'move') {
        d.layer.x = d.ox;
        d.layer.y = d.oy;
        d.layer.version++;
        d.doc.version++;
      }
      if (d && d.kind === 'anchor' && d.before) {
        d.shape.pts = PS.cloneShape(d.before).pts;
        d.layer.version++;
        d.doc.version++;
      }
      if (d && d.kind === 'shape-move') {
        d.layer.x = d.ox;
        d.layer.y = d.oy;
        d.layer.version++;
        d.doc.version++;
      }
      if (st.penEdit) cancelPen();
      st.drag = null;
      view.previewShape = null;
      view.previewRect = null;
      view.previewLine = null;
      view.previewVector = null;
      view.previewPath = null;
      view.schedule();
    }

    view.toolHandlers = { down: down, move: move, up: up };
    updateCursor();

    return {
      setTool: setTool,
      tool: function () { return st.tool; },
      setOption: setOption,
      options: options,
      drawText: drawText,
      fillAt: fillAt,
      applyGradient: applyGradient,
      finishPen: finishPen,
      cancelPen: cancelPen,
      penActive: function () { return !!st.penEdit; },
      paintDot: function (doc, layer, x, y) {
        if (!layer || layer.type !== 'pixel') return false;
        var tx = PS.beginTx(doc, '画笔');
        var fake = { kind: 'brush', doc: doc, layer: layer, tx: tx, erase: false,
          color: colors().fg, r: st.brush.size / 2, hardness: st.brush.hardness / 100,
          opacity: st.brush.opacity / 100 };
        var prev = st.drag;
        st.drag = fake;
        stampAt(x, y);
        st.drag = prev;
        if (doc.selection.active) {
          tx.tiles.forEach(function (rec) {
            var mask = PS.maskForTile(doc, layer, rec.tile);
            if (mask) PS.applyMaskBlendTile(rec.tile, rec.before, mask);
          });
        }
        PS.touch(layer);
        PS.endTx(tx);
        doc.version++;
        PS.requestMips(doc);
        if (hooks.change) hooks.change('brush');
        return true;
      },
      cancel: cancel
    };
  }

  return { create: create };
})();
