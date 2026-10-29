/* 运行历史与遥测（P0 数据地基 · P1 加入评分与统计）
 *
 * 每次运行结束后记一条：时间、工作流、耗时、成败、失败原因、节点激活数、
 * 输出参数概要（只存名称/类型/截断预览，绝不存图片 / 模型的 base64 —— 那会把
 * 浏览器存储撑爆，而且对「哪次跑得好」这个判断没有信息量）。
 *
 * P1 增补：
 *   - rating：用户赞 / 踩（最便宜也最可信的质量信号）
 *   - 统计聚合：成功率 / 平均耗时 / 评分分布 / 最近错误
 *   - 同一库内新增 bench（基准集）与 evolve（变体比较）两个 store，走一次升级
 *
 * P2 增补：versions（版本快照）与 memory（经验条目）两个 store，库版本升到 3。
 *   这两个 store 的读写各自封在 flow-versions.js / flow-memory.js 里，
 *   这里只负责把库和表建出来（RUN_STORES 是唯一建表清单）。
 *
 * P3 增补（库版本 4）：traces（对话与能力调用轨迹）与 lineage（资产血缘）两个 store。
 *   读写分别封在 ops-trace.js / lineage.js 里，这里同样只负责建表。
 *   同时 recordRun 扩了三块**让「重放」第一次有意义**的字段：
 *     versionId    — 这次跑的是哪一版快照（以前只有 flowId，流程一编辑就对不上了）
 *     nodeInputs   — 每个节点**解析后**的输入（实际用的模型 / 尺寸 / 参数），中间节点不再丢
 *     cost / cacheHits / determinism / verdict — 成本账本、复用命中最弱确定性档、成功判定
 *
 * 存储用独立的 IndexedDB 库 openagi-runs：不改 blob-store.js 里已经验证过的
 * 库版本与升级逻辑（那个文件有 34 条断言在守着，动它风险不值当）。
 * localStorage 完全不碰 —— 历史是时序数据，不该和 5MB 配额抢位置。
 */

const RUN_DB = 'openagi-runs';
const RUN_DB_VERSION = 4;
const RUN_STORE = 'runs';
const RUN_STORES = ['runs', 'bench', 'evolve', 'versions', 'memory', 'traces', 'lineage', 'cache'];
const RUN_KEEP = 200;          // 只保留最近 200 条，超出自动淘汰最旧的
const RUN_NODE_MAX = 40;       // 节点级快照最多记这么多条（长流程只留前 40 个）
const RUN_PARAM_MAX = 600;     // 每节点参数序列化后的上限（字符），超了截断并标记

let _runDb = null;
let _runOpening = null;
let _runBroken = false;

function runDbOpen(){
  if(_runDb) return Promise.resolve(_runDb);
  if(_runBroken || typeof indexedDB === 'undefined') return Promise.resolve(null);
  if(_runOpening) return _runOpening;
  _runOpening = new Promise(res => {
    let q;
    try { q = indexedDB.open(RUN_DB, RUN_DB_VERSION); } catch(e){ _runBroken = true; res(null); return; }
    q.onupgradeneeded = () => {
      // 逐个补建：v1 升 v2 时 runs 已存在，createObjectStore 会抛错，必须各自兜住
      RUN_STORES.forEach(name => {
        try { q.result.createObjectStore(name, { keyPath: 'id' }); } catch(e){}
      });
    };
    q.onsuccess = () => { _runDb = q.result; res(_runDb); };
    q.onerror = () => { _runBroken = true; res(null); };
    q.onblocked = () => { _runBroken = true; res(null); };
  });
  return _runOpening;
}

// 通用事务：store 名默认 runs；bench / evolve 复用它
function runDbTx(mode, fn, store){
  const name = store || RUN_STORE;
  return runDbOpen().then(db => {
    if(!db) return false;
    return new Promise(res => {
      let t;
      try { t = db.transaction(name, mode); } catch(e){ res(false); return; }
      try { fn(t.objectStore(name)); } catch(e){ res(false); return; }
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
      t.onabort = () => res(false);
    });
  }).catch(() => false);
}

