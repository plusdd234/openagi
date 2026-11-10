/* 对象级编辑与算子：复制 / 删除 / 隐藏 / 结合 / 分离 / 布尔
 *
 * 为什么单独成文件：这些命令全都长在同一条流水线上 ——
 * 抓快照（snap）→ 改文档 → 重建视口（rebuildModel）→ 记一条历史（pushHistory）。
 * 每个命令各写一遍快照逻辑迟早会漏，所以只有 docEdit 一个入口；
 * 继续留在 model-desk.js 里，这条流水线会被快捷键 / 热盒 / 菜单的代码割断。
 *
 * 两条铁律：
 *   - 改文档前重新解一次激活节点（st.node 只是缓存，可能指着别的对象）。
 *   - 命令失败（返回 false）时不能留下半成品：docEdit 直接返回，不记历史、不重建。
 *
 * 对外（window.MDObjOps）：create(ctx) → { docEdit, duplicateNode, dupNodes,
 *   deleteActiveNode, joinSelectedNodes, separateActiveNode, booleanSelectedNodes,
 *   toggleActiveVisible }
 * 外壳保留同名门面，快捷键 / 热盒 / 菜单的调用点一行都不用改。
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var st = ctx.st, THREE = ctx.THREE;
    var SeedModel = ctx.SeedModel, SeedOps = ctx.SeedOps;
    var snap = ctx.snap, pushHistory = ctx.pushHistory, rebuildModel = ctx.rebuildModel;
    var paintAll = ctx.paintAll, paintSelection = ctx.paintSelection;
    var syncSelectionDoc = ctx.syncSelectionDoc, syncGizmo = ctx.syncGizmo;
    var modsBlockComponents = ctx.modsBlockComponents || function () { return false; };
    var setStatus = ctx.setStatus;

    /* 统一入口：抓 before → 改文档 → 重建 → 抓 after → 一条历史。
     * 复制/删除/隐藏都走这里，避免每个命令各写一遍快照逻辑。 */
    function docEdit(label, fn) {
      if (!st.doc) return false;
      var before = snap();
      /* ⚠ 重新解一次激活节点：st.node 是缓存，可能指着别的对象
       * （用户在大纲/视口里换过激活，或 getState() 同步过）。
       * 让 fn 改的是「当前激活对象」，不是缓存里的那个。 */
      st.node = SeedModel.Scene.nodeOf(st.doc);
      st.mesh = SeedModel.Scene.getMesh(st.doc);
      var ok = fn();
      if (ok === false) return false;
      st.node = SeedModel.Scene.nodeOf(st.doc);
      st.mesh = SeedModel.Scene.getMesh(st.doc);
      rebuildModel(true);
      var after = snap();
      pushHistory(before, after, label);
      paintAll();
      return true;
    }

    function duplicateNode() { return dupNodes(1, 0.4); }

    /* 复制 n 份，每份沿对象自身 X 轴错开 offset（0 就完全重合，肉眼看不出来） */
    function dupNodes(count, offset) {
      var doc = st.doc;
      if (!doc) return false;
      var src = SeedModel.Scene.nodeOf(doc);
      if (!src) return false;
      var mesh = SeedModel.Scene.getMesh(doc, src);
      if (!mesh) return false;
      count = Math.max(1, Math.min(20, Math.round(Number(count) || 1)));
      offset = Math.max(0, Math.min(2, Number(offset) || 0));
      var t = src.transform;
      var q = new THREE.Quaternion().fromArray(t.rotation);
      var step = new THREE.Vector3(offset, 0, 0).applyQuaternion(q);
      var ok = docEdit(count > 1 ? '复制对象 ×' + count : '复制对象', function () {
        var last = null;
        for (var i = 1; i <= count; i++) {
          last = SeedModel.Scene.addMeshNode(doc, {
            name: src.name + ' 副本' + (count > 1 ? ' ' + i : ''),
            mesh: SeedModel.Mesh.clone(mesh),
            transform: {
              position: [t.position[0] + step.x * i, t.position[1] + step.y * i, t.position[2] + step.z * i],
              rotation: t.rotation.slice(),
              scale: t.scale.slice()
            }
          });
        }
        if (!last) return false;
        SeedModel.Scene.setActiveNode(doc, last.id);
        st.autoName = false;
        return true;
      });
      /* 复制完选择落在副本上：多选集合也要换过来，否则开启单独显示时
       * 会把「原对象 + 副本」一起定格。 */
      if (ok) {
        var cur = SeedModel.Scene.nodeOf(doc);
        st.nodeIds = cur ? [cur.id] : [];
      }
      return ok;
    }

    function deleteActiveNode() {
      var doc = st.doc;
      if (!doc) return false;
      var node = SeedModel.Scene.nodeOf(doc);
      if (!node) return false;
      var ok = docEdit('删除对象', function () {
        var removed = SeedModel.Scene.removeNode(doc, node.id);
        if (!removed) return false;
        var next = SeedModel.Scene.nodeOf(doc);
        if (next) SeedModel.Scene.setActiveNode(doc, next.id);
        return true;
      });
      /* 删到空场景也是合法状态：节点没了，多选 / 组件选择都要跟着清，别留下失主 id */
      var next = SeedModel.Scene.nodeOf(doc);
      st.nodeIds = next ? [next.id] : [];
      st.sel = { vertexIds: [], edgeIds: [], faceIds: [] };
      syncSelectionDoc();
      paintSelection();
      syncGizmo();
      var left = SeedModel.Scene.nodesOf(doc).length;
      setStatus(ok
        ? (left ? '已删除对象（剩 ' + left + ' 个对象，Ctrl+Z 可撤销）'
          : '已删除对象（场景已空，可用「新建」再建一个，Ctrl+Z 可撤销）')
        : '删除失败');
      return ok;
    }

    /* ------------------------------------------------ 结合 / 分离 / 布尔 */

    function nodeMatrix(n) {
      var q = new THREE.Quaternion().fromArray(n.transform.rotation || [0, 0, 0, 1]);
      return new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(n.transform.position || [0, 0, 0]),
        q,
        new THREE.Vector3().fromArray(n.transform.scale || [1, 1, 1])
      );
    }

    function bakeMeshTo(mesh, matrix) {
      var M = SeedModel.Mesh;
      var out = M.clone(mesh);
      M.ensureRawIndices(out);
      var v = new THREE.Vector3();
      for (var i = 0; i < out.positions.length; i += 3) {
        v.set(out.positions[i], out.positions[i + 1], out.positions[i + 2]).applyMatrix4(matrix);
        out.positions[i] = v.x; out.positions[i + 1] = v.y; out.positions[i + 2] = v.z;
      }
      M.bump(out);
      return out;
    }

    function selectedOpNodes() {
      var doc = st.doc;
      if (!doc) return [];
      var all = SeedModel.Scene.nodesOf(doc);
      var ids = st.nodeIds && st.nodeIds.length ? st.nodeIds : [doc.activeNodeId];
      var list = [];
      for (var i = 0; i < all.length; i++) if (ids.indexOf(all[i].id) >= 0) list.push(all[i]);
      if (!list.length) {
        var act = SeedModel.Scene.nodeOf(doc);
        if (act) list.push(act);
      }
      return list;
    }

    function clearComponentSelection() {
      st.sel = { vertexIds: [], edgeIds: [], faceIds: [] };
      syncSelectionDoc();
      paintSelection();
      syncGizmo();
    }

    function joinSelectedNodes() {
      var doc = st.doc;
      if (!doc) return false;
      var list = selectedOpNodes();
      if (list.length < 2) {
        setStatus('结合：请在大纲中按住 Ctrl/Shift 多选至少两个对象', true);
        return false;
      }
      var target = SeedModel.Scene.nodeOf(doc);
      if (list.indexOf(target) < 0) target = list[0];
      var targetInv = nodeMatrix(target).invert();
      var merged = SeedModel.Mesh.clone(SeedModel.Scene.getMesh(doc, target));
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (n.id === target.id) continue;
        var m = SeedModel.Scene.getMesh(doc, n);
        if (!m) continue;
        var local = bakeMeshTo(m, new THREE.Matrix4().multiplyMatrices(targetInv, nodeMatrix(n)));
        SeedModel.Mesh.append(merged, local);
      }
      var ok = docEdit('结合对象', function () {
        for (var j = 0; j < list.length; j++) {
          if (list[j].id !== target.id) SeedModel.Scene.removeNode(doc, list[j].id);
        }
        SeedModel.Scene.setMesh(doc, merged, target);
        SeedModel.Scene.setActiveNode(doc, target.id);
        return true;
      });
      if (!ok) return false;
      st.nodeIds = [target.id];
      st.node = SeedModel.Scene.nodeOf(doc);
      st.mesh = SeedModel.Scene.getMesh(doc);
      clearComponentSelection();
      paintAll();
      setStatus('已结合 ' + list.length + ' 个对象 → ' + target.name);
      return true;
    }

    function separateActiveNode() {
      var doc = st.doc;
      var node = SeedModel.Scene.nodeOf(doc);
      if (!node) return false;
      var parts = SeedOps.splitLooseParts(SeedModel.Scene.getMesh(doc, node));
      if (!parts || parts.length < 2) {
        setStatus('分离：当前网格只有一个连通块', true);
        return false;
      }
      var added = [];
      var ok = docEdit('分离对象', function () {
        SeedModel.Scene.setMesh(doc, parts[0], node);
        var t = node.transform;
        for (var i = 1; i < parts.length; i++) {
          added.push(SeedModel.Scene.addMeshNode(doc, {
            name: node.name + ' 分离 ' + (i + 1),
            mesh: parts[i],
            transform: {
              position: t.position.slice(),
              rotation: t.rotation.slice(),
              scale: t.scale.slice()
            }
          }));
        }
        return true;
      });
      if (!ok) return false;
      st.nodeIds = [node.id].concat(added.map(function (n) { return n.id; }));
      st.node = SeedModel.Scene.nodeOf(doc);
      st.mesh = SeedModel.Scene.getMesh(doc);
      clearComponentSelection();
      paintAll();
      setStatus('已按连通块分离出 ' + parts.length + ' 个对象');
      return true;
    }

    /* 按 UV 岛拆分：把选中的岛（面集）拆成一个独立对象。
     * 岛模式的选择集本来就是整岛（拾取 / 模式转换都会展开），这里再按 uvIslands
     * 补一次 —— 防止「面模式里攒下的零散面」被当成半只岛拆出去。
     * 只拆「一部分」：全选没有可留的原网格，直接拒绝。 */
    function splitSelectedIslands() {
      var doc = st.doc;
      if (!doc) return false;
      var node = SeedModel.Scene.nodeOf(doc);
      if (!node) return false;
      if (modsBlockComponents()) {
        setStatus('拆分 UV 岛：该对象有修改器，先「应用修改器」或删掉再拆', true);
        return false;
      }
      var mesh = SeedModel.Scene.getMesh(doc, node);
      if (!mesh) return false;
      var faceIds = (st.sel && st.sel.faceIds) ? st.sel.faceIds.slice() : [];
      if (!faceIds.length) {
        setStatus('拆分 UV 岛：先在 UV 岛模式（F12）里选中要拆的岛', true);
        return false;
      }

      var islandN = 0;
      try {
        var isl = SeedModel.Mesh.uvIslands(mesh);
        var want = Object.create(null);
        faceIds.forEach(function (id) { want[id] = 1; });
        var seen = Object.create(null);
        var set = Object.create(null);
        for (var f = 0; f < mesh.faceIds.length; f++) {
          if (!want[mesh.faceIds[f]]) continue;
          var iid = isl.faceIsland[f];
          var faces = (iid != null && iid >= 0 && isl.islands[iid]) ? isl.islands[iid].faces : null;
          if (iid != null && iid >= 0 && !seen[iid]) { seen[iid] = 1; islandN++; }
          set[mesh.faceIds[f]] = 1;
          /* 岛模式：同岛的面一起走；面模式只拆实际选中的面 */
          if (st.selMode === 'island' && faces) {
            for (var k = 0; k < faces.length; k++) set[mesh.faceIds[faces[k]]] = 1;
          }
        }
        faceIds = Object.keys(set).map(Number);
      } catch (e) { islandN = 0; }

      var res = SeedOps.extractFaces(mesh, faceIds);
      if (!res) {
        setStatus('拆分 UV 岛：选中的面覆盖了整份网格，没有可留下的部分', true);
        return false;
      }

      var added = null;
      var ok = docEdit('拆分 UV 岛', function () {
        var t = node.transform;
        SeedModel.Scene.setMesh(doc, res.keep, node);
        added = SeedModel.Scene.addMeshNode(doc, {
          name: node.name + ' 拆分',
          mesh: res.part,
          transform: {
            position: t.position.slice(),
            rotation: t.rotation.slice(),
            scale: t.scale.slice()
          }
        });
        if (!added) return false;
        SeedModel.Scene.setActiveNode(doc, added.id);
        return true;
      });
      if (!ok) return false;
      st.nodeIds = [added.id];
      st.node = SeedModel.Scene.nodeOf(doc);
      st.mesh = SeedModel.Scene.getMesh(doc);
      clearComponentSelection();
      paintAll();
      setStatus('已把 ' + faceIds.length + ' 个面'
        + (islandN ? '（' + islandN + ' 个 UV 岛）' : '') + '拆成独立对象：' + added.name);
      return true;
    }

    function booleanSelectedNodes() {
      var doc = st.doc;
      if (!doc) return false;
      var list = selectedOpNodes();
      if (list.length !== 2) {
        setStatus('布尔：请在大纲中按住 Ctrl/Shift 选择恰好两个对象（激活对象为 A）', true);
        return false;
      }
      var A = SeedModel.Scene.nodeOf(doc);
      if (list.indexOf(A) < 0) A = list[0];
      var B = list[0].id === A.id ? list[1] : list[0];
      var meshA = SeedModel.Scene.getMesh(doc, A);
      var meshB = SeedModel.Scene.getMesh(doc, B);
      if (!meshA || !meshB) return false;
      var bLocal = bakeMeshTo(meshB, new THREE.Matrix4().multiplyMatrices(nodeMatrix(A).invert(), nodeMatrix(B)));
      var result = null;
      try {
        result = SeedOps.booleanMeshes(meshA, bLocal, 'subtract');
      } catch (err) {
        result = null;
      }
      if (!result) {
        setStatus('布尔失败：对象需要是封闭网格，或结果面数超出上限', true);
        return false;
      }
      var ok = docEdit('布尔差集', function () {
        SeedModel.Scene.setMesh(doc, result, A);
        SeedModel.Scene.removeNode(doc, B.id);
        SeedModel.Scene.setActiveNode(doc, A.id);
        return true;
      });
      if (!ok) return false;
      st.nodeIds = [A.id];
      st.node = SeedModel.Scene.nodeOf(doc);
      st.mesh = SeedModel.Scene.getMesh(doc);
      clearComponentSelection();
      paintAll();
      setStatus('已执行布尔差集：' + A.name + ' − ' + B.name);
      return true;
    }

    function toggleActiveVisible() {
      var doc = st.doc;
      var node = doc && SeedModel.Scene.nodeOf(doc);
      if (!node) return false;
      var willHide = node.visible !== false;
      var ok = docEdit(willHide ? '隐藏对象' : '显示对象', function () {
        node.visible = !willHide;
        return true;
      });
      if (ok) setStatus(willHide ? '对象已隐藏（H 再按一次显示）' : '对象已显示');
      return ok;
    }

    return {
      docEdit: docEdit,
      duplicateNode: duplicateNode,
      dupNodes: dupNodes,
      deleteActiveNode: deleteActiveNode,
      joinSelectedNodes: joinSelectedNodes,
      separateActiveNode: separateActiveNode,
      splitSelectedIslands: splitSelectedIslands,
      booleanSelectedNodes: booleanSelectedNodes,
      toggleActiveVisible: toggleActiveVisible
    };
  }

  global.MDObjOps = { create: create };
}(window));
