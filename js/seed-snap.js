/* ============================================================
 * seed-snap.js —— 吸附服务（M6a / A3）
 *
 * 手柄与工具共用的「磁铁」。步长从偏好读，**不许写死 0.05**。
 *
 *   SeedSnap.setPrefs({ move: 0.05, rotate: 15, scale: 0.1 })
 *   SeedSnap.snapPoint(v3, { kind:'grid'|'vertex'|'edge'|'view' })
 *   SeedSnap.snapAngle(rad) / snapScale(s)
 *   SeedSnap.setMode('grid') / setEnabled(true)
 *
 * 对外：window.SeedSnap
 * ============================================================ */
(function (global) {
  'use strict';

  /* 默认步长 = 偏好里没配时的兜底（不是「写死」——是「默认」） */
  var DEFAULTS = { move: 0.05, rotate: 15, scale: 0.1 };
  var prefs = {
    move: DEFAULTS.move,
    rotate: DEFAULTS.rotate,
    scale: DEFAULTS.scale
  };
  var mode = 'grid';        // 'grid' | 'vertex' | 'edge' | 'view'
  var enabled = true;

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  function setPrefs(patch) {
    var p = patch || {};
    if (p.move != null) prefs.move = Math.abs(num(p.move, prefs.move));
    if (p.rotate != null) prefs.rotate = Math.abs(num(p.rotate, prefs.rotate));
    if (p.scale != null) prefs.scale = Math.abs(num(p.scale, prefs.scale));
    return getPrefs();
  }
  function getPrefs() { return { move: prefs.move, rotate: prefs.rotate, scale: prefs.scale, mode: mode, enabled: enabled }; }

  function setEnabled(v) { enabled = !!v; return enabled; }
  function setMode(m) {
    if (['grid', 'vertex', 'edge', 'view'].indexOf(m) < 0) return mode;
    mode = m; return mode;
  }

  /* 平移吸附：按 move 步长取整。kind 决定取整的轴（grid=世界轴；view=相机平面）
   * 这里只做「步长取整」；顶点/边中点吸附需要外部给候选点（见 snapTo） */
  function snapPoint(v, opts) {
    if (!enabled || !v) return v;
    var o = opts || {};
    var step = Math.abs(num(o.step, prefs.move)) || 0;
    if (!step) return v;
    if (v.x != null) v.x = Math.round(v.x / step) * step;
    if (v.y != null) v.y = Math.round(v.y / step) * step;
    if (v.z != null) v.z = Math.round(v.z / step) * step;
    return v;
  }

  /* 给一组候选点（世界坐标），返回离 target 最近且在 radius 内的点（或 null）。
   * 顶点 / 边中点吸附都靠它 —— 别在调用方各写一份距离比较。 */
  function snapTo(target, candidates, radius) {
    if (!enabled || !target || !candidates || !candidates.length) return null;
    var r = Math.abs(num(radius, prefs.move)) || 0;
    var best = null, bestD = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c) continue;
      var dx = (c.x || 0) - (target.x || 0),
          dy = (c.y || 0) - (target.y || 0),
          dz = (c.z || 0) - (target.z || 0);
      var d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) return null;
    if (r && bestD > r * r) return null;
    return best;
  }

  function snapAngle(rad) {
    if (!enabled) return rad;
    var step = prefs.rotate * Math.PI / 180;
    if (!step) return rad;
    return Math.round(rad / step) * step;
  }

  function snapScale(s) {
    if (!enabled) return s;
    var step = prefs.scale;
    if (!step) return s;
    return Math.round(s / step) * step;
  }

  global.SeedSnap = {
    setPrefs: setPrefs,
    getPrefs: getPrefs,
    setEnabled: setEnabled,
    setMode: setMode,
    snapPoint: snapPoint,
    snapTo: snapTo,
    snapAngle: snapAngle,
    snapScale: snapScale,
    DEFAULTS: DEFAULTS
  };
})(typeof window !== 'undefined' ? window : this);
