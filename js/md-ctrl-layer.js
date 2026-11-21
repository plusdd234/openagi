/* 视口里的捏脸控制器（照抄流明「三维直接操控」交互）
 *
 * 是什么
 *   选中头模时，脸上出现一排**圆点手柄**（当前分组的参数，每个点 = 一个脸型参数）。
 *   直接拖：位移投影到「该参数 +1 时锚点在屏幕上的移动方向」上，顺着力的方向拖才放大，
 *   垂直方向的余量做 30% 橡皮跟随（手感像拽皮肤，但写进参数的只有沿力方向那一段）。
 *   悬停 / 拖动时模型表面亮起该参数的线圈（shader 覆层，App 侧写 uniform）。
 *
 * 为什么是 DOM 覆盖层而不是 three 物体
 *   流明就是 DOM（.l3-gizmos 层 + projectAnchor 投影）：手柄是 UI，不该进 3D 场景 ——
 *   进场景就要处理遮挡、深度、像素尺寸换算，还会被着色模式 / 四视图搅局。
 *   DOM 只有投影一个数学点要做，被脸挡住就隐藏（facing 判定），其余交给 CSS。
 *
 * 事件权界
 *   手柄 pointer-events:auto，其余层透明。手柄上 pointerdown preventDefault +
 *   stopPropagation，视口的轨道 / 拾取收不到；没点到手柄时这层完全不存在感。
 *
 * 对外
 *   new MDCtrlLayer({ hostEl, projectAt, gainOf, onStart, onDrag, onEnd, onReset, onHover, onNeedRender })
 *   setItems([{ id, key, label, at, value }])   at 是网格局部坐标；value 0–100
 *   setGroup(name|null)        只作显示过滤（items 仍全量给）
 *   update()                   每帧：重新投影 + 拖动中的橡皮偏移
 *   setValue(id, v) / value(id) / list() / isDragging()
 *   setVisible(on) / clear() / dispose()
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function MDCtrlLayer(opts) {
    opts = opts || {};
    this.hostEl = opts.hostEl || null;
    this.projectAt = opts.projectAt || function () { return null; };
    this.gainOf = opts.gainOf || function () { return [0, 0]; };
    this.onStart = opts.onStart || function () {};
    this.onDrag = opts.onDrag || function () {};
    this.onEnd = opts.onEnd || function () {};
    this.onReset = opts.onReset || function () {};
    this.onHover = opts.onHover || function () {};
    this.onNeedRender = opts.onNeedRender || function () {};

    this.root = null;
    this.items = [];
    this.visible = true;
    this.group = null;        /* null = 全部 */
    this.drag = null;
    this._hover = null;
    this._sig = '';
  }

  MDCtrlLayer.prototype._ensureRoot = function () {
    if (this.root || !this.hostEl) return this.root;
    this.root = el('div', 'md-ctrl3d is-off');
    this.pull = el('i', 'md3-pull');
    this.pull.style.display = 'none';
    this.root.appendChild(this.pull);
    this.hostEl.appendChild(this.root);
    return this.root;
  };

  MDCtrlLayer.prototype.setGroup = function (name) {
    this.group = name || null;
    this.update();
  };

  /* 手柄按签名增删：换分组 / 换组件时整批重建，值变化只写数据不重建 DOM。 */
  MDCtrlLayer.prototype.setItems = function (list) {
    var want = list || [];
    var sig = want.map(function (w) { return w.id + ':' + w.key + ':' + w.label; }).join('|');
    if (sig === this._sig) { this._syncValues(want); return; }
    this._sig = sig;
    var root = this._ensureRoot();
    root.querySelectorAll('.md3-gizmo').forEach(function (n) { n.remove(); });
    this.items = want.map(function (w) {
      var b = el('button', 'md3-gizmo');
      b.type = 'button';
      b.setAttribute('data-key', w.key);
      b.setAttribute('aria-label', '在脸上拖动调整' + w.label);
      b.title = w.label + ' · 拖动即可修改 · 双击恢复';
      var dot = el('span', 'md3-dot');
      var tag = el('span', 'md3-tag', w.label);
      b.appendChild(dot);
      b.appendChild(tag);
      root.appendChild(b);
      var it = {
        id: w.id, key: w.key, label: w.label, at: w.at, group: w.group || null,
        value: Math.max(0, Math.min(100, Number(w.value) || 0)),
        el: b, pos: null, visible: false
      };
      this._wire(it);
      return it;
    }, this);
    this._syncValues(want);
    this.update();
  };

  MDCtrlLayer.prototype._syncValues = function (want) {
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      for (var j = 0; j < want.length; j++) {
        if (want[j].id !== it.id) continue;
        it.value = Math.max(0, Math.min(100, Number(want[j].value) || 0));
      }
    }
  };

  MDCtrlLayer.prototype._wire = function (it) {
    var self = this;
    it.el.addEventListener('pointerenter', function () {
      if (!self.drag) { self._hover = it; self.onHover(it); self.onNeedRender(); }
    });
    it.el.addEventListener('pointerleave', function () {
      if (!self.drag && self._hover === it) { self._hover = null; self.onHover(null); self.onNeedRender(); }
    });
    it.el.addEventListener('pointerdown', function (e) { self._down(e, it); });
    it.el.addEventListener('dblclick', function (e) {
      e.preventDefault();
      e.stopPropagation();
      self.setValue(it.id, 50);
      self.onReset(it);
      self.onNeedRender();
    });
  };

  MDCtrlLayer.prototype._down = function (e, it) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    var gain = this.gainOf(it);            /* 屏幕像素 / 参数 +1 格 */
    var pos = this.projectAt(it.at) || { x: e.clientX, y: e.clientY };
    this.drag = {
      it: it, id: it.id,
      x: e.clientX, y: e.clientY,
      start: it.value,
      gx: gain[0] || 0, gy: gain[1] || 0,
      restX: pos.x, restY: pos.y,
      ox: 0, oy: 0
    };
    it.el.classList.add('is-dragging');
    try { it.el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    this.onStart(it);
    this.onNeedRender();
    var self = this;
    function move(ev) { self._move(ev); }
    function end(ev) {
      it.el.removeEventListener('pointermove', move);
      it.el.removeEventListener('pointerup', end);
      it.el.removeEventListener('pointercancel', end);
      it.el.classList.remove('is-dragging');
      if (self.drag && self.drag.id === it.id) {
        var d = self.drag;
        self.drag = null;
        self.onEnd(it, it.value);
        self.onNeedRender();
      }
    }
    it.el.addEventListener('pointermove', move);
    it.el.addEventListener('pointerup', end);
    it.el.addEventListener('pointercancel', end);
  };

  /* 照抄流明 startGizmoDrag.move：指针位移投影到增益方向；垂直余量 30% 橡皮跟随。 */
  MDCtrlLayer.prototype._move = function (e) {
    var d = this.drag;
    if (!d) return;
    e.preventDefault();
    var dx = e.clientX - d.x;
    var dy = e.clientY - d.y;
    var denom = d.gx * d.gx + d.gy * d.gy;
    var units, alongX = 0, alongY = 0;
    if (denom > 1e-3) {
      units = (dx * d.gx + dy * d.gy) / denom;
      alongX = d.gx * units;
      alongY = d.gy * units;
    } else {
      units = (dx - dy) * 0.6;
      alongX = dx;
      alongY = dy;
    }
    var rx = dx - alongX;
    var ry = dy - alongY;
    d.ox = alongX + rx * 0.30;
    d.oy = alongY + ry * 0.30;
    var v = Math.max(0, Math.min(100, d.start + units));
    this.setValue(d.id, v);
    this.onDrag(d.it, v);
    this.onNeedRender();
  };

  MDCtrlLayer.prototype.setValue = function (id, v) {
    for (var i = 0; i < this.items.length; i++) {
      if (this.items[i].id === id) {
        this.items[i].value = Math.max(0, Math.min(100, Number(v) || 0));
        return this.items[i].value;
      }
    }
    return null;
  };
  MDCtrlLayer.prototype.value = function (id) {
    for (var i = 0; i < this.items.length; i++) if (this.items[i].id === id) return this.items[i].value;
    return null;
  };
  MDCtrlLayer.prototype.list = function () {
    return this.items.map(function (it) {
      return { id: it.id, key: it.key, label: it.label, value: it.value, visible: it.visible };
    });
  };
  MDCtrlLayer.prototype.isDragging = function () { return !!this.drag; };

  MDCtrlLayer.prototype.setVisible = function (on) {
    this.visible = !!on;
    this.update();
  };

  MDCtrlLayer.prototype.clear = function () {
    this._sig = '';
    this.items = [];
    if (this.root) this.root.querySelectorAll('.md3-gizmo').forEach(function (n) { n.remove(); });
  };

  MDCtrlLayer.prototype.dispose = function () {
    this.clear();
    if (this.root && this.root.parentElement) this.root.parentElement.removeChild(this.root);
    this.root = null;
  };

  /* 每帧：重新投影。拖动中的那枚手柄加橡皮偏移并画引线。 */
  MDCtrlLayer.prototype.update = function () {
    var show = this.visible && this.items.length > 0 && !!this.hostEl;
    if (!this.root) this._ensureRoot();
    if (!this.root) return;
    this.root.classList.toggle('is-off', !show);
    if (!show) return;
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      var inGroup = !this.group || it.group === this.group;
      var pos = this.projectAt(it.at);
      it.pos = pos;
      it.visible = !!pos && !!pos.visible && inGroup;
      it.el.style.display = it.visible ? '' : 'none';
      if (!it.visible) continue;
      var ox = (this.drag && this.drag.id === it.id) ? this.drag.ox : 0;
      var oy = (this.drag && this.drag.id === it.id) ? this.drag.oy : 0;
      it.el.style.left = (pos.x + ox).toFixed(1) + 'px';
      it.el.style.top = (pos.y + oy).toFixed(1) + 'px';
    }
    /* 引线：只在拖动时出现，从静止锚点连到手柄 */
    var d = this.drag;
    if (d && d.it.pos && d.it.visible) {
      var x2 = d.it.pos.x + d.ox, y2 = d.it.pos.y + d.oy;
      var len = Math.hypot(x2 - d.restX, y2 - d.restY);
      if (len >= 3) {
        this.pull.style.display = '';
        this.pull.style.left = d.restX.toFixed(1) + 'px';
        this.pull.style.top = d.restY.toFixed(1) + 'px';
        this.pull.style.width = len.toFixed(1) + 'px';
        this.pull.style.transform = 'rotate(' + Math.atan2(y2 - d.restY, x2 - d.restX).toFixed(4) + 'rad)';
      } else this.pull.style.display = 'none';
    } else this.pull.style.display = 'none';
  };

  global.MDCtrlLayer = MDCtrlLayer;
})(window);
