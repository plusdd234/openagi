/* 操作轨迹与对话落盘 + 成功判定（P3 · 让「刚刚成功那一刻」真实存在）
 *
 * 在此之前平台有个结构性缺口：
 *   对话内容一条都不落盘（desk-chat 的 msgs 是纯内存数组，localStorage 只存模型名与开关），
 *   窗口一关，这次探索的全部证据消失 —— 于是「把这次存成流程」根本没有原料，
 *   只能重新让模型凭空再生成一次，而那会把刚才真正调通的参数丢掉。
 *
 * 这个文件补的正是那一段：
 *   traceAppend  记一次**能力调用**（生图 / 搜索 / 3D …），带解析后的输入
 *   chatSave / chatLoad  会话落盘（不存大图二进制，只留 prompt / 参数 / 引用）
 *   verdictOf    成功判定：结构 + 行为 + 质量三档合判
 *
 * 存储：openagi-runs 库的 traces 表（与运行历史同库）。单会话 id 固定为 'chat:current'，
 * 不参与淘汰 —— 它代表「当前这一轮探索」，被清掉就等于又回到了本文件诞生前的状态。
 */

const TRACE_STORE = 'traces';
const TRACE_CHAT_ID = 'chat:current';
const TRACE_KEEP = 40;          // 除当前会话外，最多再留 40 个历史会话
const TRACE_EV_MAX = 200;       // 单会话最多 200 条能力事件
const TRACE_IMG_MAX = 260000;   // 超过这个长度的 data URL 不入库（约 190KB 原图），只留占位

let _traceSession = '';

/* 当前会话 id：第一次访问时生成。
 * 它同时是 chat 记录的 id，所以刷新页面还能接着上一条轨迹继续记。 */
function traceSession(){
  if(!_traceSession) _traceSession = 'c' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  return _traceSession;
}
function traceSetSession(id){
  const s = String(id || '').trim();
  if(/^[a-zA-Z0-9_:]{4,64}$/.test(s)) _traceSession = s;
  return _traceSession;
}

function traceTx(mode, fn){
  return runDbTx(mode, fn, TRACE_STORE);
}

