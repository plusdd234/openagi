/* 桌面 AI 对话：上下文清单 / 附件 / 消息渲染 / 持久化 / 存成流程
 *
 * 从 js/desk-chat.js 拆出（2026-11-01），见 desk-chat-core.js 顶部说明。
 * 与其它三段共享全局脚本作用域里的 msgs / atts / msgSeq 等状态。
 */
/* ---------- 上下文清单 ---------- */
function contextOptions(){
  const out = [{ value: 'none', label: '无上下文' }];
  (typeof FLOWS !== 'undefined' ? FLOWS : []).forEach(f => {
    out.push({ value: 'flow:' + f.id, label: (f.name || '未命名工作流') });
  });
  try{
    if(typeof Editor !== 'undefined' && Editor.selection && Editor.selection.size){
      out.push({ value: 'selection', label: '画布选中 ' + Editor.selection.size + ' 项' });
    }
  }catch(e){}
  return out;
}

function renderContextSelect(){
  const sel = el('deskAiCtx');
  if(!sel) return;
  const list = contextOptions();
  let cur = '';
  try{ cur = localStorage.getItem(CTX_KEY) || ''; }catch(e){}
  if(!list.some(o => o.value === cur)) cur = 'none';
  sel.innerHTML = '';
  list.forEach(o => {
    const op = document.createElement('option');
    op.value = o.value;
    op.textContent = o.label;
    sel.appendChild(op);
  });
  sel.value = cur;
  try{ localStorage.setItem(CTX_KEY, cur); }catch(e){}
  syncPicker('ctx');
}

function contextText(value){
  if(!value || value === 'none') return '';
  if(value === 'selection'){
    let names = [];
    try{
      if(typeof bp !== 'undefined' && bp && typeof Editor !== 'undefined'){
        names = Array.from(Editor.selection).map(id => {
          const n = (bp.nodes || []).find(x => x.id === id);
          if(!n) return null;
          const t = (typeof NODE_DEFS !== 'undefined' && NODE_DEFS[n.type]) ? NODE_DEFS[n.type].title : n.type;
          return t;
        }).filter(Boolean);
      }
    }catch(e){}
    if(!names.length) return '';
    return '当前上下文：画布上选中的节点 —— ' + names.join('、');
  }
  const fid = value.slice(5);
  let f = null;
  try{ f = (typeof FLOWS !== 'undefined' ? FLOWS : []).find(x => x.id === fid); }catch(e){}
  if(!f) return '';
  let d = null;
  try{ d = describeFlow(f); }catch(e){}
  if(!d) return '当前上下文：工作流「' + (f.name || '未命名') + '」';
  let s = '当前上下文：工作流「' + d.title + '」（' + d.stats + '）';
  if(d.types && d.types.length) s += '；节点类型：' + d.types.join('、');
  return s;
}

/* ---------- 连接 ---------- */
function connFor(value){
  const v = value || '';
  const i = v.indexOf(':');
  const src = i >= 0 ? v.slice(0, i) : 'local';
  const id = i >= 0 ? v.slice(i + 1) : v;
  if(src === 'gw'){
    return { base: gwBase() + '/v1', key: gwToken(), model: id, via: 'gateway' };
  }
  if(src === 'oll'){
    return { base: rtBase() + '/ollama/v1', key: 'ollama', model: id, via: 'ollama' };
  }
  return {
    base: confGet('llmBaseUrl').replace(/\/$/, ''),
    key: confGet('llmKey'),
    model: id,
    via: 'local'
  };
}

/* ---------- 附件 ---------- */
function renderAtts(){
  const box = el('deskAiAtts');
  if(!box) return;
  box.innerHTML = '';
  atts.forEach((src, i) => {
    const chip = document.createElement('span');
    chip.className = 'dai-chip';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '附件 ' + (i + 1);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'dai-chip-x';
    x.textContent = '×';
    x.title = '移除附件';
    x.addEventListener('click', () => { atts.splice(i, 1); renderAtts(); });
    chip.append(img, x);
    box.appendChild(chip);
  });
}

/* ---------- 消息渲染 ---------- */
/* 行缓存：流式聊天每收一片就 renderLog 一次，如果每次都重建全部行，
   之前那些生成图（dataURL 动辄几 MB）的 <img> 也会跟着重新挂载，
   一轮对话下来光解码就能把帧率拖垮。签名没变的行直接复用原节点。 */
const rowCache = new Map();      // mid -> { el, sig }

