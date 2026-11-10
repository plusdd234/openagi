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
      brush: { size: 44, hardness: 70, opacity: 92 },
      tolerance: 24,
      gradient: 'fg2transparent',
      colors: { fg: '#e8a13a', bg: '#ffffff' }
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
        brush: 'none', eraser: 'none', gradient: 'crosshair', fill: 'crosshair', text: 'text'
      };
      view.canvas.style.cursor = map[st.tool] || 'default';
    }

    function setTool(id) {
      st.tool = id;
      st.drag = null;
      view.previewShape = null;
      view.previewRect = null;
      view.previewLine = null;
      view.clearCursor();
      updateCursor();
      if (hooks.status) hooks.status('');
      view.schedule();
    }

    function setOption(key, value) {
      if (key === 'size') st.brush.size = Math.max(1, value);
      else if (key === 'hardness') st.brush.hardness = Math.max(0, Math.min(100, value));
      else if (key === 'opacity') st.brush.opacity = Math.max(1, Math.min(100, value));
      else if (key === 'tolerance') st.tolerance = Math.max(0, Math.min(255, value));
      else if (key === 'gradient') st.gradient = value;
    }

    function options() {
      return {
        tool: st.tool,
        size: st.brush.size,
        hardness: st.brush.hardness,
        opacity: st.brush.opacity,
        tolerance: st.tolerance,
        gradient: st.gradient
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
      var spacing = Math.max(1.2, d.r * 0.17);
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
      PS.setSelectionShape(activeDoc(), shape, false);
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
        ctx.globalAlpha = st.brush.opacity / 100;
        var g = ctx.createLinearGradient(x0, y0, x1, y1);
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
      var res = PS.floodFillLayer(layer, x, y, color, st.tolerance);
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

    /* ---------------- 手势 ---------------- */
    function down(p) {
      var doc = activeDoc();
      if (!doc) return;
      var layer = activeLayer();

      if (st.tool === 'move') {
        if (!layer || layer.type !== 'pixel') {
          if (hooks.status) hooks.status('调整层不能移动，请选中像素图层', true);
          return;
        }
        st.drag = {
          kind: 'move', doc: doc, layer: layer,
          sx: p.docX, sy: p.docY, ox: layer.x, oy: layer.y
        };
        view.canvas.style.cursor = 'grabbing';
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
        var c = PS.samplePixel(doc, p.docX, p.docY);
        if (hooks.onColor) hooks.onColor(c.hex);
        if (hooks.status) hooks.status('取样 ' + c.hex.toUpperCase());
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

    function move(p) {
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
      if (d.kind === 'select') {
        if (st.tool === 'select-lasso') d.points.push({ x: p.docX, y: p.docY });
        d.shape = selectionShape(p, d.start, d.points);
        view.previewShape = d.shape;
        return;
      }
      if (d.kind === 'crop') {
        view.previewRect = normalizeRect(d.start.x, d.start.y, p.docX, p.docY);
        return;
      }
      if (d.kind === 'brush') {
        stampLine(d.lastX, d.lastY, p.docX, p.docY);
        d.lastX = p.docX;
        d.lastY = p.docY;
        view.setCursor(p.docX, p.docY, d.r);
        return;
      }
      if (d.kind === 'gradient') {
        view.previewLine = { x0: d.x0, y0: d.y0, x1: p.docX, y1: p.docY };
      }
    }

    function up(p) {
      var d = st.drag;
      if (!d) return;
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
        var rect = normalizeRect(d.start.x, d.start.y, p.docX, p.docY);
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
      st.drag = null;
      view.previewShape = null;
      view.previewRect = null;
      view.previewLine = null;
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