/* 输出参数概要：类型 + 文本截断预览；图像 / 模型只记类型不记内容 */
function runOutsSummary(lastRun){
  const values = (lastRun && Array.isArray(lastRun.values)) ? lastRun.values : [];
  return values.map(v => {
    const type = v && v.type ? String(v.type) : 'string';
    let preview = '';
    if(type === 'string' || type === 'int' || type === 'float' || type === 'bool'){
      const s = v && v.value != null ? String(v.value) : '';
      preview = s.length > 120 ? s.slice(0, 120) + '…' : s;
    }
    return { name: (v && v.name) || '', type, preview };
  });
}

/* 节点级输入快照：只留**能决定产出**的东西，不留 base64。
 * 为什么要存「解析后的」而不是流程里的原始参数：引脚连线会在运行时把上游结果灌进来，
 * 光看流程数据永远算不出这张图到底用了哪个模型、多大尺寸、什么强度。
 * 早期版本只存终点 values，中间节点全丢 —— 于是「重放」只能重跑一张新图，不是同一张。 */
function runNodeSnap(list){
  if(!Array.isArray(list)) return [];
  return list.slice(0, RUN_NODE_MAX).map(x => {
    const o = x && typeof x === 'object' ? x : {};
    let params = o.params == null ? null : o.params;
    let cut = false;
    if(params && typeof params === 'object'){
      try {
        const json = JSON.stringify(params);
        if(json.length > RUN_PARAM_MAX){ params = json.slice(0, RUN_PARAM_MAX); cut = true; }
      } catch(e){ params = null; }
    }
    return {
      id: String(o.id || ''),
      type: String(o.type || ''),
      title: String(o.title || '').slice(0, 40),
      ok: o.ok !== false,
      ms: Math.max(0, Math.trunc(Number(o.ms) || 0)),
      model: String(o.model || '').slice(0, 80),
      engine: String(o.engine || '').slice(0, 40),
      determinism: String(o.determinism || '').slice(0, 16),
      cost: Math.max(0, Number(o.cost) || 0),
      cache: !!o.cache,
      params,
      paramsCut: cut || undefined,
      error: String(o.error || '').slice(0, 160) || undefined
    };
  });
}

/* 成本汇总：统一用「相对单位 u」记（文本一次≈1u、出图一次≈30u、3D 一次≈300u）。
 * 不换算成钱是故意的 —— 每个中转站/官方接口单价都不一样，写死一个汇率必然过期，
 * 反而让人以为算得准。要显示金额就让调用方自己乘。 */
function runCostSummary(nodeInputs){
  const byCap = {};
  let u = 0;
  (nodeInputs || []).forEach(n => {
    const c = Number(n.cost) || 0;
    if(!c) return;
    /* 命中复用的节点这一轮没花钱，不能计进「本次消耗」。
     * 它省下的量由 runLedger 的 cachedSaved 统计，两个数分开看才对得上。 */
    if(n.cache) return;
    u += c;
    byCap[n.type] = Math.round(((byCap[n.type] || 0) + c) * 100) / 100;
  });
  return { u: Math.round(u * 100) / 100, byCap };
}

/* 整体确定性取**最弱的一档**：一条链上有一个不确定环节，整条链就无法逐像素复现。
 * 这个字段是给 UI 说真话用的，不能取最好的一档。 */
const DET_ORDER = { exact: 0, structural: 1, none: 2 };
const DET_LABEL = { exact: '可逐像素复现', structural: '结构可复现', none: '结果不可复现' };
const DET_HINT = {
  exact: '同输入必同输出',
  structural: '结构一致、文字会变（LLM 生成）',
  none: '含出图 / 3D：云端大多不给 seed，重跑会是一张新图'
};
function runDeterminismOf(nodeInputs){
  let worst = 'exact';
  (nodeInputs || []).forEach(n => {
    const d = n && n.determinism;
    if(!(d in DET_ORDER)) return;
    if(DET_ORDER[d] > DET_ORDER[worst]) worst = d;
  });
  return worst;
}