function msgSig(m){
  if(m.kind === 'image') return 'img|' + (m.phase || '') + '|' + (m.image ? 1 : 0) + '|' + (m.error ? 1 : 0) + '|' + (m.content || '').length;
  const c = m.content;
  const cSig = Array.isArray(c)
    ? c.map(p => p.type === 'text' ? 't:' + String(p.text || '').length : 'i').join(',')
    : String(c == null ? '' : c);
  /* 来源列表在正文之外单独渲染，签名里也要带上：不带的话，流式回复结束后
     补上的来源永远画不出来（行被判定为「没变」而直接复用旧节点）。 */
  const srcSig = (m.sources && m.sources.length)
    ? m.sources.map(s => s.url).join('|').length + '#' + m.sources.length
    : '';
  return 'txt|' + cSig + '|' + (m.error ? 1 : 0) + '|' + (m.reasoning ? m.reasoning.length : 0)
    + '|' + srcSig + '|' + (m.searchNote ? m.searchNote.length : 0);
}

function buildRow(m){
  const isUser = m.role === 'user';
  const row = document.createElement('div');
  row.className = 'dchat-msg ' + (isUser ? 'user' : 'ai');
  if(m.id) row.dataset.mid = m.id;
  // QQ 式布局：AI 头像在左、用户头像在右；AI 默认头像是 Ollama 的羊驼
  if(!isUser){
    const ava = document.createElement('span');
    ava.className = 'dchat-ava ai';
    const img = document.createElement('img');
    img.src = 'vendor/ollama-llama.png';
    img.alt = 'AI';
    img.draggable = false;
    ava.appendChild(img);
    row.appendChild(ava);
  }
  const body = document.createElement('div');
  body.className = 'dchat-body';
  // 只有图片、没有文字时不要让灰气泡再包一层——卡片自己带边框，套两层很难看
  if(m.kind === 'image' && !m.content) body.classList.add('is-gen');
  if(m.error) body.classList.add('error');
  if(m.reasoning){
    const det = document.createElement('details');
    det.className = 'dchat-think';
    const sum = document.createElement('summary');
    sum.textContent = '思考过程 · ' + m.reasoning.length + ' 字';
    const pre = document.createElement('div');
    pre.textContent = m.reasoning;
    det.append(sum, pre);
    body.appendChild(det);
  }
  if(typeof m.content === 'string'){
    if(m.content || !m.kind){
      const t = document.createElement('div');
      t.className = 'dchat-text';
      // 流式回复刚开始时内容是空串，给个省略号，别留一个空气泡
      t.textContent = m.content || (m.error ? '' : '…');
      body.appendChild(t);
    }
  }else if(Array.isArray(m.content)){
    (m.content || []).forEach(part => {
      if(part.type === 'text'){
        const t = document.createElement('div');
        t.className = 'dchat-text';
        t.textContent = part.text || '';
        body.appendChild(t);
      }else if(part.type === 'image_url'){
        const img = document.createElement('img');
        img.className = 'dchat-img';
        img.src = (part.image_url && part.image_url.url) || '';
        img.alt = '图片';
        body.appendChild(img);
      }
    });
  }
  /* 联网搜索的痕迹：搜到了就列来源（点开是原网页），没搜到/失败了给一句话说明。
     失败说明是灰色小字、不挂在正文里——它不该占正文的位置，但也不能悄悄消失。 */
  if(m.searchNote){
    const n = document.createElement('div');
    n.className = 'dchat-srcnote';
    n.textContent = m.searchNote;
    body.appendChild(n);
  }
  if(m.sources && m.sources.length){
    const box = document.createElement('div');
    box.className = 'dchat-sources';
    const lab = document.createElement('span');
    lab.className = 'dchat-src-label';
    lab.textContent = '联网来源';
    box.appendChild(lab);
    m.sources.forEach((s, i) => {
      const a = document.createElement('a');
      a.className = 'dchat-src';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '[' + (i + 1) + '] ' + (s.title || s.host || '网页');
      const snip = s.snippet || '';
      a.title = (snip ? (snip.length > 160 ? snip.slice(0, 159) + '…' : snip) + '\n' : '') + s.url;
      box.appendChild(a);
    });
    body.appendChild(box);
  }
  if(m.kind === 'image') body.appendChild(genCard(m));
  row.appendChild(body);
  if(isUser){
    const ava = document.createElement('span');
    ava.className = 'dchat-ava user';
    ava.textContent = '我';
    row.appendChild(ava);
  }
  return row;
}

/* 旧记录兜底：以前漏在正文里的裸 JSON 还躺在会话里，重开一看依旧刺眼。
   渲染前统一洗一遍（洗过就打标，别每条消息每次重建都过正则）。 */
