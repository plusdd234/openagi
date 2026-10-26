/* 交流社区客户端
 *
 * 一个大厅，SSE 长连接收消息，POST 发消息。断线自动重连（重连时带 lastId 补历史）。
 * 身份是「昵称 + 本机固定 cid」，不需要账号 —— 工具版不强制登录。
 * 服务地址优先级：?chat= > 设置里保存的 > http://127.0.0.1:8792
 */
const CHAT_CID_KEY = 'hf_chat_cid';
const CHAT_NAME_KEY = 'hf_chat_name';
const CHAT_BASE_KEY = 'hf_chat_base';
const CHAT_BASE_DEFAULT = 'http://127.0.0.1:8792';

let chatES = null;
let chatMsgs = [];
let chatSeen = new Set();
let chatLastId = '';
let chatUnread = 0;
let chatOpen = false;
let chatTimer = null;
let chatFail = 0;

function chatCid(){
  let v = '';
  try { v = localStorage.getItem(CHAT_CID_KEY) || ''; } catch(e){}
  if(!v){
    v = 'c' + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(CHAT_CID_KEY, v); } catch(e){}
  }
  return v;
}
function chatName(){
  let v = '';
  try { v = localStorage.getItem(CHAT_NAME_KEY) || ''; } catch(e){}
  if(!v){
    v = '访客' + Math.floor(100 + Math.random() * 900);
    try { localStorage.setItem(CHAT_NAME_KEY, v); } catch(e){}
  }
  return v;
}
function chatBase(){
  const m = (location.search.match(/[?&]chat=([^&]+)/) || [])[1];
  if(m) return decodeURIComponent(m).replace(/\/$/, '');
  let saved = '';
  try { saved = (localStorage.getItem(CHAT_BASE_KEY) || '').trim(); } catch(e){}
  return (saved || CHAT_BASE_DEFAULT).replace(/\/$/, '');
}

/* 传输方式：sse（默认，长连接）| poll（长轮询，服务器无状态，适合多实例） */
function chatTransport(){
  const m = (location.search.match(/[?&]transport=(sse|poll)/) || [])[1];
  if(m) return m;
  let saved = '';
  try { saved = localStorage.getItem('hf_chat_transport') || ''; } catch(e){}
  return saved === 'poll' ? 'poll' : 'sse';
}

function chatHint(text, cls){
  const el = $('chatHint');
  if(!el) return;
  el.textContent = text || '';
  el.className = 'chat-hint' + (cls ? ' ' + cls : '');
}

function chatTime(at){
  const d = new Date(at);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function chatRender(){
  const host = $('chatList');
  if(!host) return;
  const stick = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
  host.innerHTML = '';
  if(!chatMsgs.length){
    const e = document.createElement('div');
    e.className = 'chat-empty';
    e.textContent = '还没有人说话，打个招呼吧';
    host.appendChild(e);
    return;
  }
  chatMsgs.slice(-200).forEach(m => {
    const mine = m.cid === chatCid();
    const row = document.createElement('div');
    row.className = 'chat-msg' + (mine ? ' mine' : '');
    const head = document.createElement('div');
    head.className = 'chat-msg-head';
    const who = document.createElement('span');
    who.className = 'chat-msg-name';
    who.textContent = m.name || '访客';
    const when = document.createElement('span');
    when.className = 'chat-msg-time';
    when.textContent = chatTime(m.at);
    head.append(who, when);
    const body = document.createElement('div');
    body.className = 'chat-msg-text';
    body.textContent = m.text;
    row.append(head, body);
    host.appendChild(row);
  });
  if(stick) host.scrollTop = host.scrollHeight;
}

function chatAdd(m){
  if(!m || !m.id || chatSeen.has(m.id)) return;
  chatSeen.add(m.id);
  chatMsgs.push(m);
  if(chatLastId < m.id) chatLastId = m.id;
  if(chatMsgs.length > 500) chatMsgs = chatMsgs.slice(-300);
  if(chatOpen) chatRender();
  else {
    chatUnread++;
    const badge = $('chatUnread');
    if(badge){
      badge.textContent = chatUnread > 99 ? '99+' : String(chatUnread);
      badge.classList.remove('hidden');
    }
  }
}

function chatConnectSSE(){
  if(chatES) return;
  const url = chatBase() + '/chat/events?cid=' + encodeURIComponent(chatCid()) +
    '&name=' + encodeURIComponent(chatName()) +
    (chatLastId ? '&since=' + encodeURIComponent(chatLastId) : '');
  try { chatES = new EventSource(url); }
  catch(e){ chatHint('浏览器不支持长连接', 'error'); return; }

  chatES.addEventListener('hello', ev => {
    chatFail = 0;
    let d = {};
    try { d = JSON.parse(ev.data); } catch(e){}
    chatHint('');
    chatOnline(d.online);
  });
  chatES.addEventListener('message', ev => {
    let d = null;
    try { d = JSON.parse(ev.data); } catch(e){}
    chatAdd(d);
  });
  chatES.addEventListener('delete', ev => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch(e){}
    if(d && d.id){
      chatMsgs = chatMsgs.filter(m => m.id !== d.id);
      chatSeen.delete(d.id);
      chatRender();
    }
  });
  chatES.addEventListener('online', ev => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch(e){}
    chatOnline(d.online);
  });
  chatES.addEventListener('error', () => {
    // EventSource 自带重连，但我们要在重连 URL 里带上 since，所以自己重建
    try { chatES.close(); } catch(e){}
    chatES = null;
    chatFail++;
    if(chatFail <= 2) chatHint('连接中断，正在重连…', 'warn');
    else chatHint('连不上社区服务（' + chatBase() + '）—— 服务启动了吗？', 'error');
    clearTimeout(chatTimer);
    if(chatFail >= 3){
      chatHint('社区服务未连接（' + chatBase() + '）', 'warn');
      return;                      // 停止空转；打开面板时会重新尝试
    }
    chatTimer = setTimeout(chatConnect, Math.min(15000, 2000 * chatFail));
  });
}

