/* 编码 App 的轨迹层（H0 提案，见 docs/提案-编码App-实验集-v0.1.md）
 *
 * 为什么需要它：在这个文件之前，编码 App **一条记录都不留**。关掉窗口，
 * 这轮对话、六次工具调用、用户点了几次「放弃」全部消失。
 * 结论：没有轨迹就没有监督 —— 没有输入，任何"改良"只能靠感觉。
 *
 * 三条硬约束（改这个文件之前先读）：
 *
 *   ① **只记工具边界，绝不记全文。**
 *      不记模型原文输出、不记文件内容、不记用户输入全文。
 *      监督要回答的是「它做了什么、结果如何」，不是「它说了什么」。
 *      存全文会把存储和隐私同时压垮，收益接近零。
 *
 *   ② **写盘只在 end()，事件只 push。**
 *      插桩开销必须 < 总时长 5%（H0 的 killCriteria）。若每个事件都
 *      JSON.stringify 整个库，一次任务几十次序列化，开销会直接吃掉这个预算。
 *
 *   ③ **存储不可用时降级到内存，绝不抛。**
 *      轨迹是观测设施，它挂掉不能连带把编码 App 弄崩 ——
 *      那会导致"为了观测反而不能用"，比没有观测更糟。
 *
 * 为什么独立 store 不复用 ops-trace.js：
 *   ops-trace 的形状是蓝图流程的（traceTx/traceAppend，按事务记），
 *   编码任务是「一条任务 → 一串工具边界事件」，两者的派生指标完全不同。
 *   硬塞进去会让两边都变形。
 *
 * 导出：浏览器挂 global.CodeTrace，node 走 module.exports（同 UMD 惯例）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CodeTrace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY = 'openagi:code-trace';
  const VERSION = 1;
  const MAX_TASKS = 80;                 // 库容量：超出丢最老的
  const MAX_EVENTS = 120;               // 单任务事件上限（防御性，正常任务约 20~40）
  const TASK_BYTE_BUDGET = 200 * 1024;  // H0 声明的单任务上限，超出砍事件

  let mem = null;     // { v, tasks: [] }
  let cur = null;     // 进行中的任务
  let turnNo = 0;

  function now(){ return Date.now(); }

  function storage(){
    try {
      return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    } catch (e) { return null; }
  }

  function load(){
    if (mem) return mem;
    const s = storage();
    if (s) {
      try {
        const raw = s.getItem(KEY);
        if (raw) {
          const o = JSON.parse(raw);
          if (o && o.v === VERSION && Array.isArray(o.tasks)) { mem = o; return mem; }
        }
      } catch (e) { /* 坏数据当作空库，不要因为一条烂记录丢整个能力 */ }
    }
    mem = { v: VERSION, tasks: [] };
    return mem;
  }

  function save(){
    const db = load();
    const s = storage();
    if (!s) return false;             // 内存模式：本会话内可用，刷新即失
    for (let guard = 0; guard < 12; guard++) {
      try { s.setItem(KEY, JSON.stringify(db)); return true; }
      catch (e) {
        if (!db.tasks.length) return false;
        db.tasks.shift();             // 配额满了就丢最老的，宁可少记也不要丢当次
      }
    }
    return false;
  }

  /* ⚠ clip 只防体积膨胀，**不是隐私防线**。
   * 它把超长字符串砍到上限，但砍不掉「前 80 个字符正好是源码」这种情况。
   * 隐私只能靠调用方保证：摘要必须是「路径 + 长度 + 计数」这种派生量，
   * 绝不把原文传进来再指望这里截断。测试里有一条专门盯着这件事。 */
  function clip(v, n){
    const s = String(v == null ? '' : v);
    return s.length > n ? s.slice(0, n) : s;
  }

  function push(ev){
    if (!cur) return;
    if (cur.events.length >= MAX_EVENTS) { cur.dropped++; cur.events.shift(); }
    cur.events.push(ev);
  }

  /* ---------------- 写入口 ---------------- */

  /* 开始一个任务。meta 只收必要字段：模型名 + 工作区名（不含完整路径，避免泄露目录结构）。 */
  function start(meta){
    const m = meta || {};
    turnNo = 0;
    cur = {
      id: 'ct' + now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: now(),
      model: clip(m.model, 60),
      ws: clip(m.ws, 80),
      events: [],
      dropped: 0,
      ms: 0,
      reason: ''
    };
    return cur.id;
  }

  /* 轮次边界。phase: 'request'（给工具）| 'final'（收口轮，不再给工具）。
   * 从 toolLoopRun 的 onRound 直接接进来，不需要改 tool-loop 的其它逻辑。 */
  function turn(n, phase){
    if (!cur) return;
    turnNo = Number(n) || 0;
    push({ e: 'turn', n: turnNo, f: phase === 'final' ? 1 : 0, t: now() - cur.at });
  }

  /* 一次工具执行。argsDigest / resultDigest 由调用方摘要好再传 ——
   * 这里不做摘要，因为它不知道各工具的字段语义，硬猜会丢掉关键信息。 */
  function tool(rec){
    if (!cur) return;
    const r = rec || {};
    push({
      e: 'tool',
      n: turnNo,
      k: clip(r.name, 24),
      a: clip(r.argsDigest, 200),
      ok: r.ok === false ? 0 : 1,
      d: clip(r.resultDigest, 200),
      ms: Math.max(0, Math.round(Number(r.ms) || 0))
    });
  }

  /* diff 卡片的人为判定。wait = 从卡片出现到点击的毫秒数。
   * 这个字段是 H2（changeset 合并）的核心指标：合并能减少确认次数，
   * 但真正要看的是一张卡要人看多久 —— 次数少了、每次更久，等于没省。 */
  function verdict(rec){
    if (!cur) return;
    const r = rec || {};
    push({
      e: 'diff',
      k: r.kind === 'new' ? 'n' : 'm',
      p: clip(r.path, 160),
      v: r.verdict === 'apply' ? 'a' : r.verdict === 'abort' ? 'x' : 's',
      wait: Math.max(0, Math.round(Number(r.wait) || 0))
    });
  }

  /* ---------------- 派生指标 ---------------- */

  /* 从事件流算出的可分析量。存进任务里，stats() 就不用每次重扫。
   * readsBeforeFirstEdit 是 H1（上下文地图）的核心指标：
   * 地图的作用是让人少读文件，这个数不降就说明地图没用。 */
  function derive(t){
    const ev = Array.isArray(t.events) ? t.events : [];
    const tools = ev.filter(x => x.e === 'tool');
    const diffs = ev.filter(x => x.e === 'diff');
    let reads = 0, readsBeforeEdit = 0, seenEdit = false, failed = 0;
    const touched = [];
    for (const x of tools) {
      if (x.ok === 0) failed++;
      if (x.k === 'ws_read') { reads++; if (!seenEdit) readsBeforeEdit++; }
      if (x.k === 'fs_edit' || x.k === 'fs_new') seenEdit = true;
    }
    let applied = 0, declined = 0, aborted = 0, waitSum = 0;
    for (const x of diffs) {
      if (x.v === 'a') applied++;
      else if (x.v === 's') declined++;
      else aborted++;
      waitSum += (x.wait || 0);
    }
    /* 去重后的被读文件列表：它回答「这次任务实际碰了哪些文件」，
     * 是判断「地图给得对不对」的唯一依据。不存内容，只存路径。 */
    for (const x of tools) {
      if (x.k !== 'ws_read' && x.k !== 'fs_edit' && x.k !== 'fs_new') continue;
      const p = firstPath(x.a);
      if (p && touched.indexOf(p) < 0) touched.push(p);
    }
    return {
      turns: ev.filter(x => x.e === 'turn').length,
      tools: tools.length,
      failed: failed,
      reads: reads,
      readsBeforeEdit: readsBeforeEdit,
      hasEdit: seenEdit,
      applied: applied,
      declined: declined,
      aborted: aborted,
      waitMs: waitSum,
      touched: touched.slice(0, 24),
      dropped: t.dropped || 0
    };
  }

  /* 从 argsDigest 里取路径。摘要格式约定为 "path · old:120 · new:80"，
   * 第一段永远是路径（没有路径的工具返回空串）。 */
  function firstPath(digest){
    const s = String(digest || '');
    const i = s.indexOf(' · ');
    const p = i < 0 ? s : s.slice(0, i);
    return /[\\/.]/.test(p) ? clip(p, 160) : '';
  }

  function end(rec){
    if (!cur) return '';
    const r = rec || {};
    cur.ms = now() - cur.at;
    cur.reason = clip(r.reason || 'done', 40);
    cur.edges = derive(cur);
    /* 单任务体积保护：事件太多就砍尾巴（保留头尾信息）。
     * 正常情况下 20~40 个事件，几 KB 而已，这段几乎不会触发。 */
    if (JSON.stringify(cur).length > TASK_BYTE_BUDGET && cur.events.length > 20) {
      const keep = cur.events.slice(0, 10).concat(cur.events.slice(-10));
      cur.dropped += cur.events.length - keep.length;
      cur.events = keep;
    }
    const db = load();
    db.tasks.push(cur);
    while (db.tasks.length > MAX_TASKS) db.tasks.shift();
    const id = cur.id;
    cur = null;
    save();
    return id;
  }

  /* ---------------- 读 ---------------- */

  function list(opts){
    const o = opts || {};
    const db = load();
    const n = Math.max(1, Math.min(MAX_TASKS, Number(o.limit) || MAX_TASKS));
    return db.tasks.slice(-n).map(t => ({
      id: t.id, at: t.at, model: t.model, ws: t.ws,
      ms: t.ms, reason: t.reason, edges: t.edges,
      events: o.full ? (t.events || []) : undefined
    }));
  }

  function get(id){
    const db = load();
    for (const t of db.tasks) if (t.id === id) return t;
    return null;
  }

  function nums(arr){
    const v = arr.filter(x => typeof x === 'number' && isFinite(x)).slice().sort((a, b) => a - b);
    if (!v.length) return { n: 0, median: 0, avg: 0, p90: 0 };
    const at = q => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
    const sum = v.reduce((a, b) => a + b, 0);
    return { n: v.length, median: at(0.5), avg: Math.round(sum / v.length), p90: at(0.9) };
  }

  /* 聚合统计。**这是 H1/H2/H3 的基线来源** —— 提案里的
   * evidence.baseline 就填这里的数，而不是让提案者自己估。 */
  function stats(){
    const db = load();
    const ts = db.tasks.slice();
    const withEdit = ts.filter(t => t.edges && t.edges.hasEdit);
    const applied = ts.reduce((a, t) => a + ((t.edges && t.edges.applied) || 0), 0);
    const declined = ts.reduce((a, t) => a + ((t.edges && t.edges.declined) || 0), 0);
    const aborted = ts.reduce((a, t) => a + ((t.edges && t.edges.aborted) || 0), 0);
    const waits = [];
    for (const t of ts) {
      for (const x of (t.events || [])) if (x.e === 'diff' && x.v !== 'x') waits.push(x.wait || 0);
    }
    const total = applied + declined;
    return {
      tasks: ts.length,
      toolCalls: nums(ts.map(t => t.edges ? t.edges.tools : 0)),
      rounds: nums(ts.map(t => t.edges ? t.edges.turns : 0)),
      ms: nums(ts.map(t => t.ms || 0)),
      readsBeforeFirstEdit: nums(withEdit.map(t => t.edges.readsBeforeEdit)),
      confirmWait: nums(waits),
      applied: applied,
      declined: declined,
      aborted: aborted,
      /* acceptRate 只在真有判定时才有意义 —— 0 次判定返回 null，
       * 不要返回 0，那会被误读成「全部放弃」。 */
      acceptRate: total ? Math.round(applied * 100 / total) / 100 : null,
      byReason: countBy(ts.map(t => t.reason || 'done'))
    };
  }

  function countBy(arr){
    const out = {};
    for (const k of arr) out[k] = (out[k] || 0) + 1;
    return out;
  }

  function clear(){
    mem = { v: VERSION, tasks: [] };
    cur = null;
    turnNo = 0;
    const s = storage();
    if (s) { try { s.removeItem(KEY); } catch (e) {} }
    return true;
  }

  function exportJson(){
    return JSON.stringify({ v: VERSION, exportedAt: now(), tasks: load().tasks }, null, 1);
  }

  /* 给测试用：当前库的体积与就绪状态 */
  function _budget(){
    const raw = JSON.stringify(load());
    return {
      bytes: raw.length,
      tasks: load().tasks.length,
      writable: !!storage(),
      curOpen: !!cur
    };
  }

  return {
    start, turn, tool, verdict, end,
    list, get, stats, clear, exportJson,
    derive, firstPath, _budget,
    VERSION, MAX_TASKS, MAX_EVENTS, TASK_BYTE_BUDGET
  };
});
