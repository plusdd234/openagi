/* 裸聊 App：无 system、无上下文、无历史 —— 每轮只发这一句
 *
 * 它存在的用途是「基准线」，不是更好用的聊天：
 *   - 默认请求体只有 messages:[{role:'user', content: 本轮}]，sys 传空（llmStreamRequest
 *     在 sys 为空时不会插入 system 消息，见 blueprint-runtime.js）；
 *   - 不读 msgs、不读 contextText、不走生图分支，所以输入 token ≈ 你打的字本身。
 *
 * 输入条上的 { } 按钮把这一句**展开成 OpenAI 兼容的请求体**（model + messages），
 * 可直接编辑再发送：加 system、加历史、换模型都在同一个编辑器里验证，
 * 不用为了试模板去改主对话。校验规则按 OpenAI 的角色约束来（首条 user、末尾 user、严格交替）。
 *
 * ⚠ 界面上的气泡只是本地显示，**从不回传**。这就是「看得见历史 ≠ 把历史发出去」：
 *   普通模式删掉这个数组不会影响任何请求，因为它压根没被读过。
 *   模板模式下历史是你自己在编辑器里写的，写几条就发几条。
 *
 * 依赖（均为全局脚本作用域）：
 *   llmStreamRequest  blueprint-runtime.js
 *   connFor / llmConn gateway-client.js、desk-chat-log.js
 *   deskCloseWin      desk-shell.js
 */
