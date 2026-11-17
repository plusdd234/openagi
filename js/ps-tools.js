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
      move: { autoSelect: false, snap: true },
      colors: { fg: '#e8a13a', bg: '#ffffff' },
      wand: { contiguous: true, sampleMerged: false },
      vector: { kind: 'rect', fillOn: true, fill: '#e8a13a', strokeOn: true, stroke: '#0f1115', width: 2, op: 'add', append: false },
      penEdit: null,
      pathSel: null
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

    /* 当前是否在图层蒙版上编辑（由 app 决定，工具层不持有 UI 状态） */
    function maskTarget(layer) {
      if (!layer || !layer.mask) return null;
      if (!hooks.mask) return null;
      return hooks.mask(layer) ? layer.mask : null;
    }

    function paintBlocked(layer) {
      if (!layer) return '请先选中图层';
      if (PS.hasLock(layer, 'image')) return '「' + layer.name + '」锁定了图像像素，不能绘画';
      return '';
    }

    function lumaOf(hex) {
      var c = PS.hexToRgb(hex);
      return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    }

    /* ---------------- 移动对齐（智能参考线） ---------------- */

    /* 对齐目标：文档边缘 / 中心，以及其他可见图层内容的左中右、上中下 */
    function collectSnapTargets(doc, layer) {
      var xs = [0, doc.width / 2, doc.width];
      var ys = [0, doc.height / 2, doc.height];
      doc.layers.forEach(function (l) {
        if (l === layer || l.visible === false) return;
        var b = PS.layerContentBounds(l);
        if (!b) return;
        xs.push(b.x, b.x + b.w / 2, b.x + b.w);
        ys.push(b.y, b.y + b.h / 2, b.y + b.h);
      });
      return { xs: xs, ys: ys };
    }

    /* 把图层包围盒的左/中/右（上/中/下）吸到最近的目标线。
     * 阈值按屏幕像素换算成文档像素，缩放时手感一致。 */
    function snapMove(d, x, y) {
      var rel = d.rel;
      if (!rel || !d.targets) return { x: x, y: y, guides: null };
      var tol = Math.max(1, 6 / Math.max(0.05, view.zoom));
      var ex = [rel.x, rel.x + rel.w / 2, rel.x + rel.w];
      var ey = [rel.y, rel.y + rel.h / 2, rel.y + rel.h];
      var bestX = tol + 1;
      var bestY = tol + 1;
      var gx = 0;
      var gy = 0;
      var i, j, delta;
      for (i = 0; i < ex.length; i++) {
        for (j = 0; j < d.targets.xs.length; j++) {
          delta = d.targets.xs[j] - (x + ex[i]);
          if (Math.abs(delta) < Math.abs(bestX)) { bestX = delta; gx = d.targets.xs[j]; }
        }
      }
      for (i = 0; i < ey.length; i++) {
        for (j = 0; j < d.targets.ys.length; j++) {
          delta = d.targets.ys[j] - (y + ey[i]);
          if (Math.abs(delta) < Math.abs(bestY)) { bestY = delta; gy = d.targets.ys[j]; }
        }
      }
      var hitX = Math.abs(bestX) <= tol;
      var hitY = Math.abs(bestY) <= tol;
      var guides = [];
      if (hitX) guides.push({ axis: 'v', pos: gx });
      if (hitY) guides.push({ axis: 'h', pos: gy });
      return {
        x: x + (hitX ? bestX : 0),
        y: y + (hitY ? bestY : 0),
        guides: guides.length ? guides : null
      };
    }

    function updateCursor() {
      var map = {
        move: 'grab', 'select-rect': 'crosshair', 'select-ellipse': 'crosshair',
        'select-lasso': 'crosshair', crop: 'crosshair', eyedropper: 'crosshair',
        brush: 'none', eraser: 'none', gradient: 'crosshair', fill: 'crosshair', text: 'text',
        'magic-wand': 'crosshair', pen: 'crosshair', shape: 'crosshair', 'path-select': 'default',
        hand: 'grab', zoom: 'zoom-in'
      };
      view.canvas.style.cursor = map[st.tool] || 'default';
    }

    function setTool(id) {
      if (st.penEdit) {
        // 切走时按开放路径落盘，闭合只由「点回起点」触发，避免误闭合
        if (st.penEdit.pts.length >= 2) finishPen(false);
        else cancelPen();
      }
      st.tool = id;
      st.drag = null;
      st.pathSel = null;
      view.previewShape = null;
      view.previewRect = null;
      view.previewLine = null;
      view.previewShapeSel = null;
      view.guides = null;
      // 路径选择工具在悬停时借用 previewPath 画锚点，切走时必须收回
      view.previewPath = null;
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
      else if (key === 'moveSnap') st.move.snap = !!value;
      else if (key === 'wandContiguous') st.wand.contiguous = !!value;
      else if (key === 'wandMerged') st.wand.sampleMerged = !!value;
      else if (key === 'vectorKind') st.vector.kind = value;
      else if (key === 'fillOn') st.vector.fillOn = !!value;
      else if (key === 'fillColor') st.vector.fill = value;
      else if (key === 'strokeOn') st.vector.strokeOn = !!value;
      else if (key === 'strokeColor') st.vector.stroke = value;
      else if (key === 'strokeWidth') st.vector.width = Math.max(0, Math.min(80, Number(value) || 0));
      else if (key === 'vectorOp') setShapeOp(value);
      else if (key === 'vectorAppend') st.vector.append = !!value;
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
        moveSnap: st.move.snap,
        wandContiguous: st.wand.contiguous,
        wandMerged: st.wand.sampleMerged,
        vectorKind: st.vector.kind,
        fillOn: st.vector.fillOn,
        fillColor: st.vector.fill,
        strokeOn: st.vector.strokeOn,
        strokeColor: st.vector.stroke,
        strokeWidth: st.vector.width,
        vectorOp: st.vector.op,
        vectorAppend: st.vector.append,
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

    /* 蒙版瓦片：alpha 表示隐藏量。深色画笔增加隐藏，浅色 / 橡皮减少隐藏。 */
    function stampMaskTile(doc, layer, mask, t, docX, docY, drag) {
      var lx = docX - layer.x - t.x;
      var ly = docY - layer.y - t.y;
      var r = drag.r;
      if (lx + r < 0 || ly + r < 0 || lx - r > t.w || ly - r > t.h) return;
      var ctx = t.ctx;
      ctx.save();
      PS.clipToSelection(ctx, doc, layer, t);
      var hard = drag.hardness;
      var strength = Math.max(0.001, Math.min(1, drag.opacity * drag.strength));
      var g = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(1, r));
      g.addColorStop(0, 'rgba(0,0,0,' + strength + ')');
      g.addColorStop(Math.max(0.02, hard), 'rgba(0,0,0,' + strength + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = drag.reveal ? 'destination-out' : 'source-over';
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
          if (d.mask) {
            var mt = PS.ensureMaskTile(d.mask, tx, ty, true);
            if (!mt) continue;
            PS.snapTile(d.tx, d.layer, mt, true);
            stampMaskTile(d.doc, d.layer, d.mask, mt, x, y, d);
            continue;
          }
          var t = PS.ensureTile(d.layer, tx, ty, !d.erase);
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
      var mask = maskTarget(layer);
      var isErase = st.tool === 'eraser';
      if (!mask && (!layer || layer.type !== 'pixel')) {
        if (hooks.status) hooks.status('请先选中一个像素图层', true);
        return;
      }
      if (layer) {
        var blocked = paintBlocked(layer);
        if (blocked) {
          if (hooks.status) hooks.status(blocked, true);
          return;
        }
      }
      var c = colors();
      if (mask) {
        /* 蒙版只存灰度：深色 = 隐藏，浅色 = 恢复；橡皮擦永远恢复 */
        var luma = lumaOf(c.fg);
        st.drag = {
          kind: 'brush',
          doc: doc,
          layer: layer,
          mask: mask,
          tx: PS.beginTx(doc, isErase ? '蒙版擦除' : '蒙版绘制'),
          erase: isErase,
          reveal: isErase || luma >= 0.5,
          strength: isErase ? 1 : Math.abs(luma >= 0.5 ? luma : 1 - luma),
          color: '#000000',
          r: Math.max(1, st.brush.size / 2),
          hardness: st.brush.hardness / 100,
          opacity: isErase ? 1 : st.brush.opacity / 100,
          lastX: p.docX,
          lastY: p.docY
        };
        stampAt(p.docX, p.docY);
        if (hooks.status) hooks.status('蒙版 · ' + (isErase ? '擦除（恢复显示）' : (luma >= 0.5 ? '恢复显示' : '隐藏')) + ' · ' + Math.round(st.brush.size) + 'px');
        view.schedule();
        return;
      }
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
      if (d.mask) {
        // 蒙版不改变图层像素，保留 mip，只刷新蒙版版本
        layer.version++;
        d.mask.version++;
      } else {
        if (PS.alphaLocked(layer)) PS.restoreTileAlpha(d.tx);
        PS.touch(layer);
        PS.requestMips(doc);
      }
      PS.endTx(d.tx);
      doc.version++;
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
      var gradBlocked = paintBlocked(layer);
      if (gradBlocked) {
        if (hooks.status) hooks.status(gradBlocked, true);
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
      if (PS.alphaLocked(layer)) PS.restoreTileAlpha(tx);
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
      var fillBlocked = paintBlocked(layer);
      if (fillBlocked) {
        if (hooks.status) hooks.status(fillBlocked, true);
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
      if (PS.alphaLocked(layer)) PS.restoreTileAlpha(tx);
      PS.touch(layer);
      PS.endTx(tx);
      doc.version++;
      PS.requestMips(doc);
      if (hooks.change) hooks.change('fill');
      if (hooks.status) hooks.status('填充 ' + (res.count || 0) + ' 像素');
      return res;
    }

    /* 用纯色填充选区（没有选区则整层）——对应 PS 的 Alt+Backspace / Ctrl+Backspace。 */
    function fillRegion(doc, layer, color) {
      if (!layer || layer.type !== 'pixel') {
        if (hooks.status) hooks.status('请先选中一个像素图层', true);
        return false;
      }
      var blocked = paintBlocked(layer);
      if (blocked) {
        if (hooks.status) hooks.status(blocked, true);
        return false;
      }
      var big = layer.width * layer.height > 16e6;
      var tiles = big ? PS.existingTiles(layer) : PS.ensureAllTiles(layer);
      if (!tiles.length) return false;
      var tx = PS.beginTx(doc, '填充');
      tiles.forEach(function (t) { if (t) PS.snapTile(tx, layer, t); });
      tiles.forEach(function (t) {
        if (!t) return;
        var ctx = t.ctx;
        ctx.save();
        PS.clipToSelection(ctx, doc, layer, t);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, t.w, t.h);
        ctx.restore();
      });
      if (doc.selection.active) {
        tx.tiles.forEach(function (rec) {
          var mask = PS.maskForTile(doc, layer, rec.tile);
          if (mask) PS.applyMaskBlendTile(rec.tile, rec.before, mask);
        });
      }
      if (PS.alphaLocked(layer)) PS.restoreTileAlpha(tx);
      PS.touch(layer);
      PS.endTx(tx);
      doc.version++;
      PS.requestMips(doc);
      if (hooks.change) hooks.change('fill');
      if (hooks.status) hooks.status('已填充 ' + color.toUpperCase());
      return true;
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
      var textBlocked = paintBlocked(layer);
      if (textBlocked) {
        if (hooks.status) hooks.status(textBlocked, true);
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
      if (PS.alphaLocked(layer)) PS.restoreTileAlpha(tx);
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
    /* 把 b 点吸附到过 a 点的 45° 射线方向，长度保持不变。 */
    function constrain45(ax, ay, bx, by) {
      var dx = bx - ax;
      var dy = by - ay;
      var len = Math.hypot(dx, dy);
      if (len < 1e-6) return { x: bx, y: by };
      var step = Math.PI / 4;
      var ang = Math.round(Math.atan2(dy, dx) / step) * step;
      return { x: ax + Math.cos(ang) * len, y: ay + Math.sin(ang) * len };
    }

    function penTol() { return 9 / Math.max(0.15, view.zoom); }

    function updateCloseHint(d, p) {
      var first = d.pts[0];
      d.closeHint = !!(first && d.pts.length >= 2 &&
        Math.hypot(p.docX - first.x, p.docY - first.y) <= penTol());
    }

    function syncPenPreview() {
      var d = st.penEdit;
      if (!d) { view.previewPath = null; return; }
      view.previewPath = {
        pts: d.pts, closed: !!d.closed, cursor: d.cursor,
        closeHint: !!d.closeHint
      };
      view.schedule();
    }

    function penState() {
      var doc = activeDoc();
      if (!st.penEdit || st.penEdit.doc !== doc) {
        st.penEdit = { doc: doc, pts: [], closed: false, dragging: -1, cursor: null, closeHint: false };
      }
      return st.penEdit;
    }

    function penDown(p, e) {
      var d = penState();
      var first = d.pts[0];
      // 先按原始指针判断是否点回起点：Shift 约束不能把闭合操作挤掉
      if (first && d.pts.length >= 2 && Math.hypot(p.docX - first.x, p.docY - first.y) <= penTol()) {
        d.closed = true;
        finishPen(true);
        return;
      }
      var x = p.docX, y = p.docY;
      var last = d.pts[d.pts.length - 1];
      // Shift 把新锚点约束到上一点的 45° 射线上
      if (last && e && e.shiftKey) {
        var c = constrain45(last.x, last.y, x, y);
        x = c.x; y = c.y;
      }
      d.pts.push({ x: x, y: y, hix: null, hiy: null, hox: null, hoy: null });
      d.dragging = d.pts.length - 1;
      d.cursor = { x: x, y: y };
      d.closeHint = false;
      syncPenPreview();
    }

    function penDrag(p, e) {
      var d = st.penEdit;
      if (!d) return;
      var shift = !!(e && e.shiftKey);
      var alt = !!(e && e.altKey);
      if (d.dragging >= 0) {
        var a = d.pts[d.dragging];
        var hx = p.docX, hy = p.docY;
        if (shift) {
          var c = constrain45(a.x, a.y, hx, hy);
          hx = c.x; hy = c.y;
        }
        var dx = hx - a.x, dy = hy - a.y;
        if (Math.hypot(dx, dy) > 1.5) {
          a.hox = hx;
          a.hoy = hy;
          if (alt) {
            // Alt 拖动：只保留外侧控制柄，形成尖角
            a.hix = null;
            a.hiy = null;
          } else {
            a.hix = a.x - dx;
            a.hiy = a.y - dy;
          }
        } else if (alt) {
          // Alt 原地点击：把刚落的锚点改成尖角
          a.hix = null;
          a.hiy = null;
        }
      }
      d.cursor = { x: p.docX, y: p.docY };
      updateCloseHint(d, p);
      syncPenPreview();
    }

    function penHover(p) {
      var d = st.penEdit;
      if (!d) return;
      d.cursor = { x: p.docX, y: p.docY };
      updateCloseHint(d, p);
      syncPenPreview();
    }

    function penUp() {
      var d = st.penEdit;
      if (d) d.dragging = -1;
    }

    /* 退回上一个锚点，用于绘制中按 Backspace / Delete。 */
    function removeLastAnchor() {
      var d = st.penEdit;
      if (!d || !d.pts.length) return false;
      d.pts.pop();
      d.dragging = -1;
      d.closeHint = false;
      if (!d.pts.length) {
        st.penEdit = null;
        view.previewPath = null;
        view.schedule();
        if (hooks.status) hooks.status('已撤回全部锚点，路径结束');
        return true;
      }
      syncPenPreview();
      if (hooks.status) hooks.status('已撤回上一个锚点 · 剩余 ' + d.pts.length + ' 个');
      return true;
    }

    /* 双击结束开放路径：第二下会多落一个重合锚点，这里先去掉。 */
    function penDouble() {
      var d = st.penEdit;
      if (!d || !d.pts.length) return false;
      if (d.pts.length >= 2) {
        var last = d.pts[d.pts.length - 1];
        var prev = d.pts[d.pts.length - 2];
        if (Math.hypot(last.x - prev.x, last.y - prev.y) <= penTol()) d.pts.pop();
      }
      return finishPen(false);
    }

    /* 决定新形状落到哪里：矢量编辑器里默认追加到当前形状层，
     * 这样布尔运算能直接作用于同一层的多条路径；否则新建图层。 */
    function placeShape(doc, shape, name, opts) {
      opts = opts || {};
      var layer = activeLayer();
      var append = st.vector.append && layer && layer.type === 'shape'
        && !PS.hasLock(layer, 'image');
      if (append) {
        shape.op = st.vector.op || 'add';
        PS.appendShape(doc, layer, shape, { label: opts.addLabel || ('添加' + name) });
        return layer;
      }
      shape.op = 'add';
      return PS.addShapeLayer(doc, [shape], {
        name: opts.layerName || name,
        label: opts.newLabel || ('新建' + name)
      });
    }

    /* 设置布尔运算：有选中路径就应用到它，否则作为下一个形状的默认值。 */
    function setShapeOp(op) {
      if (!PS.SHAPE_OPS[op]) return false;
      st.vector.op = op;
      var doc = activeDoc();
      var sel = st.pathSel;
      var applied = false;
      if (doc && sel && sel.layer && sel.shape) {
        applied = PS.setShapeOp(doc, sel.layer, sel.shape, op);
        if (applied && hooks.change) hooks.change('shape');
      }
      view.schedule();
      if (hooks.status) {
        hooks.status('布尔运算：' + PS.SHAPE_OP_NAMES[op] +
          (applied ? ' · 已应用到选中路径' : ' · 用于下一个形状'));
      }
      return true;
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
      // 少于三个点闭合没有面积，按开放路径处理
      if (close && d.pts.length < 3) close = false;
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
      PS.requestMips(doc);
      placeShape(doc, shape, '矢量路径', {
        layerName: '矢量路径', newLabel: '钢笔路径', addLabel: '添加钢笔路径'
      });
      if (hooks.change) hooks.change('shape');
      if (hooks.status) hooks.status('矢量路径已创建 · ' + d.pts.length + ' 个锚点' + (close ? ' · 已闭合' : ' · 开放路径') + (st.vector.append ? ' · 已合成到当前形状层' : ''));
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
      placeShape(d.doc, shape, name, { layerName: name, newLabel: '新建' + name, addLabel: '添加' + name });
      PS.requestMips(d.doc);
      if (hooks.change) hooks.change('shape');
      if (hooks.status) hooks.status('已创建矢量' + name + (st.vector.append ? ' · 已合成到当前形状层' : ''));
      view.schedule();
    }

    /* ---------------- 路径选择 ---------------- */
    /* 原地恢复点集：保持 pts 数组引用不变，悬停/编辑的锚点 overlay 才不会画旧数据。 */
    function restorePts(shape, src) {
      var pts = PS.cloneShape(src).pts;
      shape.pts.length = 0;
      for (var i = 0; i < pts.length; i++) shape.pts.push(pts[i]);
    }

    /* 借用 previewPath 显示锚点与控制柄；shape.pts 是实时引用，拖动时自动跟随。 */
    function setPathOverlay(shape, layer) {
      if (!shape || !shape.pts) {
        view.previewPath = null;
        view.canvas.style.cursor = 'default';
      } else {
        view.previewPath = {
          pts: shape.pts, closed: !!shape.closed, cursor: null,
          edit: true, start: false, layer: layer || null
        };
        view.canvas.style.cursor = 'move';
      }
      view.schedule();
    }

    function pathDown(p) {
      var doc = activeDoc();
      var hit = PS.hitShapeLayer(doc, p.docX, p.docY, 8 / Math.max(0.2, view.zoom));
      if (!hit) {
        st.pathSel = null;
        view.previewShapeSel = null;
        setPathOverlay(null);
        if (hooks.status) hooks.status('没有命中矢量路径');
        return;
      }
      doc.activeId = hit.layer.id;
      PS.touchDoc(doc);
      if (hooks.change) hooks.change('layer');
      setPathOverlay(hit.shape, hit.layer);
      if (hit.anchor >= 0 && hit.handle) {
        // 控制柄：Alt 只改单侧，否则另一侧同步镜像
        st.pathSel = { doc: doc, layer: hit.layer, shape: hit.shape, shapeIndex: hit.shapeIndex, index: hit.anchor, handle: hit.handle };
        st.drag = {
          kind: 'handle', doc: doc, layer: hit.layer, shape: hit.shape,
          index: hit.anchor, which: hit.handle,
          before: PS.cloneShape(hit.shape), moved: false
        };
        if (hooks.status) hooks.status('拖动' + (hit.handle === 'in' ? '内侧' : '外侧') + '控制柄 · Alt 单独调整');
      } else if (hit.anchor >= 0) {
        var a = hit.shape.pts[hit.anchor];
        st.pathSel = { doc: doc, layer: hit.layer, shape: hit.shape, shapeIndex: hit.shapeIndex, index: hit.anchor, handle: null };
        st.drag = {
          kind: 'anchor', doc: doc, layer: hit.layer, shape: hit.shape,
          index: hit.anchor, sx: p.docX, sy: p.docY,
          ox: a.x, oy: a.y,
          before: PS.cloneShape(hit.shape), moved: false
        };
        if (hooks.status) hooks.status('拖动锚点 · 第 ' + (hit.anchor + 1) + ' 个 · Shift 约束 45° · Delete 删除');
      } else {
        if (PS.hasLock(hit.layer, 'position')) {
          if (hooks.status) hooks.status('「' + hit.layer.name + '」锁定了位置，不能移动', true);
          return;
        }
        st.pathSel = null;
        st.drag = {
          kind: 'shape-move', doc: doc, layer: hit.layer,
          sx: p.docX, sy: p.docY, ox: hit.layer.x, oy: hit.layer.y, moved: false
        };
        if (hooks.status) hooks.status('拖动矢量图层');
      }
      view.schedule();
    }

    /* 悬停时显示路径锚点，否则用户只能靠猜锚点在哪。 */
    function pathHover(p) {
      var doc = activeDoc();
      if (!doc) return;
      var hit = PS.hitShapeLayer(doc, p.docX, p.docY, 8 / Math.max(0.2, view.zoom));
      // 只有自由路径才有锚点可显示；矩形/椭圆等基础形状不画 overlay
      var shape = hit && hit.shape && hit.shape.kind === 'path' ? hit.shape : null;
      if (!shape) {
        if (!view.previewPath) return;
        view.previewPath = null;
        view.canvas.style.cursor = 'default';
        view.schedule();
        return;
      }
      if (view.previewPath && view.previewPath.edit && view.previewPath.pts === shape.pts &&
        view.previewPath.layer === hit.layer) return;
      view.previewPath = {
        pts: shape.pts, closed: !!shape.closed, cursor: null,
        edit: true, start: false, layer: hit.layer
      };
      view.canvas.style.cursor = hit.anchor >= 0 ? 'move' : 'default';
      view.schedule();
    }

    function pathMove(p, shift, alt) {
      var d = st.drag;
      if (!d) return;
      if (d.kind === 'anchor') {
        var dx = p.docX - d.sx;
        var dy = p.docY - d.sy;
        if (shift) {
          var c = constrain45(0, 0, dx, dy);
          dx = c.x;
          dy = c.y;
        }
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
      } else if (d.kind === 'handle') {
        var shape = d.shape;
        var hp = shape.pts[d.index];
        // 锚点和控制柄都在图层本地坐标里，指针要先减掉图层偏移
        var hx = p.docX - d.layer.x, hy = p.docY - d.layer.y;
        if (shift) {
          var hc = constrain45(hp.x, hp.y, hx, hy);
          hx = hc.x;
          hy = hc.y;
        }
        if (d.which === 'in') {
          hp.hix = hx; hp.hiy = hy;
          if (!alt && hp.hox != null) {
            hp.hox = hp.x * 2 - hx;
            hp.hoy = hp.y * 2 - hy;
          }
        } else {
          hp.hox = hx; hp.hoy = hy;
          if (!alt && hp.hix != null) {
            hp.hix = hp.x * 2 - hx;
            hp.hiy = hp.y * 2 - hy;
          }
        }
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

    /* 删除路径选择中的锚点，保留至少两个点。 */
    function deletePathAnchor() {
      var sel = st.pathSel;
      if (st.tool !== 'path-select' || !sel || !sel.shape || sel.index == null) return false;
      var pts = sel.shape.pts || [];
      if (pts.length <= 2) {
        if (hooks.status) hooks.status('路径至少保留两个锚点', true);
        return false;
      }
      var before = PS.cloneShape(sel.shape);
      sel.shape.pts.splice(sel.index, 1);
      var after = PS.cloneShape(sel.shape);
      sel.layer.version++;
      sel.doc.version++;
      PS.pushEntry(sel.doc, {
        label: '删除锚点',
        touched: [sel.layer],
        undo: function () { restorePts(sel.shape, before); sel.layer.version++; sel.doc.version++; },
        redo: function () { restorePts(sel.shape, after); sel.layer.version++; sel.doc.version++; }
      });
      PS.touch(sel.layer);
      st.pathSel = null;
      setPathOverlay(sel.shape, sel.layer);
      if (hooks.change) hooks.change('shape');
      if (hooks.status) hooks.status('已删除锚点 · 剩余 ' + sel.shape.pts.length + ' 个');
      return true;
    }

    /* 路径面板点击：选中矢量图层里的某个形状，画布同步高亮。
     * 只做选择，不切换当前工具，避免用户点面板时被强行换掉画笔。 */
    function selectShape(layer, index) {
      var doc = activeDoc();
      if (!doc || !layer || layer.type !== 'shape' || !layer.shapes) return false;
      var shape = layer.shapes[index];
      if (!shape) return false;
      doc.activeId = layer.id;
      st.pathSel = { doc: doc, layer: layer, shape: shape, shapeIndex: index, index: null, handle: null };
      if (shape.kind === 'path' && shape.pts && shape.pts.length) {
        view.previewShapeSel = null;
        view.previewPath = {
          pts: shape.pts, closed: !!shape.closed, cursor: null,
          edit: true, start: false, layer: layer
        };
      } else {
        view.previewPath = null;
        view.previewShapeSel = { layer: layer, shape: shape };
      }
      view.schedule();
      if (hooks.change) hooks.change('shape');
      return true;
    }

    function pathUp() {
      var d = st.drag;
      if (!d) return;
      st.drag = null;
      if (!d.moved) return;
      if (d.kind === 'anchor' || d.kind === 'handle') {
        var after = PS.cloneShape(d.shape);
        var before = d.before;
        PS.pushEntry(d.doc, {
          label: d.kind === 'handle' ? '编辑控制柄' : '编辑锚点',
          touched: [d.layer],
          undo: function () { restorePts(d.shape, before); d.layer.version++; d.doc.version++; },
          redo: function () { restorePts(d.shape, after); d.layer.version++; d.doc.version++; }
        });
        PS.touch(d.layer);
        if (hooks.change) hooks.change('shape');
        if (hooks.status) hooks.status(d.kind === 'handle' ? '控制柄已调整' : '锚点已移动');
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

      if (st.tool === 'hand') {
        view._startPan(e);
        return;
      }

      if (st.tool === 'zoom') {
        var factor = e && e.altKey ? 1 / 1.35 : 1.35;
        view.zoomAt(p.x, p.y, factor);
        if (hooks.status) hooks.status('缩放 ' + Math.round(view.zoom * 100) + '%');
        return;
      }

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
        if (PS.hasLock(target, 'position')) {
          if (hooks.status) hooks.status('「' + target.name + '」锁定了位置，不能移动（图层属性里可解锁）', true);
          return;
        }
        st.drag = {
          kind: 'move', doc: doc, layer: target,
          sx: p.docX, sy: p.docY, ox: target.x, oy: target.y,
          rel: null, targets: null
        };
        var tb = PS.layerContentBounds(target);
        if (tb) {
          st.drag.rel = {
            x: tb.x - target.x, y: tb.y - target.y, w: tb.w, h: tb.h
          };
        }
        if (st.move.snap) st.drag.targets = collectSnapTargets(doc, target);
        view.guides = null;
        view.canvas.style.cursor = 'grabbing';
        return;
      }

      if (st.tool === 'magic-wand') {
        wandAt(doc, layer, p);
        return;
      }

      if (st.tool === 'pen') {
        penDown(p, e);
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
        // PS 习惯：画笔状态下按住 Alt 临时变成吸管
        if (e && e.altKey && st.tool === 'brush') {
          var pick = PS.samplePixel(doc, p.docX, p.docY, {
            size: st.eye.size, layer: st.eye.merged ? null : layer
          });
          if (hooks.onColor) hooks.onColor(pick.hex);
          if (hooks.status) hooks.status('吸管取样 ' + pick.hex.toUpperCase());
          return;
        }
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
      var alt = !!(e && e.altKey);
      if (st.tool === 'pen') { penDrag(p, e); return; }
      var d = st.drag;
      if (!d) {
        if (st.tool === 'path-select') pathHover(p);
        if (st.tool === 'brush' || st.tool === 'eraser') {
          view.setCursor(p.docX, p.docY, st.brush.size / 2);
        }
        return;
      }
      if (d.kind === 'move') {
        var nx = Math.round(d.ox + (p.docX - d.sx));
        var ny = Math.round(d.oy + (p.docY - d.sy));
        // Shift 约束到水平 / 垂直方向
        if (shift) {
          if (Math.abs(nx - d.ox) >= Math.abs(ny - d.oy)) ny = d.oy;
          else nx = d.ox;
        }
        // Ctrl / Cmd 临时关闭吸附，和 PS 的「临时禁用对齐」一致
        var noSnap = !!(e && (e.ctrlKey || e.metaKey));
        if (!noSnap && st.move.snap && d.targets) {
          var snapped = snapMove(d, nx, ny);
          nx = snapped.x;
          ny = snapped.y;
          view.guides = snapped.guides;
        } else {
          view.guides = null;
        }
        d.layer.x = nx;
        d.layer.y = ny;
        d.layer.version++;
        d.doc.version++;
        return;
      }
      if (d.kind === 'vector') {
        shapeMove(p, shift);
        return;
      }
      if (d.kind === 'anchor' || d.kind === 'handle' || d.kind === 'shape-move') {
        pathMove(p, shift, alt);
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
      if (d.kind === 'anchor' || d.kind === 'handle' || d.kind === 'shape-move') {
        pathUp();
        return;
      }
      if (d.kind === 'move') {
        st.drag = null;
        view.guides = null;
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
        // 内容没变，只更新缓存版本，下一次拖动不必重扫像素
        if (d.rel) layer._boundsCache = { version: layer.version, rel: d.rel };
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
      if (d && (d.kind === 'anchor' || d.kind === 'handle') && d.before) {
        restorePts(d.shape, d.before);
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
      st.pathSel = null;
      view.previewShape = null;
      view.previewRect = null;
      view.previewLine = null;
      view.previewVector = null;
      view.previewPath = null;
      view.previewShapeSel = null;
      view.guides = null;
      if (st.tool === 'path-select') view.canvas.style.cursor = 'default';
      view.schedule();
    }

    /* 钢笔绘制中右键 = 结束开放路径（与 Photoshop 一致）。 */
    function contextDown() {
      if (st.tool === 'pen' && st.penEdit) finishPen(false);
    }

    /* 钢笔双击 = 结束开放路径；第二下产生的重合锚点由 penDouble 去掉。 */
    function dblclick() {
      if (st.tool === 'pen' && st.penEdit) penDouble();
    }

    view.toolHandlers = { down: down, move: move, up: up, context: contextDown, dblclick: dblclick };
    updateCursor();

    return {
      setTool: setTool,
      tool: function () { return st.tool; },
      setOption: setOption,
      options: options,
      drawText: drawText,
      fillAt: fillAt,
      fillRegion: fillRegion,
      setShapeOp: setShapeOp,
      applyGradient: applyGradient,
      finishPen: finishPen,
      cancelPen: cancelPen,
      removeLastAnchor: removeLastAnchor,
      deletePathAnchor: deletePathAnchor,
      selectShape: selectShape,
      penActive: function () { return !!st.penEdit; },
      penPoints: function () {
        return st.penEdit ? st.penEdit.pts.map(function (a) {
          return { x: a.x, y: a.y, hix: a.hix, hiy: a.hiy, hox: a.hox, hoy: a.hoy };
        }) : [];
      },
      pathSelection: function () {
        var sel = st.pathSel;
        return sel && sel.shape ? {
          layerId: sel.layer ? sel.layer.id : null,
          shapeIndex: typeof sel.shapeIndex === 'number' ? sel.shapeIndex : null,
          index: sel.index, handle: sel.handle || null,
          pts: sel.shape.pts ? sel.shape.pts.length : 0
        } : null;
      },
      paintDot: function (doc, layer, x, y) {
        if (!layer || layer.type !== 'pixel') return false;
        var blocked = paintBlocked(layer);
        if (blocked) return false;
        var mask = maskTarget(layer);
        var tx = PS.beginTx(doc, mask ? '蒙版绘制' : '画笔');
        var fake = { kind: 'brush', doc: doc, layer: layer, tx: tx, erase: false,
          color: colors().fg, r: st.brush.size / 2, hardness: st.brush.hardness / 100,
          opacity: st.brush.opacity / 100 };
        if (mask) {
          fake.mask = mask;
          fake.reveal = false;
          fake.strength = 1;
        }
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
        if (mask) {
          layer.version++;
          mask.version++;
        } else {
          if (PS.alphaLocked(layer)) PS.restoreTileAlpha(tx);
          PS.touch(layer);
          PS.requestMips(doc);
        }
        PS.endTx(tx);
        doc.version++;
        if (hooks.change) hooks.change('brush');
        return true;
      },
      cancel: cancel
    };
  }

  return { create: create };
})();
