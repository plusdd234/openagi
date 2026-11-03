/* 求值 / 缓存层（架构层 ③ evaluator）
 *
 * 职责：base mesh + 节点修改器栈 → evaluated mesh；脏标记、显示缓存失效。
 * M1 只留接口与空壳：文档里 modifiers 恒为空，求值直接返回 base mesh（seed-model-scene 的缓存网格）。
 * P3 才接修改器求值，所以这里**不实现任何求值逻辑**，也不让上层依赖它的内部结构。
 *
 * 对外（window.SeedModel.Evaluator）：
 *   evaluate(doc, node) → mesh（M1 恒为 base mesh，失败返回 null）
 *   invalidate(nodeId) / clearDirty(nodeId) / isDirty(nodeId)
 */
(function (global) {
  'use strict';

  var M = global.SeedModel = global.SeedModel || {};
  var dirty = Object.create(null);

  function sceneApi() { return M.Scene || null; }

  function evaluate(doc, node) {
    var scene = sceneApi();
    if (!scene || !doc) return null;
    if (!node) node = scene.nodeOf(doc);
    var base = scene.getMesh(doc);
    if (!base) return null;
    /* M1：没有修改器栈。这里刻意不复制网格 —— 上层拿到的是同一份 base mesh，
     * 只读使用；之后再改网格必须经过 mesh-core 并 bump 版本号。 */
    return base;
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
