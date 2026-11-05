/* 自研变换手柄（Maya 式，2026-11 重做）
 *
 * 功能对照：
 *   移动  轴箭头 = 沿轴拖动；平面手柄 = 在两轴平面内拖动；中心方块 = 屏幕空间拖动
 *   旋转  三色环 = 绕对象自身的轴旋转（环跟着对象走）；外圈 = 屏幕空间旋转
 *   缩放  轴柄 = 单轴缩放；中心方块 = 整体缩放（右拖变大、左拖变小）
 *
 * 为什么自己写：
 *   vendor 里的 TransformControls 会改相机、接管 OrbitControls、还带着一整套餐具；
 *   这里只需要上面这些手柄和一条硬规则：
 *   拖动期间只预览，pointerup 才提交一次历史。自己写能把这个边界写死。
 *
 * 防闪烁：所有拖动都从 pointerdown 那一刻的快照（位置 / 旋转 / 缩放 / 起始射线交点）
 *   每帧整算，绝不在上一帧结果上叠加；平面与屏幕拖动用固定平面求交，
 *   不受拾取射线抖动影响。
 *
 * 对外：new ModelTransformGizmo({ scene, camera, canvas, controls, onStart, onChange, onEnd, onStatus })
 *   gizmo.setTarget(pivot)        被编辑的 Object3D（父节点必须是场景本身）
 *   gizmo.setMode('translate'|'rotate'|'scale')
 *   gizmo.setSpace('world'|'local')   只影响移动轴；旋转 / 缩放始终跟对象轴
 *   gizmo.setSnap(true|false)
 *   gizmo.setConstraint('x'|'y'|'z'|null)  世界轴约束；传同一轴再调一次 = 取消
 *   gizmo.getConstraint()         当前约束轴（null / 'x' / 'y' / 'z'）
 *   gizmo.isDragging()            是否正在拖动
 *   gizmo.update()                每帧调用：跟着目标走 + 按距离保持屏幕尺寸
 *   gizmo.dispose()
 *
 * 吸附步长：从 SeedSnap 偏好读（默认 0.05 m / 15° / 0.1；SeedSnap 缺席时用同值兜底）。
 */
