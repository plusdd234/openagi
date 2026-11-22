/* 场景文档 v2.1（架构层 ① scene-doc）
 *
 * 一个 GLB 的 asset.extras.seedModel 就是这里的完整文档；纯数据，没有旁路文件。
 *
 * v2.1 结构（2026-11-03 多对象化 B2a：从「一个网格」改成「一组网格」）：
 *   schemaVersion 2 / mode 'mesh' / storage 'json'
 *   revision        current 总版本 · source 规格版本（v1 遗留）· mesh 网格版本 · modifiers 修改器版本
 *   nodes[]         { id, type:'mesh'|'group', name, parent, transform, visible, meshRef, materialSlots, modifiers:[] }
 *   meshes          { meshId: meshJSON } —— 网格的**唯一真源**（见 seed-mesh-core.js）
 *                   ⚠ 老文件只有 mesh 字段，读入时迁移成 { main: mesh }；保存只写 meshes，不写 mesh
 *                   ⚠ 两个节点可以共用一个 meshId（等于实例：改一个两边都变）
 *   activeNodeId    当前激活节点（组件选择、属性面板、手柄都作用在它上面）
 *   selection       { mode, nodeIds, vertexIds, edgeIds, faceIds }，只存稳定 ID，不存数组下标
 *   materials       { slotNames, slotColors, textureConfigKey, textureConfigMissing }
 *                   贴图真源仍是 localStorage 的 openagi_model_tex_v1（D5），这里只记槽名 / 显示色 / 查询 key
 *   historyBoundary 重开清撤销：undoPersisted / loadedAtRevision / lastConversionRevision / historyResetReason
 *
 * 为什么不把 spec 当真相（D2）：
 *   v1 的参数化资产打开时一次性烘焙成可编辑网格；之后所有编辑都落在 mesh 上。
 *   旧文件不改、不覆盖：打开 v1 → 内存里转 v2 → 用户主动保存时才写回单个 GLB。
 *
 * 对外（window.SeedModel.Scene）：
 *   createDoc(opts) / validate(raw) / fromV1(raw) / isV1(raw) / detect(raw)
 *   getMesh(doc, node) / setMesh(doc, mesh, node) / nodeOf(doc) / nodesOf(doc) / stats(doc, node)
 *   addMeshNode(doc, opts) / removeNode(doc, id) / setActiveNode(doc, id) / activeNode(doc)
 *   setName / setSelection / setNodeTransform / revision(doc, kind)
 *   snapshot(doc) / applySnapshot(doc, snap) / toSeedModel(doc)
 */