let chatPolling = false;
let chatPollStop = false;

async function chatPollLoop(){
  if(chatPolling) return;
  chatPolling = true;
  chatPollStop = false;
  while(!chatPollStop){
    try {
      const url = chatBase() + '/chat/poll?cid=' + encodeURIComponent(chatCid()) +
        '&since=' + encodeURIComponent(chatLastId) + '&wait=25000';
      const res = await fetch(url, { cache: 'no-store' });
      const d = await res.json();
      if(d && Array.isArray(d.messages)) d.messages.forEach(chatAdd);
      chatOnline(d && d.online);
      chatFail = 0;
      if(chatOpen) chatHint('');
    } catch(e){
      chatFail++;
      if(chatFail <= 2) chatHint('连接中断，正在重连…', 'warn');
      else chatHint('连不上社区服务（' + chatBase() + '）', 'error');
      if(chatFail >= 3){ chatPollStop = true; break; }
      await new Promise(r => setTimeout(r, Math.min(15000, 2000 * chatFail)));
    }
  }
  chatPolling = false;
}

function chatConnect(){
  if(chatTransport() === 'poll') return chatPollLoop();
  return chatConnectSSE();
}

function chatOnline(n){
  const el = $('chatOnline');
  if(el) el.textContent = (Number(n) || 0) + ' 人在线';
}

async function chatSend(){
  const input = $('chatInput');
  if(!input) return;
  const text = String(input.value || '').trim();
  if(!text) return;
  const btn = $('chatSend');
  if(btn) btn.disabled = true;
  try {
    const res = await fetch(chatBase() + '/chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: chatCid(), name: chatName(), text })
    });
    let d = null;
    try { d = await res.json(); } catch(e){}
    if(!res.ok) throw new Error((d && d.error) || ('HTTP ' + res.status));
    input.value = '';
    input.style.height = '';
    chatHint('');
    if(d && d.message) chatAdd(d.message);
  } catch(e){
    chatHint(String((e && e.message) || e), 'error');
  } finally {
    if(btn) btn.disabled = false;
  }
}

function chatToggle(force){
  const panel = $('chatPanel');
  if(!panel) return;
  chatOpen = typeof force === 'boolean' ? force : !chatOpen;
  panel.classList.toggle('hidden', !chatOpen);
  $('chatBtn').classList.toggle('active', chatOpen);
  if(chatOpen){
    chatFail = 0;                  // 用户主动打开，重新给三次机会
    chatUnread = 0;
    const badge = $('chatUnread');
    if(badge) badge.classList.add('hidden');
    chatConnect();
    chatRender();
    const host = $('chatList');
    if(host) host.scrollTop = host.scrollHeight;
    setTimeout(() => { const i = $('chatInput'); if(i) i.focus(); }, 60);
  }
}

function chatBind(){
  const btn = $('chatBtn');
  if(!btn) return;
  btn.addEventListener('click', () => chatToggle());
  $('chatClose').addEventListener('click', () => chatToggle(false));
  $('chatSend').addEventListener('click', chatSend);

  const nameInput = $('chatName');
  nameInput.value = chatName();
  nameInput.addEventListener('change', () => {
    const v = String(nameInput.value || '').trim().slice(0, 16) || '访客';
    nameInput.value = v;
    try { localStorage.setItem(CHAT_NAME_KEY, v); } catch(e){}
    // 昵称变了要重连才会带上新名字
    if(chatES){ try { chatES.close(); } catch(e){} chatES = null; }
    chatConnect();
  });
  nameInput.addEventListener('keydown', e => { if(e.key === 'Enter') nameInput.blur(); });

  const input = $('chatInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(96, input.scrollHeight) + 'px';
  });
  input.addEventListener('keydown', e => {
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); chatSend(); }
  });

  // 面板打开时才连；关闭时保留连接（未读计数仍能累加）
  document.addEventListener('visibilitychange', () => {
    if(document.hidden && chatES){ /* 保持连接，靠心跳维持 */ }
  });
}

chatBind();
// 连接是懒加载：第一次打开面板才连（对没配社区服务的用户零干扰，也不会刷控制台报错）
