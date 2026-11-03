/* 自研变换手柄（最小实现，不移植 TransformControls）
 *
 * 为什么自己写：
 *   vendor 里的 TransformControls 会改相机、接管 OrbitControls、还带着一整套餐具；
 *   这里只需要「三条轴、三个环、三条缩放轴」和一条硬规则：
 *   拖动期间只预览，pointerup 才提交一次历史。自己写能把这个边界写死。
 *
 * 对外：new ModelTransformGizmo({ scene, camera, canvas, controls, onStart, onChange, onEnd, onStatus })
 *   gizmo.setTarget(pivot)        被编辑的 Object3D（父节点必须是场景本身）
 *   gizmo.setMode('translate'|'rotate'|'scale')
 *   gizmo.setSpace('world'|'local')
 *   gizmo.setSnap(true|false)
 *   gizmo.setConstraint('x'|'y'|'z'|null)  世界轴约束；传同一轴再调一次 = 取消
 *   gizmo.getConstraint()         当前约束轴（null / 'x' / 'y' / 'z'）
 *   gizmo.isDragging()            是否正在拖动
 *   gizmo.update()                每帧调用：跟着目标走 + 按距离保持屏幕尺寸
 *   gizmo.dispose()
 *
 * 吸附步长：从 SeedSnap 偏好读（默认 0.05 m / 15° / 0.1；SeedSnap 缺席时用同值兜底）。
 * 方向：世界空间下三条轴固定；局部空间下轴跟着目标旋转。
 */
