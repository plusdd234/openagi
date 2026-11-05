/* 历史栈：快照 + 网格指纹 + 字节预算
 *
 * 为什么单独成文件：撤销 / 重做是一条完整的闭环 —— 快照结构、网格去重、
 * 预算裁剪、应用还原，四件事必须一起改才不会失衡（比如只删条目不删网格副本，
 * 预算会永远超）。继续长在 model-desk.js 里，这条链会被视口 / 文档 IO 的代码割开。
 *
 * 两条铁律：
 *   - 快照必须带**每个节点自己的网格指纹**：单存 st.mesh 在多对象下会漏
 *     （新建球体后撤销 → 球体网格没存 → 撤不回几何）。
 *   - 画笔历史是「贴图补丁」，不是网格快照；应用时走 applyPaintPatch，别塞进 Scene。
 *
 * 对外（window.MDHistory）：create(ctx) → { snap, registerMesh, hashOf, push, clear,
 *   apply, undo, redo, totalBytes, syncBytes, meshStates }
 * 外壳保留同名门面（snap / pushHistory / clearHistory / undo / redo ...），原调用点不用改。
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var st = ctx.st, SeedModel = ctx.SeedModel;
    var HISTORY_BUDGET = ctx.historyBudget;
    var applyPaintPatch = ctx.applyPaintPatch;
    var rebuildModel = ctx.rebuildModel, paintAll = ctx.paintAll;
    var updateChrome = ctx.updateChrome, setStatus = ctx.setStatus;

    /* hash -> { mesh, bytes }：同一份网格会被多条快照引用，
     * 按内容哈希去重，预算才不会被重复副本吃光。 */
    var meshStore = Object.create(null);

    function hashOf(mesh) {
      try { return (mesh && SeedModel.Mesh.hash) ? SeedModel.Mesh.hash(mesh) : ''; } catch (e) { return ''; }
    }
    function registerMesh(mesh) {
      var h = hashOf(mesh);
      if (!h) return '';
      if (!meshStore[h]) {
        meshStore[h] = { mesh: SeedModel.Mesh.clone(mesh), bytes: SeedModel.Mesh.byteSize(mesh) };
      }
      return h;
    }

    function snap() {
      var s = SeedModel.Scene.snapshot(st.doc);
      s.meshHash = registerMesh(st.mesh);
      if (st.doc && Array.isArray(st.doc.nodes)) {
        var per = Object.create(null);
        st.doc.nodes.forEach(function (n) {
          try {
            var m = SeedModel.Scene.getMesh(st.doc, n);
            var h = m ? hashOf(m) : '';
            if (h) per[n.id] = registerMesh(m);
          } catch (e) {}
        });
        if (Object.keys(per).length) s.meshHashes = per;
      }
      return s;
    }

    function entryBytes(e) {
      return (JSON.stringify(e.before).length + JSON.stringify(e.after).length) * 2;
    }
    function refHashes(set, e) {
      if (e.before && e.before.meshHash) set[e.before.meshHash] = 1;
      if (e.after && e.after.meshHash) set[e.after.meshHash] = 1;
      ['before', 'after'].forEach(function (side) {
        var per = e[side] && e[side].meshHashes;
        if (per) Object.keys(per).forEach(function (id) { set[per[id]] = 1; });
      });
    }
    function gcMeshes() {
      var keep = Object.create(null);
      st.history.undo.forEach(function (e) { refHashes(keep, e); });
      st.history.redo.forEach(function (e) { refHashes(keep, e); });
      if (st.mesh) {
        var cur = hashOf(st.mesh);
        if (cur) keep[cur] = 1;
      }
      Object.keys(meshStore).forEach(function (k) { if (!keep[k]) delete meshStore[k]; });
    }
    function totalBytes() {
      var n = 0;
      st.history.undo.forEach(function (e) { n += e.bytes; });
      st.history.redo.forEach(function (e) { n += e.bytes; });
      Object.keys(meshStore).forEach(function (k) { n += meshStore[k].bytes; });
      return n;
    }
    function syncBytes() {
      gcMeshes();
      st.history.bytes = totalBytes();
    }
    function meshStates() {
      return Object.keys(meshStore).length;
    }

    function editKey(s) {
      return s ? JSON.stringify({ name: s.name, nodes: s.nodes, mesh: s.meshHash || '' }) : '';
    }
    function push(before, after, label) {
      if (!before || !after) return false;
      if (editKey(before) === editKey(after)) return false;
      var entry = { before: before, after: after, label: label, bytes: 0 };
      entry.bytes = entryBytes(entry);
      st.history.undo.push(entry);
      st.history.redo = [];
      /* 至少留一条：预算再小也要能撤一步，否则用户点撤销毫无反应。 */
      while (st.history.undo.length > 1 && totalBytes() > HISTORY_BUDGET) {
        st.history.undo.shift();
      }
      syncBytes();
      updateChrome();
      return true;
    }
    function clear(reason) {
      st.history.undo = [];
      st.history.redo = [];
      st.history.bytes = 0;
      meshStore = Object.create(null);
      if (st.doc && st.doc.historyBoundary) {
        st.doc.historyBoundary.undoPersisted = false;
        st.doc.historyBoundary.loadedAtRevision = st.doc.revision.current;
        st.doc.historyBoundary.historyResetReason = reason || '';
      }
      updateChrome();
    }

    function apply(entry, target) {
      /* 画笔历史是「贴图补丁」，没有网格 / 节点快照 */
      if (entry.patch) { applyPaintPatch(entry.patch, target); return; }
      var s = entry[target];
      SeedModel.Scene.applySnapshot(st.doc, s);
      /* 先按「每个节点自己的指纹」还原（多对象），再兜底 active 那个 */
      if (s && s.meshHashes) {
        Object.keys(s.meshHashes).forEach(function (id) {
          var h = s.meshHashes[id];
          var rec = meshStore[h];
          if (!rec) return;
          var node = null;
          var nodes = SeedModel.Scene.nodesOf(st.doc);
          for (var k = 0; k < nodes.length; k++) if (nodes[k].id === id) { node = nodes[k]; break; }
          if (!node) return;
          var cur = SeedModel.Scene.getMesh(st.doc, node);
          if (hashOf(cur) !== h) {
            SeedModel.Scene.setMesh(st.doc, SeedModel.Mesh.clone(rec.mesh), node);
          }
        });
      }
      if (s && s.meshHash) {
        var rec2 = meshStore[s.meshHash];
        if (rec2 && hashOf(SeedModel.Scene.getMesh(st.doc)) !== s.meshHash) {
          SeedModel.Scene.setMesh(st.doc, SeedModel.Mesh.clone(rec2.mesh));
        }
      }
      st.node = SeedModel.Scene.nodeOf(st.doc);
      st.mesh = SeedModel.Scene.getMesh(st.doc);
      rebuildModel(true);
      paintAll();
    }

    function undo() {
      var entry = st.history.undo.pop();
      if (!entry) return false;
      st.history.redo.push(entry);
      apply(entry, 'before');
      syncBytes();
      updateChrome();
      setStatus('已撤销：' + (entry.label || '编辑'));
      return true;
    }
    function redo() {
      var entry = st.history.redo.pop();
      if (!entry) return false;
      st.history.undo.push(entry);
      apply(entry, 'after');
      syncBytes();
      updateChrome();
      setStatus('已重做：' + (entry.label || '编辑'));
      return true;
    }

    return {
      snap: snap, registerMesh: registerMesh, hashOf: hashOf,
      push: push, clear: clear, apply: apply, undo: undo, redo: redo,
      totalBytes: totalBytes, syncBytes: syncBytes, meshStates: meshStates
    };
  }

  global.MDHistory = { create: create };
})(window);