function traceRead(){
  return runDbOpen().then(db => {
    if(!db) return null;
    return new Promise(res => {
      let t;
      try { t = db.transaction(TRACE_STORE, 'readonly'); } catch(e){ res(null); return; }
      let q;
      try { q = t.objectStore(TRACE_STORE).get(TRACE_CHAT_ID); } catch(e){ res(null); return; }
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  }).catch(() => null);
}

/* 读改写一次完成：事件、消息、sid 都挂在同一条记录上，
 * 谁先写谁后写都不能把对方那段抹掉（否则「存消息」会把轨迹冲掉，反之亦然）。 */
function traceUpdate(patch){
  return traceRead().then(prev => {
    const base = (prev && typeof prev === 'object') ? prev : {};
    const next = {
      id: TRACE_CHAT_ID,
      sid: base.sid || traceSession(),
      at: Date.now(),
      events: Array.isArray(base.events) ? base.events.slice() : [],
      msgs: Array.isArray(base.msgs) ? base.msgs.slice() : []
    };
    const p = patch && typeof patch === 'object' ? patch : {};
    if(Array.isArray(p.events)) next.events = p.events.slice(-TRACE_EV_MAX);
    if(Array.isArray(p.msgs)) next.msgs = p.msgs.length > 120 ? p.msgs.slice(-120) : p.msgs;
    if(p.sid) next.sid = p.sid;
    return traceTx('readwrite', s => s.put(next)).then(ok => !!ok);
  }).catch(() => false);
}

/* 记一次能力调用。永不抛错：轨迹是附加价值，绝不能反过来弄坏对话 */
function traceAppend(ev){
  const e = ev && typeof ev === 'object' ? ev : {};
  const cap = String(e.cap || '').trim();
  if(!cap) return Promise.resolve(false);
  const item = {
    at: Number(e.at) || Date.now(),
    cap,
    ok: e.ok !== false,
    ms: Math.max(0, Math.trunc(Number(e.ms) || 0)),
    model: String(e.model || '').slice(0, 80),
    engine: String(e.engine || '').slice(0, 40),
    inputs: (e.inputs && typeof e.inputs === 'object') ? e.inputs : {},
    outKind: String(e.outKind || '').slice(0, 20),
    error: String(e.error || '').slice(0, 200) || undefined,
    ref: e.ref ? String(e.ref).slice(0, 200) : undefined
  };
  return traceRead().then(prev => {
    const events = ((prev && Array.isArray(prev.events)) ? prev.events.slice() : []);
    events.push(item);
    if(events.length > TRACE_EV_MAX) events.splice(0, events.length - TRACE_EV_MAX);
    return traceUpdate({ events });
  });
}

/* 读当前会话的能力轨迹（按时间正序） */
function traceList(){
  return traceRead().then(rec => ({
    sid: (rec && rec.sid) || traceSession(),
    at: (rec && rec.at) || 0,
    events: (rec && Array.isArray(rec.events)) ? rec.events.slice().sort((a, b) => a.at - b.at) : []
  })).catch(() => ({ sid: traceSession(), at: 0, events: [] }));
}

function traceClear(){
  return traceTx('readwrite', s => s.delete(TRACE_CHAT_ID)).catch(() => false);
}

/* 轨迹概览：给 UI 判断「这次值不值得存成流程」用 */
function traceSummary(list){
  const events = (list && list.events) || [];
  const byCap = {};
  let okCount = 0, failCount = 0, ms = 0;
  events.forEach(e => {
    byCap[e.cap] = (byCap[e.cap] || 0) + 1;
    if(e.ok) okCount++; else failCount++;
    ms += Number(e.ms) || 0;
  });
  return { steps: events.length, byCap, okCount, failCount, ms, at: (list && list.at) || 0 };
}

/* ---------------------------------------------------------------
 * 对话落盘
 *
 * 只存「能还原这次探索」的部分：文本、prompt、解析后的参数、引用。
 * **不存大图二进制** —— 理由和运行历史一致：存了会把配额吃光，
 * 而且对「存成流程」这件事没有信息量（要的是 prompt 和参数，不是像素）。
 * 小图（<190KB）顺手留着，让刷新后还能看见缩略图。
 * -------------------------------------------------------------- */
function chatSlim(msgs){
  return (Array.isArray(msgs) ? msgs : []).map(m => {
    if(!m || typeof m !== 'object') return null;
    const out = {
      id: m.id,
      role: m.role,
      kind: m.kind || 'text',
      at: m.at || 0
    };
    if(typeof m.content === 'string') out.content = m.content.length > 8000 ? m.content.slice(0, 8000) : m.content;
    ['text', 'prompt', 'raw', 'ref', 'srcLabel', 'phase', 'phaseText', 'denoise', 'error', 'searchNote'].forEach(k => {
      if(m[k] !== undefined && m[k] !== null && m[k] !== '') out[k] = m[k];
    });
    if(typeof out.error === 'string') out.error = out.error.slice(0, 400);
    if(Array.isArray(m.atts) && m.atts.length){
      out.atts = m.atts.slice(0, 6).map(a => {
        const s = String((a && (a.src || a)) || '');
        return /^data:/i.test(s) && s.length > TRACE_IMG_MAX ? '' : s;
      }).filter(Boolean);
    }
    if(m.image){
      const s = String(m.image);
      if(!/^data:/i.test(s)) out.image = s;
      else if(s.length <= TRACE_IMG_MAX) out.image = s;
      else out.imgDropped = true;
    }
    if(Array.isArray(m.sources)) out.sources = m.sources.slice(0, 6).map(x => ({ title: String(x.title || '').slice(0, 140), url: String(x.url || '') }));
    if(Array.isArray(m.values)) out.values = m.values.slice(0, 8);
    return out;
  }).filter(Boolean);
}

function chatSave(msgs){
  const slim = chatSlim(msgs);
  if(!slim.length) return Promise.resolve(false);
  return traceUpdate({ sid: traceSession(), msgs: slim });
}

function chatLoad(){
  return traceRead().then(rec => {
    if(!rec) return { msgs: [], sid: '' };
    if(rec.sid) traceSetSession(rec.sid);
    return { msgs: Array.isArray(rec.msgs) ? rec.msgs : [], sid: rec.sid || '' };
  }).catch(() => ({ msgs: [], sid: '' }));
}

/* ---------------------------------------------------------------
 * 成功判定：结构 + 行为 + 质量
 *
 * 之前的 ok 只有一个布尔（没报错），太粗：
 *   「跑完了但一个节点都没激活」和「全跑通只是一张图糊」都被判成 ok。
 * 「刚刚成功」这个触发条件不精确，后面所有自动化都建在沙子上。
 *
 * 三档：
 *   ok       结构通过 + 无失败节点 + 质量没被否
 *   partial  跑通了但有瑕疵（部分节点失败 / 试错过多 / 被踩 / 中途停止）
 *   failed   没跑起来或结构不成立
 * -------------------------------------------------------------- */
function verdictOf(input){
  const o = input && typeof input === 'object' ? input : {};
  const reasons = [];
  const started = o.started !== false;
  const structuralOk = o.structuralOk !== false;
  const failedNodes = Math.max(0, Math.trunc(Number(o.failedNodes) || 0));
  const activated = Math.max(0, Math.trunc(Number(o.activated) || 0));
  const retries = Math.max(0, Math.trunc(Number(o.retries) || 0));
  const rating = Number(o.rating) || 0;

  if(!started){
    reasons.push({ code:'no-start', text:'没有「任务开始」节点，一步都没执行' });
    return { verdict:'failed', reasons };
  }
  if(!structuralOk){
    reasons.push({ code:'invalid', text:'流程结构没通过校验' });
    return { verdict:'failed', reasons };
  }
  if(activated === 0 && o.activated !== undefined){
    reasons.push({ code:'idle', text:'运行结束了但没有任何节点被激活' });
    return { verdict:'failed', reasons };
  }
  if(o.stopped){
    reasons.push({ code:'stopped', text:'中途手动停止，产出不完整' });
  }
  if(failedNodes > 0){
    reasons.push({ code:'node-fail', text:failedNodes + ' 个节点执行失败' });
  }
  if(retries > 2){
    reasons.push({ code:'retry', text:'试错了 ' + retries + ' 轮才成功，参数未必稳定' });
  }
  if(rating < 0){
    reasons.push({ code:'down', text:'你给这次结果点过「踩」' });
  }
  if(reasons.length) return { verdict:'partial', reasons };
  return { verdict:'ok', reasons: [{ code:'ok', text:'结构通过、全部节点成功、结果未被否定' }] };
}

const VERDICT_LABEL = { ok:'成功', partial:'有瑕疵', failed:'失败' };
function verdictLabel(v){ return VERDICT_LABEL[v] || '未判定'; }
function verdictText(res){
  if(!res) return '未判定';
  const head = verdictLabel(res.verdict);
  const first = (res.reasons || [])[0];
  return first ? (head + ' · ' + first.text) : head;
}

/* 对话侧的成功判定：一条 error 消息 / 一次失败的生图都算瑕疵；
 * 但**只要最后有产出**就不到 failed —— 中间试错是探索的正常部分。 */
function chatVerdict(msgs){
  const list = Array.isArray(msgs) ? msgs : [];
  const errs = list.filter(m => m && (m.error || (m.kind === 'image' && m.phase === 'error')));
  const images = list.filter(m => m && m.kind === 'image' && m.phase === 'done' && m.image);
  const texts = list.filter(m => m && m.role === 'assistant' && m.text && !m.error);
  if(!images.length && !texts.length){
    return { verdict:'failed', reasons:[{ code:'empty', text:'这一轮没有任何产出' }] };
  }
  if(errs.length){
    return { verdict:'partial', reasons:[{ code:'err', text: errs.length + ' 次尝试失败过（' + String(errs[0].error || '').slice(0, 60) + '）' }] };
  }
  return { verdict:'ok', reasons:[{ code:'ok', text:'有可用产出且没有失败记录' }] };
}

/* 淘汰老会话（不碰当前那条） */
function tracePrune(){
  return runDbOpen().then(db => {
    if(!db) return 0;
    return new Promise(res => {
      let t;
      try { t = db.transaction(TRACE_STORE, 'readonly'); } catch(e){ res(0); return; }
      let q;
      try { q = t.objectStore(TRACE_STORE).getAll(); } catch(e){ res(0); return; }
      q.onsuccess = () => {
        const arr = (q.result || []).filter(x => x && x.id !== TRACE_CHAT_ID)
          .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
        const drop = arr.slice(TRACE_KEEP).map(x => x.id);
        if(!drop.length) return res(0);
        traceTx('readwrite', s => drop.forEach(id => s.delete(id))).then(n => res(n ? drop.length : 0));
      };
      q.onerror = () => res(0);
    });
  }).catch(() => 0);
}
