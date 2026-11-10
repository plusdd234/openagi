/* 求值 / 缓存层（架构层 ③ evaluator）
 *
 * 职责：base mesh + 节点修改器栈 → evaluated mesh；脏标记、显示缓存失效。
 *
 * 两条硬约束：
 *   ① base 没有（生效的）修改器时，必须**原样返回 Scene.getMesh 的对象**。
 *      老调用点（model-desk / md-isolate）默认网格只读且可原地标脏，换一份副本就会
 *      让「改网格 → 视口更新」链路断掉。
 *   ② 缓存键必须同时包含 base 网格版本、修改器参数、revision.modifiers。
 *      少了任何一项都会在「改了一个参数却看到旧网格」上翻车；base 版本用对象
 *      身份 + mesh.version 判断（对象被换掉、原地 bump 都能失效）。
 *
 * 对外（window.SeedModel.Evaluator）：
 *   evaluate(doc, node) → mesh（失败返回 null，调用点会回退到 base）
 *   invalidate(nodeId) / clearDirty(nodeId) / isDirty(nodeId)
 */
(function (global) {
  'use strict';

  var M = global.SeedModel = global.SeedModel || {};
  var dirty = Object.create(null);
  var cacheRoot = typeof WeakMap === 'function' ? new WeakMap() : null;
  var baseTags = typeof WeakMap === 'function' ? new WeakMap() : null;
  var baseTagSeq = 0;

  function sceneApi() { return M.Scene || null; }
  function modifiersApi() { return M.Modifiers || global.SeedModifiers || null; }

  function bucketOf(doc, create) {
    if (!cacheRoot) return null;
    var b = cacheRoot.get(doc);
    if (!b && create) { b = Object.create(null); cacheRoot.set(doc, b); }
    return b || null;
  }

  /* 对象身份标签：mesh.version 只在「同一份对象被 bump」时可靠；
   * setMesh 换成一个同版本的克隆对象时，只有对象身份能区分。 */
  function baseTagOf(mesh) {
    if (!baseTags) return '0';
    var t = baseTags.get(mesh);
    if (!t) { baseTagSeq += 1; t = baseTagSeq; baseTags.set(mesh, t); }
    return String(t);
  }

  function stableParam(v) {
    if (v === undefined) return 'u';
    if (v === null) return 'null';
    var tv = typeof v;
    if (tv === 'number' || tv === 'boolean') return String(v);
    if (tv === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(stableParam(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (tv === 'object') {
      var keys = Object.keys(v).sort();
      var seg = [];
      for (var k = 0; k < keys.length; k++) seg.push(JSON.stringify(keys[k]) + ':' + stableParam(v[keys[k]]));
      return '{' + seg.join(',') + '}';
    }
    return String(v);
  }

  function cacheKeyOf(doc, base, items) {
    var rev = doc && doc.revision ? doc.revision.modifiers || 0 : 0;
    return baseTagOf(base) + ':' + (base.version || 0) + ':' +
      base.vertexIds.length + ':' + base.faceIds.length + '|' + rev + '|' + stableParam(items);
  }

  function evaluate(doc, node) {
    var scene = sceneApi();
    if (!scene || !doc) return null;
    if (!node) node = scene.nodeOf(doc);
    var base = scene.getMesh(doc, node);
    if (!base) return null;

    var mods = modifiersApi();
    var stack = (node && Array.isArray(node.modifiers)) ? node.modifiers : [];
    var items = [];
    var i;
    for (i = 0; i < stack.length; i++) {
      /* 只把「支持的、启用的」当修改器；未知类型忽略，避免旧文件一打开就整只模型消失 */
      if (mods && mods.isActive(stack[i])) items.push(stack[i]);
    }
    /* 没有生效修改器 = 老行为：同一份 base，不做任何复制与缓存 */
    if (!items.length) return base;

    var nodeKey = String((node && node.id) || '*');
    var bucket = bucketOf(doc, true);
    if (bucket) {
      /* invalidate(nodeId) 只负责把这一格的缓存作废；'*' 表示全部作废 */
      if (dirty[nodeKey]) { delete bucket[nodeKey]; delete dirty[nodeKey]; }
      else if (dirty['*']) { delete bucket[nodeKey]; }
    }

    var key = null;
    try { key = cacheKeyOf(doc, base, items); } catch (e) { key = null; }
    if (bucket && key) {
      var rec = bucket[nodeKey];
      if (rec && rec.key === key) return rec.mesh;
    }

    var out = null;
    try {
      out = mods.apply(base, items);
    } catch (e) {
      /* 参数非法 / 超出面数上限：宁可回退到 base，也不要把坏网格塞进视口 */
      out = null;
    }
    if (!out) return null;
    if (bucket && key) bucket[nodeKey] = { key: key, mesh: out };
    return out;
  }

  function invalidate(nodeId) {
    dirty[String(nodeId || '*')] = true;
  }

  function clearDirty(nodeId) {
    if (nodeId == null) dirty = Object.create(null);
    else delete dirty[String(nodeId)];
  }

  function isDirty(nodeId) {
    return !!dirty['*'] || !!dirty[String(nodeId || '')];
  }

  M.Evaluator = {
    evaluate: evaluate,
    invalidate: invalidate,
    clearDirty: clearDirty,
    isDirty: isDirty
  };
})(typeof window !== 'undefined' ? window : globalThis);