(function (global) {
  'use strict';

  function el(id){ return document.getElementById(id); }

  let busy = false;

  /* 一条气泡。复用对话 App 的 .dchat-msg / .dchat-body，不另做一套视觉。 */
  function addBubble(role, text){
    const box = el('bareLog');
    if(!box) return null;
    const row = document.createElement('div');
    row.className = 'dchat-msg' + (role === 'user' ? ' user' : '');
    const ava = document.createElement('div');
    ava.className = 'dchat-ava' + (role === 'user' ? ' user' : '');
    ava.textContent = role === 'user' ? '你' : 'AI';
    const body = document.createElement('div');
    body.className = 'dchat-body';
    const txt = document.createElement('div');
    txt.className = 'dchat-text';
    txt.textContent = text || '';
    body.appendChild(txt);
    row.appendChild(ava);
    row.appendChild(body);
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
    return { body: body, txt: txt };
  }

  function scrollDown(){
    const box = el('bareLog');
    if(box) box.scrollTop = box.scrollHeight;
  }

  function setBusy(on){
    busy = on;
    const btn = el('bareSend');
    if(btn){ btn.disabled = on; btn.textContent = on ? '…' : 'Send'; }
    const tbtn = el('bareTplSend');
    if(tbtn){ tbtn.disabled = on; tbtn.textContent = on ? '…' : 'Send'; }
  }

  /* ---------- 连接：和主对话共用同一份配置 ----------
   * 裸聊没有自己的模型下拉，但也不该另起一套连接：
   *   - 优先跟随主对话下拉选中的模型（同一个键 hf_desk_model，用同一个 connFor 解析）；
   *   - 没选过时落回 llmConn()（设置里的自定义接口 / 网关登录态）。
   * 这样「主对话能用的模型，裸聊也能用」，不会出现两边连到不同端点的问题
   * （此前裸聊只读 llmConn()，主对话选了 Ollama 它却仍去打设置里的本地地址，于是 404）。
   * 模板里的 model 字段会作为「本次覆盖」，不写回任何地方。 */
  function sharedConn(){
    let val = '';
    try{ val = localStorage.getItem('hf_desk_model') || ''; }catch(e){ return null; }
    if(!val || typeof global.connFor !== 'function') return null;
    try{
      const c = global.connFor(val);
      if(c && c.base && c.key && c.model) return c;
    }catch(e){ /* 网关未登录等：交给默认连接，让错误在发送时暴露 */ }
    return null;
  }

  function resolvedConn(){
    const shared = sharedConn();
    if(shared) return shared;
    try{
      if(typeof global.llmConn === 'function') return global.llmConn();
    }catch(e){ /* 设置项还没就绪 */ }
    return null;
  }

  function connLabel(modelOverride){
    const c = resolvedConn();
    const model = String(modelOverride || (c && c.model) || '');
    if(!model) return '未配置模型';
    const via = !c ? '' : c.via === 'gateway' ? '网关' : c.via === 'ollama' ? 'Ollama 本地' : '自定义接口';
    const base = String((c && c.base) || '').replace(/^https?:\/\//, '').split('/')[0];
    return (via ? via + ' · ' : '') + model + (base ? ' · ' + base : '');
  }

  /* 把「这次请求打给谁」摆在窗口顶部：出 403 / 404 时不用猜 */
  function syncMeta(modelOverride){
    const m = el('bareMeta');
    if(m) m.textContent = '连接：' + connLabel(modelOverride);
  }

  /* ---------- 唯一的发送执行点 ----------
   * 普通模式和模板模式都走这里，差别只有「传进来的 messages 是什么」。
   * 这样出错展示、忙碌状态、元信息同步都只有一份实现。 */
  async function runRequest(sys, messages, conn, modelOverride){
    const node = addBubble('assistant', '');
    setBusy(true);
    syncMeta(modelOverride);
    let acc = '';
    try{
      if(typeof global.llmStreamRequest !== 'function') throw new Error('语言模型未就绪：请先在设置里配置接口');
      await global.llmStreamRequest(sys, messages,
        d => { acc += d; if(node){ node.txt.textContent = acc; scrollDown(); } },
        conn ? { conn: conn } : {});
      if(!acc && node) node.txt.textContent = '（模型没有返回内容）';
    }catch(e){
      if(node){
        node.body.classList.add('error');
        node.txt.textContent = (e && e.message) || String(e);
      }
    }finally{
      setBusy(false);
    }
  }

  /* ---------- 普通模式：只发这一句 ---------- */
  async function send(){
    if(busy) return;
    const ta = el('bareText');
    if(!ta) return;
    const text = String(ta.value || '').trim();
    if(!text) return;

    addBubble('user', text);
    ta.value = '';
    ta.style.height = '';
    ta.focus();

    /* 注意 messages 里只有本轮这一句——这个函数没有「历史」这个概念，
       所以也不存在忘记裁剪的风险。 */
    await runRequest('', [{ role: 'user', content: text }], sharedConn(), '');
  }

  /* ---------- 模板模式 ---------- */
  let tplAuto = true;   // 编辑器里的内容是不是「自动生成的一条 user」（是则下次展开跟着输入同步）

  function textOf(content){
    if(typeof content === 'string') return content;
    if(Array.isArray(content)){
      return content.map(p => (p && typeof p === 'object' && typeof p.text === 'string') ? p.text : '').join('');
    }
    return '';
  }

  function buildTemplate(text){
    const conn = resolvedConn();
    return JSON.stringify({
      model: (conn && conn.model) || '',
      messages: [{ role: 'user', content: text || '' }]
    }, null, 2);
  }

  function note(msg, isErr){
    const n = el('bareTplNote');
    if(!n) return;
    n.textContent = msg;
    n.classList.toggle('err', !!isErr);
  }

  const RESET_NOTE = 'temperature 0.3 / stream true 由运行时固定';

  function isAutoShape(str){
    try{
      const b = JSON.parse(str);
      const m = Array.isArray(b) ? b : (b && b.messages);
      return Array.isArray(m) && m.length === 1 && m[0] && m[0].role === 'user';
    }catch(e){ return true; }   // 解析不了就当成自动内容，重填成合法 JSON
  }

  function openTpl(){
    const tpl = el('bareTpl');
    const bar = el('bareBar');
    const box = el('bareTplText');
    if(!tpl || !box) return;
    const ta = el('bareText');
    const src = ta ? String(ta.value || '') : '';
    if(tplAuto && (!box.value || isAutoShape(box.value))){
      box.value = buildTemplate(src.trim());
      tplAuto = true;
    }
    /* 赋值后光标默认可能把视图推到末尾，这里强制回到第一行 */
    box.scrollTop = 0;
    try{ box.setSelectionRange(0, 0); }catch(e){}
    if(bar) bar.classList.add('hidden');
    tpl.classList.remove('hidden');
    /* 输入框为空时生成的是 content:""，直接发会被校验拦住——先说明该填哪里 */
    note(src.trim() ? RESET_NOTE : '在 content 里写问题；Ctrl+Enter 发送', false);
    setTimeout(() => box.focus(), 40);
  }

  function closeTpl(){
    const tpl = el('bareTpl');
    const bar = el('bareBar');
    if(tpl) tpl.classList.add('hidden');
    if(bar) bar.classList.remove('hidden');
    const ta = el('bareText');
    if(ta) ta.focus();
  }

  /* 把编辑器里的 JSON 校验成 messages。规则就是 OpenAI 的角色约束：
   * 除 system 外以 user 开头、以 user 结尾、user / assistant 严格交替。 */
  function parseTemplate(str){
    let body;
    try{ body = JSON.parse(str); }
    catch(e){ return { err: 'JSON 解析失败：' + e.message }; }

    const raw = Array.isArray(body) ? body : (body && body.messages);
    if(!Array.isArray(raw) || !raw.length) return { err: '缺少 messages 数组（也可以直接给一个消息数组）' };

    const msgs = [];
    for(let i = 0; i < raw.length; i++){
      const m = raw[i] || {};
      const role = String(m.role || '');
      if(role !== 'system' && role !== 'user' && role !== 'assistant'){
        return { err: '第 ' + (i + 1) + ' 条的 role 不合法：' + (role || '（空）') + '，只能是 system / user / assistant' };
      }
      const hasParts = Array.isArray(m.content) && m.content.length;
      if(!hasParts && !textOf(m.content).trim()) return { err: '第 ' + (i + 1) + ' 条的 content 为空' };
      msgs.push({ role: role, content: m.content });
    }

    let sys = '';
    if(msgs[0].role === 'system') sys = textOf(msgs[0].content);
    const rest = msgs[0].role === 'system' ? msgs.slice(1) : msgs;
    if(!rest.length) return { err: '除 system 外至少还需要一条 user 消息' };
    if(rest[0].role !== 'user') return { err: 'system 之后的第一条必须是 user' };
    if(rest[rest.length - 1].role !== 'user') return { err: '最后一条必须是 user（不能停在 assistant 上）' };
    for(let i = 1; i < rest.length; i++){
      if(rest[i].role === rest[i - 1].role){
        return { err: '第 ' + (i + 1) + ' 条与上一条都是 ' + rest[i].role + '，必须 user / assistant 交替' };
      }
    }

    const override = (body && !Array.isArray(body) && body.model) ? String(body.model) : '';
    return { sys: sys, messages: rest, model: override };
  }

  async function sendTemplate(){
    if(busy) return;
    const box = el('bareTplText');
    if(!box) return;
    const parsed = parseTemplate(String(box.value || '').trim());
    if(parsed.err){ note(parsed.err, true); return; }

    let lastUser = '';
    for(let i = parsed.messages.length - 1; i >= 0; i--){
      if(parsed.messages[i].role === 'user'){ lastUser = textOf(parsed.messages[i].content); break; }
    }
    addBubble('user', lastUser);
    note(RESET_NOTE, false);

    const base = resolvedConn();
    const conn = base ? (parsed.model ? Object.assign({}, base, { model: parsed.model }) : base) : null;
    await runRequest(parsed.sys, parsed.messages, conn, parsed.model);
  }

  /* ---------- 初始化 ---------- */
  function focus(){
    syncMeta('');
    const tpl = el('bareTpl');
    const inTpl = tpl && !tpl.classList.contains('hidden');
    const target = inTpl ? el('bareTplText') : el('bareText');
    if(target) setTimeout(() => target.focus(), 60);
  }

  function init(){
    const btn = el('bareSend');
    const ta = el('bareText');
    if(btn) btn.addEventListener('click', send);
    if(ta){
      ta.addEventListener('keydown', e => {
        if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); }
      });
      /* 自适应高度：最多 160px，再多就内部滚动（与会话输入条同一套手感） */
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
      });
    }

    const tplBtn = el('bareTplBtn');
    if(tplBtn) tplBtn.addEventListener('click', openTpl);
    const back = el('bareTplBack');
    if(back) back.addEventListener('click', closeTpl);
    const tplSend = el('bareTplSend');
    if(tplSend) tplSend.addEventListener('click', sendTemplate);
    const box = el('bareTplText');
    if(box){
      box.addEventListener('input', () => { tplAuto = false; note(RESET_NOTE, false); });
      /* JSON 里 Enter 是换行，发送用 Ctrl/Cmd+Enter */
      box.addEventListener('keydown', e => {
        if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); sendTemplate(); }
      });
    }

    const close = el('btnBareWinClose');
    if(close) close.addEventListener('click', () => {
      if(typeof global.deskCloseWin === 'function') global.deskCloseWin(el('bareWin'));
    });
  }

  global.bareChatApp = { send: send, focus: focus, open: focus, openTemplate: openTpl };

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
