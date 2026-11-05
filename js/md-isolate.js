/* 单独显示（隔离所选）：视口层的定格过滤，不写文档
 *
 * 为什么单独成文件：这段逻辑（对象级隐藏 + 面/岛级替身网格）自洽，
 * 但要读外壳的 pivot 表、材质和边线工厂；放在 model-desk.js 里只会继续推高行数。
 *
 * 三条铁律：
 *   - 只切 pivot.visible，文档里的 node.visible 一律不动；
 *     所以退出隔离后原来手动隐藏的对象还是隐藏的。
 *   - 面 / UV 岛模式的替身只进视口，不进文档；退出隔离时直接扔掉。
 *   - 开启那一刻把选择**定格成快照**：之后取消选中（比如点空白、换选别处）
 *     都不会改变隔离空间 —— 选了头部就一直是头部，方便在零件上继续绘制；
 *     要恢复整个场景只能再点一次 ◱。
 *   - 可见性只有一个出口：nodeVisible(id) / visibleMesh(id)。拾取、区域选择、
 *     绘画、切割、手柄都从这里取 —— 别在任何地方再写一份「这个能不能点」的推断，
 *     否则迟早会出现「点穿隐藏物体」。
 *
 * 对外（window.MDIsolate）：create(ctx) → { apply, refresh, toggle, nodeVisible, visibleMesh }
 * 外壳仍用同名门面 applyIsolation / refreshIsoChild / toggleIsolate 调用。
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var st = ctx.st, THREE = ctx.THREE, SeedModel = ctx.SeedModel;
    var applyShading = ctx.applyShading;
    var makeMaterials = ctx.makeMaterials, buildEdgeLinesFor = ctx.buildEdgeLinesFor;
    var setStatus = ctx.setStatus, updateChrome = ctx.updateChrome;

    /* 隔离快照：开启时定格的「对象 + 面」，之后不再读 st.sel。
     * nodeId = 定格时的激活对象（组件替身挂它的 pivot 上）。 */
    var iso = { nodeIds: [], nodeId: '', faceIds: [] };
    /* 定格面的替身网格缓存：拾取 / 绘制 / 渲染共用同一份，避免每次点一下都重切一次 */
    var subCache = { key: '', mesh: null };

    /* 开启那一刻该定格哪些对象：
     *   对象模式 = 大纲多选（nodeIds）∪ 激活对象；
     *   组件模式 = 激活对象（组件只存在于它的网格上）。
     * 与文档里真实存在的节点取交集：换文档 / 撤销后可能残留旧 id。 */
    function shownNodeIds() {
      var nodes = SeedModel.Scene.nodesOf(st.doc);
      var alive = Object.create(null);
      nodes.forEach(function (n) { alive[n.id] = 1; });
      var ids = [];
      if (st.selMode === 'object') {
        (st.nodeIds || []).forEach(function (id) {
          if (alive[id] && ids.indexOf(id) < 0) ids.push(id);
        });
      }
      if (st.node && alive[st.node.id] && ids.indexOf(st.node.id) < 0) ids.push(st.node.id);
      return ids;
    }

    /* 先定「哪些对象可见」，再给定格对象建组件替身。快照里的对象被删光时
     * 退到激活对象，避免隔离还开着、视口却全空。 */
    function apply() {
      if (!st.doc || !st.pivots) return;
      var nodes = SeedModel.Scene.nodesOf(st.doc);
      var alive = Object.create(null);
      nodes.forEach(function (n) { alive[n.id] = 1; });
      var ids = st.isolate ? iso.nodeIds.filter(function (id) { return alive[id]; }) : [];
      if (st.isolate && !ids.length && st.node && alive[st.node.id]) ids = [st.node.id];
      var keep = Object.create(null);
      ids.forEach(function (id) { keep[id] = 1; });
      nodes.forEach(function (n) {
        var pv = st.pivots[n.id];
        if (!pv) return;
        pv.visible = st.isolate ? !!keep[n.id] : (n.visible !== false);
        if (!pv.visible) disposeGroup(pv);
      });
      refresh();
    }

    /* 定格对象当前的网格：激活对象直接用 st.mesh（含修改器求值结果），
     * 其余节点现算一份 —— 这样即使激活对象换了，头部替身也不会算错网格。 */
    function meshOf(node) {
      if (!node) return null;
      if (st.node && node.id === st.node.id && st.mesh) return st.mesh;
      try {
        return SeedModel.Evaluator.evaluate(st.doc, node) || SeedModel.Scene.getMesh(st.doc, node);
      } catch (e) {
        return SeedModel.Scene.getMesh(st.doc, node);
      }
    }

    /* 定格的面下标；不是面 / 岛模式或没选面时返回 null（整只对象都显示） */
    function faceSet(mesh) {
      if (!st.isolate || !mesh || !iso.faceIds.length) return null;
      var byId = Object.create(null), f;
      for (f = 0; f < mesh.faceIds.length; f++) byId[mesh.faceIds[f]] = f;
      var out = [];
      for (var i = 0; i < iso.faceIds.length; i++) {
        var fi = byId[iso.faceIds[i]];
        if (fi != null) out.push(fi);
      }
      out.sort(function (a, b) { return a - b; });
      return out.length ? out : null;
    }

    /* 从整份网格里抽出指定面，拼成一个「临时网格」：字段齐全，能直接喂 buildGeometry。
     * 同一个（网格版本 + 面集合）只切一次：拾取、绘制、渲染都读这份，口径不会分叉。 */
    function subMesh(mesh, faces) {
      var key = mesh.version + '|' + faces.join(',');
      if (subCache.mesh && subCache.key === key) return subCache.mesh;
      var hasUv = !!(mesh.uvs && mesh.uvs.length === mesh.faceIndices.length * 2);
      var offs = [0], indices = [], slots = [], ids = [], uvs = hasUv ? [] : null;
      for (var i = 0; i < faces.length; i++) {
        var f = faces[i], s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1];
        for (var c = s; c < e; c++) {
          indices.push(mesh.faceIndices[c]);
          if (hasUv) uvs.push(mesh.uvs[c * 2], mesh.uvs[c * 2 + 1]);
        }
        offs.push(indices.length);
        slots.push(mesh.faceSlots[f] || 0);
        ids.push(mesh.faceIds[f]);
      }
      var sub = {
        positions: mesh.positions, vertexIds: mesh.vertexIds,
        nextVertexId: mesh.nextVertexId, nextFaceId: mesh.nextFaceId,
        faceOffsets: offs, faceIndices: indices, faceSlots: slots, faceIds: ids,
        uvs: uvs, version: mesh.version
      };
      subCache.key = key; subCache.mesh = sub;
      return sub;
    }

    function nodeOfId(id) {
      var nodes = st.doc ? SeedModel.Scene.nodesOf(st.doc) : [];
      for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i];
      return null;
    }

    /* 视口可见性（唯一口径）：
     *   nodeVisible(id) —— 这个对象此刻在视口里看不看得见（含隔离与文档隐藏）；
     *   visibleMesh(id) —— 拾取 / 绘制该用哪份网格：面级隔离返回替身网格，
     *                     对象不可见返回 null。所有交互都从这里取，别各自算一套。 */
    function nodeVisible(id) {
      var pv = st.pivots && st.pivots[id];
      return !!(pv && pv.visible);
    }
    function visibleMesh(id) {
      if (!st.doc) return null;
      var node = nodeOfId(id);
      if (!node || !nodeVisible(node.id)) return null;
      var mesh = meshOf(node);
      if (!mesh) return null;
      if (!st.isolate || node.id !== iso.nodeId || !iso.faceIds.length) return mesh;
      var faces = faceSet(mesh);
      return faces ? subMesh(mesh, faces) : mesh;
    }

    /* 替身是自己建的，几何与材质都要销毁；共享贴图由材质 dispose 内部按 disposeMap 规则放过 */
    function disposeGroup(pv) {
      if (!pv || !pv.userData || !pv.userData.mdIsoMesh) return;
      var g = pv.userData.mdIsoMesh;
      if (g.parent) g.parent.remove(g);
      g.traverse(function (o) {
        if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < ms.length; i++) { if (ms[i]) { try { ms[i].dispose(); } catch (e2) {} } }
      });
      pv.userData.mdIsoMesh = null;
      pv.userData.mdIsoSig = '';
    }

    /* 网格一变就换替身；签名相同则复用，避免每次刷新都重建几何。
     * 只认定格的面集合，不认当前选择 —— 这是「取消选中仍保留」的关键。 */
    function refresh() {
      var nodes = st.doc ? SeedModel.Scene.nodesOf(st.doc) : [];
      var node = null;
      for (var i = 0; i < nodes.length; i++) if (nodes[i].id === iso.nodeId) { node = nodes[i]; break; }
      var pv = node ? st.pivots[node.id] : null;
      /* 替身只允许挂在定格对象上：其余 pivot 上残留的一律清掉 */
      Object.keys(st.pivots || {}).forEach(function (id) {
        if (st.pivots[id] !== pv) disposeGroup(st.pivots[id]);
      });
      if (!st.isolate || !pv) {
        st.isoComp = false; st.isoFaceCount = 0;
        if (pv) disposeGroup(pv);
        applyShading();
        return;
      }
      var mesh = meshOf(node);
      if (!mesh) { st.isoComp = false; st.isoFaceCount = 0; disposeGroup(pv); applyShading(); return; }
      var faces = faceSet(mesh);
      var sig = faces ? (mesh.version + '|' + faces.join(',')) : '';
      st.isoComp = !!faces;
      st.isoFaceCount = faces ? faces.length : 0;
      if (!faces) {
        disposeGroup(pv);
        applyShading();
        return;
      }
      if (pv.userData.mdIsoMesh && pv.userData.mdIsoSig === sig) { applyShading(); return; }
      disposeGroup(pv);
      var sub = subMesh(mesh, faces);
      var group = new THREE.Group();
      group.userData.mdIsolate = true;
      var solid = new THREE.Mesh(SeedModel.Mesh.buildGeometry(sub, { cache: false }), makeMaterials());
      solid.userData.mdPart = 'solid';
      solid.userData.mdIsolate = true;
      group.add(solid);
      var edges = buildEdgeLinesFor(sub, 'isolate-edges');
      edges.userData.mdIsolate = true;
      group.add(edges);
      pv.add(group);
      pv.userData.mdIsoMesh = group;
      pv.userData.mdIsoSig = sig;
      applyShading();
    }

    /* 定格：对象集合 + 激活对象 + 面 ID（面 ID 是稳定标识，网格改了也能找回） */
    function capture() {
      iso.nodeIds = shownNodeIds();
      iso.nodeId = st.node ? st.node.id : '';
      iso.faceIds = (st.selMode === 'face' || st.selMode === 'island')
        ? (st.sel.faceIds || []).slice()
        : [];
    }

    function toggle() {
      if (!st.doc || !st.node) { setStatus('单独显示：先在视口或大纲里选中一个对象', true); return false; }
      st.isolate = !st.isolate;
      if (st.isolate) capture();
      else { iso.nodeIds = []; iso.nodeId = ''; iso.faceIds = []; }
      apply();
      updateChrome();
      var faces = st.isoComp ? st.isoFaceCount : 0;
      setStatus(st.isolate
        ? ('单独显示：已定格 ' + iso.nodeIds.length + ' 个对象' + (faces ? ' / ' + faces + ' 个面' : '') +
          '（取消选择也不会消失，再点 ◱ 退出）')
        : '已退出单独显示：全部对象恢复显示');
      return st.isolate;
    }

    return { apply: apply, refresh: refresh, toggle: toggle, nodeVisible: nodeVisible, visibleMesh: visibleMesh };
  }

  global.MDIsolate = { create: create };
})(window);
