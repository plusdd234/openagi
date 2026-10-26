/* 运行历史与遥测（P0 · 自我迭代的数据地基）
 *
 * 每次运行结束后记一条：时间、工作流、耗时、成败、失败原因、节点激活数、
 * 输出参数概要（只存名称/类型/截断预览，绝不存图片 / 模型的 base64 —— 那会把
 * 浏览器存储撑爆，而且对「哪次跑得好」这个判断没有信息量）。
 *
 * 存储用独立的 IndexedDB 库 openagi-runs：不改 blob-store.js 里已经验证过的
 * 库版本与升级逻辑（那个文件有 34 条断言在守着，动它风险不值当）。
 * localStorage 完全不碰 —— 历史是时序数据，不该和 5MB 配额抢位置。
 */

const RUN_DB = 'openagi-runs';
const RUN_DB_VERSION = 1;
const RUN_STORE = 'runs';
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
    q.onupgradeneeded = () => { try { q.result.createObjectStore(RUN_STORE, { keyPath: 'id' }); } catch(e){} };
    q.onsuccess = () => { _runDb = q.result; res(_runDb); };
    q.onerror = () => { _runBroken = true; res(null); };
    q.onblocked = () => { _runBroken = true; res(null); };
  });
  return _runOpening;
}

function runDbTx(mode, fn){
  return runDbOpen().then(db => {
    if(!db) return false;
    return new Promise(res => {
      let t;
      try { t = db.transaction(RUN_STORE, mode); } catch(e){ res(false); return; }
      try { fn(t.objectStore(RUN_STORE)); } catch(e){ res(false); return; }
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
    outs: Array.isArray(rec.outs) ? rec.outs.slice(0, 12) : []
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

function renderRunHistory(){
  const host = $('runHistoryList');
  if(!host) return;
  host.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'run-empty';
  empty.textContent = '加载中…';
  host.appendChild(empty);
  runHistoryList(60).then(list => {
    host.innerHTML = '';
    if(!list.length){
      const e = document.createElement('div');
      e.className = 'run-empty';
      e.textContent = '还没有运行记录。运行一次工作流后，这里会留下时间、耗时与成败。';
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
      host.appendChild(row);
    });
  });
}
