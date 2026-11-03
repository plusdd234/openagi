/* ============================================================
 * seed-commands.js —— 命令注册表（M6a / A1 / P1）
 *
 * 一个算子会出现在 菜单 / Shelf / 工具箱 / 命令行 / 快捷键 五处。
 * 五处都只查这一张表，**算子只在这里加一行**：
 *
 *   SeedCommands.define({
 *     id: 'mesh.extrude',
 *     label: '挤出',
 *     group: 'mesh',              // 菜单分组（用于菜单按组渲染）
 *     when: ctx => ctx.hasSelection,   // 为假时入口灰显（不消失）
 *     run: ctx => { ... return true; } // 返回 false = 没做成（不要自己弹错误框）
 *   });
 *
 * ⚠ 不要在 desktop / runtime / validate / flow-gen 里写 `if (cmdId === '...')`。
 *   那是五张表的开端，迟早各写各的。
 *
 * 对外：window.SeedCommands = { define, lookup, list, run, available, unregister }
 * ============================================================ */
(function (global) {
  'use strict';

  var byId = Object.create(null);

  function isFn(v) { return typeof v === 'function'; }
  function str(v, d) { var s = String(v == null ? '' : v); return s || d; }

  function define(spec) {
    if (!spec || !spec.id) throw new Error('SeedCommands.define 需要 id');
    var id = String(spec.id);
    if (byId[id]) {
      /* 重复定义是 bug，不是「覆盖」——静默覆盖会让两个入口显示同一个 id 却跑不同逻辑 */
      throw new Error('SeedCommands: 重复定义命令 ' + id);
    }
    byId[id] = {
      id: id,
      label: str(spec.label, id),
      group: str(spec.group, 'misc'),
      when: isFn(spec.when) ? spec.when : function () { return true; },
      run: isFn(spec.run) ? spec.run : function () { return false; },
      /* 可选：参数面板描述（HB_PANEL 的 hbPanelSpec 同源），没填就不弹面板 */
      panel: spec.panel || null,
      /* 可选：快捷键字符串（仅用于显示，绑定仍是 model-desk 的键盘层） */
      key: str(spec.key, ''),
      /* 可选：菜单里的排序（小的在前） */
      order: Number(spec.order) || 0
    };
    return byId[id];
  }

  function lookup(id) { return byId[String(id || '')] || null; }

  function list(group) {
    var all = Object.keys(byId).map(function (k) { return byId[k]; });
    if (group) all = all.filter(function (c) { return c.group === group; });
    all.sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return all;
  }

  /* 可用性：when(ctx) 为真才算可用。UI 靠它决定灰显还是可点。 */
  function available(id, ctx) {
    var c = lookup(id);
    if (!c) return false;
    try { return !!c.when(ctx || {}); } catch (e) { return false; }
  }

  /* 执行。返回 { ok, id, value }；命令没注册 / when 为假 → ok:false。
   * 不在这层弹错误框 —— 调用方（外壳）决定怎么报。 */
  function run(id, ctx) {
    var c = lookup(id);
    if (!c) return { ok: false, id: String(id || ''), reason: 'no-such-command' };
    if (!available(id, ctx)) return { ok: false, id: c.id, reason: 'not-available' };
    var value;
    try {
      value = c.run(ctx || {});
    } catch (e) {
      return { ok: false, id: c.id, reason: String((e && e.message) || e) };
    }
    return { ok: value !== false, id: c.id, value: value };
  }

  /* 测试 / 重构用：清掉重来（别在产品代码里调） */
  function unregister(id) { delete byId[String(id || '')]; }

  global.SeedCommands = {
    define: define,
    lookup: lookup,
    list: list,
    available: available,
    run: run,
    unregister: unregister
  };
})(typeof window !== 'undefined' ? window : this);
