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
    for (var i = 0; i < names.length; i++) {
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colors[i] || '')) colors[i] = '#c9ccd4';
    }
    return {
      slotNames: names,
      /* 只用于视口显示；贴图配置仍按 textureConfigKey 去 m3d-slots 查 */
      slotColors: colors.slice(0, names.length),
      slotMaps: maps.slice(0, names.length),
      textureConfigKey: str(o.textureConfigKey, assetId),
      textureConfigMissing: !!o.textureConfigMissing
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
      modifiers: Array.isArray(n.modifiers) ? clone(n.modifiers) : []
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
    node.materialSlots = mats.slotNames.slice();

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
    if (nodes.length && !nodes[0].materialSlots.length) nodes[0].materialSlots = mats.slotNames.slice();

    /* v2 → v2.1 迁移：只补结构，不改数据。meshRef 指向不存在的网格时统一落到第一个，
     * 否则节点会「指向空气」，渲染时表现为打开后什么都没有。 */
    var mm = meshesOf(raw);
    nodes.forEach(function (n) {
      if (n.type !== 'mesh') return;
      if (!n.meshRef || !mm.map[n.meshRef]) n.meshRef = mm.first || MESH_REF;
    });
    var actId = str(raw.activeNodeId, '');
    if (!actId || !nodes.some(function (n) { return n.id === actId; })) {
      var firstMesh = nodes.filter(function (n) { return n.type === 'mesh'; })[0];
      actId = firstMesh ? firstMesh.id : (nodes[0] ? nodes[0].id : '');
    }

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
      historyBoundary: {
        undoPersisted: false,
        loadedAtRevision: Math.max(0, Math.round(num(raw.historyBoundary && raw.historyBoundary.loadedAtRevision, rev.current))),
        lastConversionRevision: Math.max(0, Math.round(num(raw.historyBoundary && raw.historyBoundary.lastConversionRevision, 0))),
        historyResetReason: str(raw.historyBoundary && raw.historyBoundary.historyResetReason, 'reopen')
      }
    };
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
    Object.keys(doc.meshes).forEach(function (id) {
      try {
        cacheOf(doc)[id] = M.Mesh.fromJSON(doc.meshes[id]);
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
    var id = meshIdOfNode(doc, node) || MESH_REF;
    doc.meshes[id] = M.Mesh.toJSON(mesh);
    if (node) node.meshRef = id;
    cacheOf(doc)[id] = mesh;
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
    node.materialSlots = (doc.materials && doc.materials.slotNames ? doc.materials.slotNames : []).slice();
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
      if (!used) { delete doc.meshes[ref]; delete cacheOf(doc)[ref]; }
    }
    if (doc.activeNodeId === id) {
      var next = nodesOf(doc)[0] || doc.nodes[0];
      doc.activeNodeId = next ? next.id : '';
    }
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
    var names = (doc && doc.materials && doc.materials.slotNames) || [];
    (doc.nodes || []).forEach(function (n) { n.materialSlots = names.slice(); });
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
    var name = str(opts.name, '插槽 ' + (names.length + 1)).slice(0, 60);
    names.push(name);
    colors.push(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(opts.color || '')) ? opts.color : '#c9ccd4');
    maps.push('');
    syncSlotNamesToNodes(doc);
    return names.length - 1;
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
  function removeSlot(doc, index) {
    if (!doc) return false;
    var names = slotNamesOf(doc);
    index = Math.round(Number(index));
    if (!(index >= 0 && index < names.length)) return false;
    /* 至少留一个槽：零槽文档会让「槽名 → 贴图 key」整条链没有落点 */
    if (names.length <= 1) return false;
    names.splice(index, 1);
    var colors = slotArray(doc, 'slotColors');
    var maps = slotArray(doc, 'slotMaps');
    if (colors.length > index) colors.splice(index, 1);
    if (maps.length > index) maps.splice(index, 1);
    /* 每个 meshRef 只重排一次：两个节点共用一份网格时不能算两遍 */
    var seen = Object.create(null);
    (doc.nodes || []).forEach(function (n) {
      var ref = n.meshRef || MESH_REF;
      if (seen[ref]) return;
      seen[ref] = 1;
      var mesh = null;
      try { mesh = getMesh(doc, n); } catch (e) { mesh = null; }
      if (!mesh || !mesh.faceSlots) return;
      for (var i = 0; i < mesh.faceSlots.length; i++) {
        var s = mesh.faceSlots[i] || 0;
        if (s === index) mesh.faceSlots[i] = 0;
        else if (s > index) mesh.faceSlots[i] = s - 1;
      }
      M.Mesh.bump(mesh);
      setMesh(doc, mesh, n);
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
      selection: doc.selection,
      revision: doc.revision
    });
  }

  function applySnapshot(doc, snap) {
    if (!doc || !isObj(snap)) return doc;
    if (snap.name != null) doc.name = String(snap.name);
    if (Array.isArray(snap.nodes)) doc.nodes = clone(snap.nodes);
    if (isObj(snap.selection)) doc.selection = selectionOf(snap.selection);
    if (isObj(snap.revision)) doc.revision = revisionOf(snap.revision);
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
    nodesOf: nodesOf,
    activeNode: activeNode,
    setActiveNode: setActiveNode,
    addMeshNode: addMeshNode,
    removeNode: removeNode,
    addSlot: addSlot,
    renameSlot: renameSlot,
    removeSlot: removeSlot,
    assignSlot: assignSlot,
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