(function (global) {
  'use strict';

  var THREE = global.THREE;

  var COLORS = { x: 0xe1524b, y: 0x5fbf63, z: 0x4d86f5 };
  var HOVER = 0xffd45e;          /* Maya 悬停高亮：琥珀 */
  var CENTER = 0xffd45e;
  var OUTER = 0xcfd6df;
  var AXES = [
    { key: 'x', index: 0, base: new THREE.Vector3(1, 0, 0) },
    { key: 'y', index: 1, base: new THREE.Vector3(0, 1, 0) },
    { key: 'z', index: 2, base: new THREE.Vector3(0, 0, 1) }
  ];
  /* 三个平面手柄：法向轴决定颜色（和 Maya 一致：XY 面 = 蓝、YZ 面 = 红、XZ 面 = 绿） */
  var PLANES = [
    { key: 'xy', axes: ['x', 'y'], normal: 'z' },
    { key: 'yz', axes: ['y', 'z'], normal: 'x' },
    { key: 'xz', axes: ['x', 'z'], normal: 'y' }
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
    this.constraint = null;
    this.drag = null;
    this.handles = [];        // { kind, mode, axis, axisIndex, root, mats, pickers, color, hover }
    this._hover = null;
    this._pickMat = null;
    this._billboards = [];    // 面向相机的手柄（中心方块 / 屏幕旋转外圈）

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qv = new THREE.Vector3();

    this.group = new THREE.Group();
    this.group.name = '__model_gizmo';
    this.group.renderOrder = 12;
    this.scene.add(this.group);

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

  /* ---------- 材质 / 小工具 ----------
   * 手柄材质一律 depthTest:false，保证手柄永远压在被编辑的模型上（Maya 也一样）。 */
  /* 材质颜色要按 sRGB 写入再转线性：渲染器 outputEncoding 是 sRGB，
   * 直接把十六进制塞进线性槽位会被「再编码」一次，红绿蓝全变成粉彩 */
  ModelTransformGizmo.prototype._color = function (mat, hex) {
    mat.color.setHex(hex);
    if (mat.color.convertSRGBToLinear) mat.color.convertSRGBToLinear();
    return mat;
  };
  ModelTransformGizmo.prototype._mat = function (color, opacity) {
    var m = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: opacity == null ? 0.95 : opacity,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      /* 场景开了 ACES 色调映射；手柄是要「一眼认出红绿蓝」的 UI，不能被映射成粉彩 */
      toneMapped: false
    });
    this._color(m, color);
    return m;
  };
  ModelTransformGizmo.prototype._invisible = function () {
    /* 拾取体不能被看见，但必须还能被射线命中 */
    if (!this._pickMat) {
      this._pickMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthTest: false, depthWrite: false,
        colorWrite: false, side: THREE.DoubleSide, toneMapped: false
      });
    }
    return this._pickMat;
  };
  ModelTransformGizmo.prototype._mesh = function (geo, mat) {
    var m = new THREE.Mesh(geo, mat);
    m.renderOrder = 12;
    m.frustumCulled = false;
    return m;
  };
  ModelTransformGizmo.prototype._reg = function (h) {
    h.mats = h.mats || [];
    h.pickers = h.pickers || [];
    this.handles.push(h);
    this.group.add(h.root);
    return h;
  };

  /* ---------- 几何 ----------
   * 所有手柄都建在「单位长度」空间里（轴长 1），每帧用 group.scale 放大到
   * 「离相机距离 * 0.18」——模型大小差 100 倍，手柄在屏幕上还是同一只手能拖的大小。 */
  ModelTransformGizmo.prototype._build = function () {
    var self = this;

    /* ===== 移动：轴箭头（锥头 + 细杆） ===== */
    AXES.forEach(function (a) {
      var root = new THREE.Group();
      if (a.index === 0) root.rotation.z = -Math.PI / 2;   // 几何默认沿 +Y
      else if (a.index === 2) root.rotation.x = Math.PI / 2;

      var mat = self._mat(COLORS[a.key], 0.95);
      var shaft = self._mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.78, 8, 1, true), mat);
      shaft.position.y = 0.40;
      var tip = self._mesh(new THREE.ConeGeometry(0.078, 0.21, 18), mat);
      tip.position.y = 0.90;
      root.add(shaft); root.add(tip);

      /* 拾取体从 0.28 开始：贴着中心的圆柱在「轴几乎正对相机」时,
       * 投影会变成盖住中心方块的一个圆，中心拖动就会被轴抢走 → 点不了屏幕平移 */
      var pick = self._mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.72, 6, 1, true), self._invisible());
      pick.position.y = 0.64;
      root.add(pick);

      var h = self._reg({
        kind: 'axis', mode: 'translate', axis: a.key, axisIndex: a.index, root: root,
        mats: [mat], pickers: [pick], color: COLORS[a.key], opacity: 0.95, hover: HOVER
      });
      tip.userData = { handle: h };
      pick.userData = { handle: h };
    });

    /* ===== 移动：平面手柄（两轴构成的小方块，悬在两根轴箭头之间的角上） ===== */
    PLANES.forEach(function (p) {
      var root = new THREE.Group();
      var color = COLORS[p.normal];
      var mat = self._mat(color, 0.72);
      var quad = self._mesh(new THREE.PlaneGeometry(0.16, 0.16), mat);
      /* 平面片默认法向 +Z：XY 面不用转，XZ 绕 X 转 -90°（法向 +Y），YZ 绕 Y 转 90°（法向 +X） */
      if (p.key === 'xz') quad.rotation.x = -Math.PI / 2;
      if (p.key === 'yz') quad.rotation.y = Math.PI / 2;
      /* 摆在两根轴中间偏外：0.32 是 Maya 平面手柄的常规位置；
       * 也不能更靠内——会和中心方块的拾取区叠在一起，点中心时会被平面手柄抢走。 */
      quad.position.set(
        (p.key === 'xy' || p.key === 'xz') ? 0.32 : 0,
        (p.key === 'xy' || p.key === 'yz') ? 0.32 : 0,
        (p.key === 'xz' || p.key === 'yz') ? 0.32 : 0
      );
      root.add(quad);

      var pick = self._mesh(new THREE.PlaneGeometry(0.24, 0.24), self._invisible());
      pick.position.copy(quad.position);
      pick.rotation.copy(quad.rotation);
      root.add(pick);

      var h = self._reg({
        kind: 'plane', mode: 'translate', axis: null, axes: p.axes, normal: p.normal,
        root: root, mats: [mat], pickers: [pick], color: color, opacity: 0.55, hover: HOVER
      });
      quad.userData = { handle: h };
      pick.userData = { handle: h };
    });

    /* ===== 移动：中心方块（屏幕空间拖动） ===== */
    (function () {
      var root = new THREE.Group();
      var mat = self._mat(CENTER, 0.95);
      var quad = self._mesh(new THREE.PlaneGeometry(0.17, 0.17), mat);
      var dotMat = self._mat(0x24262c, 0.95);
      var dot = self._mesh(new THREE.PlaneGeometry(0.06, 0.06), dotMat);
      dot.position.z = 0.001;
      /* 点挂到方块下面：方块每帧朝相机，点就跟着一起转，不会在局部空间里歪掉 */
      quad.add(dot);
      root.add(quad);

      var pick = self._mesh(new THREE.PlaneGeometry(0.24, 0.24), self._invisible());
      root.add(pick);

      var h = self._reg({
        kind: 'center', mode: 'translate', axis: null, root: root,
        mats: [mat], pickers: [pick], color: CENTER, opacity: 0.95, hover: 0xfff3c4
      });
      quad.userData = { handle: h };
      dot.userData = { handle: h };
      pick.userData = { handle: h };
      self._billboards.push(quad);
      self._billboards.push(pick);
      self._center = h;
    })();

    /* ===== 旋转：三色环 + 屏幕空间外圈 ===== */
    AXES.forEach(function (a) {
      var root = new THREE.Group();
      var mat = self._mat(COLORS[a.key], 0.9);
      var ring = self._mesh(new THREE.TorusGeometry(1.0, 0.030, 8, 96), mat);
      if (a.index === 0) ring.rotation.y = Math.PI / 2;
      if (a.index === 1) ring.rotation.x = Math.PI / 2;
      root.add(ring);

      var pick = self._mesh(new THREE.TorusGeometry(1.0, 0.09, 6, 40), self._invisible());
      pick.rotation.copy(ring.rotation);
      root.add(pick);

      var h = self._reg({
        kind: 'ring', mode: 'rotate', axis: a.key, axisIndex: a.index, root: root,
        mats: [mat], pickers: [pick], color: COLORS[a.key], opacity: 0.9, hover: HOVER
      });
      ring.userData = { handle: h };
      pick.userData = { handle: h };
    });

    (function () {
      var root = new THREE.Group();
      var mat = self._mat(OUTER, 0.42);
      var ring = self._mesh(new THREE.TorusGeometry(1.45, 0.024, 8, 120), mat);
      root.add(ring);

      /* 拾取圈要比三色环离得够远（1.45 vs 1.09）：不然斜视时内环的粗拾取管
       * 会挡住外圈，点「屏幕空间旋转」变成转单轴（实测就是这里踩的坑） */
      var pick = self._mesh(new THREE.TorusGeometry(1.45, 0.12, 6, 48), self._invisible());
      root.add(pick);

      var h = self._reg({
        kind: 'screen', mode: 'rotate', axis: null, root: root,
        mats: [mat], pickers: [pick], color: OUTER, opacity: 0.42, hover: HOVER
      });
      ring.userData = { handle: h };
      pick.userData = { handle: h };
      self._billboards.push(ring);
      self._billboards.push(pick);
    })();

    /* ===== 缩放：轴柄 + 方块头，中心方块做整体缩放 ===== */
    AXES.forEach(function (a) {
      var root = new THREE.Group();
      if (a.index === 0) root.rotation.z = -Math.PI / 2;
      else if (a.index === 2) root.rotation.x = Math.PI / 2;

      var mat = self._mat(COLORS[a.key], 0.95);
      var shaft = self._mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.80, 10, 1, true), mat);
      shaft.position.y = 0.40;
      var cube = self._mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), mat);
      cube.position.y = 0.86;
      root.add(shaft); root.add(cube);

      var pick = self._mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.72, 6, 1, true), self._invisible());
      pick.position.y = 0.64;
      root.add(pick);

      var h = self._reg({
        kind: 'axis', mode: 'scale', axis: a.key, axisIndex: a.index, root: root,
        mats: [mat], pickers: [pick], color: COLORS[a.key], opacity: 0.95, hover: HOVER
      });
      cube.userData = { handle: h };
      pick.userData = { handle: h };
    });

    (function () {
      var root = new THREE.Group();
      var mat = self._mat(CENTER, 0.95);
      var cube = self._mesh(new THREE.BoxGeometry(0.15, 0.15, 0.15), mat);
      var pick = self._mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), self._invisible());
      root.add(cube); root.add(pick);

      var h = self._reg({
        kind: 'uniform', mode: 'scale', axis: null, root: root,
        mats: [mat], pickers: [pick], color: CENTER, opacity: 0.95, hover: 0xfff3c4
      });
      cube.userData = { handle: h };
      pick.userData = { handle: h };
    })();
  };

  ModelTransformGizmo.prototype.setTarget = function (target) {
    this.target = target || null;
    this.group.visible = !!target;
    if (!this.target) this._clearTracking();
    this._hover = null;
  };
  ModelTransformGizmo.prototype.setMode = function (mode) {
    this.mode = mode === 'rotate' || mode === 'scale' ? mode : 'translate';
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

  ModelTransformGizmo.prototype._clearTracking = function () {
    this.constraint = null;
    this._highlight(null);
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

  /* 轴方向：
   *   约束时坚决用世界轴；
   *   旋转始终用对象自身的轴（环跟着对象转，拖动也必须绕同一根轴）；
   *   缩放始终沿对象局部轴；
   *   移动按世界 / 局部开关。 */
  ModelTransformGizmo.prototype._axisDir = function (key) {
    var a = this._axisEntry(key);
    var v = new THREE.Vector3().copy(a.base);
    if (this.mode === 'rotate' || this.mode === 'scale' || this.space === 'local') {
      v.applyQuaternion(this.target.getWorldQuaternion(new THREE.Quaternion()));
    }
    return v.normalize();
  };
  ModelTransformGizmo.prototype._anchorDir = function (key) {
    if (this.constraint) return new THREE.Vector3().copy(this._axisEntry(key).base).normalize();
    return this._axisDir(key);
  };

  /* 中途换轴的锚定：起点全部换成「当前」状态，起始交点/角度也按当前指针重算。
   * 若此刻射线与轴平行（算不出坐标），把锚点留空，等下一次 pointermove 惰性锚定，
   * 这样切换那一帧位移一定是 0，不会突然跳一下。 */
  ModelTransformGizmo.prototype._reanchor = function (d) {
    if (!this.target) return;
    var key = this.constraint || d.handleAxis || d.axis;
    var entry = this._axisEntry(key);
    d.axis = key;
    d.axisIndex = entry.index;
    d.dir = this._anchorDir(key);
    d.origin = this.target.getWorldPosition(new THREE.Vector3());
    d.startPos = this.target.position.clone();
    d.startQuat = this.target.quaternion.clone();
    d.startScale = this.target.scale.clone();
    d.startWorldQuat = this.target.getWorldQuaternion(new THREE.Quaternion());
    d.unit0 = Math.max(1e-4, this.group.scale.x);
    if (this.mode === 'rotate') {
      d.ref = null;
      var hp = this._planeHit(d.origin, d.dir);
      if (hp) {
        var ref = hp.clone().sub(d.origin);
        if (ref.lengthSq() > 1e-8) d.ref = ref.normalize();
      }
    } else {
      d.t0 = this._axisT(d.origin, d.dir);
      d.hit0 = this._planeHit(d.origin, d.normal || this._cameraDir());
    }
  };

  ModelTransformGizmo.prototype._syncVisible = function () {
    var hasTarget = !!this.target;
    var mode = this.mode;
    this.group.visible = hasTarget;
    this.handles.forEach(function (h) { h.root.visible = hasTarget && h.mode === mode; });
  };

  /* 旋转环 / 缩放轴跟着对象走；移动按世界 / 局部 */
  ModelTransformGizmo.prototype._orientation = function () {
    if (!this.target) return this._q.set(0, 0, 0, 1);
    if (this.mode === 'rotate' || this.mode === 'scale' || this.space === 'local') {
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
    var unit = Math.max(0.02, dist * 0.20);
    this.group.scale.setScalar(unit);

    /* 中心方块和外圈始终正对相机：把相机的世界朝向换算回 group 的局部朝向 */
    var inv = this._tempsInvQuat || (this._tempsInvQuat = new THREE.Quaternion());
    inv.copy(this.group.quaternion).invert();
    for (var i = 0; i < this._billboards.length; i++) {
      this._billboards[i].quaternion.copy(inv).multiply(this.camera.quaternion);
    }
  };

  /* ---------- 拾取 / 高亮 ---------- */
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
      for (var i = 0; i < h.pickers.length; i++) picks.push(h.pickers[i]);
    });
    var hits = this._ray.intersectObjects(picks, false);
    return hits.length ? hits[0] : null;
  };

  /* 悬停高亮：把该手柄的可见材质换成琥珀色，离开时换回自己的颜色 */
  ModelTransformGizmo.prototype._highlight = function (h) {
    if (this._hover === h) return;
    var prev = this._hover;
    this._hover = h || null;
    if (prev) this._paint(prev, false);
    if (h) this._paint(h, true);
    this.canvas.style.cursor = h ? 'grab' : (this.drag ? 'grabbing' : '');
  };
  ModelTransformGizmo.prototype._paint = function (h, on) {
    for (var i = 0; i < h.mats.length; i++) {
      var m = h.mats[i];
      this._color(m, on ? h.hover : h.color);
      m.opacity = on ? Math.max(0.9, h.opacity) : h.opacity;
    }
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

  ModelTransformGizmo.prototype._cameraDir = function () {
    if (!this._camDir) this._camDir = new THREE.Vector3();
    return this.camera.getWorldDirection(this._camDir);
  };

  /* 世界坐标 → 画布像素：屏幕空间旋转要靠指针绕手柄中心的角度 */
  ModelTransformGizmo.prototype._screenPoint = function (worldPos) {
    var r = this.canvas.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    var p = worldPos.clone().project(this.camera);
    return {
      x: r.left + (p.x * 0.5 + 0.5) * r.width,
      y: r.top + (-p.y * 0.5 + 0.5) * r.height
    };
  };

  function wrapPI(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /* ---------- 指针按下 ---------- */
  ModelTransformGizmo.prototype._pointerDown = function (e) {
    /* Alt 是视口导航修饰键：按住 Alt 时手柄让位给环绕/平移/推拉 */
    if (e.button || e.altKey || !this.target) return;
    var hit = this._raycast(e);
    if (!hit || !hit.object.userData || !hit.object.userData.handle) return;
    var h = hit.object.userData.handle;
    if (h.mode !== this.mode) return;

    e.stopPropagation();
    e.preventDefault();
    this._highlight(h);

    /* 有约束时：除了屏幕旋转，其他手柄一律按约束轴走 */
    var kind = h.kind === 'ring' ? 'axis' : h.kind;   /* 旋转环结构上就是一根轴：走 axis 分支 */
    var key = h.axis;
    if (this.constraint && kind !== 'screen') {
      kind = 'axis';
      key = this.constraint;
    }

    var target = this.target;
    var origin = target.getWorldPosition(new THREE.Vector3());
    var d = {
      pointerId: e.pointerId,
      mode: this.mode,
      kind: kind,
      axis: key,
      axes: h.axes || null,
      normal: null,
      dir: null,
      origin: origin,
      handleAxis: h.axis,
      startPos: target.position.clone(),
      startQuat: target.quaternion.clone(),
      startScale: target.scale.clone(),
      startWorldQuat: target.getWorldQuaternion(new THREE.Quaternion()),
      unit0: Math.max(1e-4, this.group.scale.x),
      t0: null, ref: null, changed: false,
      hit0: null, normal0: null,
      x0: e.clientX, y0: e.clientY,
      sx: 0, sy: 0, lastA: 0, total: 0
    };

    var nd = this._pointerNdc(e);
    if (nd) this._ray.setFromCamera(nd, this.camera);

    if (kind === 'axis') {
      d.axisIndex = this._axisEntry(key).index;
      d.dir = this._anchorDir(key);
      if (this.mode === 'rotate') {
        var hp = this._planeHit(origin, d.dir);
        if (!hp) return;
        var ref = hp.clone().sub(origin);
        if (ref.lengthSq() < 1e-8) ref.set(1, 0, 0);
        d.ref = ref.normalize();
      } else {
        d.t0 = this._axisT(origin, d.dir);
        if (d.t0 == null) return;
      }
    } else if (kind === 'plane') {
      /* 平面拖动：法向是平面手柄对应的那根轴（世界或对象朝向） */
      var nrm = new THREE.Vector3().copy(this._axisEntry(h.normal).base);
      if (this.space === 'local') nrm.applyQuaternion(d.startWorldQuat);
      d.normal = nrm.normalize();
      d.hit0 = this._planeHit(origin, d.normal);
      if (!d.hit0) return;
    } else if (kind === 'center') {
      /* 屏幕空间拖动：过中心、正对相机的平面 */
      d.normal = this._cameraDir().clone();
      d.hit0 = this._planeHit(origin, d.normal);
      if (!d.hit0) return;
    } else if (kind === 'screen') {
      /* 屏幕空间旋转：记录指针相对中心的角度 */
      var sp = this._screenPoint(origin);
      d.sx = sp.x; d.sy = sp.y;
      d.lastA = Math.atan2(e.clientY - sp.y, e.clientX - sp.x);
    } else if (kind === 'uniform') {
      /* 整体缩放：水平位移为增量，x0 已记 */
    }

    this.drag = d;
    if (this.controls) this.controls.enabled = false;
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    this.canvas.style.cursor = 'grabbing';
    this.onStart({ mode: this.mode, axis: key || h.axis, kind: kind });
  };

  /* ---------- 指针移动 ---------- */
  ModelTransformGizmo.prototype._pointerMove = function (e) {
    if (!this.drag) {
      if (!this.target) return;
      var hh = this._raycast(e);
      this._highlight(hh ? hh.object.userData.handle : null);
      return;
    }
    if (e.pointerId !== this.drag.pointerId) return;
    var d = this.drag;
    var nd = this._pointerNdc(e);
    if (!nd) return;
    this._ray.setFromCamera(nd, this.camera);

    var target = this.target;
    var status = '';
    var axisLabel = (d.axis || '').toUpperCase();

    if (d.kind === 'plane') {
      /* 固定平面求交，从按下那一刻的命中点整算位移，不叠加上一帧结果 → 不闪 */
      var hp = this._planeHit(d.origin, d.normal);
      if (!hp) return;
      var delta = hp.clone().sub(d.hit0);
      if (this.snap) {
        var stepP = this._steps().translate;
        delta.set(
          Math.round(delta.x / stepP) * stepP,
          Math.round(delta.y / stepP) * stepP,
          Math.round(delta.z / stepP) * stepP
        );
      }
      target.position.copy(d.startPos).add(delta);
      status = '平面平移 ' + d.axes.join('').toUpperCase() +
        ' · ' + delta.x.toFixed(3) + ', ' + delta.y.toFixed(3) + ', ' + delta.z.toFixed(3);

    } else if (d.kind === 'center') {
      /* 屏幕空间平移：同样用固定平面，位移完全跟随指针在屏幕平面上的投影 */
      var hc = this._planeHit(d.origin, d.normal);
      if (!hc) return;
      var dc = hc.clone().sub(d.hit0);
      if (this.snap) {
        var stepC = this._steps().translate;
        dc.set(
          Math.round(dc.x / stepC) * stepC,
          Math.round(dc.y / stepC) * stepC,
          Math.round(dc.z / stepC) * stepC
        );
      }
      target.position.copy(d.startPos).add(dc);
      status = '屏幕平移 · ' + dc.length().toFixed(3) + ' m';

    } else if (d.kind === 'screen') {
      /* 屏幕空间旋转：指针绕中心的累计角度，绕相机视线转 */
      var len = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
      if (len < 2) return;
      var a = Math.atan2(e.clientY - d.sy, e.clientX - d.sx);
      var da = wrapPI(a - d.lastA);
      d.lastA = a;
      d.total += da;
      if (this.snap) {
        var stepR0 = this._steps().rotate;
        d.total = Math.round(d.total / stepR0) * stepR0;
      }
      var axisV = this._cameraDir().clone().normalize();
      var qs = new THREE.Quaternion().setFromAxisAngle(axisV, d.total);
      target.quaternion.copy(d.startQuat).premultiply(qs);
      status = '屏幕旋转 · ' + (d.total * 180 / Math.PI).toFixed(1) + '°';

    } else if (d.kind === 'uniform') {
      /* 整体缩放：向右拖变大、向左拖变小 */
      var factor = 1 + (e.clientX - d.x0) / 90;
      if (this.snap) {
        var stepS0 = this._steps().scale;
        factor = Math.max(stepS0, Math.round(factor / stepS0) * stepS0);
      }
      factor = Math.max(0.02, Math.min(20, factor));
      target.scale.copy(d.startScale).multiplyScalar(factor);
      status = '整体缩放 · ' + factor.toFixed(3) + '×';

    } else if (this.mode === 'translate') {
      var t = this._axisT(d.origin, d.dir);
      if (t == null) return;
      if (d.t0 == null) { d.t0 = t; return; }
      var amount = t - d.t0;
      if (this.snap) {
        var stepT = this._steps().translate;
        amount = Math.round(amount / stepT) * stepT;
      }
      target.position.copy(d.startPos).addScaledVector(d.dir, amount);
      status = '平移 ' + axisLabel + ' · ' + amount.toFixed(3) + ' m';

    } else if (this.mode === 'rotate') {
      var hr = this._planeHit(d.origin, d.dir);
      if (!hr) return;
      var cur = hr.clone().sub(d.origin);
      if (cur.lengthSq() < 1e-8) return;
      cur.normalize();
      if (!d.ref) { d.ref = cur.clone(); return; }
      var cross = new THREE.Vector3().crossVectors(d.ref, cur);
      var ang = Math.atan2(cross.dot(d.dir), d.ref.dot(cur));
      if (this.snap) {
        var stepR = this._steps().rotate;
        ang = Math.round(ang / stepR) * stepR;
      }
      d.angle = ang;
      var q = new THREE.Quaternion().setFromAxisAngle(d.dir, ang);
      target.quaternion.copy(d.startQuat).premultiply(q);
      status = '旋转 ' + axisLabel + ' · ' + (ang * 180 / Math.PI).toFixed(1) + '°';

    } else {
      var t2 = this._axisT(d.origin, d.dir);
      if (t2 == null) return;
      if (d.t0 == null) { d.t0 = t2; return; }
      var raw = 1 + (t2 - d.t0) / d.unit0;
      if (this.snap) {
        var stepS = this._steps().scale;
        raw = Math.max(stepS, Math.round(raw / stepS) * stepS);
      }
      raw = Math.max(0.02, Math.min(20, raw));
      target.scale.copy(d.startScale);
      target.scale.setComponent(d.axisIndex, d.startScale.getComponent(d.axisIndex) * raw);
      status = '缩放 ' + axisLabel + ' · ' + target.scale.getComponent(d.axisIndex).toFixed(3);
    }

    if (!d.changed) {
      if (d.kind === 'screen' || this.mode === 'rotate') d.changed = Math.abs(d.total || d.angle || 0) > 1e-4;
      else if (this.mode === 'translate') d.changed = d.startPos.distanceToSquared(target.position) > 1e-10;
      else d.changed = d.startScale.distanceToSquared(target.scale) > 1e-10;
    }
    if (status) this.onStatus(status);
    this.onChange({ mode: this.mode, axis: d.axis, kind: d.kind });
  };

  ModelTransformGizmo.prototype._pointerUp = function (e) {
    if (!this.drag || (e && e.pointerId !== this.drag.pointerId)) return;
    var d = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch (err) {}
    if (this.controls) this.controls.enabled = true;
    this.constraint = null;   // 每段拖动结束就清约束，下一段不继承
    this.canvas.style.cursor = this._hover ? 'grab' : '';
    /* 拖动再小也算一次「操作结束」：提交与否由 onEnd 里比较快照决定 */
    this.onEnd({ mode: d.mode, axis: d.axis, kind: d.kind, changed: d.changed });
  };

  ModelTransformGizmo.prototype.dispose = function () {
    this._clearTracking();
    this.target = null;
    this.canvas.removeEventListener('pointerdown', this._onDown, true);
    this.canvas.removeEventListener('pointermove', this._onMove, true);
    global.removeEventListener('pointerup', this._onUp, true);
    global.removeEventListener('pointercancel', this._onUp, true);
    if (this.scene) this.scene.remove(this.group);
    this.group.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (this._pickMat) this._pickMat.dispose();
    this.handles = [];
    this._billboards = [];
  };

  global.ModelTransformGizmo = ModelTransformGizmo;
})(typeof window !== 'undefined' ? window : globalThis);
