/* 建模文档：一个 GLB 的 asset.extras.seedModel 就是这里的完整结构
 *
 * 定位（和 modeler.js 的分工）：
 *   modeler 负责「规格 → 网格」的确定性执行；本文件负责「文档」——
 *   规格、变换、revision、材质槽名、历史边界。文档是纯数据，能被序列化进 GLB，
 *   所以重新打开时不需要任何旁路文件（.model.json / sidecar 一律不做）。
 *
 * revision 的语义（四个数各管一件事，别混用）：
 *   current    总版本，每次「已提交的编辑」+1（参数、变换、以后还有网格）
 *   source     规格版本：参数改动时跟 current 同步
 *   mesh       网格版本：MVP-0 恒为 0（没有网格编辑，也不会建 baseMesh）
 *   modifiers  修改器版本：MVP-0 恒为 0（没有修改器栈）
 *   历史面板只显示 current；判断「重开时该不该清空撤销」看 historyBoundary.loadedAtRevision。
 *
 * MVP-0 的边界：mode 只允许 'parametric'，baseMesh.status 只允许 'none'。
 *   转换为可编辑网格在第二阶段做，这里只留下明确的拒绝理由，不假装转换成功。
 */
(function (global) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var MODELER_VERSION = '1';

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  function identityTransform() {
    return {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1]
    };
  }

  function transformOf(t) {
    var o = isObj(t) ? t : {};
    var p = Array.isArray(o.position) ? o.position : [];
    var r = Array.isArray(o.rotation) ? o.rotation : [];
    var s = Array.isArray(o.scale) ? o.scale : [];
    return {
      position: [num(p[0], 0), num(p[1], 0), num(p[2], 0)],
      /* 四元数不归一化也照样能渲染，但存进 GLB 后别的查看器会按归一化解释，
       * 两边就不一致了；这里统一归一化，避免「我们自己看是对的、外部打开是歪的」。 */
      rotation: quatNorm([num(r[0], 0), num(r[1], 0), num(r[2], 0), num(r[3], 1)]),
      scale: [num(s[0], 1) || 1, num(s[1], 1) || 1, num(s[2], 1) || 1]
    };
  }

  function quatNorm(q) {
    var len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (!(len > 1e-8)) return [0, 0, 0, 1];
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
  }

  function revisionOf(r) {
    var o = isObj(r) ? r : {};
    var cur = Math.max(1, Math.round(num(o.current, 1)));
    return {
      current: cur,
      source: Math.max(0, Math.round(num(o.source, cur))),
      mesh: Math.max(0, Math.round(num(o.mesh, 0))),
      modifiers: Math.max(0, Math.round(num(o.modifiers, 0)))
    };
  }

  function createDocument(opts) {
    opts = opts || {};
    var spec = clone(opts.spec || { parts: [] });
    var assetId = String(opts.assetId || '');
    var rev = revisionOf(opts.revision);
    return {
      schemaVersion: SCHEMA_VERSION,
      assetId: assetId,
      name: String(opts.name || spec.name || '未命名模型'),
      mode: 'parametric',
      revision: rev,
      transform: transformOf(opts.transform),
      source: {
        kind: 'modeler-spec',
        modelerVersion: MODELER_VERSION,
        spec: spec,
        generatedRevision: Math.max(0, Math.round(num(opts.generatedRevision, rev.source)))
      },
      modifiers: { items: Array.isArray(opts.modifiers && opts.modifiers.items) ? clone(opts.modifiers.items) : [] },
      baseMesh: {
        status: 'none',
        sourceRevision: Math.max(0, Math.round(num(opts.baseMesh && opts.baseMesh.sourceRevision, 0))),
        meshRevision: Math.max(0, Math.round(num(opts.baseMesh && opts.baseMesh.meshRevision, 0)))
      },
      materials: {
        slotNames: Array.isArray(opts.materials && opts.materials.slotNames)
          ? opts.materials.slotNames.map(String) : [],
        /* 贴图配置的真源仍是 m3d-slots.js 的 localStorage：
         *   这里只记「按哪个 key 去查」。MVP-0 新文档的 key 就等于 assetId。 */
        textureConfigKey: String((opts.materials && opts.materials.textureConfigKey) || assetId),
        textureConfigMissing: !!(opts.materials && opts.materials.textureConfigMissing)
      },
      historyBoundary: {
        undoPersisted: false,
        loadedAtRevision: Math.max(0, Math.round(num(opts.historyBoundary && opts.historyBoundary.loadedAtRevision, rev.current))),
        lastConversionRevision: Math.max(0, Math.round(num(opts.historyBoundary && opts.historyBoundary.lastConversionRevision, 0))),
        historyResetReason: String((opts.historyBoundary && opts.historyBoundary.historyResetReason) || 'new')
      }
    };
  }

  /* ---------- 校验 / 迁移 ----------
   * 从 GLB 里读回来的东西不可信（可能是旧版本、也可能是手改过的 JSON），
   * 所以统一走这里：能修的修，不能修的记 errors，由调用方决定是否继续。 */
  function validate(raw) {
    var errors = [], warnings = [];
    if (!isObj(raw)) {
      return { ok: false, errors: ['seedModel 不是对象'], warnings: warnings, doc: null };
    }
    var ver = Math.round(num(raw.schemaVersion, 0));
    if (ver !== SCHEMA_VERSION) {
      warnings.push('seedModel 版本 ' + (raw.schemaVersion || '缺失') + '，已按 v' + SCHEMA_VERSION + ' 读取');
    }
    if (!isObj(raw.source) || !isObj(raw.source.spec)) errors.push('缺少 source.spec（参数化规格）');
    var spec = isObj(raw.source) && isObj(raw.source.spec) ? raw.source.spec : null;
    if (!spec || !Array.isArray(spec.parts) || !spec.parts.length) errors.push('source.spec.parts 为空');

    var mode = String(raw.mode || 'parametric');
    if (mode !== 'parametric') {
      warnings.push('mode=' + mode + '：MVP-0 只支持参数化模式，按 parametric 打开');
      mode = 'parametric';
    }
    var base = isObj(raw.baseMesh) ? raw.baseMesh : {};
    if (String(base.status || 'none') !== 'none') {
      warnings.push('baseMesh.status=' + base.status + '：MVP-0 不认可编辑网格，按 none 处理');
    }

    var doc = createDocument({
      assetId: raw.assetId,
      name: raw.name,
      spec: spec || { parts: [] },
      revision: raw.revision,
      transform: raw.transform,
      modifiers: raw.modifiers,
      baseMesh: base,
      materials: raw.materials,
      generatedRevision: raw.source && raw.source.generatedRevision,
      historyBoundary: raw.historyBoundary
    });
    doc.mode = 'parametric';
    doc.baseMesh.status = 'none';
    /* asset.extras 里的 assetId 才是权威；外层资产库的 id 由调用方覆写（复制资产时两者会不同） */
    if (!doc.assetId) {
      doc.assetId = String(raw.assetId || '');
      doc.materials.textureConfigKey = doc.assetId;
    }
    if (!doc.materials.textureConfigKey) doc.materials.textureConfigKey = doc.assetId;
    if (!Array.isArray(doc.materials.slotNames) || !doc.materials.slotNames.length) {
      doc.materials.textureConfigMissing = !!raw.materials && !!raw.materials.textureConfigMissing;
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings, doc: doc };
  }

  function serialize(doc) {
    return clone(doc);
  }

  function snapshot(doc) {
    if (!doc) return null;
    var s = clone(doc);
    /* 历史只回滚「编辑相关」的东西；assetId / textureConfigKey 这类身份信息不参与撤销 */
    delete s.assetId;
    delete s.materials;
    delete s.historyBoundary;
    return s;
  }

  function applySnapshot(doc, snap) {
    if (!doc || !snap) return doc;
    if (isObj(snap.source)) doc.source = clone(snap.source);
    if (snap.transform) doc.transform = transformOf(snap.transform);
    if (snap.revision) doc.revision = revisionOf(snap.revision);
    if (isObj(snap.baseMesh)) doc.baseMesh = clone(snap.baseMesh);
    if (isObj(snap.modifiers)) doc.modifiers = clone(snap.modifiers);
    if (snap.name != null) doc.name = String(snap.name);
    doc.mode = 'parametric';
    return doc;
  }

  /* ---------- 编辑 ----------
   * 所有写入都改在 doc.source.spec 上（文档里只有这一份规格）。
   * 参数提交时才 pushRevision('source')；拖动过程只更新规格用于预览。 */
  function partAt(doc, i) {
    var parts = doc && doc.source && doc.source.spec && doc.source.spec.parts;
    return parts && parts[i] ? parts[i] : null;
  }

  function setPartNumber(doc, partIndex, field, index, value) {
    var p = partAt(doc, partIndex);
    if (!p || !field) return false;
    var n = num(value, 0);
    if (field === 'size' || field === 'pos' || field === 'rot') {
      if (!Array.isArray(p[field])) p[field] = field === 'size' ? [0.1, 0.1, 0.1] : [0, 0, 0];
      var k = Math.max(0, Math.min(2, Math.round(num(index, 0))));
      p[field][k] = n;
      return true;
    }
    if (field === 'seg') { p.seg = Math.max(6, Math.min(64, Math.round(n))); return true; }
    if (field === 'smooth') { p.smooth = !!value; return true; }
    if (field === 'repeat.count' && p.repeat) {
      p.repeat.count = Math.max(1, Math.min(64, Math.round(n))); return true;
    }
    if (field === 'repeat.offset' && p.repeat) {
      if (!Array.isArray(p.repeat.offset)) p.repeat.offset = [0, 0, 0];
      var k2 = Math.max(0, Math.min(2, Math.round(num(index, 0))));
      p.repeat.offset[k2] = n;
      return true;
    }
    return false;
  }

  function setPartText(doc, partIndex, field, value) {
    var p = partAt(doc, partIndex);
    if (!p) return false;
    if (field === 'id') { p.id = String(value || p.id || ''); return true; }
    if (field === 'color') {
      p.color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || '')) ? String(value) : p.color;
      return true;
    }
    return false;
  }

  function setHeight(doc, value) {
    if (!doc || !doc.source || !doc.source.spec) return false;
    var n = num(value, 0);
    doc.source.spec.height = n > 0 ? n : undefined;
    if (n <= 0) delete doc.source.spec.height;
    return true;
  }

  function setName(doc, name) {
    if (!doc) return false;
    doc.name = String(name || '').slice(0, 120) || '未命名模型';
    if (doc.source && doc.source.spec) doc.source.spec.name = doc.name;
    return true;
  }

  function pushRevision(doc, kind) {
    if (!doc) return doc;
    if (!doc.revision) doc.revision = revisionOf(null);
    if (kind === 'source') {
      doc.revision.current += 1;
      doc.revision.source = doc.revision.current;
      if (doc.source) doc.source.generatedRevision = doc.revision.source;
    } else if (kind === 'mesh') {
      /* 第二阶段才会走这里；MVP-0 保留分支，免得以后改语义 */
      doc.revision.current += 1;
      doc.revision.mesh = doc.revision.current;
      if (doc.baseMesh) doc.baseMesh.meshRevision = doc.revision.mesh;
    } else {
      doc.revision.current += 1;
    }
    return doc;
  }

  function setTransform(doc, position, quaternion, scale) {
    if (!doc) return false;
    var p = Array.isArray(position) ? position : (position && position.toArray ? position.toArray() : null);
    var q = Array.isArray(quaternion) ? quaternion : (quaternion && quaternion.toArray ? quaternion.toArray() : null);
    var s = Array.isArray(scale) ? scale : (scale && scale.toArray ? scale.toArray() : null);
    doc.transform = transformOf({
      position: p || doc.transform.position,
      rotation: q || doc.transform.rotation,
      scale: s || doc.transform.scale
    });
    return true;
  }

  /* MVP-0 明确拒绝：不落 half-edge、不建 baseMesh，也不把 mode 改成 mesh。
   * 返回结构化结果，UI 直接显示 message；不做「静默降级」。 */
  function convertToEditableMesh(doc) {
    return {
      ok: false,
      message: 'MVP-0 只支持参数化模式；转换为可编辑网格是第二阶段的能力',
      doc: doc
    };
  }

  function partCount(doc) {
    var parts = doc && doc.source && doc.source.spec && doc.source.spec.parts;
    return Array.isArray(parts) ? parts.length : 0;
  }

  global.SeedDocument = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MODELER_VERSION: MODELER_VERSION,
    identityTransform: identityTransform,
    transformOf: transformOf,
    createDocument: createDocument,
    validate: validate,
    serialize: serialize,
    snapshot: snapshot,
    applySnapshot: applySnapshot,
    setPartNumber: setPartNumber,
    setPartText: setPartText,
    setHeight: setHeight,
    setName: setName,
    pushRevision: pushRevision,
    setTransform: setTransform,
    convertToEditableMesh: convertToEditableMesh,
    partCount: partCount
  };
})(window);