/* 写一条记录。永不抛错、永不阻塞运行收尾：历史是附加价值，不能反过来弄坏主流程 */
function recordRun(rec){
  if(!rec || typeof rec !== 'object') return Promise.resolve(false);
  const nodeInputs = runNodeSnap(rec.nodeInputs);
  /* 命中次数**从快照里数**，不是信任调用方传进来的数。
   * 真相在 nodeInputs 里那几个 cache:true —— 让调用方再报一次，两处必然对不上
   * （第一次实现就是这样：账本永远显示 0，而快照里明明有命中）。 */
  const derivedHits = nodeInputs.filter(n => n && n.cache).length;
  const givenHits = Number(rec.cacheHits);
  const cacheHits = isFinite(givenHits) && givenHits > 0 ? Math.max(derivedHits, Math.trunc(givenHits)) : derivedHits;
  const item = {
    id: 'r' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    at: Number(rec.at) || Date.now(),
    flowId: String(rec.flowId || ''),
    flowName: String(rec.flowName || '未命名工作流'),
    /* 以前这里没有 versionId：flowId 指向的流程之后会被编辑，
     * 于是「重放这次运行」跑的是今天的图，不是当时那一版。 */
    versionId: String(rec.versionId || ''),
    ok: !!rec.ok,
    stopped: !!rec.stopped,
    ms: Math.max(0, Math.trunc(Number(rec.ms) || 0)),
    nodes: Math.max(0, Math.trunc(Number(rec.nodes) || 0)),
    activated: Math.max(0, Math.trunc(Number(rec.activated) || 0)),
    failed: Math.max(0, Math.trunc(Number(rec.failed) || 0)),
    error: String(rec.error || '').slice(0, 300),
    outs: Array.isArray(rec.outs) ? rec.outs.slice(0, 12) : [],
    rating: 0,
    verdict: String(rec.verdict || '').slice(0, 12),
    determinism: String(rec.determinism || runDeterminismOf(nodeInputs)).slice(0, 16),
    cacheHits,
    cost: rec.cost && typeof rec.cost === 'object' ? rec.cost : runCostSummary(nodeInputs),
    nodeInputs
  };
  return runDbTx('readwrite', s => s.put(item))
    .then(ok => { if(ok) pruneRuns(); return ok; })
    .catch(() => false);
}

function pruneRuns(){
  return runHistoryList(0).then(list => {
    if(list.length <= RUN_KEEP) return 0;
    const drop = list.slice(RUN_KEEP);
    return runDbTx('readwrite', s => drop.forEach(r => s.delete(r.id))).then(() => drop.length);
  }).catch(() => 0);
}

/* 按时间倒序返回；limit <= 0 表示全部 */
function runHistoryList(limit){
  return runDbOpen().then(db => {
    if(!db) return [];
    return new Promise(res => {
      let t;
      try { t = db.transaction(RUN_STORE, 'readonly'); } catch(e){ res([]); return; }
      let req;
      try { req = t.objectStore(RUN_STORE).getAll(); } catch(e){ res([]); return; }
      req.onsuccess = () => {
        const arr = (req.result || []).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
        res(limit > 0 ? arr.slice(0, limit) : arr);
      };
      req.onerror = () => res([]);
    });
  }).catch(() => []);
}

function runHistoryGet(id){
  return runHistoryList(0).then(list => list.find(r => r.id === id) || null);
}

/* 评分：+1 赞 / -1 踩 / 0 取消。读改写放进同一事务，避免并发丢更新 */
function runHistoryRate(id, rating){
  const v = rating > 0 ? 1 : rating < 0 ? -1 : 0;
  return runDbOpen().then(db => {
    if(!db) return false;
    return new Promise(res => {
      let t;
      try { t = db.transaction(RUN_STORE, 'readwrite'); } catch(e){ res(false); return; }
      const store = t.objectStore(RUN_STORE);
      const q = store.get(id);
      q.onsuccess = () => {
        const rec = q.result;
        if(!rec){ res(false); return; }
        rec.rating = v;
        rec.ratedAt = Date.now();
        try { store.put(rec); } catch(e){ res(false); return; }
      };
      q.onerror = () => res(false);
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
      t.onabort = () => res(false);
    });
  }).catch(() => false);
}

