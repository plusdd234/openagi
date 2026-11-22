/* 材质槽服务（MaterialSlotService · 分层路线第 1 步）
 *
 * 为什么单独成层：
 *   材质槽的语义（稳定 id / 去重 / faceSlots 重映射 / 追加资产时整体后移）
 *   原先长在 seed-model-scene.js 里，和「文档结构 / 节点 / 网格」混在一起。
 *   外壳（model-desk.js）与绘画、导出、UV 各自又直接读写 slotNames / slotMaps，
 *   谁都能改下标，出错时没有任何一方能回答「槽的规则是什么」。
 *
 * 本模块只负责「槽的规则」，不碰 three、不碰 DOM、不碰历史：
 *   ① 槽 id：生成 / 补全 / 去重（slotIdsOf / freshIds）
 *   ② 槽数组：slotNames / slotColors / slotMaps 同长保证（namesOf / arrayOf）
 *   ③ faceSlots：解码（GLB 里是 base64）、去重、追加偏移、删槽重排
 *   ④ 跨文档并入：adoptMaterials（源材质整体后移并给出 id 对照）
 * 网格归属（doc.meshSlots：哪个 mesh 用到哪些下标）仍留在 Scene ——
 * 它需要节点解析（nodeOf / meshRef），属于文档结构，不属于槽语义。
 *
 * 对外（window.MDMaterialSlots）：
 *   uniq(list) / packedSlots(meshJson) / usedSlots(meshJson)
 *   namesOf(doc) / arrayOf(doc, key) / idsOf(doc) / freshIds(ids, n)
 *   adopt(doc, srcDoc) / remap(mesh, offset, bump)
 *   retarget(mesh, from, to, bump) / shiftAfterRemoval(mesh, index, bump)
 *   clamp(slotCount, slot)
 * bump 由调用方注入（M.Mesh.bump）：本模块不认识 SeedModel.Mesh。
 */
(function (global) {
  'use strict';

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v, d) { var s = String(v == null ? '' : v); return s || d; }

  /* 去重 + 升序：只保留非负整数。faceSlots / meshSlots 的唯一口径。 */
  function uniq(list) {
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
  function packedSlots(meshJson) {
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

  /* 一个网格实际用到的槽：没有 faceSlots 的老网格按「全部用槽 0」处理。 */
  function usedSlots(meshJson) {
    var fs = packedSlots(meshJson);
    return uniq(fs.length ? fs : [0]);
  }

  /* 槽名数组是槽是否存在的唯一判据；同时保证颜色 / 贴图两份数组同长。 */
  function namesOf(doc) {
    if (!doc) return [];
    doc.materials = doc.materials || {};
    if (!Array.isArray(doc.materials.slotNames)) doc.materials.slotNames = [];
    if (!Array.isArray(doc.materials.slotColors)) doc.materials.slotColors = [];
    if (!Array.isArray(doc.materials.slotMaps)) doc.materials.slotMaps = [];
    return doc.materials.slotNames;
  }

  function arrayOf(doc, key) {
    doc.materials = doc.materials || {};
    if (!Array.isArray(doc.materials[key])) doc.materials[key] = [];
    return doc.materials[key];
  }

  /* 稳定槽 id：改名 / 删槽 / 追加资产之后，纹理配置仍认得住同一个材质。
   * 老文档没有这个字段，按位置补一个确定性的 id，打开后行为不变。 */
  function idsOf(doc) {
    if (!doc) return [];
    var names = namesOf(doc);
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
  function freshIds(ids, n) {
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
  function adopt(doc, srcDoc) {
    var names = namesOf(doc);
    var colors = arrayOf(doc, 'slotColors');
    var maps = arrayOf(doc, 'slotMaps');
    var ids = idsOf(doc);
    var sm = (srcDoc && srcDoc.materials) || {};
    var sNames = Array.isArray(sm.slotNames) ? sm.slotNames : [];
    var sColors = Array.isArray(sm.slotColors) ? sm.slotColors : [];
    var sMaps = Array.isArray(sm.slotMaps) ? sm.slotMaps : [];
    var sIds = Array.isArray(sm.slotIds) ? sm.slotIds : [];
    var count = Math.max(sNames.length, 1);
    var offset = names.length;
    var fresh = freshIds(ids, count);
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

  /* 追加资产：面的槽下标整体后移，落到刚并入的那批材质上。 */
  function remap(mesh, offset, bump) {
    if (!mesh || !Array.isArray(mesh.faceSlots) || !offset) return mesh;
    for (var i = 0; i < mesh.faceSlots.length; i++) {
      var s = Number(mesh.faceSlots[i]);
      mesh.faceSlots[i] = (s >= 0 ? s : 0) + offset;
    }
    if (bump) bump(mesh);
    return mesh;
  }

  /* 把落在 from 槽的面改指 to 槽（删槽前的对象级摘除）。 */
  function retarget(mesh, from, to, bump) {
    if (!mesh || !Array.isArray(mesh.faceSlots)) return mesh;
    for (var i = 0; i < mesh.faceSlots.length; i++) {
      if ((mesh.faceSlots[i] || 0) === from) mesh.faceSlots[i] = to;
    }
    if (bump) bump(mesh);
    return mesh;
  }

  /* 真正回收一个槽：该槽的面回落到 0，比它大的下标整体 -1。 */
  function shiftAfterRemoval(mesh, index, bump) {
    if (!mesh || !Array.isArray(mesh.faceSlots)) return mesh;
    for (var i = 0; i < mesh.faceSlots.length; i++) {
      var s = mesh.faceSlots[i] || 0;
      if (s === index) mesh.faceSlots[i] = 0;
      else if (s > index) mesh.faceSlots[i] = s - 1;
    }
    if (bump) bump(mesh);
    return mesh;
  }

  /* 指派前的下标夹取：面永远不能指到不存在的槽。 */
  function clamp(slotCount, slot) {
    var max = Math.max(0, Math.round(Number(slotCount) || 0) - 1);
    return Math.max(0, Math.min(max, Math.round(Number(slot) || 0)));
  }

  global.MDMaterialSlots = {
    uniq: uniq,
    packedSlots: packedSlots,
    usedSlots: usedSlots,
    namesOf: namesOf,
    arrayOf: arrayOf,
    idsOf: idsOf,
    freshIds: freshIds,
    adopt: adopt,
    remap: remap,
    retarget: retarget,
    shiftAfterRemoval: shiftAfterRemoval,
    clamp: clamp
  };
})(typeof window !== 'undefined' ? window : globalThis);