function scrubMsg(m){
  if(m.__clean) return;
  if(typeof m.content === 'string' && m.content.indexOf('"type"') >= 0
    && typeof deskImage !== 'undefined' && deskImage.strip){
    const t = deskImage.strip(m.content, true);
    if(t !== m.content) m.content = t;
    m.__clean = true;
  }
}

function renderLog(){
  const log = el('deskChatLog');
  if(!log) return;
  log.innerHTML = '';
  if(!msgs.length){
    rowCache.clear();
    const e = document.createElement('div');
    e.className = 'dchat-empty';
    e.textContent = '还没有对话。可以直接问，也可以说「画一只在雨里的猫」——会自动出图。';
    log.appendChild(e);
    persistSoon();
    return;
  }
  msgs.forEach(m => {
    scrubMsg(m);
    const sig = msgSig(m);
    const hit = m.id ? rowCache.get(m.id) : null;
    if(hit && hit.sig === sig){
      log.appendChild(hit.el);      // 复用原节点（图片不会被重新解码）
      return;
    }
    const row = buildRow(m);
    if(m.id) rowCache.set(m.id, { el: row, sig: sig });
    log.appendChild(row);
  });
  log.scrollTop = log.scrollHeight;
  persistSoon();
  refreshSaveFlowSoon();
}

/* ==================== 轨迹与「存成流程」 ====================
 * 这一段的由来：以前对话内容一条都不落盘，窗口一关这次探索就没了 ——
 * 于是「把这次存成流程」只能重新让模型凭空再生成一次，而那样会把真正调通的参数丢掉。
 * 现在做两件事：
 *   ① 每次能力调用记一条轨迹（解析后的参数，不是用户那句原话）；
 *   ② 跑通了就把「存成流程」递到眼前 —— 它是筛选器不是广告位，点 × 就不再烦。 */

function traceCap(cap, o){
  try {
    if(typeof traceAppend !== 'function') return;
    traceAppend(Object.assign({ cap: cap }, o || {}))
      .then(() => refreshSaveFlowSoon())
      .catch(() => {});
  } catch(e){}
}

let persistTimer = 0;
let saveFlowTimer = 0;
let saveFlowDismissed = false;
let saveFlowBusy = false;

function persistSoon(){
  if(persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    try { if(typeof chatSave === 'function') chatSave(msgs); } catch(e){}
  }, 600);
}
function refreshSaveFlowSoon(){
  if(saveFlowTimer) clearTimeout(saveFlowTimer);
  saveFlowTimer = setTimeout(() => { saveFlowTimer = 0; refreshSaveFlow(); }, 300);
}

function refreshSaveFlow(){
  const bar = el('deskChatSaveFlow');
  const txt = el('deskChatSaveFlowText');
  if(!bar || !txt) return;
  if(saveFlowDismissed || typeof traceList !== 'function'){ bar.classList.add('hidden'); return; }
  /* 判定先看「这一轮成没成」：有失败记录就还不到存的时候，
   * 让用户先把结果弄对，再谈固化 —— 否则存下来的是一张废图的做法。 */
  const v = (typeof chatVerdict === 'function') ? chatVerdict(msgs) : { verdict: '' };
  if(v.verdict !== 'ok'){ bar.classList.add('hidden'); return; }
  traceList().then(list => {
    const sum = (typeof traceSummary === 'function') ? traceSummary(list) : { steps: 0 };
    const hint = (typeof traceFlowHint === 'function') ? traceFlowHint(list, sum) : { worthy: false };
    if(!hint.worthy){ bar.classList.add('hidden'); return; }
    txt.textContent = hint.reason;
    bar.classList.remove('hidden');
  }).catch(() => bar.classList.add('hidden'));
}

function saveChatFlow(btn){
  if(saveFlowBusy) return;
  saveFlowBusy = true;
  const label = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = '编译中…'; }
  const done = () => {
    saveFlowBusy = false;
    if(btn){ btn.disabled = false; btn.textContent = label || '存成流程'; }
  };
  traceList().then(list => {
    const res = flowFromTrace(list.events, {});
    if(!res.ok){ deskToast('存成流程失败：' + res.error); return; }
    /* 用户点这一下**就是确认**。和 flow-gen 同一条规矩：生成的流程绝不自动落盘。 */
    const flow = installGeneratedFlow(res);
    const bits = ['已存为「' + flow.name + '」'];
    if(res.skipped && res.skipped.length){
      bits.push(res.skipped.length + ' 个步骤没映射（' + res.skipped[0].cap + '）');
    }
    deskToast(bits.join(' · '));
    saveFlowDismissed = true;
    refreshSaveFlow();
  }).catch(e => {
    deskToast('存成流程失败：' + String((e && e.message) || e));
  }).then(done, done);
}