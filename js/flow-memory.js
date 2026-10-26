/* 经验记忆（P2 · 让改动留下痕迹并反哺下次生成）
 *
 * 一条经验 = 「在某类节点的某个文本参数上，采纳过这样一版写法」。
 * 来源：采用变体时自动记录（一条 patch 一条）；也可以手动写。
 *
 * 反哺：generateFlowDag / mutateFlowVariants 会把相关的几条经验拼进系统提示词，
 * 让模型看到「这台机器上哪些写法真的被采纳过」。这是最轻的自我迭代闭环 ——
 * 不训练模型，只训练上下文。
 */

const MEM_STORE = 'memory';
const MEM_KEEP = 200;          // 经验条目上限，超出淘汰最旧的
const MEM_HINT_MAX = 5;        // 每次注入提示词最多几条
const MEM_TEXT_MAX = 140;      // 每条注入的最大字符数

function memAll(){
  return runDbOpen().then(db => {
    if(!db) return [];
    return new Promise(res => {
      let t;
      try { t = db.transaction(MEM_STORE, 'readonly'); } catch(e){ res([]); return; }
      let q;
      try { q = t.objectStore(MEM_STORE).getAll(); } catch(e){ res([]); return; }
      q.onsuccess = () => res((q.result || []).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)));
      q.onerror = () => res([]);
    });
  }).catch(() => []);
}

function flowMemoryList(filter){
  const f = filter || {};
  return memAll().then(list => list.filter(m => {
    if(f.nodeType && m.nodeType !== f.nodeType) return false;
    if(f.key && m.key !== f.key) return false;
    if(f.flowId && m.flowId !== f.flowId) return false;
    return true;
  }));
}

/* 批量写入。同节点类型 + 同参数 + 同目标文本视为同一条：只加 hits，不重复堆 */
function flowMemoryAdd(lessons, opts){
  const o = opts || {};
  const list = (Array.isArray(lessons) ? lessons : []).filter(l => l && l.nodeType && l.key && l.to);
  if(!list.length) return Promise.resolve({ ok: true, added: 0, bumped: 0 });
  return memAll().then(exist => {
    const keyOf = m => m.nodeType + '|' + m.key + '|' + String(m.to).trim();
    const map = new Map(exist.map(m => [keyOf(m), m]));
    let added = 0, bumped = 0;
    const writes = [];
    list.forEach(l => {
      const k = keyOf(l);
      const hit = map.get(k);
      if(hit){
        hit.hits = (Number(hit.hits) || 0) + 1;
        bumped++;
        writes.push(hit);
        return;
      }
      const item = {
        id: 'm' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        at: Date.now(),
        nodeType: String(l.nodeType),
        key: String(l.key),
        from: String(l.from || '').slice(0, 400),
        to: String(l.to).slice(0, 600),
        source: String(l.source || 'variant'),
        note: String(l.note || (o.reason || '')).slice(0, 120),
        flowId: String(l.flowId || o.flowId || ''),
        flowName: String(l.flowName || o.flowName || ''),
        hits: 1
      };
      map.set(k, item);
      added++;
      writes.push(item);
    });
    return runDbTx('readwrite', s => writes.forEach(w => s.put(w)), MEM_STORE)
      .then(ok => {
        if(!ok) return { ok: false, added: 0, bumped: 0 };
        return memPrune().then(() => ({ ok: true, added, bumped }));
      });
  }).catch(() => ({ ok: false, added: 0, bumped: 0 }));
}

function memPrune(){
  return memAll().then(list => {
    if(list.length <= MEM_KEEP) return 0;
    const drop = list.slice(MEM_KEEP);
    return runDbTx('readwrite', s => drop.forEach(m => s.delete(m.id)), MEM_STORE).then(() => drop.length);
  }).catch(() => 0);
}

function flowMemoryDelete(id){
  return runDbTx('readwrite', s => s.delete(id), MEM_STORE);
}

function flowMemoryClear(){
  return runDbTx('readwrite', s => s.clear(), MEM_STORE);
}

/* 从「采用的变体」生成经验条目（每个 patch 一条） */
function flowMemoryFromVariant(flow, variant){
  const out = [];
  ((variant && variant.patches) || []).forEach(p => {
    const n = ((flow && flow.nodes) || []).find(x => x.id === p.nodeId);
    if(!n) return;
    out.push({
      nodeType: n.type,
      key: p.key,
      from: String((n.data || {})[p.key] || ''),
      to: p.value,
      source: 'variant',
      note: variant.name ? '采用变体「' + variant.name + '」' : '采用变体',
      flowId: flow.id,
      flowName: flow.name
    });
  });
  return out;
}

/* 拼给模型的「历史经验」段落。flow 不为空时只取该流程用到的节点类型 */
function flowMemoryHint(flow){
  return memAll().then(list => {
    const types = new Set((((flow && flow.nodes) || [])).map(n => n.type));
    // 旧经验里记的节点类型是 aiBranch；智能分支语义等价，别让老经验失效
    if(types.has('smartBranch')) types.add('aiBranch');
    const rows = (types.size ? list.filter(m => types.has(m.nodeType)) : list).slice(0, MEM_HINT_MAX);
    if(!rows.length) return '';
    return rows.map(m => {
      const title = ((NODE_DEFS[m.nodeType] || {}).title) || m.nodeType;
      const txt = String(m.to || '').replace(/\s+/g, ' ').trim();
      const cut = txt.length > MEM_TEXT_MAX ? txt.slice(0, MEM_TEXT_MAX) + '…' : txt;
      return '- [' + title + '·' + m.key + '] 采纳过：' + cut;
    }).join('\n');
  }).catch(() => '');
}

function flowMemoryStats(){
  return memAll().then(list => {
    const byType = {};
    list.forEach(m => { byType[m.nodeType] = (byType[m.nodeType] || 0) + 1; });
    return { total: list.length, byType, lastAt: list.length ? list[0].at : 0 };
  });
}
