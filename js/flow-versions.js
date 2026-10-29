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
// 同一毫秒内连续存多份时，at 会并列；用自增序号做稳定排序的次级键，
// 否则「最新的快照」会是随机的某一份（淘汰时也会挑错对象）
let _verSeq = 0;

function verAll(){
  return runDbOpen().then(db => {
    if(!db) return [];
    return new Promise(res => {
      let t;
      try { t = db.transaction(VER_STORE, 'readonly'); } catch(e){ res([]); return; }
      let q;
      try { q = t.objectStore(VER_STORE).getAll(); } catch(e){ res([]); return; }
      q.onsuccess = () => res((q.result || []).slice().sort((a, b) =>
        (Number(b.at) || 0) - (Number(a.at) || 0) || (Number(b.seq) || 0) - (Number(a.seq) || 0)));
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
    seq: ++_verSeq,
    reason: String(o.reason || '').slice(0, 60),
    /* 结构签名：只由「节点类型 + 参数 + 连线」算出来，不含坐标。
     * 用途是让「运行前自动存快照」在结构没变时**复用**上一份，
     * 否则用户每跑一次就多一份，很快把 10 份上限挤满、把手工快照挤掉。 */
    sig: String(o.sig || '').slice(0, 40),
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
      reason: v.reason || '', sig: v.sig || '', size: v.size || 0, nodes: v.nodes || 0, links: v.links || 0
    }));
  });
}

/* 结构签名：决定「这份快照能不能拿来重放这次运行」的东西全在里面。
 * 刻意不含坐标 / 状态 / 上次结果 —— 挪一下节点位置并不产生新的一版。 */
function flowSigOf(flow){
  const nodes = (flow && flow.nodes) || [];
  const links = (flow && flow.links) || [];
  const body = nodes.map(n => {
    let d = '';
    try { d = JSON.stringify(n.data || {}); } catch(e){ d = ''; }
    return n.type + '|' + d.slice(0, 400);
  }).join(';') + '#' + links.map(l =>
    l.from.node + ':' + l.from.key + '>' + l.to.node + ':' + l.to.key).join(';');
  const h = (typeof fnv1a === 'function')
    ? (fnv1a(body, 2166136261).toString(36) + fnv1a(body, 84696351).toString(36))
    : String(body.length);
  return 'g' + h;
}

const VER_AUTO_KEEP = 3;
/* 带大媒体的流程整份快照不划算：stringify 要卡一下主线程，存下来也多半会被 30MB 总量淘汰。
 * 超过这个阈值就跳过锁定，versionId 留空 —— 这是**诚实的降级**，
 * 运行记录里会显示「没有版本」，而不是假装有。 */
const PIN_MAX_INLINE = 6 * 1024 * 1024;
/* 本会话内记住「这个流程上次锁的是哪一版」。
 * 没有它的话，每次运行都要 verAll() 把最多 10 份完整快照（可能带图、几十 MB）读进内存，
 * 只为比较一个结构签名 —— 那是把最贵的一次 IO 放在了运行的关键路径上。 */
const _pinCache = {};

/* 运行前锁定版本：返回 versionId，事后的运行记录靠它证明「跑的是哪一版」。
 * 结构没变就复用上一份（不新增），所以正常迭代不会刷屏。
 * 自动快照单独限 3 份，超了淘汰最旧的自动快照 —— 绝不动用户手工存的那几份。 */
async function pinFlowVersion(flow){
  if(!flow || !flow.id) return '';
  const sig = flowSigOf(flow);
  const memo = _pinCache[flow.id];
  if(memo && memo.sig === sig) return memo.id;
  try {
    if(typeof flowInlineBytes === 'function' && flowInlineBytes(flow) > PIN_MAX_INLINE) return '';
  } catch(e){}
  let list = [];
  try { list = await flowVersionList(flow.id); } catch(e){ list = []; }
  const top = list[0];
  if(top && top.sig === sig){
    _pinCache[flow.id] = { sig, id: top.id };
    return top.id;
  }

  const auto = list.filter(v => v.reason === '运行前自动');
  if(auto.length >= VER_AUTO_KEEP){
    const drop = auto.slice(VER_AUTO_KEEP - 1);
    for(const v of drop){ try { await flowVersionDelete(v.id); } catch(e){} }
  }
  let r = null;
  try { r = await flowVersionSave(flow, { reason: '运行前自动', sig }); } catch(e){ r = null; }
  const id = (r && r.ok) ? r.id : '';
  if(id) _pinCache[flow.id] = { sig, id };
  return id;
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
