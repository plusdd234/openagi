/* ============================================================
 * seed-tools.js —— 工具会话状态机（M6a / A2）
 *
 * 算子不是「一个函数」，而是**一段会话**：
 *   begin(预览) → drag(改预览) → commit(一次历史) | cancel(无痕)
 *
 * 三条硬规矩：
 *   ① **预览只进视口**，绝不改文档 / 绝不进历史。
 *      commit 才调 applyMesh / docEdit。
 *   ② **松手 = 一条历史**。哪怕用户拖了 200 帧，Ctrl+Z 一次就回退到 begin 之前。
 *   ③ **Esc = 无痕**。cancel 后文档必须与 begin 之前逐字节一致
 *      （探针会比 hash）。
 *
 * 会话实现一个对象：
 *   { id, begin(ctx), drag(ctx), commit(ctx), cancel(ctx), params }
 *   - begin 返回 false 表示条件不满足、根本不该开会话
 *   - drag 期间 ctx.preview 是**会话自己维护的**临时网格（不进文档）
 *   - commit 返回 false 时视为没改成，外壳要回滚预览
 *
 * 对外：window.SeedTools = { register, lookup, list, begin, drag, commit, cancel,
 *                           isLive, current, setParams, listParams }
 * ============================================================ */
(function (global) {
  'use strict';

  var impls = Object.create(null);
  var live = null;       // { id, impl, ctx, params }

  function isFn(v) { return typeof v === 'function'; }
  function str(v, d) { var s = String(v == null ? '' : v); return s || d; }

  function register(spec) {
    if (!spec || !spec.id) throw new Error('SeedTools.register 需要 id');
    var id = String(spec.id);
    if (impls[id]) throw new Error('SeedTools: 重复注册工具 ' + id);
    if (!isFn(spec.begin)) throw new Error('SeedTools.register 需要 begin');
    impls[id] = {
      id: id,
      label: str(spec.label, id),
      /* 参数 schema：[{ key, label, value, min, max, step, off, type }]
       * 参数条由它生成（type='toggle' 时 value 当 0/1 开关），会话里通过 ctx.params.key 读 */
      params: Array.isArray(spec.params) ? spec.params.map(function (p) {
        return {
          key: str(p.key, ''),
          label: str(p.label, p.key),
          value: p.value == null ? 0 : Number(p.value),
          min: p.min == null ? null : Number(p.min),
          max: p.max == null ? null : Number(p.max),
          step: p.step == null ? null : Number(p.step),
          off: !!p.off,
          type: p.type === 'toggle' ? 'toggle' : 'number'
        };
      }) : [],
      begin: spec.begin,
      drag: isFn(spec.drag) ? spec.drag : function () {},
      commit: isFn(spec.commit) ? spec.commit : function () { return true; },
      cancel: isFn(spec.cancel) ? spec.cancel : function () {},
      /* 可选：会话能不能在「没有组件选择」时开（默认可以） */
      needSelection: !!spec.needSelection
    };
    return impls[id];
  }

  function lookup(id) { return impls[String(id || '')] || null; }
  function list() {
    return Object.keys(impls).map(function (k) { return impls[k]; });
  }

  /* 会话参数：开之前/开着都可以改（drag 里按 ctx.params 重算预览） */
  function paramsOf(impl) {
    var out = Object.create(null);
    (impl.params || []).forEach(function (p) { out[p.key] = p.value; });
    return out;
  }

  function setParams(patch) {
    if (!live) return false;
    Object.keys(patch || {}).forEach(function (k) {
      if (k in live.params) live.params[k] = Number(patch[k]);
    });
    /* 参数变了 → 让会话按新参数重算预览 */
    try { live.impl.drag({ preview: live.ctx.preview, params: live.params, ctx: live.ctx }); } catch (e) {}
    return true;
  }

  function listParams() {
    if (!live) return [];
    return live.impl.params.map(function (p) {
      return {
        key: p.key, label: p.label, min: p.min, max: p.max, step: p.step, off: p.off,
        type: p.type || 'number',
        value: live.params[p.key]
      };
    });
  }

  /* begin：开会话。已在别的会话里就先 cancel 它（不留悬空预览）。 */
  function begin(id, ctx) {
    var impl = lookup(id);
    if (!impl) return { ok: false, reason: 'no-such-tool' };
    if (live) cancel({ silent: true });
    var session = {
      ctx: ctx || {},
      params: paramsOf(impl)
    };
    session.ctx.params = session.params;
    session.ctx.preview = null;
    var ok;
    try { ok = impl.begin(session.ctx); } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
    if (ok === false) return { ok: false, reason: 'refused' };
    live = { id: impl.id, impl: impl, ctx: session.ctx, params: session.params };
    return { ok: true, id: impl.id, params: session.params };
  }

  function drag(update) {
    if (!live) return false;
    var patch = update || {};
    Object.keys(patch).forEach(function (k) {
      if (k === 'preview' || k === 'params' || k === 'ctx') return;
      live.ctx[k] = patch[k];
    });
    if (patch.params) setParams(patch.params);
    try { live.impl.drag(live.ctx); } catch (e) { return false; }
    return true;
  }

  /* commit：把预览写进文档 + 一条历史。失败要自己回滚预览。 */
  function commit() {
    if (!live) return { ok: false, reason: 'no-session' };
    var id = live.id, impl = live.impl, ctx = live.ctx;
    var ok;
    try { ok = impl.commit(ctx); } catch (e) {
      try { impl.cancel(ctx); } catch (e2) {}
      live = null;
      return { ok: false, id: id, reason: String((e && e.message) || e) };
    }
    live = null;
    return { ok: ok !== false, id: id };
  }

  /* cancel：丢掉预览，文档必须回到 begin 之前 */
  function cancel(opts) {
    if (!live) return false;
    var impl = live.impl, ctx = live.ctx;
    try { impl.cancel(ctx); } catch (e) {}
    live = null;
    return !(opts && opts.silent);
  }

  function isLive(id) { return !!live && (!id || live.id === String(id)); }
  function current() {
    return live ? { id: live.id, params: live.params } : null;
  }

  global.SeedTools = {
    register: register,
    lookup: lookup,
    list: list,
    begin: begin,
    drag: drag,
    commit: commit,
    cancel: cancel,
    isLive: isLive,
    current: current,
    setParams: setParams,
    listParams: listParams
  };
})(typeof window !== 'undefined' ? window : this);
