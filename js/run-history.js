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
 * 存储用独立的 IndexedDB 库 openagi-runs：不改 blob-store.js 里已经验证过的
 * 库版本与升级逻辑（那个文件有 34 条断言在守着，动它风险不值当）。
 * localStorage 完全不碰 —— 历史是时序数据，不该和 5MB 配额抢位置。
 */

const RUN_DB = 'openagi-runs';
const RUN_DB_VERSION = 2;
const RUN_STORE = 'runs';
const RUN_STORES = ['runs', 'bench', 'evolve'];
const RUN_KEEP = 200;          // 只保留最近 200 条，超出自动淘汰最旧的

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

/* 写一条记录。永不抛错、永不阻塞运行收尾：历史是附加价值，不能反过来弄坏主流程 */
function recordRun(rec){
  if(!rec || typeof rec !== 'object') return Promise.resolve(false);
  const item = {
    id: 'r' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    at: Number(rec.at) || Date.now(),
    flowId: String(rec.flowId || ''),
    flowName: String(rec.flowName || '未命名工作流'),
    ok: !!rec.ok,
    stopped: !!rec.stopped,
    ms: Math.max(0, Math.trunc(Number(rec.ms) || 0)),
    nodes: Math.max(0, Math.trunc(Number(rec.nodes) || 0)),
    activated: Math.max(0, Math.trunc(Number(rec.activated) || 0)),
    failed: Math.max(0, Math.trunc(Number(rec.failed) || 0)),
    error: String(rec.error || '').slice(0, 300),
    outs: Array.isArray(rec.outs) ? rec.outs.slice(0, 12) : [],
    rating: 0
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
    return {
      total, ok, failed, stopped,
      successRate: total ? Math.round(ok / total * 100) : 0,
      avgMs, up, down,
      lastError: lastErrRec ? (lastErrRec.flowName + '：' + lastErrRec.error) : '',
      lastAt: total ? rows[0].at : 0
    };
  });
}

function runHistoryClear(){
  return runDbTx('readwrite', s => s.clear()).catch(() => false);
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
      bits.push(r.ok ? '成功' : r.stopped ? '已停止' : '失败');
      bits.push(r.activated + '/' + r.nodes + ' 节点');
      if(r.failed) bits.push(r.failed + ' 失败');
      if(r.outs && r.outs.length) bits.push(r.outs.length + ' 个输出');
      sub.textContent = bits.join(' · ');
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
