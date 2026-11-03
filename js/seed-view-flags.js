/* ============================================================
 * seed-view-flags.js —— 显示开关表（M6a / A4）
 *
 * 渲染主循环**不许再出现 `if (showX)`**。所有「显示/隐藏」走这张表：
 *
 *   SeedViewFlags.get('grid')        // 读
 *   SeedViewFlags.set('grid', false) // 写 → 自动广播给订阅者
 *   SeedViewFlags.toggle('grid')
 *   SeedViewFlags.onChange(fn)       // 订阅（视口重建、UI 高亮都靠它）
 *
 * 八项：grid / edges / verts / backface / material / texture / lighting / wireframe
 *
 * ⚠ 新加开关只改 FLAGS 数组 + 订阅方各自处理；**不要**在渲染主干加分支。
 *
 * 对外：window.SeedViewFlags
 * ============================================================ */
(function (global) {
  'use strict';

  /* name → 默认值。顺序即「显示菜单」里的顺序。 */
  var FLAGS = [
    { name: 'grid', label: '栅格', def: true },
    { name: 'edges', label: '边线', def: true },
    { name: 'verts', label: '顶点', def: true },
    { name: 'backface', label: '背面', def: true },
    { name: 'material', label: '材质', def: true },
    { name: 'texture', label: '纹理', def: true },
    { name: 'lighting', label: '光照', def: true },
    { name: 'wireframe', label: '线框', def: false }
  ];

  var state = Object.create(null);
  var listeners = [];
  FLAGS.forEach(function (f) { state[f.name] = f.def; });

  function has(name) { return FLAGS.some(function (f) { return f.name === name; }); }
  function get(name) { return has(name) ? state[name] : undefined; }

  function set(name, v) {
    if (!has(name)) return false;
    var nv = !!v;
    if (state[name] === nv) return true;
    state[name] = nv;
    emit(name, nv);
    return true;
  }

  function toggle(name) {
    if (!has(name)) return false;
    return set(name, !state[name]);
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function emit(name, v) {
    /* 复制一份再遍历：订阅者可能在回调里再订阅/退订 */
    listeners.slice().forEach(function (fn) {
      try { fn(name, v, state); } catch (e) {}
    });
  }

  function all() {
    return FLAGS.map(function (f) {
      return { name: f.name, label: f.label, value: state[f.name], def: f.def };
    });
  }

  function reset() {
    FLAGS.forEach(function (f) { state[f.name] = f.def; });
    emit('*', null, state);
  }

  global.SeedViewFlags = {
    get: get,
    set: set,
    toggle: toggle,
    onChange: onChange,
    all: all,
    reset: reset,
    FLAGS: FLAGS
  };
})(typeof window !== 'undefined' ? window : this);