/* 聚合统计：成功率 / 平均耗时 / 评分分布 / 最近一条错误 */
function runHistoryStats(flowId){
  return runHistoryList(0).then(list => {
    const rows = flowId ? list.filter(r => r.flowId === flowId) : list;
    const total = rows.length;
    const ok = rows.filter(r => r.ok).length;
    const failed = rows.filter(r => !r.ok && !r.stopped).length;
    const stopped = rows.filter(r => r.stopped).length;
    const times = rows.filter(r => r.ms > 0).map(r => r.ms);
    const avgMs = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
    const up = rows.filter(r => r.rating === 1).length;
    const down = rows.filter(r => r.rating === -1).length;
    const lastErrRec = rows.find(r => r.error);
    /* 成本与复用一起汇总：这两个数以前完全看不见，
     * 于是「本地跑到底省了多少」「重跑会不会一样」全靠猜。 */
    let costU = 0, savedU = 0, cacheHits = 0, detNone = 0;
    rows.forEach(r => {
      costU += Number(r.cost && r.cost.u) || 0;
      cacheHits += Number(r.cacheHits) || 0;
      if(r.determinism === 'none') detNone++;
      if(Array.isArray(r.nodeInputs)) r.nodeInputs.forEach(n => { if(n && n.cache) savedU += Number(n.cost) || 0; });
    });
    return {
      total, ok, failed, stopped,
      successRate: total ? Math.round(ok / total * 100) : 0,
      avgMs, up, down,
      costU: Math.round(costU * 100) / 100,
      savedU: Math.round(savedU * 100) / 100,
      cacheHits, detNone,
      lastError: lastErrRec ? (lastErrRec.flowName + '：' + lastErrRec.error) : '',
      lastAt: total ? rows[0].at : 0
    };
  });
}

function runHistoryClear(){
  return runDbTx('readwrite', s => s.clear()).catch(() => false);
}

/* 成本账本：把每条的 cost.u 加起来，按能力拆。
 * 「异构成本路由」要成立就得先有这个数 —— 否则本地跑了多少次、省了多少，全是感觉。 */
function runLedger(flowId){
  return runHistoryList(0).then(list => {
    const rows = flowId ? list.filter(r => r.flowId === flowId) : list;
    let u = 0, cacheHits = 0, cachedSaved = 0;
    const byCap = {};
    const byVerdict = { ok: 0, partial: 0, failed: 0, '': 0 };
    const byDet = {};
    rows.forEach(r => {
      const c = (r.cost && Number(r.cost.u)) || 0;
      u += c;
      cacheHits += Number(r.cacheHits) || 0;
      if(r.cost && r.cost.byCap){
        Object.keys(r.cost.byCap).forEach(k => { byCap[k] = (byCap[k] || 0) + Number(r.cost.byCap[k] || 0); });
      }
      const v = r.verdict || '';
      byVerdict[v in byVerdict ? v : '']++;
      if(r.determinism) byDet[r.determinism] = (byDet[r.determinism] || 0) + 1;
    });
    /* 命中缓存省下的钱：直接从节点快照里挑 cache:true 的节点累加。
     * 早先版本先看 `r.cacheHits` 才往下走，于是只要那个计数漏了，省下的量就恒为 0 ——
     * 账本里两个数字（花了 / 省了）必须各自独立算得出来，不能互相依赖。 */
    rows.forEach(r => {
      if(!Array.isArray(r.nodeInputs)) return;
      r.nodeInputs.filter(n => n && n.cache).forEach(n => { cachedSaved += Number(n.cost) || 0; });
    });
    return {
      runs: rows.length,
      u: Math.round(u * 100) / 100,
      byCap, byVerdict, byDet,
      cacheHits,
      cachedSaved: Math.round(cachedSaved * 100) / 100
    };
  });
}

function runHistoryState(){
  return runHistoryList(0).then(list => ({
    count: list.length,
    lastAt: list.length ? list[0].at : 0,
    broken: _runBroken
  }));
}

/* ---------------------------------------------------------------
 * 以下为浏览器端渲染（只在画布侧栏「历史」页用；Node 侧逻辑测试不会调到）
 * -------------------------------------------------------------- */