(function (global) {
  'use strict';

  var THREE = global.THREE;

  var COLORS = { x: 0xe05252, y: 0x55c46b, z: 0x4f8ff7 };
  var AXES = [
    { key: 'x', index: 0, base: new THREE.Vector3(1, 0, 0) },
    { key: 'y', index: 1, base: new THREE.Vector3(0, 1, 0) },
    { key: 'z', index: 2, base: new THREE.Vector3(0, 0, 1) }
  ];
  /* 兜底：SeedSnap 未加载时才用这组值；正常情况步长一律从 SeedSnap.getPrefs() 读 */
  var STEPS = { translate: 0.05, rotate: Math.PI / 12, scale: 0.1 };

  function ModelTransformGizmo(opts) {
    opts = opts || {};
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.canvas = opts.canvas;
    this.controls = opts.controls || null;
    this.onStart = opts.onStart || function () {};
    this.onChange = opts.onChange || function () {};
    this.onEnd = opts.onEnd || function () {};
    this.onStatus = opts.onStatus || function () {};

    this.target = null;
    this.mode = 'translate';
    this.space = 'world';
    this.snap = false;
    this.constraint = null;  // 世界轴约束：null / 'x' / 'y' / 'z'
    this.drag = null;
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    this.group = new THREE.Group();
    this.group.name = '__model_gizmo';
    this.group.renderOrder = 12;
    this.scene.add(this.group);

    this.handles = [];       // { mode, axis, index, mesh, picker, base }
    this._build();
    this.setMode(this.mode);

    this._onDown = this._pointerDown.bind(this);
    this._onMove = this._pointerMove.bind(this);
    this._onUp = this._pointerUp.bind(this);
    this.canvas.addEventListener('pointerdown', this._onDown, true);
    this.canvas.addEventListener('pointermove', this._onMove, true);
    global.addEventListener('pointerup', this._onUp, true);
    global.addEventListener('pointercancel', this._onUp, true);
  }

  /* ---------- 几何 ----------
   * 所有手柄都建在「单位长度」空间里（沿轴 0→1），每帧用 group.scale 放大到
   * 「离相机距离 * 0.18」——这样模型大小差 100 倍，手柄在屏幕上还是同一只手能拖的大小。 */
  ModelTransformGizmo.prototype._mat = function (color, pick) {
    if (pick) {
      /* 拾取体不能被看见，但必须还能被射线命中：透明 + 不写深度 + 不写颜色 */
      return new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthTest: false, depthWrite: false,
        colorWrite: false, side: THREE.DoubleSide
      });
    }
    return new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false
    });
  };

  ModelTransformGizmo.prototype._shaft = function (color, radius) {
    var g = new THREE.CylinderGeometry(radius, radius, 0.74, 8, 1, true);
    var m = new THREE.Mesh(g, this._mat(color, false));
    m.position.set(0, 0.37, 0);       // 沿本地 +Y，和 CylinderGeometry 的轴一致
    m.renderOrder = 12;
    return m;
  };

  ModelTransformGizmo.prototype._build = function () {
    var self = this;
    AXES.forEach(function (a) {
      var color = COLORS[a.key];

      /* --- 平移 --- */
      var tRoot = new THREE.Group();
      /* CylinderGeometry / ConeGeometry 默认沿 +Y；X 轴绕 Z 转 -90°，Z 轴绕 X 转 90°。
         锥体只要跟着根节点转，不能再单独转一次（否则 Z 轴的锥会指向 X）。 */
      if (a.index === 0) tRoot.rotation.set(0, 0, -Math.PI / 2);
      else if (a.index === 2) tRoot.rotation.set(Math.PI / 2, 0, 0);
      tRoot.add(self._shaft(color, 0.022));
      var tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 12), self._mat(color, false));
      tip.position.set(0, 0.84, 0);
      tRoot.add(tip);
      var tPick = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.9, 6, 1, true), self._mat(color, true));
      tPick.position.set(0, 0.45, 0);
      tRoot.add(tPick);
      tip.userData = { axis: a.key, axisIndex: a.index, mode: 'translate' };
      tPick.userData = { axis: a.key, axisIndex: a.index, mode: 'translate', pick: true };
      self.group.add(tRoot);
      self.handles.push({ mode: 'translate', axis: a.key, index: a.index, root: tRoot, meshes: [tip, tPick] });

      /* --- 旋转环 --- */
      var rRoot = new THREE.Group();
      var ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.92, 0.032, 8, 64),
        self._mat(color, false)
      );
      var rPick = new THREE.Mesh(
        new THREE.TorusGeometry(0.92, 0.11, 6, 32),
        self._mat(color, true)
      );
      if (a.index === 0) { ring.rotation.y = Math.PI / 2; rPick.rotation.y = Math.PI / 2; }
      if (a.index === 1) { ring.rotation.x = Math.PI / 2; rPick.rotation.x = Math.PI / 2; }
      ring.userData = { axis: a.key, axisIndex: a.index, mode: 'rotate' };
      rPick.userData = { axis: a.key, axisIndex: a.index, mode: 'rotate', pick: true };
      rRoot.add(ring); rRoot.add(rPick);
      self.group.add(rRoot);
      self.handles.push({ mode: 'rotate', axis: a.key, index: a.index, root: rRoot, meshes: [ring, rPick] });

      /* --- 缩放 --- */
      var sRoot = new THREE.Group();
      if (a.index === 0) { sRoot.rotation.set(0, 0, -Math.PI / 2); }
      if (a.index === 2) { sRoot.rotation.set(Math.PI / 2, 0, 0); }
      sRoot.add(self._shaft(color, 0.022));
      var cube = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), self._mat(color, false));
      cube.position.set(0, 0.82, 0);
      cube.userData = { axis: a.key, axisIndex: a.index, mode: 'scale' };
      sRoot.add(cube);
      var sPick = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.9, 6, 1, true), self._mat(color, true));
      sPick.position.set(0, 0.45, 0);
      sPick.userData = { axis: a.key, axisIndex: a.index, mode: 'scale', pick: true };
      sRoot.add(sPick);
      self.group.add(sRoot);
      self.handles.push({ mode: 'scale', axis: a.key, index: a.index, root: sRoot, meshes: [cube, sPick] });
    });
  };

  ModelTransformGizmo.prototype.setTarget = function (target) {
    this.target = target || null;
    this.group.visible = !!target;
    /* 目标没了，旧约束和半截拖动都不能留给下一段 */
    if (!this.target) this._clearTracking();
  };
  ModelTransformGizmo.prototype.setMode = function (mode) {
    this.mode = mode === 'rotate' || mode === 'scale' ? mode : 'translate';
    this.handles.forEach(function (h) { h.root.visible = h.mode === this.mode; }, this);
    this._syncVisible();
  };
  ModelTransformGizmo.prototype.setSpace = function (space) {
    this.space = space === 'local' ? 'local' : 'world';
  };
  ModelTransformGizmo.prototype.setSnap = function (on) { this.snap = !!on; };

  /* 吸附步长只有一份来源：SeedSnap 的偏好。
   * 平移取 move；旋转偏好按「度」，手柄内部按弧度；缩放取 scale。
   * 偏好缺项 / 非正数时退回 STEPS（0 步长会让取整除零，不能直接用）。 */
  ModelTransformGizmo.prototype._steps = function () {
    var S = global.SeedSnap;
    var p = (S && typeof S.getPrefs === 'function') ? S.getPrefs() : null;
    if (!p) return STEPS;
    var mv = Math.abs(Number(p.move)), rt = Math.abs(Number(p.rotate)), sc = Math.abs(Number(p.scale));
    return {
      translate: mv > 0 ? mv : STEPS.translate,
      rotate: rt > 0 ? rt * Math.PI / 180 : STEPS.rotate,
      scale: sc > 0 ? sc : STEPS.scale
    };
  };

  /* 世界轴约束：拖动中也能切，切换时以当前变换重新锚定，所以不会跳。
   * 同一轴再调一次 = 取消；换一条轴 = 直接切换。返回实际生效的轴。 */
  ModelTransformGizmo.prototype.setConstraint = function (axis) {
    var key = (axis === 'x' || axis === 'y' || axis === 'z') ? axis : null;
    if (this.constraint === key) key = null;
    this.constraint = key;
    if (this.drag) this._reanchor(this.drag);
    return this.constraint;
  };
  ModelTransformGizmo.prototype.getConstraint = function () { return this.constraint; };
  ModelTransformGizmo.prototype.isDragging = function () { return !!this.drag; };

  /* 清掉拖动与约束（不动回调：调用方自己负责历史边界） */
  ModelTransformGizmo.prototype._clearTracking = function () {
    if (this.constraint) this.constraint = null;
    if (!this.drag) return;
    var d = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch (err) {}
    this.canvas.style.cursor = '';
    if (this.controls) this.controls.enabled = true;
  };

  ModelTransformGizmo.prototype._axisEntry = function (key) {
    for (var i = 0; i < AXES.length; i++) {
      if (AXES[i].key === key) return AXES[i];
    }
    return AXES[0];
  };

  /* 约束时坚决用世界轴；没约束时沿用原来的「世界/局部」规则 */
  ModelTransformGizmo.prototype._anchorDir = function (key) {
    if (this.constraint) return new THREE.Vector3().copy(this._axisEntry(key).base).normalize();
    return this._axisDir(key);
  };

  /* 中途换轴的锚定：起点全部换成「当前」状态，一维坐标/参考向量也按当前指针重算。
   * 若此刻射线与轴平行（算不出坐标），把锚点留空，等下一次 pointermove 惰性锚定，
   * 这样切换那一帧位移一定是 0，不会突然跳一下。 */
  ModelTransformGizmo.prototype._reanchor = function (d) {
    if (!this.target) return;
    var key = this.constraint || d.handleAxis;
    var entry = this._axisEntry(key);
    d.axis = key;
    d.axisIndex = entry.index;
    d.dir = this._anchorDir(key);
    d.origin = this.target.getWorldPosition(new THREE.Vector3());
    d.startPos = this.target.position.clone();
    d.startQuat = this.target.quaternion.clone();
    d.startScale = this.target.scale.clone();
    if (this.mode === 'rotate') {
      d.a0 = 0;
      d.ref = null;
      var hp = this._planeHit(d.origin, d.dir);
      if (hp) {
        var ref = hp.clone().sub(d.origin);
        if (ref.lengthSq() > 1e-8) d.ref = ref.normalize();
      }
    } else {
      d.t0 = this._axisT(d.origin, d.dir);   // null = 惰性锚定
    }
  };

  ModelTransformGizmo.prototype._syncVisible = function () {
    var hasTarget = !!this.target;
    this.group.visible = hasTarget;
    var mode = this.mode;
    this.handles.forEach(function (h) { h.root.visible = hasTarget && h.mode === mode; });
  };

  ModelTransformGizmo.prototype._orientation = function () {
    if (!this.target) return this._q.set(0, 0, 0, 1);
    if (this.space === 'local' || this.mode === 'scale') {
      return this.target.getWorldQuaternion(this._q);
    }
    return this._q.set(0, 0, 0, 1);
  };

  ModelTransformGizmo.prototype.update = function () {
    if (!this.target || !this.target.parent) { this._syncVisible(); return; }
    this._syncVisible();
    var pos = this.target.getWorldPosition(this._tmp);
    this.group.position.copy(pos);
    this.group.quaternion.copy(this._orientation());
    var dist = this.camera.position.distanceTo(pos);
    var unit = Math.max(0.02, dist * 0.18);
    this.group.scale.setScalar(unit);
  };

  /* ---------- 指针 ---------- */
  ModelTransformGizmo.prototype._pointerNdc = function (e) {
    var r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    this._ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    return this._ndc;
  };

  ModelTransformGizmo.prototype._raycast = function (e) {
    var nd = this._pointerNdc(e);
    if (!nd) return null;
    this._ray.setFromCamera(nd, this.camera);
    var picks = [];
    var mode = this.mode;
    this.handles.forEach(function (h) {
      if (!h.root.visible || h.mode !== mode) return;
      h.meshes.forEach(function (m) { if (m.userData && m.userData.pick) picks.push(m); });
    });
    var hits = this._ray.intersectObjects(picks, false);
    return hits.length ? hits[0] : null;
  };

  ModelTransformGizmo.prototype._axisDir = function (axisKey) {
    var a = AXES.filter(function (x) { return x.key === axisKey; })[0];
    var v = new THREE.Vector3().copy(a.base);
    if (this.space === 'local' || this.mode === 'scale') {
      v.applyQuaternion(this.target.getWorldQuaternion(new THREE.Quaternion()));
    }
    return v.normalize();
  };

  /* 指针射线与「过 origin、法向 n」的平面交点 */
  ModelTransformGizmo.prototype._planeHit = function (origin, normal) {
    var n = new THREE.Vector3().copy(normal);
    if (n.lengthSq() < 1e-8) return null;
    this._plane.setFromNormalAndCoplanarPoint(n.normalize(), origin);
    var out = new THREE.Vector3();
    return this._ray.ray.intersectPlane(this._plane, out);
  };

  /* 沿轴拖动时取「轴上的一维坐标」：求指针射线与轴线的最近点。
   *   ⚠ 不能拿 axis × camDir 当平面法向：那个平面正好包含相机视线，
   *     射线与平面平行，永远没有交点（踩过这个坑，表现为手柄点不中/拖不动）。 */
  ModelTransformGizmo.prototype._axisT = function (origin, dir) {
    var u = dir;
    var v = this._ray.ray.direction;
    var w0 = new THREE.Vector3().subVectors(origin, this._ray.ray.origin);
    var a = u.dot(u), b = u.dot(v), c = v.dot(v);
    var d = u.dot(w0), e = v.dot(w0);
    var denom = a * c - b * b;
    if (Math.abs(denom) < 1e-8) return null;      // 射线和轴平行，拖不了
    return (b * e - c * d) / denom;
  };

  ModelTransformGizmo.prototype._pointerDown = function (e) {
    /* Alt 是视口导航修饰键（M2）：按住 Alt 时手柄让位给环绕/平移/推拉 */
    if (e.button || e.altKey || !this.target) return;
    var hit = this._raycast(e);
    if (!hit || !hit.object.userData) return;
    var ud = hit.object.userData;
    if (ud.mode !== this.mode) return;

    e.stopPropagation();
    e.preventDefault();
    /* 约束生效时，点哪根手柄都按约束轴走（例如约束 X 后拖 Y 手柄，实际只沿 X 动） */
    var key = this.constraint || ud.axis;
    var entry = this._axisEntry(key);
    var dir = this._anchorDir(key);
    var origin = this.target.getWorldPosition(new THREE.Vector3());

    this.drag = {
      pointerId: e.pointerId,
      mode: this.mode,
      axis: key,
      axisIndex: entry.index,
      handleAxis: ud.axis,          // 换轴/取消约束时要知道原来抓的是哪根
      handleAxisIndex: ud.axisIndex,
      dir: dir,
      origin: origin,
      startPos: this.target.position.clone(),
      startQuat: this.target.quaternion.clone(),
      startScale: this.target.scale.clone(),
      /* 平移/缩放记一维坐标；旋转记起始角 */
      t0: null,
      a0: null,
      ref: null,
      changed: false
    };

    if (this.mode === 'rotate') {
      var hitPt = this._planeHit(origin, dir);
      if (!hitPt) { this.drag = null; return; }
      var ref = hitPt.clone().sub(origin);
      if (ref.lengthSq() < 1e-8) ref.set(1, 0, 0);
      this.drag.ref = ref.normalize();
      this.drag.a0 = 0;
    } else {
      this.drag.t0 = this._axisT(origin, dir);
      if (this.drag.t0 == null) { this.drag = null; return; }
    }

    if (this.controls) this.controls.enabled = false;
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    this.canvas.style.cursor = 'grabbing';
    this.onStart({ mode: this.mode, axis: ud.axis });
  };

  ModelTransformGizmo.prototype._pointerMove = function (e) {
    if (!this.drag) {
      /* 悬停：只在手柄上变成抓取，别抢画布的旋转光标 */
      if (!this.target) return;
      var h = this._raycast(e);
      this.canvas.style.cursor = h ? 'grab' : '';
      return;
    }
    if (e.pointerId !== this.drag.pointerId) return;
    var d = this.drag;
    var nd = this._pointerNdc(e);
    if (!nd) return;
    this._ray.setFromCamera(nd, this.camera);

    var amount = 0, unit = 0, angle = 0;
    if (this.mode === 'translate') {
      var t = this._axisT(d.origin, d.dir);
      if (t == null) return;
      if (d.t0 == null) { d.t0 = t; return; }   // 换轴时射线平行：这一帧只锚定，不位移
      amount = t - d.t0;
      if (this.snap) { var stepT = this._steps().translate; amount = Math.round(amount / stepT) * stepT; }
      this.target.position.copy(d.startPos).addScaledVector(d.dir, amount);
      this.onStatus('平移 ' + d.axis.toUpperCase() + ' · ' + amount.toFixed(3) + ' m');
    } else if (this.mode === 'rotate') {
      var hp = this._planeHit(d.origin, d.dir);
      if (!hp) return;
      var cur = hp.clone().sub(d.origin);
      if (cur.lengthSq() < 1e-8) return;
      cur.normalize();
      if (!d.ref) { d.ref = cur.clone(); return; }  // 换轴时先锚定参考方向
      var cross = new THREE.Vector3().crossVectors(d.ref, cur);
      var ang = Math.atan2(cross.dot(d.dir), d.ref.dot(cur));
      if (this.snap) {
        var stepR = this._steps().rotate;
        ang = Math.round(ang / stepR) * stepR;
      }
      angle = ang;
      var q = new THREE.Quaternion().setFromAxisAngle(d.dir, ang);
      this.target.quaternion.copy(d.startQuat).premultiply(q);
      this.onStatus('旋转 ' + d.axis.toUpperCase() + ' · ' + (ang * 180 / Math.PI).toFixed(1) + '°');
    } else {
      var t2 = this._axisT(d.origin, d.dir);
      if (t2 == null) return;
      if (d.t0 == null) { d.t0 = t2; return; }
      unit = Math.max(1e-4, this.group.scale.x);
      var raw = 1 + (t2 - d.t0) / unit;
      if (this.snap) {
        var stepS = this._steps().scale;
        raw = Math.max(stepS, Math.round(raw / stepS) * stepS);
      }
      raw = Math.max(0.02, Math.min(20, raw));
      this.target.scale.copy(d.startScale);
      this.target.scale.setComponent(d.axisIndex, d.startScale.getComponent(d.axisIndex) * raw);
      this.onStatus('缩放 ' + d.axis.toUpperCase() + ' · ' + this.target.scale.getComponent(d.axisIndex).toFixed(3));
    }

    if (!d.changed) {
      if (this.mode === 'rotate') d.changed = Math.abs(angle) > 1e-4;
      else if (this.mode === 'translate') d.changed = d.startPos.distanceToSquared(this.target.position) > 1e-10;
      else d.changed = d.startScale.distanceToSquared(this.target.scale) > 1e-10;
    }
    this.onChange({ mode: this.mode, axis: d.axis });
  };

  ModelTransformGizmo.prototype._pointerUp = function (e) {
    if (!this.drag || (e && e.pointerId !== this.drag.pointerId)) return;
    var d = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch (err) {}
    this.canvas.style.cursor = '';
    if (this.controls) this.controls.enabled = true;
    this.constraint = null;   // 每段拖动结束就清约束，下一段不继承
    /* 拖动再小也算一次「操作结束」：提交与否由 onEnd 里比较快照决定，
     * 这里不替它做判断，避免「按一下没动」也被记进历史。 */
    this.onEnd({ mode: d.mode, axis: d.axis, changed: d.changed });
  };

  ModelTransformGizmo.prototype.dispose = function () {
    this._clearTracking();
    this.target = null;
    this.canvas.removeEventListener('pointerdown', this._onDown, true);
    this.canvas.removeEventListener('pointermove', this._onMove, true);
    global.removeEventListener('pointerup', this._onUp, true);
    global.removeEventListener('pointercancel', this._onUp, true);
    if (this.scene) this.scene.remove(this.group);
    this.handles.forEach(function (h) {
      h.root.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    });
    this.handles = [];
  };

  global.ModelTransformGizmo = ModelTransformGizmo;
})(typeof window !== 'undefined' ? window : globalThis);