(function (global) {
  'use strict';

  var M = global.SeedModel = global.SeedModel || {};
  var SCHEMA_VERSION = 2;
  var MESH_REF = 'main';
  /* doc → { meshId: 解码后的 mesh }：一个文档可能有多份网格，cache 也必须按 meshId 分桶 */
  var cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function cacheOf(doc) {
    var m = cache ? cache.get(doc) : null;
    if (!m) { m = Object.create(null); if (cache) cache.set(doc, m); }
    return m;
  }

  /* 网格映射的读取与迁移：meshes 是真源；只有 mesh 的老文件在这里补成 { main: mesh }。
   * 迁移只发生在内存里，用户主动保存时才写成新结构 —— 不静默覆盖旧文件。 */
  function meshesOf(raw) {
    var map = Object.create(null);
    if (raw && isObj(raw.meshes)) {
      Object.keys(raw.meshes).forEach(function (k) {
        if (isObj(raw.meshes[k])) map[k] = raw.meshes[k];
      });
    }
    if (!Object.keys(map).length && raw && isObj(raw.mesh)) map[MESH_REF] = raw.mesh;
    return { map: map, first: Object.keys(map)[0] || null };
  }

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function str(v, d) { var s = String(v == null ? '' : v); return s || d; }

  function quatNorm(q) {
    var len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (!(len > 1e-8)) return [0, 0, 0, 1];
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
  }

  function transformOf(t) {
    var o = isObj(t) ? t : {};
    var p = Array.isArray(o.position) ? o.position : [];
    var r = Array.isArray(o.rotation) ? o.rotation : [];
    var s = Array.isArray(o.scale) ? o.scale : [];
    return {
      position: [num(p[0], 0), num(p[1], 0), num(p[2], 0)],
      rotation: quatNorm([num(r[0], 0), num(r[1], 0), num(r[2], 0), num(r[3], 1)]),
      /* 0 缩放会让包围盒塌成一点，模型直接消失；统一挡掉 */
      scale: [num(s[0], 1) || 1, num(s[1], 1) || 1, num(s[2], 1) || 1]
    };
  }

  function revisionOf(r) {
    var o = isObj(r) ? r : {};
    var cur = Math.max(1, Math.round(num(o.current, 1)));
    return {
      current: cur,
      source: Math.max(0, Math.round(num(o.source, 0))),
      mesh: Math.max(0, Math.round(num(o.mesh, 1))),
      modifiers: Math.max(0, Math.round(num(o.modifiers, 0)))
    };
  }

  function selectionOf(s) {
    var o = isObj(s) ? s : {};
    function ids(v) {
      return Array.isArray(v) ? v.map(function (x) { return Math.round(num(x, -1)); })
        .filter(function (x) { return x >= 0; }) : [];
    }
    /* island = UV 岛选择：存的是岛内所有面的 ID（岛本身是派生结果，不稳定，不存） */
    var mode = ['object', 'vertex', 'edge', 'face', 'island'].indexOf(o.mode) >= 0 ? o.mode : 'object';
    return {
      mode: mode,
      nodeIds: Array.isArray(o.nodeIds) ? o.nodeIds.map(String) : [],
      vertexIds: ids(o.vertexIds),
      edgeIds: ids(o.edgeIds),
      faceIds: ids(o.faceIds)
    };
  }

  function materialsOf(m, assetId) {
    var o = isObj(m) ? m : {};
    var names = Array.isArray(o.slotNames) ? o.slotNames.map(function (n) { return String(n); }) : [];
    var colors = Array.isArray(o.slotColors) ? o.slotColors.map(function (c) { return String(c); }) : [];
    /* 导入时从源模型里抽出的基础色贴图（data URL）。只是显示用，不进 GLB 主材质，
     * 但跟着 seedModel 走，重开资产才不会又变回一片灰。 */
    var maps = Array.isArray(o.slotMaps) ? o.slotMaps.map(function (u) { return String(u || ''); }) : [];
    /* 材质稳定 id：改名 / 删槽 / 追加资产之后，纹理配置还认得住同一个材质。
     * 老文档没有这个字段，按位置补一个确定性的 id，打开后行为不变。 */
    var ids = Array.isArray(o.slotIds) ? o.slotIds.map(function (v) { return String(v); }) : [];
    for (var k = 0; k < names.length; k++) {
      if (!ids[k]) ids[k] = 'slot-' + (k + 1);
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colors[k] || '')) colors[k] = '#c9ccd4';
    }
    return {
      slotNames: names,
      slotIds: ids.slice(0, names.length),
      /* 只用于视口显示；贴图配置仍按 textureConfigKey 去 m3d-slots 查 */
      slotColors: colors.slice(0, names.length),
      slotMaps: maps.slice(0, names.length),
      textureConfigKey: str(o.textureConfigKey, assetId),
      textureConfigMissing: !!o.textureConfigMissing
    };
  }

  /* ---------------- 材质归属（meshId → 材质下标） ----------------
   * 材质库仍是文档级（slotNames / slotColors / slotMaps / slotIds 同长），
   * 但每个网格只「拥有」自己用到的下标。追加资产时源材质整体后移，
   * faceSlots 跟着重映射，两个模型就不会再落到同一批槽上。 */
  function uniqSlots(list) {
    var seen = Object.create(null), out = [];
    (list || []).forEach(function (v) {
      var n = Math.round(Number(v));
      if (!(n >= 0)) return;
      if (seen[n]) return;
      seen[n] = 1;
      out.push(n);
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }
  /* GLB 里 faceSlots 是 packI32 的 base64 字符串，不是数组；
   * 直接当数组用会拿到字符串，迁移时按面解码出真实下标。 */
  function packedSlotsOf(meshJson) {
    var raw = meshJson && meshJson.faceSlots;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw) {
      try {
        var bin = global.atob ? global.atob(raw) : '';
        var n = Math.floor(bin.length / 4), out = new Array(n);
        for (var i = 0; i < n; i++) {
          var o = i * 4;
          out[i] = bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8) |
            (bin.charCodeAt(o + 2) << 16) | (bin.charCodeAt(o + 3) << 24);
        }
        return out;
      } catch (e) { return []; }
    }
    return [];
  }
  function usedSlotsOfMeshJson(meshJson) {
    var fs = packedSlotsOf(meshJson);
    return uniqSlots(fs.length ? fs : [0]);
  }
  function usedSlotsOfMesh(mesh) {
    return usedSlotsOfMeshJson(mesh);
  }
  function meshSlotsOfRaw(raw, meshJson, minCount) {
    if (isObj(raw)) {
      var out = Object.create(null);
      Object.keys(raw).forEach(function (k) {
        if (Array.isArray(raw[k])) out[k] = uniqSlots(raw[k]);
      });
      return out;
    }
    var one = Object.create(null);
    one[MESH_REF] = usedSlotsOfMeshJson(meshJson);
    return one;
  }
  function meshSlotsOf(doc, nodeOrId) {
    if (!doc) return [];
    doc.meshSlots = isObj(doc.meshSlots) ? doc.meshSlots : Object.create(null);
    var id = nodeOrId
      ? (typeof nodeOrId === 'string' ? nodeOrId : (nodeOrId.meshRef || MESH_REF))
      : (nodeOf(doc) ? (nodeOf(doc).meshRef || MESH_REF) : MESH_REF);
    if (id && isObj(doc.meshes) && doc.meshes[id] && !Array.isArray(doc.meshSlots[id])) {
      doc.meshSlots[id] = usedSlotsOfMeshJson(doc.meshes[id]);
    }
    return doc.meshSlots[id] || [];
  }
  function setMeshSlots(doc, nodeOrId, list) {
    if (!doc) return [];
    doc.meshSlots = isObj(doc.meshSlots) ? doc.meshSlots : Object.create(null);
    var id = typeof nodeOrId === 'string' ? nodeOrId : (nodeOrId && (nodeOrId.meshRef || MESH_REF));
    if (!id) return [];
    doc.meshSlots[id] = uniqSlots(list);
    return doc.meshSlots[id];
  }
  function slotsOf(doc, node) {
    var names = slotNamesOf(doc);
    return meshSlotsOf(doc, node).filter(function (i) { return i >= 0 && i < names.length; });
  }
  function slotNamesFor(doc, list) {
    var names = (doc && doc.materials && doc.materials.slotNames) || [];
    return uniqSlots(list).map(function (i) { return names[i] || ('插槽 ' + (i + 1)); });
  }
  function refreshNodeSlotNames(doc) {
    (doc && doc.nodes || []).forEach(function (n) {
      n.materialSlots = slotNamesFor(doc, meshSlotsOf(doc, n));
    });
  }

  function slotIdsOf(doc) {
    if (!doc) return [];
    var names = slotNamesOf(doc);
    doc.materials = doc.materials || {};
    var ids = doc.materials.slotIds;
    if (!Array.isArray(ids)) ids = doc.materials.slotIds = [];
    var seen = Object.create(null);
    for (var i = 0; i < names.length; i++) {
      var s = ids[i] ? String(ids[i]) : '';
      if (!s || seen[s]) {
        var k = i + 1, id = 'slot-' + k;
        while (seen[id]) { k++; id = 'slot-' + k; }
        s = ids[i] = id;
      }
      seen[s] = 1;
    }
    ids.length = names.length;
    return ids;
  }
  /* 为「追加进来的材质」生成一批不会撞车的稳定 id */
  function freshSlotIds(ids, n) {
    var used = Object.create(null), max = 0;
    (ids || []).forEach(function (x) {
      var s = String(x);
      used[s] = 1;
      var m = /^(?:slot-|m)(\d+)$/.exec(s);
      if (m) max = Math.max(max, Number(m[1]));
    });
    var out = [], k = Math.max(max, (ids || []).length);
    for (var i = 0; i < n; i++) {
      var id;
      do { k++; id = 'm' + k; } while (used[id]);
      used[id] = 1;
      out.push(id);
    }
    return out;
  }
  /* 把另一份文档的材质整体并入当前材质库；返回下标偏移与 id 对照，
   * 调用方据此重映射 faceSlots 并迁移纹理配置。 */
  function adoptMaterials(doc, srcDoc) {
    var names = slotNamesOf(doc);
    var colors = slotArray(doc, 'slotColors');
    var maps = slotArray(doc, 'slotMaps');
    var ids = slotIdsOf(doc);
    var sm = (srcDoc && srcDoc.materials) || {};
    var sNames = Array.isArray(sm.slotNames) ? sm.slotNames : [];
    var sColors = Array.isArray(sm.slotColors) ? sm.slotColors : [];
    var sMaps = Array.isArray(sm.slotMaps) ? sm.slotMaps : [];
    var sIds = Array.isArray(sm.slotIds) ? sm.slotIds : [];
    var count = Math.max(sNames.length, 1);
    var offset = names.length;
    var fresh = freshSlotIds(ids, count);
    for (var i = 0; i < count; i++) {
      names.push(str(sNames[i], '插槽 ' + (names.length + 1)).slice(0, 60));
      colors.push(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(sColors[i] || '')) ? sColors[i] : '#c9ccd4');
      maps.push(str(sMaps[i], ''));
      ids.push(fresh[i]);
    }
    return {
      offset: offset, count: count, ids: fresh,
      srcIds: Array.prototype.slice.call(sIds, 0, count),
      srcNames: sNames.slice(0, count),
      textureConfigKey: str(sm.textureConfigKey, srcDoc && srcDoc.assetId)
    };
  }
  function remapSlotIndices(mesh, offset) {
    if (!mesh || !Array.isArray(mesh.faceSlots) || !offset) return mesh;
    for (var i = 0; i < mesh.faceSlots.length; i++) {
      var s = Number(mesh.faceSlots[i]);
      mesh.faceSlots[i] = (s >= 0 ? s : 0) + offset;
    }
    M.Mesh.bump(mesh);
    return mesh;
  }

  /* 节点级表面覆盖（可选）：{ map: dataURL, color: '#hex' }。
   * 「AI 生成材质」把它写在**节点**上：材质库是文档级的，直接写 slotMaps
   * 会串到共享同槽的其他对象（两个基础体都用槽 0，给一个贴青铜另一个也变青铜）。
   * 只认 dataURL —— 重开文档不依赖网络，远程 URL 一律拒收（不存不可复现的引用）。
   * 应用在视口的哪个环节见外壳 applyNodeSurface（盖过组件表面与槽贴图）。 */
  function surfaceOf(raw) {
    if (!isObj(raw)) return null;
    var map = String(raw.map || '');
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(map)) return null;
    return {
      map: map,
      color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(raw.color || '')) ? raw.color : '#ffffff'
    };
  }

  function nodeOfRaw(raw, index) {
    var n = isObj(raw) ? raw : {};
    return {
      id: str(n.id, 'obj-' + (index + 1)),
      type: 'mesh',
      name: str(n.name, '对象 ' + (index + 1)),
      parent: n.parent == null ? null : String(n.parent),
      transform: transformOf(n.transform),
      visible: n.visible !== false,
      meshRef: str(n.meshRef, MESH_REF),
      materialSlots: Array.isArray(n.materialSlots) ? n.materialSlots.map(String) : [],
      /* D4：修改器栈只保留字段与求值接口，M1 不做 UI / 不做求值 */
      modifiers: Array.isArray(n.modifiers) ? clone(n.modifiers) : [],
      /* 组件来源（可选）：{ id, params } —— 这个节点是某个组件源生成的，带着它自己的参数。
       * ⚠ 只存**纯数据**：组件的行为（怎么把参数变成形状）在组件源里，不在文档里。
       *   不保留这个字段的后果是「存盘重开 = 头模退化成一个普通网格」，
       *   表情、贴图、来源全都调不回来了 —— 那才是把特殊组件当成普通零件。 */
      comp: (isObj(n.comp) && n.comp.id) ? clone(n.comp) : null,
      /* 节点级表面覆盖（可选，AI 生成材质的落点）：白名单外会被 normalizeDoc 悄悄剥掉，
       * 忘了加这行 = 「生成完存盘重开贴图凭空消失」，而且一条报错都没有。 */
      surface: surfaceOf(n.surface)
    };
  }

  /* ---------------- 创建 / 校验 ---------------- */
  function createDoc(opts) {
    opts = opts || {};
    var assetId = str(opts.assetId, '');
    var name = str(opts.name, '未命名模型');
    var mesh = opts.mesh || null;
    var meshJson = mesh ? M.Mesh.toJSON(mesh) : (isObj(opts.meshJson) ? opts.meshJson : null);
    var meshes = Object.create(null);
    if (meshJson) meshes[MESH_REF] = meshJson;
    var mats = materialsOf(opts.materials, assetId);
    var node = nodeOfRaw(opts.node, 0);
    node.name = str(opts.nodeName, name);
    var ownSlots0 = meshSlotsOfRaw(opts.meshSlots, meshJson, mats.slotNames.length);
    node.materialSlots = (ownSlots0[MESH_REF] || []).map(function (i) {
      return mats.slotNames[i] || ('插槽 ' + (i + 1));
    });

    var revIn = isObj(opts.revision) ? opts.revision : {};
    var rev = revisionOf({
      current: revIn.current,
      source: revIn.source,
      mesh: revIn.mesh,
      modifiers: revIn.modifiers
    });

    var doc = {
      schemaVersion: SCHEMA_VERSION,
      assetId: assetId,
      name: name,
      mode: 'mesh',
      storage: 'json',
      revision: rev,
      nodes: [node],
      meshes: meshes,
      activeNodeId: node.id,
      selection: selectionOf(opts.selection),
      materials: mats,
      /* meshId → 该网格自己用到的材质下标（材质库是文档级，归属是网格级）。
       * 追加资产时导入的材质会整体后移，归属表让每个对象只看到自己的槽。 */
      meshSlots: meshSlotsOfRaw(opts.meshSlots, meshJson, mats.slotNames.length),
      historyBoundary: {
        undoPersisted: false,
        loadedAtRevision: Math.max(0, Math.round(num(opts.historyBoundary && opts.historyBoundary.loadedAtRevision, rev.current))),
        lastConversionRevision: Math.max(0, Math.round(num(opts.historyBoundary && opts.historyBoundary.lastConversionRevision, 0))),
        historyResetReason: str(opts.historyBoundary && opts.historyBoundary.historyResetReason, 'new')
      }
    };
    if (!doc.selection.nodeIds.length) doc.selection.nodeIds = [node.id];
    if (mesh) cacheOf(doc)[MESH_REF] = mesh;
    return doc;
  }

  function normalizeDoc(raw) {
    var rev = revisionOf(raw.revision);
    /* nodes: [] 是合法状态（删掉最后一个对象后的空场景）：不能凭空补节点，
     * 否则「打开一个空模型」会冒出一个幽灵对象。只有缺 nodes 字段的老格式才补默认节点。 */
    var nodes = Array.isArray(raw.nodes) ? raw.nodes.map(nodeOfRaw) : [nodeOfRaw({}, 0)];
    var mats = materialsOf(raw.materials, raw.assetId);

    /* v2 → v2.1 迁移：只补结构，不改数据。meshRef 指向不存在的网格时统一落到第一个，
     * 否则节点会「指向空气」，渲染时表现为打开后什么都没有。 */
    var mm = meshesOf(raw);
    nodes.forEach(function (n) {
      if (n.type !== 'mesh') return;
      if (!n.meshRef || !mm.map[n.meshRef]) n.meshRef = mm.first || MESH_REF;
    });
    /* v2.2 迁移：老文档没有 meshSlots，按每个网格实际用到的 faceSlots 反推归属；
     * 这样打开老资产时，材质面板显示的范围和以前一致（不会把没用到的槽也算进来）。 */
    var meshSlots = meshSlotsOfRaw(raw.meshSlots, null, mats.slotNames.length);
    Object.keys(mm.map).forEach(function (id) {
      if (!Array.isArray(meshSlots[id])) meshSlots[id] = usedSlotsOfMeshJson(mm.map[id]);
    });
    nodes.forEach(function (n) {
      if (!n.materialSlots.length) n.materialSlots = slotNamesFor({ materials: mats }, meshSlots[n.meshRef] || []);
    });
    var actId = str(raw.activeNodeId, '');
    if (!actId || !nodes.some(function (n) { return n.id === actId; })) {
      var firstMesh = nodes.filter(function (n) { return n.type === 'mesh'; })[0];
      actId = firstMesh ? firstMesh.id : (nodes[0] ? nodes[0].id : '');
    }
    /* 关卡（v2.3，对标 Unreal 的 World/Level）：老文档没有 levels = 全部对象都在主关卡。
     * 悬空引用在这里清掉（节点删了关卡还挂着 id），一个节点只归属一个关卡。 */
    var levels = levelsOfRaw(raw.levels, nodes);

    return {
      schemaVersion: SCHEMA_VERSION,
      assetId: str(raw.assetId, ''),
      name: str(raw.name, nodes[0] ? nodes[0].name : '空场景'),
      mode: 'mesh',
      storage: 'json',
      revision: rev,
      nodes: nodes,
      meshes: mm.map,
      activeNodeId: actId,
      selection: selectionOf(raw.selection),
      materials: mats,
      meshSlots: meshSlots,
      levels: levels,
      historyBoundary: {
        undoPersisted: false,
        loadedAtRevision: Math.max(0, Math.round(num(raw.historyBoundary && raw.historyBoundary.loadedAtRevision, rev.current))),
        lastConversionRevision: Math.max(0, Math.round(num(raw.historyBoundary && raw.historyBoundary.lastConversionRevision, 0))),
        historyResetReason: str(raw.historyBoundary && raw.historyBoundary.historyResetReason, 'reopen')
      }
    };
  }

  /* ---------------- 关卡（v2.3，对标 Unreal 的 World / Level） ----------------
   * World = doc（不复制数据，关卡只是节点引用清单）；Persistent Level = 未列入
   * 任何子关卡的对象，永远在场；Sub-Level = doc.levels[] 的一条。
   * 铁律：关卡操作**绝不丢数据** —— 删关卡 = 节点回主关卡；隐藏 = node.visible
   * 批量置 false，恢复 = 批量回 true（对象级隐藏状态被关卡开关覆盖，Unreal 同语义）；
   * 锁定 = 拾取/变换过滤（数据不动）。节点删除后关卡里的悬空 id 由 levelsNormalize 清。 */
  function levelsOfRaw(raw, nodes) {
    var have = isObj(nodes) ? null : null;
    var nodeSet = Object.create(null);
    if (Array.isArray(nodes)) nodes.forEach(function (n) { nodeSet[n.id] = 1; });
    var out = [];
    var seenNode = Object.create(null);
    if (Array.isArray(raw)) {
      raw.forEach(function (lv, li) {
        if (!isObj(lv)) return;
        var rec = {
          id: str(lv.id, 'lvl-' + (out.length + 1)).slice(0, 64),
          name: str(lv.name, '关卡 ' + (out.length + 1)).slice(0, 60),
          nodes: [],
          visible: lv.visible !== false,
          locked: lv.locked === true
        };
        if (Array.isArray(lv.nodes)) {
          lv.nodes.forEach(function (nid) {
            var s = str(nid, '');
            if (!s || seenNode[s] || !nodeSet[s]) return;   /* 一个节点只归一关；悬空剔除 */
            seenNode[s] = 1;
            rec.nodes.push(s);
          });
        }
        out.push(rec);
      });
    }
    return out;
  }

  function levelsNormalize(doc) {
    if (!doc) return [];
    if (!Array.isArray(doc.levels)) doc.levels = [];
    var nodeSet = Object.create(null);
    if (Array.isArray(doc.nodes)) doc.nodes.forEach(function (n) { nodeSet[n.id] = 1; });
    var seen = Object.create(null);
    doc.levels.forEach(function (lv) {
      var kept = [];
      (lv.nodes || []).forEach(function (nid) {
        if (!nodeSet[nid] || seen[nid]) return;
        seen[nid] = 1;
        kept.push(nid);
      });
      lv.nodes = kept;
    });
    return doc.levels;
  }

  function levelsOf(doc) {
    if (!doc) return [];
    if (!Array.isArray(doc.levels)) doc.levels = [];
    return doc.levels;
  }

  function levelById(doc, id) {
    var list = levelsOf(doc);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 节点归属：'main'（主关卡 / 未分配）或关卡 id；节点不存在返回 null。 */
  function nodeLevelId(doc, nodeId) {
    if (!doc || !nodeById(doc, nodeId)) return null;
    var list = levelsOf(doc);
    for (var i = 0; i < list.length; i++) {
      if ((list[i].nodes || []).indexOf(nodeId) >= 0) return list[i].id;
    }
    return 'main';
  }

  /* 关卡的对象清单：levelId 'main' = 未分配到任何子关卡的所有节点（按文档顺序）。 */
  function levelNodeIds(doc, levelId) {
    if (!doc) return [];
    if (levelId === 'main') {
      var assigned = Object.create(null);
      levelsOf(doc).forEach(function (lv) { (lv.nodes || []).forEach(function (nid) { assigned[nid] = 1; }); });
      var out = [];
      if (Array.isArray(doc.nodes)) doc.nodes.forEach(function (n) { if (!assigned[n.id]) out.push(n.id); });
      return out;
    }
    var lv = levelById(doc, levelId);
    return lv ? (lv.nodes || []).slice() : [];
  }

  /* 关卡 id 的序号必须是**模块级递增**：同毫秒连建两关时 Date.now 相同，
   * 而 n 是「重名顺延计数」—— 名字不同的两关 n 都是 1，id 就撞车了。
   * 实测后果：levelSetVisible(lv2) 命中 lv1，对象被隐藏、单关导出变空场景。 */
  var LEVEL_SEQ = 0;
  function levelCreate(doc, name) {
    if (!doc) return null;
    var list = levelsOf(doc);
    /* ⚠ 重名顺延必须在「基础名」上加序号，而不是在 while 里重算 nm ——
     * 用户给了名字时 str(name) 永远非空，nm 不变，while 就是死循环
     * （实测：页面 evaluate 直接挂死，整条命令超时被杀）。 */
    var base = str(name, '').slice(0, 60);
    if (!base) base = '关卡 ' + (list.length + 1);
    var nm = base, n = 1;
    while (list.some(function (lv) { return lv.name === nm; })) { n++; nm = base + ' ' + n; }
    var lv = { id: 'lvl-' + Date.now().toString(36) + '-' + (++LEVEL_SEQ), name: nm, nodes: [], visible: true, locked: false };
    list.push(lv);
    return lv;
  }

  /* 删关卡：节点全部回主关卡（数据不动）。返回回主的节点数。 */
  function levelDelete(doc, id) {
    var list = levelsOf(doc);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var count = (list[i].nodes || []).length;
      /* 隐藏过的关卡删掉前先把节点显回来（回主关卡=回到视野） */
      if (list[i].visible === false) {
        (list[i].nodes || []).forEach(function (nid) {
          var n = nodeById(doc, nid);
          if (n) n.visible = true;
        });
      }
      list.splice(i, 1);
      return count;
    }
    return -1;
  }

  function levelRename(doc, id, name) {
    var lv = levelById(doc, id);
    if (!lv) return false;
    var s = str(name, '').slice(0, 60);
    if (!s) return false;
    lv.name = s;
    return true;
  }

  /* 关卡显隐：直接批量写 node.visible（渲染判定只认它）。隐藏不丢数据 ——
   * mesh / 参数 / 变换全在，恢复 = 显回来。 */
  function levelSetVisible(doc, id, visible) {
    var lv = levelById(doc, id);
    if (!lv) return false;
    lv.visible = visible !== false;
    (lv.nodes || []).forEach(function (nid) {
      var n = nodeById(doc, nid);
      if (n) n.visible = lv.visible;
    });
    return true;
  }

  /* 移入关卡：从其它关卡自动摘除（一个节点只归一关）。 */
  function levelAssign(doc, id, nodeIds) {
    var lv = levelById(doc, id);
    if (!lv || !Array.isArray(nodeIds) || !nodeIds.length) return false;
    var ok = 0;
    nodeIds.forEach(function (nid) {
      if (!nodeById(doc, nid)) return;
      levelsOf(doc).forEach(function (other) {
        if (other === lv) return;
        var at = (other.nodes || []).indexOf(nid);
        if (at >= 0) other.nodes.splice(at, 1);
      });
      if (lv.nodes.indexOf(nid) < 0) lv.nodes.push(nid);
      /* 目标关卡如果是隐藏的，节点跟着隐（与 visible 状态一致） */
      var n = nodeById(doc, nid);
      if (n && lv.visible === false) n.visible = false;
      ok++;
    });
    return ok > 0;
  }

  /* 移回主关卡：从所属子关卡摘除。 */
  function levelUnassign(doc, nodeIds) {
    if (!Array.isArray(nodeIds) || !nodeIds.length) return false;
    var ok = 0;
    nodeIds.forEach(function (nid) {
      levelsOf(doc).forEach(function (lv) {
        var at = (lv.nodes || []).indexOf(nid);
        if (at >= 0) { lv.nodes.splice(at, 1); ok++; }
      });
    });
    return ok > 0;
  }

  /* 锁定关卡返回节点 id 集（拾取/变换过滤用）。 */
  function lockedNodeIds(doc) {
    var out = [];
    levelsOf(doc).forEach(function (lv) {
      if (lv.locked) (lv.nodes || []).forEach(function (nid) { out.push(nid); });
    });
    return out;
  }

  function validate(raw) {
    var errors = [], warnings = [];
    if (!isObj(raw)) return { ok: false, errors: ['seedModel 不是对象'], warnings: warnings, doc: null };
    if (Math.round(num(raw.schemaVersion, 0)) !== SCHEMA_VERSION) {
      warnings.push('seedModel 版本 ' + (raw.schemaVersion || '缺失') + '，已按 v2 读取');
    }
    var mmIn = meshesOf(raw);
    var emptyScene = Array.isArray(raw.nodes) && raw.nodes.length === 0;
    if (!Object.keys(mmIn.map).length && !emptyScene) errors.push('缺少网格数据（meshes 与 mesh 都没有）');
    if (!Array.isArray(raw.nodes)) warnings.push('缺少 nodes，已补一个默认网格节点');
    else if (emptyScene) warnings.push('空场景（nodes 为空）');
    if (!isObj(raw.meshes) && isObj(raw.mesh)) warnings.push('老格式（单 mesh）已迁移为 meshes.main');

    var doc = normalizeDoc(raw);
    var slotN = Math.max(1, ((doc.materials && doc.materials.slotNames) || []).length);
    Object.keys(doc.meshes).forEach(function (id) {
      try {
        var mesh = M.Mesh.fromJSON(doc.meshes[id]);
        /* 老资产（材质串通时代保存、材质库被回收过）的 faceSlots 可能指向已不存在的槽。
         * 这些面在视口里没有材质，绘画命中时拿不到材质 → 静默无反应。加载时夹回槽 0。 */
        var bad = false;
        for (var i = 0; i < mesh.faceSlots.length; i++) {
          var s = mesh.faceSlots[i];
          if (!(s >= 0) || s >= slotN) { mesh.faceSlots[i] = 0; bad = true; }
        }
        cacheOf(doc)[id] = mesh;
        if (bad) {
          doc.meshes[id] = M.Mesh.toJSON(mesh);
          doc.meshSlots[id] = usedSlotsOfMeshJson(doc.meshes[id]);
          warnings.push('网格 ' + id + ' 的材质槽下标越界，已夹回槽 0');
        }
      } catch (e) {
        errors.push('网格 ' + id + ' 解析失败：' + ((e && e.message) || e));
      }
    });
    var meshNode = doc.nodes.filter(function (n) { return n.type === 'mesh'; })[0];
    if (doc.nodes.length && !meshNode) errors.push('nodes 里没有 mesh 类型节点');
    return { ok: errors.length === 0, errors: errors, warnings: warnings, doc: errors.length ? null : doc };
  }

  /* ---------------- v1 → v2 烘焙（D2：参数化降级为基础体工厂） ---------------- */
  function isV1(raw) {
    if (!isObj(raw)) return false;
    if (Math.round(num(raw.schemaVersion, 0)) === 1) return true;
    if (String(raw.mode || '') === 'parametric') return true;
    return !!(isObj(raw.source) && isObj(raw.source.spec));
  }

  function detect(raw) {
    if (!isObj(raw)) return 'none';
    if (isV1(raw)) return 'v1';
    if (Math.round(num(raw.schemaVersion, 0)) >= 2) return 'v2';
    return 'unknown';
  }

  function fromV1(raw) {
    var warnings = [];
    if (!global.SeedDocument) {
      return { ok: false, errors: ['SeedDocument 未加载，无法读取 v1 文档'], warnings: warnings, doc: null };
    }
    if (!global.Modeler) {
      return { ok: false, errors: ['Modeler 未加载，无法烘焙 v1 网格'], warnings: warnings, doc: null };
    }
    var v = global.SeedDocument.validate(raw);
    if (!v.ok) {
      return { ok: false, errors: v.errors, warnings: v.warnings || warnings, doc: null };
    }
    var old = v.doc;

    var group;
    try {
      group = global.Modeler.buildGroup(old.source.spec).group;
    } catch (e) {
      return { ok: false, errors: ['规格重建失败：' + ((e && e.message) || e)], warnings: warnings, doc: null };
    }

    var THREE = global.THREE;
    if (!THREE) return { ok: false, errors: ['three.js 未就绪'], warnings: warnings, doc: null };

    var mesh = M.Mesh.create();
    var slotNames = [], slotColors = [];
    var meshed = 0;
    try {
      group.updateMatrixWorld(true);
      group.traverse(function (o) {
        if (!o.isMesh || !o.geometry) return;
        var mat = Array.isArray(o.material) ? o.material[0] : o.material;
        var slotName = str((mat && mat.name) || o.name, '槽 ' + (slotNames.length + 1));
        var slotColor = (mat && mat.color && mat.color.getHexString) ? '#' + mat.color.getHexString() : '#c9ccd4';
        var slot = slotNames.indexOf(slotName);
        if (slot < 0) {
          slot = slotNames.length;
          slotNames.push(slotName);
          slotColors.push(slotColor);
        }
        /* 世界矩阵直接烘进顶点；负行列式（镜像件）要翻绕序，否则面朝里 */
        var flip = o.matrixWorld.determinant() < 0;
        o.geometry.applyMatrix4(o.matrixWorld);
        var part = M.Mesh.fromBufferGeometry(o.geometry, { slot: slot, flip: flip });
        M.Mesh.append(mesh, part, { slot: slot });
        meshed += 1;
      });
    } catch (e) {
      return { ok: false, errors: ['烘焙失败：' + ((e && e.message) || e)], warnings: warnings, doc: null };
    } finally {
      group.traverse(function (o) { if (o.isMesh && o.geometry) { try { o.geometry.dispose(); } catch (e2) {} } });
    }
    if (!meshed || !mesh.faceIds.length) {
      return { ok: false, errors: ['规格里没有可烘焙的网格'], warnings: warnings, doc: null };
    }

    /* 手柄 / 相机都以包围盒中心为原点：把顶点挪到中心，节点变换保留原 v1 变换 */
    var bb = new THREE.Box3();
    var V = new THREE.Vector3();
    var n = mesh.positions.length / 3;
    for (var i = 0; i < n; i++) {
      V.set(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
      bb.expandByPoint(V);
    }
    var center = bb.getCenter(new THREE.Vector3());
    M.Mesh.translate(mesh, -center.x, -center.y, -center.z);

    var revCurrent = Math.max(1, old.revision.current) + 1;
    var doc = createDoc({
      assetId: old.assetId,
      name: old.name,
      mesh: mesh,
      transform: old.transform,
      nodeName: old.name,
      materials: {
        slotNames: slotNames,
        slotColors: slotColors,
        textureConfigKey: (old.materials && old.materials.textureConfigKey) || old.assetId,
        textureConfigMissing: !!(old.materials && old.materials.textureConfigMissing)
      },
      revision: { current: revCurrent, source: old.revision.source, mesh: revCurrent, modifiers: 0 },
      historyBoundary: {
        lastConversionRevision: revCurrent,
        historyResetReason: 'v1-baked',
        loadedAtRevision: revCurrent
      }
    });
    doc.historyBoundary.undoPersisted = false;
    warnings.push('v1 参数化文档已烘焙为可编辑网格（' + meshed + ' 个部件 → ' + mesh.faceIds.length + ' 面）');
    return { ok: true, errors: [], warnings: warnings, doc: doc };
  }

  /* ---------------- 网格访问（meshes 是权威，内存里按 meshId 缓存解码结果） ---------------- */
  function meshIds(doc) { return (doc && isObj(doc.meshes)) ? Object.keys(doc.meshes) : []; }

  function meshIdOfNode(doc, node) {
    if (!doc) return null;
    if (node && node.meshRef && isObj(doc.meshes) && doc.meshes[node.meshRef]) return node.meshRef;
    return meshIds(doc)[0] || null;
  }

  function nodeById(doc, id) {
    if (!doc || !Array.isArray(doc.nodes)) return null;
    for (var i = 0; i < doc.nodes.length; i++) if (doc.nodes[i].id === id) return doc.nodes[i];
    return null;
  }

  function nodesOf(doc) {
    return (doc && Array.isArray(doc.nodes))
      ? doc.nodes.filter(function (n) { return n.type === 'mesh'; })
      : [];
  }

  /* 「当前对象」：组件选择、属性面板、手柄都作用在它上面 */
  function activeNode(doc) {
    if (!doc || !Array.isArray(doc.nodes) || !doc.nodes.length) return null;
    var n = doc.activeNodeId ? nodeById(doc, doc.activeNodeId) : null;
    return n || nodesOf(doc)[0] || doc.nodes[0] || null;
  }

  function setActiveNode(doc, id) {
    if (!doc) return null;
    var n = nodeById(doc, id);
    if (!n) return null;
    doc.activeNodeId = n.id;
    return n;
  }

  /* nodeOf 保留旧签名（一堆调用方靠它取「那个节点」），语义改成「激活节点」 */
  function nodeOf(doc) { return activeNode(doc); }

  function getMesh(doc, node) {
    if (!doc) return null;
    var id = meshIdOfNode(doc, node || nodeOf(doc));
    if (!id || !isObj(doc.meshes[id])) return null;
    var c = cacheOf(doc);
    if (c[id]) return c[id];
    var mesh = M.Mesh.fromJSON(doc.meshes[id]);
    c[id] = mesh;
    return mesh;
  }

  function setMesh(doc, mesh, node) {
    if (!doc || !mesh) return null;
    node = node || nodeOf(doc);
    doc.meshes = doc.meshes || Object.create(null);
    /* 写回必须认节点自己声明的 meshRef：撤销会先回收未引用网格（pruneMeshes），
     * 重做时 meshRef 指向的键暂时不存在，若这时回退到「第一个网格」，
     * 就会把新对象的网格盖到旧对象头上（多对象 + 撤销/重做后几何与材质一起串）。
     * 回退只在节点没有 meshRef 时使用。 */
    var id = (node && node.meshRef) || meshIdOfNode(doc, node) || MESH_REF;
    doc.meshes[id] = M.Mesh.toJSON(mesh);
    if (node) node.meshRef = id;
    cacheOf(doc)[id] = mesh;
    /* 归属表只增不减：结合 / 分离 / 布尔产出的新下标也要纳进来，
     * 否则新出现的槽在材质面板里看不见、也没法指派。 */
    doc.meshSlots = isObj(doc.meshSlots) ? doc.meshSlots : Object.create(null);
    doc.meshSlots[id] = uniqSlots((doc.meshSlots[id] || []).concat(usedSlotsOfMesh(mesh)));
    if (node) node.materialSlots = slotNamesFor(doc, doc.meshSlots[id]);
    return doc;
  }

  /* 新增一个网格节点（B2a 的数据层接口，UI 在 B2b 接大纲）。
   * meshId 可以复用已有网格 → 两个节点共享同一份数据（实例语义：改一个两边都变）。 */
  function addMeshNode(doc, opts) {
    opts = opts || {};
    if (!doc) return null;
    doc.meshes = doc.meshes || Object.create(null);
    var base = str(opts.id, 'obj-' + (doc.nodes.length + 1));
    var id = base, k = 2;
    while (nodeById(doc, id)) { id = base + '-' + (k++); }
    var meshId = str(opts.meshId, 'mesh-' + (Object.keys(doc.meshes).length + 1));
    while (!opts.meshId && doc.meshes[meshId]) { meshId = meshId + 'x'; }
    if (opts.mesh) {
      doc.meshes[meshId] = M.Mesh.toJSON(opts.mesh);
      cacheOf(doc)[meshId] = opts.mesh;
    } else if (isObj(opts.meshJson)) {
      doc.meshes[meshId] = opts.meshJson;
    }
    var node = nodeOfRaw({
      id: id,
      name: str(opts.name, '对象 ' + (doc.nodes.length + 1)),
      parent: opts.parent || null,
      transform: opts.transform,
      meshRef: meshId,
      visible: opts.visible
    }, doc.nodes.length);
    doc.meshSlots = isObj(doc.meshSlots) ? doc.meshSlots : Object.create(null);
    doc.meshSlots[meshId] = opts.slots && Array.isArray(opts.slots)
      ? uniqSlots(opts.slots)
      : usedSlotsOfMeshJson(doc.meshes[meshId]);
    node.materialSlots = slotNamesFor(doc, doc.meshSlots[meshId]);
    doc.nodes.push(node);
    return node;
  }

  function removeNode(doc, id) {
    if (!doc || !Array.isArray(doc.nodes)) return false;
    var removed = null;
    doc.nodes = doc.nodes.filter(function (n) {
      if (n.id === id) { removed = n; return false; }
      return true;
    });
    if (!removed) return false;
    /* 子节点上提为根，别留下指向已删除节点的 parent */
    doc.nodes.forEach(function (n) { if (n.parent === id) n.parent = removed.parent || null; });
    /* 网格没人用了才回收：两个节点共用一个网格时不能删 */
    var ref = removed.meshRef;
    if (ref && isObj(doc.meshes) && doc.meshes[ref]) {
      var used = doc.nodes.some(function (n) { return n.meshRef === ref; });
      if (!used) {
        delete doc.meshes[ref];
        delete cacheOf(doc)[ref];
        if (isObj(doc.meshSlots)) delete doc.meshSlots[ref];
      }
    }
    if (doc.activeNodeId === id) {
      var next = nodesOf(doc)[0] || doc.nodes[0];
      doc.activeNodeId = next ? next.id : '';
    }
    /* 关卡里别留悬空引用：节点删了，关卡清单跟着清（关卡不丢，只是少一条） */
    levelsNormalize(doc);
    return true;
  }

  function stats(doc, node) {
    var mesh = getMesh(doc, node);
    return M.Mesh.stats(mesh);
  }

  /* 选择集（M3）：只存稳定 ID，不存数组下标 —— 拓扑一变下标就全错位了。
   * 这里只做结构归一；ID 是否还存在由调用方 prune（它才知道当前网格）。 */
  function setSelection(doc, sel) {
    if (!doc) return false;
    doc.selection = selectionOf(sel);
    return true;
  }

  /* ---------------- 编辑（节点级，M1 只有变换 / 命名） ---------------- */
  function setName(doc, name) {
    if (!doc) return false;
    var s = str(name, '').slice(0, 120);
    if (!s) return false;
    doc.name = s;
    var node = nodeOf(doc);
    if (node) node.name = s;
    return true;
  }

  function setNodeTransform(doc, node, position, quaternion, scale) {
    if (!doc) return false;
    node = node || nodeOf(doc);
    if (!node) return false;
    var p = Array.isArray(position) ? position : (position && position.toArray ? position.toArray() : null);
    var q = Array.isArray(quaternion) ? quaternion : (quaternion && quaternion.toArray ? quaternion.toArray() : null);
    var s = Array.isArray(scale) ? scale : (scale && scale.toArray ? scale.toArray() : null);
    node.transform = transformOf({
      position: p || node.transform.position,
      rotation: q || node.transform.rotation,
      scale: s || node.transform.scale
    });
    return true;
  }

  /* ---------------- 材质槽（P5）
   * 槽名 / 显示色 / 基础贴图三份数组必须同长：少一份，视口里就会冒出「没有名字的槽」。
   * 删槽要连 faceSlots 一起重排，否则残留的旧下标会指向空槽（渲染时多出一套默认材质）。 */

  function slotNamesOf(doc) {
    if (!doc) return [];
    doc.materials = doc.materials || {};
    if (!Array.isArray(doc.materials.slotNames)) doc.materials.slotNames = [];
    if (!Array.isArray(doc.materials.slotColors)) doc.materials.slotColors = [];
    if (!Array.isArray(doc.materials.slotMaps)) doc.materials.slotMaps = [];
    return doc.materials.slotNames;
  }
  function syncSlotNamesToNodes(doc) {
    refreshNodeSlotNames(doc);
  }
  function slotArray(doc, key) {
    doc.materials = doc.materials || {};
    if (!Array.isArray(doc.materials[key])) doc.materials[key] = [];
    return doc.materials[key];
  }
  function addSlot(doc, opts) {
    opts = opts || {};
    if (!doc) return -1;
    var names = slotNamesOf(doc);
    var colors = slotArray(doc, 'slotColors');
    var maps = slotArray(doc, 'slotMaps');
    var ids = slotIdsOf(doc);
    var name = str(opts.name, '插槽 ' + (names.length + 1)).slice(0, 60);
    names.push(name);
    colors.push(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(opts.color || '')) ? opts.color : '#c9ccd4');
    maps.push('');
    ids.push(freshSlotIds(ids, 1)[0]);
    var index = names.length - 1;
    /* 新槽归到当前对象名下：别的模型的面不会自动跑到这个槽上 */
    var node = opts.node || nodeOf(doc);
    if (node) setMeshSlots(doc, node, meshSlotsOf(doc, node).concat([index]));
    syncSlotNamesToNodes(doc);
    return index;
  }
  function renameSlot(doc, index, name) {
    if (!doc) return false;
    var names = slotNamesOf(doc);
    index = Math.round(Number(index));
    if (!(index >= 0 && index < names.length)) return false;
    var s = str(name, '').slice(0, 60);
    if (!s || s === names[index]) return false;
    names[index] = s;
    syncSlotNamesToNodes(doc);
    return true;
  }
  /* 删槽现在是「对象级」：只从当前对象的归属里摘掉，面改指它自己的另一个槽；
   * 只有当别的网格也不再引用这个材质时，才真正从文档材质库里回收并整体重排。 */
  function removeSlot(doc, index, opts) {
    if (!doc) return false;
    opts = opts || {};
    var names = slotNamesOf(doc);
    index = Math.round(Number(index));
    if (!(index >= 0 && index < names.length)) return false;
    /* 至少留一个槽：零槽文档会让「槽名 → 贴图 key」整条链没有落点 */
    if (names.length <= 1) return false;
    var node = opts.node || nodeOf(doc);
    var ref = node ? (node.meshRef || MESH_REF) : null;
    var own = node ? meshSlotsOf(doc, node).slice() : [];
    if (own.indexOf(index) >= 0) {
      /* 每个对象至少保留一个材质槽，否则它就没有可绘制/可指派的落点 */
      if (own.length <= 1) return false;
      own.splice(own.indexOf(index), 1);
    }
    var target = own.length ? own[0] : (index > 0 ? index - 1 : 1);
    var mesh = null;
    try { mesh = node ? getMesh(doc, node) : null; } catch (e) { mesh = null; }
    if (mesh && mesh.faceSlots) {
      for (var f = 0; f < mesh.faceSlots.length; f++) {
        if ((mesh.faceSlots[f] || 0) === index) mesh.faceSlots[f] = target;
      }
      M.Mesh.bump(mesh);
    }
    /* 还有别的网格引用这个下标 → 只做对象级摘除，材质库保持不动 */
    var shared = Object.keys(doc.meshSlots || {}).some(function (id) {
      if (id === ref) return false;
      return (doc.meshSlots[id] || []).indexOf(index) >= 0;
    });
    if (shared) {
      if (ref && Array.isArray(doc.meshSlots[ref])) {
        setMeshSlots(doc, ref, doc.meshSlots[ref].filter(function (i) { return i !== index; }));
      }
      if (mesh) setMesh(doc, mesh, node);
      syncSlotNamesToNodes(doc);
      return true;
    }
    /* 没别的对象用了：从材质库回收，所有网格（包括当前）整体 -1 重排 */
    names.splice(index, 1);
    var colors = slotArray(doc, 'slotColors');
    var maps = slotArray(doc, 'slotMaps');
    var ids = slotIdsOf(doc);
    if (colors.length > index) colors.splice(index, 1);
    if (maps.length > index) maps.splice(index, 1);
    if (ids.length > index) ids.splice(index, 1);
    var seenMesh = Object.create(null);
    (doc.nodes || []).forEach(function (n) {
      var r = n.meshRef || MESH_REF;
      if (seenMesh[r]) return;
      seenMesh[r] = 1;
      var m = null;
      try { m = getMesh(doc, n); } catch (e) { m = null; }
      if (!m || !m.faceSlots) return;
      for (var i = 0; i < m.faceSlots.length; i++) {
        var s = m.faceSlots[i] || 0;
        if (s === index) m.faceSlots[i] = 0;
        else if (s > index) m.faceSlots[i] = s - 1;
      }
      M.Mesh.bump(m);
      setMesh(doc, m, n);
    });
    Object.keys(doc.meshSlots || {}).forEach(function (id) {
      doc.meshSlots[id] = (doc.meshSlots[id] || [])
        .filter(function (i) { return i !== index; })
        .map(function (i) { return i > index ? i - 1 : i; });
    });
    syncSlotNamesToNodes(doc);
    return true;
  }
  /* 把一组面的稳定 ID 指派到某槽；返回实际改动的面数（0 = 本来就在该槽）。 */
  function assignSlot(doc, node, faceIds, slot) {
    if (!doc || !Array.isArray(faceIds) || !faceIds.length) return 0;
    node = node || nodeOf(doc);
    var mesh = getMesh(doc, node);
    if (!mesh) return 0;
    var slotMax = Math.max(0, slotNamesOf(doc).length - 1);
    slot = Math.max(0, Math.min(slotMax, Math.round(Number(slot) || 0)));
    var changed = 0;
    for (var i = 0; i < faceIds.length; i++) {
      var k = mesh.faceIds.indexOf(faceIds[i]);
      if (k < 0) continue;
      if ((mesh.faceSlots[k] || 0) === slot) continue;
      mesh.faceSlots[k] = slot;
      changed += 1;
    }
    if (changed) {
      M.Mesh.bump(mesh);
      setMesh(doc, mesh, node);
    }
    return changed;
  }

  function revision(doc, kind) {
    if (!doc) return doc;
    if (!doc.revision) doc.revision = revisionOf(null);
    doc.revision.current += 1;
    if (kind === 'mesh') doc.revision.mesh = doc.revision.current;
    else if (kind === 'source') doc.revision.source = doc.revision.current;
    else if (kind === 'modifiers') doc.revision.modifiers = doc.revision.current;
    return doc;
  }

  /* ---------------- 历史快照 ----------------
   * M1 只有变换 / 命名可撤销，快照故意不带 mesh 的 base64：
   * 每次拖动都复制一份 1MB 网格会让 64MB 预算迅速见底。
   * M6 拓扑算子落地时再把 mesh 纳入快照并继续用同一套预算裁剪。 */
  function snapshot(doc) {
    if (!doc) return null;
    return clone({
      name: doc.name,
      nodes: doc.nodes,
      /* 激活对象一起回滚：多对象下撤销/重做后 active 若停在已删除的节点，
       * 兜底恢复网格会写错对象（把另一个对象的网格盖掉）。 */
      activeNodeId: doc.activeNodeId,
      selection: doc.selection,
      revision: doc.revision,
      /* 槽位归属和网格引用一起回滚：撤销「新建对象 / 结合 / 分离」时，
       * 否则会出现网格没了、归属还挂着的悬空条目 */
      meshSlots: doc.meshSlots || {}
    });
  }

  function applySnapshot(doc, snap) {
    if (!doc || !isObj(snap)) return doc;
    if (snap.name != null) doc.name = String(snap.name);
    if (Array.isArray(snap.nodes)) doc.nodes = clone(snap.nodes);
    if (snap.activeNodeId && nodeById(doc, snap.activeNodeId)) doc.activeNodeId = snap.activeNodeId;
    if (isObj(snap.selection)) doc.selection = selectionOf(snap.selection);
    if (isObj(snap.revision)) doc.revision = revisionOf(snap.revision);
    if (isObj(snap.meshSlots)) doc.meshSlots = clone(snap.meshSlots);
    if (!nodeById(doc, doc.activeNodeId)) {
      var next = nodesOf(doc)[0] || doc.nodes[0];
      doc.activeNodeId = next ? next.id : '';
    }
    pruneMeshes(doc);
    return doc;
  }

  /* 快照只恢复 nodes、不恢复 meshes（网格本体在外壳的指纹库里）。
   * 于是「新建对象 → 撤销」会留下一个没人引用的网格 → 必须在这里按引用回收，
   * 否则 doc.meshes 会越撤销越多（实测多出一个孤儿网格，导出时数量对不上）。 */
  function pruneMeshes(doc) {
    if (!doc || !isObj(doc.meshes)) return;
    var used = Object.create(null);
    (doc.nodes || []).forEach(function (n) { if (n.meshRef) used[n.meshRef] = 1; });
    var c = cache ? cache.get(doc) : null;
    Object.keys(doc.meshes).forEach(function (k) {
      if (used[k]) return;
      delete doc.meshes[k];
      if (isObj(doc.meshSlots)) delete doc.meshSlots[k];
      if (c) delete c[k];
    });
  }

  /* 保存前把内存网格重新编码，保证 JSON 里的网格和视口里的一致 */
  function toSeedModel(doc) {
    if (!doc) return null;
    var c = cache ? cache.get(doc) : null;
    if (c) {
      Object.keys(c).forEach(function (id) {
        if (isObj(doc.meshes) && doc.meshes[id]) doc.meshes[id] = M.Mesh.toJSON(c[id]);
      });
    }
    var out = clone(doc);
    delete out.__cache;
    /* 只写 meshes：同一个网格不能在文件里存两份（一份 412KB，两份就是白白翻倍） */
    delete out.mesh;
    return out;
  }

  M.Scene = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MESH_REF: MESH_REF,
    createDoc: createDoc,
    validate: validate,
    fromV1: fromV1,
    isV1: isV1,
    detect: detect,
    getMesh: getMesh,
    setMesh: setMesh,
    nodeOf: nodeOf,
    /* 按 id 取节点：外包（属性面板的「调整这个组件」、大纲、探针）都要按 id 找，
     * 早先只有内部能用 nodeById，外部只好自己遍历 nodes —— 写漏一次就成了
     * 「静默不工作」（try/catch 一包，异常变成 null，功能只是消失，不报错）。 */
    nodeById: nodeById,
    nodesOf: nodesOf,
    activeNode: activeNode,
    setActiveNode: setActiveNode,
    addMeshNode: addMeshNode,
    removeNode: removeNode,
    addSlot: addSlot,
    renameSlot: renameSlot,
    removeSlot: removeSlot,
    assignSlot: assignSlot,
    /* 关卡（World/Level）：只存节点引用清单，绝不复制网格数据；删关/隐藏/锁定都无损 */
    levelsOf: levelsOf,
    levelsNormalize: levelsNormalize,
    levelById: levelById,
    nodeLevelId: nodeLevelId,
    levelNodeIds: levelNodeIds,
    levelCreate: levelCreate,
    levelDelete: levelDelete,
    levelRename: levelRename,
    levelSetVisible: levelSetVisible,
    levelAssign: levelAssign,
    levelUnassign: levelUnassign,
    lockedNodeIds: lockedNodeIds,
    /* 材质归属：材质库是文档级，归属是网格级；追加资产靠 adoptMaterials + remapSlotIndices */
    slotIdsOf: slotIdsOf,
    slotsOf: slotsOf,
    meshSlotsOf: meshSlotsOf,
    setMeshSlots: setMeshSlots,
    usedSlotsOfMesh: usedSlotsOfMesh,
    adoptMaterials: adoptMaterials,
    remapSlotIndices: remapSlotIndices,
    syncSlotNamesToNodes: syncSlotNamesToNodes,
    meshIds: meshIds,
    meshIdOfNode: meshIdOfNode,
    stats: stats,
    setName: setName,
    setSelection: setSelection,
    setNodeTransform: setNodeTransform,
    revision: revision,
    snapshot: snapshot,
    applySnapshot: applySnapshot,
    toSeedModel: toSeedModel
  };
})(typeof window !== 'undefined' ? window : globalThis);
