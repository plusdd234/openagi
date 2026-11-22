/* 组件注册中心（ComponentRegistry · 分层路线第 1 步）
 *
 * 为什么单独成层：
 *   组件源（window.MDComponents）由各桥文件（如 js/md-lumen-bridge.js）自行登记，
 *   外壳 model-desk.js 之前直接遍历 reg.list、自己判断异步资产是否就绪、
 *   自己在打开文档前预载。规则（什么叫「就绪」、什么时候必须等）散在外壳里，
 *   外壳因此认识了组件的生命周期 —— 但它只该认识「怎么画」。
 *
 * 本模块只负责组件的**资产生命周期**，不认识任何具体零件、不碰 DOM / 历史：
 *   ① 目录：list / byId / current（当前选中项，找不到退回第一个）
 *   ② 就绪：pending(node)＝节点引用的异步组件资产还没读进来
 *   ③ 预载：ensure(doc) 打开文档前把引用到的异步资产读完，失败不阻塞
 *   ④ 汇总：hasPending(doc) 判断是否还有节点在等资产
 *
 * 组件源仍由桥文件登记到 window.MDComponents（list / get），本模块只做包装；
 * 读的时候现取全局，不缓存 —— 桥文件何时登记不影响这里。
 *
 * 对外（window.MDComponentRegistry）：
 *   list() / byId(id) / current(kind) / pending(node) / ensure(doc) / hasPending(doc)
 */
(function (global) {
  'use strict';

  function list() {
    var reg = global.MDComponents;
    return (reg && reg.list && reg.list.length) ? reg.list : [];
  }

  function byId(id) {
    var all = list();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* 当前面板选中的组件：kind 找不到就退回第一个，避免空面板。 */
  function current(kind) {
    return byId(kind) || list()[0] || null;
  }

  /* 异步组件源的资产是否还没读进来（例如刚重开页面就打开含头模的文档）。
   * 几何住在文档里，但 surface / groupMats / skin 全在组件源的缓存里 —— 没读进来时
   * 这些口一律返回空，材质会退回文档级槽贴图（可能就是别的模型的）。 */
  function pending(node) {
    if (!node || !node.comp || !node.comp.id) return false;
    var def = byId(node.comp.id);
    return !!(def && def.async && typeof def.ready === 'function' && !def.ready() &&
      typeof def.surface === 'function');
  }

  /* 打开文档前先把里面引用的异步组件资产读进来，再走 rebuildModel。
   * 不预载的后果：makeMaterials 先把文档级材质槽的贴图铺到脸上，而组件表面
   * （surface 返回空）没法接回来 —— 文档里只要有别的模型，头模就被别人的贴图盖住。
   * 读失败不阻塞打开：宁可先显示灰壳，也不要把别人的贴图当成它的。 */
  function ensure(doc) {
    var Scene = global.SeedModel && global.SeedModel.Scene;
    var nodes = (doc && Scene && Scene.nodesOf(doc)) || [];
    var seen = Object.create(null);
    var jobs = [];
    nodes.forEach(function (n) {
      var id = n.comp && n.comp.id;
      if (!id || seen[id]) return;
      seen[id] = 1;
      var def = byId(id);
      if (!def || !def.async || (typeof def.ready === 'function' && def.ready())) return;
      if (typeof def.load !== 'function') return;
      jobs.push(Promise.resolve().then(function () { return def.load(); }).catch(function () {}));
    });
    return jobs.length ? Promise.all(jobs) : Promise.resolve([]);
  }

  function hasPending(doc) {
    var Scene = global.SeedModel && global.SeedModel.Scene;
    var nodes = (doc && Scene && Scene.nodesOf(doc)) || [];
    for (var i = 0; i < nodes.length; i++) {
      if (pending(nodes[i])) return true;
    }
    return false;
  }

  global.MDComponentRegistry = {
    list: list,
    byId: byId,
    current: current,
    pending: pending,
    ensure: ensure,
    hasPending: hasPending
  };
})(typeof window !== 'undefined' ? window : globalThis);
