/* 版本快照与回滚（P2 · 安全门）
 *
 * 把工作流在关键时刻整份存一份：采用变体前、手动存点、恢复前先存当前状态。
 * 恢复也先存快照 —— 回滚本身必须是可回滚的，否则「安全门」不成立。
 *
 * 存储：openagi-runs 库的 versions store（与运行历史同库，但独立表）。
 * 容量：单条上限 20MB、全部上限 30MB、每个流程最多 10 份，超了从最旧的开始淘汰。
 *   快照是完整内联的（图片/模型也一起存），所以必须有上限；
 *   不用 blob 存根是因为 blob 的 GC 只认当前流程，只被快照引用的素材会被清掉。
 */

const VER_STORE = 'versions';
const VER_MAX_PER_FLOW = 10;
const VER_MAX_BYTES = 30 * 1024 * 1024;
const VER_MAX_ONE = 20 * 1024 * 1024;

function verAll(){
  return runDbOpen().then(db => {
    if(!db) return [];
    return new Promise(res => {
      let t;
      try { t = db.transaction(VER_STORE, 'readonly'); } catch(e){ res([]); return; }
      let q;
      try { q = t.objectStore(VER_STORE).getAll(); } catch(e){ res([]); return; }
      q.onsuccess = () => res((q.result || []).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)));
      q.onerror = () => res([]);
    });
  }).catch(() => []);
}

function flowVersionGet(id){
  return runDbOpen().then(db => {
    if(!db) return null;
    return new Promise(res => {
      let t;
      try { t = db.transaction(VER_STORE, 'readonly'); } catch(e){ res(null); return; }
      let q;
      try { q = t.objectStore(VER_STORE).get(id); } catch(e){ res(null); return; }
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  }).catch(() => null);
}

/* 存一份快照。flow 用 snapshotBp() 的形态；reason 会显示在列表里 */
function flowVersionSave(flow, opts){
  const o = opts || {};
  if(!flow || !flow.id) return Promise.resolve({ ok: false, error: '没有可保存的流程' });
  let json = '';
  try { json = JSON.stringify(flow); }
  catch(e){ return Promise.resolve({ ok: false, error: '流程无法序列化' }); }
  const size = json.length;
  if(size > VER_MAX_ONE){
    return Promise.resolve({ ok: false, error: '流程过大（' + fmtBytes(size) + '），未存快照' });
  }
  const item = {
    id: 's' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    flowId: flow.id,
    flowName: flow.name || '未命名工作流',
    at: Date.now(),
    reason: String(o.reason || '').slice(0, 60),
    size,
    nodes: (flow.nodes || []).length,
    links: (flow.links || []).length,
    flow: JSON.parse(json)          // 深拷贝，后续编辑不会改到快照
  };
  return runDbTx('readwrite', s => s.put(item), VER_STORE).then(ok => {
    if(!ok) return { ok: false, error: '存储不可用（IndexedDB 打不开）' };
    return flowVersionPrune().then(() => ({ ok: true, id: item.id, size, nodes: item.nodes }));
  });
}

/* 列表只回元信息，避免把整份流程（可能带图）搬到内存里 */
function flowVersionList(flowId){
  return verAll().then(list => {
    const rows = flowId ? list.filter(v => v.flowId === flowId) : list;
    return rows.map(v => ({
      id: v.id, flowId: v.flowId, flowName: v.flowName, at: v.at,
      reason: v.reason || '', size: v.size || 0, nodes: v.nodes || 0, links: v.links || 0
    }));
  });
}

function flowVersionDelete(id){
  return runDbTx('readwrite', s => s.delete(id), VER_STORE);
}

/* 淘汰：每个流程保留最近 10 份，全局总量控制在 30MB 内 */
function flowVersionPrune(){
  return verAll().then(list => {
    const perFlow = {};
    let bytes = 0;
    const drop = [];
    list.forEach(v => {
      const n = perFlow[v.flowId] || 0;
      const tooMany = n >= VER_MAX_PER_FLOW;
      const tooBig = bytes > 0 && bytes + (v.size || 0) > VER_MAX_BYTES;
      if(tooMany || tooBig){ drop.push(v.id); return; }
      perFlow[v.flowId] = n + 1;
      bytes += v.size || 0;
    });
    if(!drop.length) return 0;
    return runDbTx('readwrite', s => drop.forEach(id => s.delete(id)), VER_STORE).then(() => drop.length);
  }).catch(() => 0);
}

/* 恢复用的合并：沿用当前流程 id（同一个工作流），内容整体替换为快照 */
function flowVersionMerge(current, snapshot){
  if(!snapshot) return null;
  const out = JSON.parse(JSON.stringify(snapshot));
  out.id = (current && current.id) || out.id;
  out.name = out.name || (current && current.name) || '未命名工作流';
  out.updated = Date.now();
  return out;
}