function runTimeText(at){
  if(!at) return '';
  const d = new Date(at);
  const pad = n => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if(sameDay) return hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

function renderRunStats(st){
  const host = $('runStats');
  if(!host) return;
  host.innerHTML = '';
  if(!st || !st.total){ host.classList.add('hidden'); return; }
  const add = (txt, cls) => {
    const s = document.createElement('span');
    s.className = 'rs-item' + (cls ? ' ' + cls : '');
    s.textContent = txt;
    host.appendChild(s);
  };
  add('总 ' + st.total);
  add('成功率 ' + st.successRate + '%', st.successRate >= 80 ? 'ok' : st.successRate >= 50 ? 'warn' : 'bad');
  if(st.avgMs) add('平均 ' + (st.avgMs / 1000).toFixed(1) + 's');
  if(st.costU) add('成本 ' + st.costU + 'u');
  if(st.savedU) add('复用省 ' + st.savedU + 'u', 'ok');
  if(st.detNone) add(st.detNone + ' 次不可复现', 'warn');
  if(st.up || st.down) add('赞 ' + st.up + ' / 踩 ' + st.down, st.down > st.up ? 'warn' : '');
  if(st.stopped) add('停止 ' + st.stopped);
  host.classList.remove('hidden');
}

function renderRunHistory(){
  const host = $('runHistoryList');
  if(!host) return;
  // 基准区与历史一起刷新（基准也在这一页）
  if(typeof benchRender === 'function') benchRender();
  host.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'run-empty';
  empty.textContent = '加载中…';
  host.appendChild(empty);
  Promise.all([runHistoryList(60), runHistoryStats('')]).then(([list, st]) => {
    host.innerHTML = '';
    renderRunStats(st);
    if(!list.length){
      const e = document.createElement('div');
      e.className = 'run-empty';
      e.textContent = '还没有运行记录。运行一次工作流后，这里会留下时间、耗时与成败；点「赞 / 踩」就是最直接的质量信号。';
      host.appendChild(e);
      return;
    }
    list.forEach(r => {
      const row = document.createElement('div');
      row.className = 'run-row' + (r.ok ? ' ok' : r.stopped ? ' stopped' : ' bad');
      const head = document.createElement('div');
      head.className = 'run-l1';
      const dot = document.createElement('span');
      dot.className = 'run-dot';
      const name = document.createElement('span');
      name.className = 'run-name';
      name.textContent = r.flowName || '未命名工作流';
      name.title = r.flowName || '';
      const meta = document.createElement('span');
      meta.className = 'run-meta';
      meta.textContent = runTimeText(r.at) + ' · ' + (r.ms / 1000).toFixed(1) + 's';
      head.append(dot, name, meta);
      const sub = document.createElement('div');
      sub.className = 'run-sub';
      const bits = [];
      /* 判定优先用三档结论：它比 ok 布尔精确 —— 「跑完但一步都没执行」以前算成功。
         再补成本 / 复用 / 确定性这三项，它们以前完全不可见。 */
      bits.push(r.verdict ? verdictLabel(r.verdict) : (r.ok ? '成功' : r.stopped ? '已停止' : '失败'));
      bits.push(r.activated + '/' + r.nodes + ' 节点');
      if(r.failed) bits.push(r.failed + ' 失败');
      if(r.cost && r.cost.u) bits.push(r.cost.u + 'u');
      if(r.cacheHits) bits.push('复用 ' + r.cacheHits);
      if(r.determinism && r.determinism !== 'exact') bits.push(DET_LABEL[r.determinism] || r.determinism);
      if(r.versionId) bits.push('版 ' + String(r.versionId).slice(-4));
      if(r.outs && r.outs.length) bits.push(r.outs.length + ' 个输出');
      sub.textContent = bits.join(' · ');
      if(r.determinism && DET_HINT[r.determinism]) sub.title = DET_HINT[r.determinism];
      row.append(head, sub);
      if(r.error){
        const err = document.createElement('div');
        err.className = 'run-error';
        err.textContent = r.error;
        row.appendChild(err);
      }
      if(r.outs && r.outs.length){
        const outs = document.createElement('div');
        outs.className = 'run-outs hidden';
        r.outs.forEach(o => {
          const line = document.createElement('div');
          line.textContent = (o.name || '输出') + '（' + (TYPE_META[o.type] ? TYPE_META[o.type].label : o.type) + '）' +
            (o.preview ? '：' + o.preview : '');
          outs.appendChild(line);
        });
        row.appendChild(outs);
        row.addEventListener('click', e => {
          if(e.target.closest('button')) return;
          outs.classList.toggle('hidden');
        });
      }
      // 赞 / 踩：最便宜的质量信号，也是 P2 变异选择要用的标注数据
      const rate = document.createElement('div');
      rate.className = 'run-rate';
      [[1, '赞'], [-1, '踩']].forEach(pair => {
        const v = pair[0], label = pair[1];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'run-rate-btn' + (r.rating === v ? ' on' : '');
        b.textContent = label + (r.rating === v ? ' ✓' : '');
        b.title = v > 0 ? '这次结果不错' : '这次结果不行';
        b.addEventListener('click', ev => {
          ev.stopPropagation();
          const next = r.rating === v ? 0 : v;
          runHistoryRate(r.id, next).then(ok => { if(ok) renderRunHistory(); });
        });
        rate.appendChild(b);
      });
      row.appendChild(rate);
      host.appendChild(row);
    });
  });
}
